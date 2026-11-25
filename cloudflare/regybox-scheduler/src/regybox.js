// Client for Regybox's newer member app ("app3", served under
// https://www.regibox.pt/php8/app3/). Boxes that moved to app3 no longer accept
// the old app_nova endpoints, so this client signs in with the member's email
// and password (Worker secrets), keeps the PHPSESSID session in KV, and signs in
// again whenever Regybox reports that the session has ended.
import { parseFragment } from "parse5";

export const REGIBOX_ORIGIN = "https://www.regibox.pt";
export const APP_BASE = `${REGIBOX_ORIGIN}/php8/app3/`;
export const DEFAULT_BOX_ID = "180";
// Fallbacks for classes whose card does not show its own rules. Regybox's
// countdown timer, when present, always wins over the booking window. Most of
// Trend's classes show no cancellation rule, so by default the bot does not
// assume one and lets Regybox decide (it removes the CANCELAR button).
export const DEFAULT_BOOKING_WINDOW_HOURS = 48;
export const DEFAULT_CANCEL_CUTOFF_HOURS = null;
export const SESSION_KEY = "regybox:v1:regibox:session";
export const LOGIN_REJECTED_KEY = "regybox:v1:regibox:login-rejected";

// The member app's login screen is shared by every box under this pseudo-PWA id.
const LOGIN_PWA = "999999";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
// After Regybox rejects the saved password, do not try again until the Worker
// secrets change (new Worker version) or this long has passed, so repeated
// cron runs cannot lock the account.
export const LOGIN_REJECTED_TTL_SECONDS = 12 * 60 * 60;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_REDIRECTS = 3;
const OPENING_ROLLOVER_GRACE_MS = 30_000;
const OPENING_ROLLOVER_TOLERANCE_SECONDS = 60;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LOGGED_OUT_RE = /location\.replace\(\s*["'][^"']*\/pages\/login\/index\.php/i;
const ACTION_SCRIPTS = {
  enroll: "book_classes.php",
  unenroll: "cancel_class.php",
};
const ACTION_URL_RE = /[^'"\s,()]*(?:book_classes|cancel_class)\.php(?:\?[^'"\s,()]*)?/gi;
const ACTION_PATH_RE = /^\/php8\/app3\/(?:pwa\/\d+\/)?pages\/classes\/scripts\/(book_classes|cancel_class)\.php$/;
const WAITLIST_RE = /lista de espera|em espera|waiting ?list|wait ?list/i;
const CONFIRMED_RE = /reserva confirmada|inscri[çc][ãa]o confirmada|\bconfirmad[oa]\b|\binscrit[oa]\b|\bbooked\b/i;
const OVER_RE = /terminad[oa]|a decorrer|em curso|\bfinished\b|in progress/i;
const BLOCKED_RE =
  /limite|conflito|bloquead|sem cr[ée]ditos?|sem saldo|sem plano|n[ãa]o tem|n[ãa]o permitid|indispon[ií]vel|suspens|\blimit\b|conflict/i;
const FULL_RE = /lotad[oa]|esgotad[oa]|complet[oa]|cheia|sem vagas|\bfull\b/i;
const ALREADY_BOOKED_RE = /j[áa]\s.*(?:inscrit|reservad|marcad)|already\s+(?:enrolled|registered|booked)/i;
const CANCEL_CLOSED_RE = /prazo|tarde demais|n[ãa]o (?:[ée] )?poss[ií]vel cancelar|j[áa] n[ãa]o (?:pode|[ée] poss[ií]vel)|too late/i;
// Per-class rules: the "Regras de marcação e cancelamento" sheet (one per class
// with special rules, outside the card) and the booking button's confirmation.
const RULES_SHEET_RE = /\bid\s*=\s*["']book_rules(\d+)["']/gi;
const RULES_SHEET_LINK_RE = /^#book_rules(\d+)$/;
const CANCEL_RULE_RE = /cancel(?:amentos|ar a reserva)\s+at[ée]\s+([^<.]{1,60}?)\s+antes d[ao]/i;
const BOOKING_WINDOW_RULE_RE = /marca[çc][õo]es podem ser feitas at[ée]\s+([^<.]{1,60}?)\s+de anteced[êe]ncia/i;
const DURATION_PART_RE = /(\d+)\s*(semanas?|dias?|horas?|minutos?)\b/gi;
const DURATION_UNIT_MINUTES = { semana: 10_080, dia: 1_440, hora: 60, minuto: 1 };
// After booking or cancelling, the member app fires these Regybox URLs to email
// the coach or the member promoted from the waitlist. The bot does the same.
const FOLLOW_UP_FIELDS = ["mail_profs", "mail_url", "sms_url"];
const MAX_FOLLOW_UPS = 5;

export class RegyboxLoginError extends Error {
  constructor(message = "Unable to log in", { reason = "unexpected", detail } = {}) {
    super(message);
    this.name = "RegyboxLoginError";
    this.reason = reason;
    if (detail) {
      this.detail = detail;
    }
  }
}

export class ClassNotFoundError extends Error {
  constructor({ classType = "", classTime = "", classDate = "" } = {}) {
    super(`Unable to find class '${classType}' at ${classTime} on ${classDate}`);
    this.name = "ClassNotFoundError";
  }
}

export class ClassNotOpenError extends Error {
  constructor(message = "Class is not open for enrollment") {
    super(message);
    this.name = "ClassNotOpenError";
  }
}

export class ClassIsOverbookedError extends Error {
  constructor(message = "Class is overbooked") {
    super(message);
    this.name = "ClassIsOverbookedError";
  }
}

export class UserAlreadyEnrolledError extends Error {
  constructor(message = "User already enrolled in class") {
    super(message);
    this.name = "UserAlreadyEnrolledError";
  }
}

export class RegyboxTimeoutError extends Error {
  constructor(timeoutSeconds, { timeToEnroll } = {}) {
    super(
      timeToEnroll === undefined
        ? `Timed out waiting for enrollment to open after ${timeoutSeconds} seconds`
        : `Enrollment opens in ${timeToEnroll} seconds, which exceeds ${timeoutSeconds} seconds`,
    );
    this.name = "RegyboxTimeoutError";
  }
}

export class UnparseableError extends Error {
  constructor(message = "Unable to parse HTML", diagnostics = undefined) {
    super(message);
    this.name = "UnparseableError";
    if (diagnostics) {
      this.safeDiagnostics = diagnostics;
    }
  }
}

export class NoClassesFoundError extends Error {
  constructor(classDate = "") {
    super(`No classes found on ${classDate}`);
    this.name = "NoClassesFoundError";
  }
}

/** Regybox lists the class but does not offer booking (daily limit, clash, credits...). */
export class ClassBlockedError extends Error {
  constructor(reason = "") {
    super(reason ? `Regybox does not allow booking this class: ${reason}` : "Regybox does not allow booking this class");
    this.name = "ClassBlockedError";
    this.reason = reason;
  }
}

/** Regybox answered a booking or cancellation request with success=false. */
export class BookingRejectedError extends Error {
  constructor(message = "", { operation = "enroll" } = {}) {
    const verb = operation === "unenroll" ? "cancellation" : "booking";
    super(message ? `Regybox refused the ${verb}: ${message}` : `Regybox refused the ${verb}`);
    this.name = "BookingRejectedError";
    this.operation = operation;
  }
}

/** The booking can no longer be cancelled (Regybox stops cancellations some time before class). */
export class CancellationClosedError extends Error {
  constructor({ cancelDeadline = "", cutoffHours = null, message = "" } = {}) {
    const detail = message ? ` Regybox said: ${message}` : "";
    const rule = cutoffHours
      ? `Regybox only allows cancelling until ${formatHours(cutoffHours)} before class`
      : "Regybox no longer offers cancelling this booking";
    super(`Too late to cancel: ${rule}${cancelDeadline ? ` (deadline ${cancelDeadline})` : ""}.${detail}`);
    this.name = "CancellationClosedError";
    this.regyboxMessage = message;
    this.cancelDeadline = cancelDeadline;
    this.cutoffHours = cutoffHours;
  }
}

function attributes(node) {
  return Object.fromEntries((node?.attrs ?? []).map(({ name, value }) => [name.toLowerCase(), value]));
}

function classTokens(node) {
  return String(attributes(node).class ?? "").split(/\s+/).filter(Boolean);
}

function hasClass(node, ...names) {
  const tokens = new Set(classTokens(node));
  return names.every((name) => tokens.has(name));
}

function elements(root, tagName = null) {
  const matches = [];
  const visit = (node) => {
    if (node?.tagName && (!tagName || node.tagName === tagName)) {
      matches.push(node);
    }
    for (const child of node?.childNodes ?? []) {
      visit(child);
    }
    if (node?.content) {
      visit(node.content);
    }
  };
  visit(root);
  return matches;
}

function descendants(root, tagName = null) {
  return elements({ childNodes: root?.childNodes ?? [] }, tagName);
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, value) => {
      const number = value.toLowerCase().startsWith("x")
        ? Number.parseInt(value.slice(1), 16)
        : Number.parseInt(value, 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : _;
    });
}

function fixText(value) {
  const text = String(value).trim().replace(/\s+/g, " ");
  // Regybox occasionally returns UTF-8 decoded as Windows-1252.
  if (!/[ÃÂâ]/.test(text) || [...text].some((character) => character.codePointAt(0) > 255)) {
    return text;
  }
  try {
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from([...text], (character) => character.charCodeAt(0)),
    );
    return repaired.includes("�") ? text : repaired;
  } catch {
    return text;
  }
}

function textContent(node) {
  const parts = [];
  const visit = (current) => {
    if (current?.nodeName === "#text") {
      parts.push(current.value);
    }
    if (current?.tagName === "script" || current?.tagName === "style") {
      return;
    }
    for (const child of current?.childNodes ?? []) {
      visit(child);
    }
  };
  visit(node);
  return fixText(parts.join(" "));
}

/** Short, tag-free text from a Regybox message, safe to show in emails and run logs. */
export function safeText(value, limit = 160) {
  return fixText(decodeEntities(String(value ?? "").replace(/<[^>]*>/g, " ")))
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\S+@\S+/g, "[email]")
    .trim()
    .slice(0, limit);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function zonedParts(timestampMs, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter
      .formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

/** The calendar date (YYYY-MM-DD) of a timestamp in a timezone. */
export function zonedDate(timestampMs, timezone = "Europe/Lisbon") {
  const parts = zonedParts(timestampMs, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function zonedOffsetMs(timestampMs, timezone) {
  const parts = zonedParts(timestampMs, timezone);
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return localAsUtc - Math.floor(timestampMs / 1000) * 1000;
}

/** Epoch milliseconds of a local wall-clock time (YYYY-MM-DD, HH:MM) in a timezone. */
export function zonedEpochMs(date, time, timezone = "Europe/Lisbon") {
  const [year, month, day] = String(date).split("-").map(Number);
  const [hour, minute] = String(time).split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) {
    throw new Error(`Invalid local time: ${date} ${time}`);
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall - zonedOffsetMs(wall, timezone);
  guess = wall - zonedOffsetMs(guess, timezone);
  return guess;
}

function zonedIso(timestampMs, timezone) {
  const parts = zonedParts(timestampMs, timezone);
  const offsetMinutes = Math.round(zonedOffsetMs(timestampMs, timezone) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

/** Human-readable local time for emails, e.g. "Thu 26 Nov, 12:00". */
export function formatLocalTime(timestampMs, timezone = "Europe/Lisbon") {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestampMs));
}

function setCookieLines(headers) {
  if (typeof headers?.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const value = headers?.get?.("set-cookie");
  return value ? value.split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/) : [];
}

/** Minimal cookie jar for the single Regybox origin. */
export function createCookieJar(initial = {}) {
  const cookies = new Map(
    Object.entries(initial && typeof initial === "object" ? initial : {}).filter(
      ([name, value]) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) && typeof value === "string",
    ),
  );
  let changed = false;
  return {
    get size() {
      return cookies.size;
    },
    get changed() {
      return changed;
    },
    markSaved() {
      changed = false;
    },
    has(name) {
      return cookies.has(name);
    },
    restore(saved) {
      for (const [name, value] of Object.entries(saved && typeof saved === "object" ? saved : {})) {
        if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) && typeof value === "string" && value) {
          cookies.set(name, value);
        }
      }
      changed = false;
    },
    header() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    update(headers) {
      for (const line of setCookieLines(headers)) {
        const [pair, ...attrs] = String(line).split(";");
        const separator = pair.indexOf("=");
        if (separator <= 0) {
          continue;
        }
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        const expired =
          value === "" ||
          value === "deleted" ||
          attrs.some((attr) => {
            const [key, ...rest] = attr.split("=");
            const attrName = key.trim().toLowerCase();
            const attrValue = rest.join("=").trim();
            if (attrName === "max-age") {
              return Number(attrValue) <= 0;
            }
            if (attrName === "expires") {
              const expires = Date.parse(attrValue);
              return Number.isFinite(expires) && expires < Date.now();
            }
            return false;
          });
        if (expired) {
          changed = cookies.delete(name) || changed;
        } else if (cookies.get(name) !== value) {
          cookies.set(name, value);
          changed = true;
        }
      }
    },
    toJSON() {
      return Object.fromEntries(cookies);
    },
    clear() {
      if (cookies.size) {
        changed = true;
      }
      cookies.clear();
    },
  };
}

function parseJsonObject(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSuccess(value) {
  if (value === true || value === 1) {
    return true;
  }
  return ["1", "true", "ok", "s", "sim", "success", "y", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function assertRegiboxUrl(url) {
  if (url.origin !== REGIBOX_ORIGIN || !url.pathname.startsWith("/php8/app3/")) {
    throw new UnparseableError("Regybox pointed to an unexpected address", {
      unexpectedOriginEndpoints: [url.pathname],
    });
  }
}

/** Parse the app3 sign-in form: hidden fields plus the obfuscated email/password names. */
export function parseLoginForm(html, formUrl) {
  const document = parseFragment(String(html));
  const form = elements(document, "form").find((node) => /verifica_acesso\.php/i.test(attributes(node).action ?? ""));
  if (!form) {
    throw new UnparseableError("Regybox sign-in form was not found");
  }
  const action = new URL(decodeEntities(attributes(form).action), formUrl);
  assertRegiboxUrl(action);
  if (!/\/pages\/login\/scripts\/verifica_acesso\.php$/.test(action.pathname)) {
    throw new UnparseableError("Regybox sign-in form posts to an unexpected address", {
      unexpectedOriginEndpoints: [action.pathname],
    });
  }
  const fields = new Map();
  let emailField = null;
  let passwordField = null;
  for (const input of descendants(form, "input")) {
    const attrs = attributes(input);
    const name = attrs.name;
    const type = String(attrs.type ?? "text").toLowerCase();
    if (!name || ["submit", "button", "image", "reset", "file"].includes(type)) {
      continue;
    }
    if (type === "password") {
      passwordField ??= name;
    } else if (type !== "hidden" && /^login./i.test(name)) {
      emailField ??= name;
    }
    fields.set(name, decodeEntities(attrs.value ?? ""));
  }
  if (!emailField || !passwordField) {
    throw new UnparseableError("Regybox sign-in form has no email or password field");
  }
  if (!fields.get("csrf_token")) {
    throw new UnparseableError("Regybox sign-in form has no CSRF token");
  }
  return { action: action.href, fields, emailField, passwordField };
}

function resolveActionUrl(raw, boxId) {
  const value = decodeEntities(raw).replace(/^\.\//, "");
  if (/^https?:/i.test(value) || value.startsWith("/")) {
    return new URL(value, REGIBOX_ORIGIN);
  }
  if (value.startsWith("../")) {
    return new URL(value, `${APP_BASE}pwa/${boxId}/`);
  }
  return new URL(value, APP_BASE);
}

function blockActions(block, boxId) {
  const found = { enroll: new Set(), unenroll: new Set() };
  const unexpected = [];
  for (const node of [block, ...descendants(block)]) {
    const onclick = attributes(node).onclick;
    if (!onclick) {
      continue;
    }
    for (const raw of onclick.match(ACTION_URL_RE) ?? []) {
      let url;
      try {
        url = resolveActionUrl(raw, boxId);
      } catch {
        continue;
      }
      const match = url.origin === REGIBOX_ORIGIN ? url.pathname.match(ACTION_PATH_RE) : null;
      if (!match) {
        unexpected.push(url.pathname);
        continue;
      }
      found[match[1] === "book_classes" ? "enroll" : "unenroll"].add(url.href);
    }
  }
  const diagnostics = {
    actionEndpoints: [...found.enroll, ...found.unenroll],
    unexpectedOriginEndpoints: unexpected,
  };
  if (unexpected.length > 0) {
    throw new UnparseableError("Class action used an unexpected address", diagnostics);
  }
  if (found.enroll.size > 1 || found.unenroll.size > 1 || (found.enroll.size && found.unenroll.size)) {
    throw new UnparseableError("Class card has ambiguous booking controls", diagnostics);
  }
  return {
    enrollUrl: [...found.enroll][0] ?? null,
    unenrollUrl: [...found.unenroll][0] ?? null,
  };
}

function classBlocks(document) {
  return elements(document, "div").filter((node) => hasClass(node, "filtro0"));
}

const BLOCK_START_RE = /<div\b[^>]*?\bclass\s*=\s*(["'])(?:(?!\1)[^>])*?\bfiltro0\b(?:(?!\1)[^>])*?\1[^>]*>/gi;

// Parsing a whole day's list with parse5 costs ~10 ms of CPU, which matters on
// Cloudflare's free plan when the Worker polls every second around opening.
// Split the list at each class card's opening tag so only the cards that can
// match are parsed. Falls back to a full parse when no card tag is found.
function classChunks(html) {
  const text = String(html);
  const starts = [...text.matchAll(BLOCK_START_RE)].map((match) => match.index);
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
}

function chunkBlock(chunk) {
  return classBlocks(parseFragment(chunk))[0] ?? null;
}

function firstByClass(nodes, name) {
  return nodes.find((node) => hasClass(node, name));
}

function blockStartTime(nodes) {
  const node = firstByClass(nodes, "a_hora");
  const match = node ? textContent(node).match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/) : null;
  return match ? { start: `${pad2(match[1])}:${match[2]}`, end: `${pad2(match[3])}:${match[4]}` } : null;
}

function blockName(nodes) {
  const node = firstByClass(nodes, "a_nome_aula");
  return node ? textContent(node) : null;
}

/** Minutes in a Portuguese duration such as "8 horas", "1 hora" or "2 dias e 5 minutos". */
export function parseDurationMinutes(text) {
  let total = 0;
  let found = false;
  for (const [, amount, unit] of String(text ?? "").matchAll(DURATION_PART_RE)) {
    const key = unit.toLowerCase().replace(/s$/, "");
    total += Number.parseInt(amount, 10) * DURATION_UNIT_MINUTES[key];
    found = true;
  }
  return found ? total : null;
}

function ruleMinutes(text, pattern) {
  const match = String(text ?? "").match(pattern);
  return match ? parseDurationMinutes(match[1]) : null;
}

/**
 * Read the per-class rule sheets on a class list, keyed by class id. Only
 * classes with special rules have one; the regex pass is cheap enough to run on
 * every poll, unlike a full HTML parse.
 */
export function parseClassRules(html) {
  const text = String(html ?? "");
  const rules = new Map();
  const starts = [...text.matchAll(RULES_SHEET_RE)];
  starts.forEach((match, index) => {
    const end = Math.min(starts[index + 1]?.index ?? text.length, match.index + 4000);
    let sheet = text.slice(match.index, end);
    const nextCard = sheet.search(/\bfiltro0\b/);
    if (nextCard > 0) {
      sheet = sheet.slice(0, nextCard);
    }
    rules.set(match[1], {
      cancelCutoffMinutes: ruleMinutes(sheet, CANCEL_RULE_RE),
      bookingWindowMinutes: ruleMinutes(sheet, BOOKING_WINDOW_RULE_RE),
    });
  });
  return rules;
}

/** "8 hours", "1 hour", "30 minutes". */
export function formatHours(hours) {
  const minutes = Math.round(Number(hours) * 60);
  if (minutes % 60 === 0) {
    const whole = minutes / 60;
    return `${whole} ${whole === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export function parseCapacity(value) {
  const normalized = String(value).trim();
  if (normalized === "∞") {
    return null;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new UnparseableError(`Unexpected capacity value: ${value}`);
  }
  return Number.parseInt(normalized, 10);
}

function blockRules(nodes, rules) {
  let sheetRules = null;
  let buttonCutoff = null;
  for (const node of nodes) {
    const attrs = attributes(node);
    const sheetId = attrs["data-sheet"]?.match(RULES_SHEET_LINK_RE)?.[1];
    if (sheetId && rules?.has(sheetId)) {
      sheetRules ??= rules.get(sheetId);
    }
    if (attrs.onclick && /book_classes\.php/i.test(attrs.onclick)) {
      buttonCutoff ??= ruleMinutes(attrs.onclick, CANCEL_RULE_RE);
    }
  }
  return {
    cancelCutoffMinutes: sheetRules?.cancelCutoffMinutes ?? buttonCutoff,
    bookingWindowMinutes: sheetRules?.bookingWindowMinutes ?? null,
  };
}

function parseClassBlock(
  block,
  {
    date,
    timezone = "Europe/Lisbon",
    now = Date.now(),
    boxId = DEFAULT_BOX_ID,
    bookingWindowHours = DEFAULT_BOOKING_WINDOW_HOURS,
    cancelCutoffHours = DEFAULT_CANCEL_CUTOFF_HOURS,
    rules = null,
  } = {},
) {
  const nodes = descendants(block);
  const name = blockName(nodes);
  const time = blockStartTime(nodes);
  if (!name || !time) {
    throw new UnparseableError("Class card is missing its name or time", {
      missingName: !name,
      missingTime: !time,
    });
  }
  const capacityNode = firstByClass(nodes, "a_insc");
  const capacity = capacityNode ? textContent(capacityNode).match(/(\d+)\s*(?:de|of|\/)\s*(\d+|∞)/i) : null;
  const curCapacity = capacity ? parseCapacity(capacity[1]) : null;
  const maxCapacity = capacity ? parseCapacity(capacity[2]) : null;
  const info = nodes
    .filter((node) => hasClass(node, "a_info"))
    .map((node) => textContent(node))
    .filter(Boolean)
    .join(" · ");
  const timers = descendants(block, "input")
    .filter((node) => hasClass(node, "timers"))
    .map((node) => {
      const attrs = attributes(node);
      const value = Number.parseInt(attrs.value, 10);
      if (!Number.isFinite(value)) {
        throw new UnparseableError("Class card has an unreadable countdown");
      }
      // data-abre="1" marks a countdown to booking opening; without it the
      // countdown is to the class start.
      return { value, opens: attrs["data-abre"] === "1" };
    });
  const { enrollUrl, unenrollUrl } = blockActions(block, boxId);
  const userIsWaitlisted = WAITLIST_RE.test(info);
  const userIsEnrolled = !userIsWaitlisted && (Boolean(unenrollUrl) || CONFIRMED_RE.test(info));
  const startMs = zonedEpochMs(date, time.start, timezone);
  const isOver = OVER_RE.test(info) || startMs <= now;
  const isOpen = Boolean(enrollUrl);
  const isFull = maxCapacity !== null && curCapacity !== null && curCapacity >= maxCapacity;
  const blockedReason =
    !isOpen && !userIsEnrolled && !userIsWaitlisted && !isOver && BLOCKED_RE.test(info) ? info : null;
  const waitingToOpen = !isOpen && !userIsEnrolled && !userIsWaitlisted && !isOver && !blockedReason;
  const classRules = blockRules(nodes, rules);
  const cancelCutoffMinutes =
    classRules.cancelCutoffMinutes ??
    (cancelCutoffHours === null || cancelCutoffHours === undefined ? null : Number(cancelCutoffHours) * 60);
  const bookingWindowMinutes = classRules.bookingWindowMinutes ?? Number(bookingWindowHours) * 60;
  const computedOpensIn = Math.round((startMs - bookingWindowMinutes * 60_000 - now) / 1000);
  const openingTimer = timers.find((timer) => timer.opens);
  let timeToEnroll = null;
  if (waitingToOpen) {
    timeToEnroll = openingTimer ? openingTimer.value : computedOpensIn > 0 ? computedOpensIn : null;
  }
  return {
    name,
    date,
    start: time.start,
    end: time.end,
    startsAt: zonedIso(startMs, timezone),
    startMs,
    cancelDeadlineMs: cancelCutoffMinutes === null ? null : startMs - cancelCutoffMinutes * 60_000,
    cancelCutoffHours: cancelCutoffMinutes === null ? null : cancelCutoffMinutes / 60,
    bookingWindowHours: bookingWindowMinutes / 60,
    maxCapacity,
    curCapacity,
    info,
    isOpen,
    isFull,
    isOverbooked: (isFull || FULL_RE.test(info)) && !isOpen && !userIsEnrolled && !userIsWaitlisted,
    enrollmentDeadlineExpired: isOver,
    isOver,
    userIsBlocked: Boolean(blockedReason),
    blockedReason,
    userIsEnrolled,
    userIsWaitlisted,
    timeToStart: Math.max(0, Math.round((startMs - now) / 1000)),
    timeToEnroll,
    computedOpensIn,
    enrollUrl,
    unenrollUrl,
  };
}

/** Count the class cards on a list and parse the first few, to check the layout cheaply. */
export function sampleClasses(html, { limit = 3, ...options } = {}) {
  if (!options.date) {
    throw new Error("sampleClasses requires the list's date");
  }
  const chunks = classChunks(html);
  if (!chunks.length) {
    const classes = parseClasses(html, options);
    return { total: classes.length, sample: classes.slice(0, limit) };
  }
  const rules = parseClassRules(html);
  const sample = chunks.slice(0, limit).map((chunk) => {
    const block = chunkBlock(chunk);
    if (!block) {
      throw new UnparseableError("Class card could not be read");
    }
    return parseClassBlock(block, { ...options, rules });
  });
  return { total: chunks.length, sample };
}

/** Parse every class card on an app3 class list for one day. */
export function parseClasses(html, options = {}) {
  if (!options.date) {
    throw new Error("parseClasses requires the list's date");
  }
  const rules = options.rules ?? parseClassRules(html);
  return classBlocks(parseFragment(String(html))).map((block) => parseClassBlock(block, { ...options, rules }));
}

function parseClassesAtTime(html, { classTime, classTypes = [], ...options } = {}) {
  const chunks = classChunks(html);
  const blocks = chunks.length
    ? chunks.filter((chunk) => chunk.includes(classTime)).map(chunkBlock).filter(Boolean)
    : classBlocks(parseFragment(String(html)));
  const candidates = new Set(classTypes.map((name) => String(name).toUpperCase()));
  const rules = parseClassRules(html);
  return {
    total: chunks.length || blocks.length,
    classes: blocks
      .filter((block) => {
        const nodes = descendants(block);
        const time = blockStartTime(nodes);
        const name = blockName(nodes);
        return time?.start === classTime && (candidates.size === 0 || candidates.has(String(name).toUpperCase()));
      })
      .map((block) => parseClassBlock(block, { ...options, rules })),
  };
}

export function pickClass(classes, { classTime, classType, classDate }) {
  const selected = classes.find(
    (class_) =>
      class_.start === classTime &&
      class_.name.toUpperCase() === String(classType).toUpperCase() &&
      class_.date === classDate,
  );
  if (!selected) {
    throw new ClassNotFoundError({ classType, classTime, classDate });
  }
  return selected;
}

export function parseClassTypes(classTypes) {
  return String(classTypes ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function pickFirstClass(classes, { classTime, classTypes, classDate }) {
  const candidates = Array.isArray(classTypes) ? classTypes : parseClassTypes(classTypes);
  let lastError;
  for (const classType of candidates) {
    try {
      return pickClass(classes, { classTime, classType, classDate });
    } catch (error) {
      if (!(error instanceof ClassNotFoundError)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError ?? new ClassNotFoundError({ classTime, classDate });
}

export function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseActionJson(text, operation) {
  const data = parseJsonObject(String(text).trim());
  if (!data) {
    throw new UnparseableError(
      operation === "unenroll" ? "Regybox cancellation response was not JSON" : "Regybox booking response was not JSON",
    );
  }
  return data;
}

function actionMessage(data) {
  return safeText(data?.message ?? data?.msg ?? data?.toast?.text ?? "");
}

function withConfirmation(url) {
  const confirmed = new URL(url);
  confirmed.searchParams.set("conf", "ok");
  return confirmed.href;
}

export function createRegyboxClient({
  email,
  password,
  boxId = DEFAULT_BOX_ID,
  kv = null,
  versionId = null,
  fetchImpl = fetch,
  timezone = "Europe/Lisbon",
  retryTotal = 4,
  retryBackoffMs = 50,
  sleep = defaultSleep,
  now = () => Date.now(),
  onTrace = async () => {},
  bookingWindowHours = DEFAULT_BOOKING_WINDOW_HOURS,
  cancelCutoffHours = DEFAULT_CANCEL_CUTOFF_HOURS,
} = {}) {
  if (!String(email ?? "").trim() || !String(password ?? "")) {
    throw new RegyboxLoginError("The Regybox email or password secret is missing", { reason: "missing_credentials" });
  }
  const box = /^\d+$/.test(String(boxId ?? "").trim()) ? String(boxId).trim() : DEFAULT_BOX_ID;
  const jar = createCookieJar();
  let sessionLoaded = false;
  const emitTrace = async (event) => {
    try {
      await onTrace(event);
    } catch (error) {
      console.warn("regybox: HTTP trace callback failed:", error);
    }
  };

  async function fetchWithRetry(url, { method, body, referer, accept }) {
    let response;
    for (let attempt = 0; attempt <= retryTotal; attempt += 1) {
      const headers = {
        Accept: accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        Referer: referer ?? `${APP_BASE}pwa/${box}/`,
        "User-Agent": USER_AGENT,
      };
      if (jar.size) {
        headers.Cookie = jar.header();
      }
      if (method === "POST") {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        headers.Origin = REGIBOX_ORIGIN;
      }
      const requestStartedAt = now();
      try {
        response = await fetchImpl(url.href, { method, headers, body, redirect: "manual" });
      } catch (error) {
        await emitTrace({
          level: attempt === retryTotal ? "error" : "warn",
          scope: "http",
          code: "regybox_request_network_error",
          message:
            attempt === retryTotal
              ? `Regybox request failed after ${attempt + 1} attempt(s)`
              : `Regybox request failed; retrying attempt ${attempt + 2}`,
          data: {
            attempt: attempt + 1,
            durationMs: Math.max(0, now() - requestStartedAt),
            endpointPath: url.pathname,
            nextRetryMs: attempt === retryTotal ? undefined : retryBackoffMs * 2 ** attempt,
          },
        });
        if (attempt === retryTotal) {
          throw error;
        }
        await sleep(retryBackoffMs * 2 ** attempt);
        continue;
      }
      await emitTrace({
        level: RETRYABLE_STATUS_CODES.has(response.status) ? "warn" : "info",
        scope: "http",
        code: "regybox_response_received",
        message: `Regybox request returned HTTP ${response.status}`,
        data: {
          attempt: attempt + 1,
          durationMs: Math.max(0, now() - requestStartedAt),
          endpointPath: url.pathname,
          httpStatus: response.status,
        },
      });
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === retryTotal) {
        break;
      }
      await sleep(retryBackoffMs * 2 ** attempt);
    }
    return response;
  }

  async function send(target, { method = "GET", body, referer, accept } = {}) {
    let url = new URL(target);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      assertRegiboxUrl(url);
      const response = await fetchWithRetry(url, { method, body, referer, accept });
      jar.update(response.headers);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url);
        method = "GET";
        body = undefined;
        continue;
      }
      if (!response.ok) {
        throw new Error(`Regybox request failed with HTTP ${response.status}`);
      }
      return response.text();
    }
    throw new UnparseableError("Regybox redirected too many times");
  }

  async function kvGet(key) {
    if (!kv) {
      return null;
    }
    try {
      return parseJsonObject(await kv.get(key));
    } catch (error) {
      console.warn("regybox: session state read failed:", error?.name ?? "Error");
      return null;
    }
  }

  async function kvPut(key, value, ttl) {
    if (!kv) {
      return;
    }
    try {
      await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
    } catch (error) {
      console.warn("regybox: session state write failed:", error?.name ?? "Error");
    }
  }

  async function kvDelete(key) {
    if (!kv || typeof kv.delete !== "function") {
      return;
    }
    try {
      await kv.delete(key);
    } catch (error) {
      console.warn("regybox: session state delete failed:", error?.name ?? "Error");
    }
  }

  const sameVersion = (record) => !versionId || !record?.versionId || record.versionId === versionId;

  async function loadSavedSession() {
    if (sessionLoaded) {
      return;
    }
    sessionLoaded = true;
    const saved = await kvGet(SESSION_KEY);
    if (saved?.cookies && saved.versionId === (versionId ?? null)) {
      jar.restore(saved.cookies);
    }
  }

  async function saveSession() {
    await kvPut(
      SESSION_KEY,
      { cookies: jar.toJSON(), savedAt: new Date(now()).toISOString(), versionId: versionId ?? null },
      SESSION_TTL_SECONDS,
    );
    jar.markSaved();
  }

  async function login() {
    const rejected = await kvGet(LOGIN_REJECTED_KEY);
    if (rejected && sameVersion(rejected)) {
      await emitTrace({
        level: "error",
        scope: "session",
        code: "regybox_login_paused",
        message: "Skipped sign-in: Regybox rejected the saved email or password recently",
      });
      throw new RegyboxLoginError(
        "Regybox rejected the saved email or password; sign-in is paused until a secret changes or 12 hours pass",
        { reason: "rejected_recently" },
      );
    }
    await emitTrace({ scope: "session", code: "regybox_login_started", message: "Signing in to Regybox" });
    jar.clear();
    const shellUrl = `${APP_BASE}pwa/${LOGIN_PWA}/pages/login/index.php?lang=pt`;
    await send(shellUrl);
    const formUrl = `${APP_BASE}pwa/${LOGIN_PWA}/pages/login/login.php?id_box=${box}&pwa=${LOGIN_PWA}&lang=pt&v=`;
    const form = parseLoginForm(await send(formUrl, { referer: shellUrl }), formUrl);
    form.fields.set(form.emailField, String(email).trim());
    form.fields.set(form.passwordField, String(password));
    const responseText = await send(form.action, {
      method: "POST",
      body: new URLSearchParams([...form.fields]).toString(),
      referer: shellUrl,
      accept: "application/json, text/plain, */*",
    });
    const data = parseJsonObject(String(responseText).trim());
    if (!data) {
      throw new UnparseableError("Regybox sign-in response was not JSON");
    }
    const toast = safeText(data.toast?.text ?? "");
    if (data.action === "login_falhou") {
      await kvPut(LOGIN_REJECTED_KEY, { at: new Date(now()).toISOString(), versionId: versionId ?? null }, LOGIN_REJECTED_TTL_SECONDS);
      await emitTrace({
        level: "error",
        scope: "session",
        code: "regybox_login_rejected",
        message: "Regybox rejected the saved email or password",
      });
      throw new RegyboxLoginError("Regybox rejected the saved email or password", { reason: "rejected", detail: toast });
    }
    if (data.action !== "verifica_acesso_fun") {
      throw new RegyboxLoginError(`Regybox sign-in did not complete${toast ? `: ${toast}` : ""}`, {
        reason: "unexpected",
        detail: toast,
      });
    }
    const accountBox = /^\d+$/.test(String(data.id ?? "")) ? String(data.id) : box;
    const appUrl = `${APP_BASE}pwa/${accountBox}/?pwa=${accountBox}&ignore=s&v=${encodeURIComponent(String(data.v ?? ""))}`;
    const appHtml = await send(appUrl, { referer: shellUrl });
    if (LOGGED_OUT_RE.test(appHtml)) {
      throw new RegyboxLoginError("Regybox did not keep the session after signing in", { reason: "session_not_kept" });
    }
    await kvDelete(LOGIN_REJECTED_KEY);
    await saveSession();
    await emitTrace({ scope: "session", code: "regybox_login_succeeded", message: "Signed in to Regybox" });
  }

  async function ensureSession() {
    await loadSavedSession();
    if (!jar.has("PHPSESSID")) {
      await login();
    }
  }

  async function authedGet(url) {
    await ensureSession();
    let text = await send(url);
    if (LOGGED_OUT_RE.test(text)) {
      await emitTrace({
        level: "warn",
        scope: "session",
        code: "regybox_session_expired",
        message: "Regybox session ended; signing in again",
      });
      await login();
      text = await send(url);
      if (LOGGED_OUT_RE.test(text)) {
        throw new RegyboxLoginError("Regybox asked to sign in again right after a fresh sign-in", {
          reason: "session_not_kept",
        });
      }
    }
    if (jar.changed) {
      await saveSession();
    }
    return text;
  }

  function classListUrl(classDate) {
    const date = typeof classDate === "number" ? zonedDate(classDate, timezone) : String(classDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid class date: ${classDate}`);
    }
    return `${APP_BASE}pages/classes/classes_list.php?date=${date}&type=1&plano=0&box=`;
  }

  // Same as the member app after a booking or cancellation: call the e-mail/SMS
  // URLs Regybox returns (coach notice, member promoted from the waitlist).
  // Best effort: the booking itself is already saved, so failures are only traced.
  async function runFollowUps(data, base) {
    const urls = FOLLOW_UP_FIELDS.flatMap((field) => (Array.isArray(data?.[field]) ? data[field] : [data?.[field]]))
      .filter((value) => typeof value === "string" && value.trim())
      .slice(0, MAX_FOLLOW_UPS);
    for (const raw of urls) {
      let url;
      try {
        url = new URL(decodeEntities(raw.trim()), base);
      } catch {
        continue;
      }
      if (url.origin !== REGIBOX_ORIGIN) {
        await emitTrace({
          level: "warn",
          scope: "regybox",
          code: "follow_up_skipped",
          message: "Skipped a Regybox notification URL on another site",
          data: { endpointPath: url.pathname },
        });
        continue;
      }
      try {
        const headers = { "User-Agent": USER_AGENT, Referer: `${APP_BASE}pwa/${box}/` };
        if (jar.size) {
          headers.Cookie = jar.header();
        }
        const response = await fetchImpl(url.href, { method: "GET", headers, redirect: "manual" });
        await response.body?.cancel?.();
        await emitTrace({
          level: response.ok ? "info" : "warn",
          scope: "regybox",
          code: "follow_up_sent",
          message: `Regybox notification request returned HTTP ${response.status}`,
          data: { endpointPath: url.pathname, httpStatus: response.status },
        });
      } catch {
        await emitTrace({
          level: "warn",
          scope: "regybox",
          code: "follow_up_failed",
          message: "Regybox notification request failed",
          data: { endpointPath: url.pathname },
        });
      }
    }
  }

  function actionUrl(url, operation) {
    const parsed = new URL(url);
    const match = parsed.origin === REGIBOX_ORIGIN ? parsed.pathname.match(ACTION_PATH_RE) : null;
    if (!match || ACTION_SCRIPTS[operation] !== `${match[1]}.php`) {
      throw new UnparseableError("Refusing to call an unexpected Regybox action", {
        unexpectedOriginEndpoints: [parsed.pathname],
      });
    }
    return parsed.href;
  }

  return {
    timezone,
    boxId: box,
    bookingWindowHours,
    cancelCutoffHours,
    bootstrapSession: () => ensureSession(),
    login,
    fetchClassesHtml: (classDate) => authedGet(classListUrl(classDate)),
    async enroll(url) {
      const target = actionUrl(url, "enroll");
      let data = parseActionJson(await authedGet(target), "enroll");
      let confirmedInsideCancelWindow = false;
      if (data.conf && !isSuccess(data.success)) {
        // Regybox asks for confirmation when the class is inside the
        // no-cancellation window. The calendar event is the member's intent.
        await emitTrace({
          level: "warn",
          scope: "regybox",
          code: "booking_confirmation_required",
          message: "Regybox asked to confirm a booking that can no longer be cancelled; confirming",
        });
        data = parseActionJson(await authedGet(withConfirmation(target)), "enroll");
        confirmedInsideCancelWindow = true;
      }
      const message = actionMessage(data);
      if (!isSuccess(data.success)) {
        if (ALREADY_BOOKED_RE.test(message)) {
          throw new UserAlreadyEnrolledError(message);
        }
        if (data.wait_url || FULL_RE.test(message)) {
          throw new ClassIsOverbookedError(message ? `Class is full: ${message}` : "Class is full");
        }
        throw new BookingRejectedError(message, { operation: "enroll" });
      }
      await runFollowUps(data, target);
      // A full class still offers RESERVAR; booking it joins the waitlist and
      // Regybox answers success with a wait_url (the app then shows the queue).
      return {
        message,
        confirmedInsideCancelWindow,
        userIsWaitlisted: Boolean(data.wait_url) || WAITLIST_RE.test(message),
      };
    },
    async unenroll(url) {
      const target = actionUrl(url, "unenroll");
      const data = parseActionJson(await authedGet(target), "unenroll");
      const message = actionMessage(data);
      if (!isSuccess(data.success)) {
        if (CANCEL_CLOSED_RE.test(message)) {
          throw new CancellationClosedError({ cutoffHours: cancelCutoffHours, message });
        }
        throw new BookingRejectedError(message, { operation: "unenroll" });
      }
      await runFollowUps(data, target);
      return { message };
    },
  };
}

function operationResult(operation, status, classType, extra = {}) {
  return { operation, status, classType, ...extra };
}

function closedResult({ classType, timeToEnroll, now, timezone }) {
  return operationResult("enroll", "noop", classType, {
    cacheState: "not_open",
    enrollmentOpensAt:
      timeToEnroll === null || timeToEnroll === undefined ? null : zonedIso(now + timeToEnroll * 1000, timezone),
    lastCheckedAt: zonedIso(now, timezone),
  });
}

function cancelDetails(selected, timezone) {
  return {
    cancelDeadline: selected.cancelDeadlineMs === null ? "" : formatLocalTime(selected.cancelDeadlineMs, timezone),
    cutoffHours: selected.cancelCutoffHours,
  };
}

function bookingNote(selected, { confirmedInsideCancelWindow, now, timezone }) {
  const hours = selected.cancelCutoffHours;
  const deadline = selected.cancelDeadlineMs;
  if (confirmedInsideCancelWindow || (deadline !== null && deadline <= now)) {
    return hours
      ? `This booking was made less than ${formatHours(hours)} before class, so Regybox will not let you cancel it.`
      : "Regybox said this booking can no longer be cancelled, so deleting the calendar event will not cancel it.";
  }
  if (deadline === null) {
    return "To cancel, delete the calendar event. Regybox decides how close to class it still allows cancelling.";
  }
  return (
    `To cancel, delete the calendar event before ${formatLocalTime(deadline, timezone)} ` +
    `(Regybox allows cancelling this class until ${formatHours(hours)} before it starts).`
  );
}

async function loadClasses(
  client,
  {
    classDate,
    classTime,
    classTypes,
    timezone,
    now,
    sleep = defaultSleep,
    emptyRetryTotal = 3,
    emptyRetryBackoffMs = 50,
    beforeFetch = async () => {},
  },
) {
  // An empty list is treated as transient, with a bounded retry that keeps
  // the run inside Cloudflare's per-invocation subrequest cap.
  for (let attempt = 0; ; attempt += 1) {
    await beforeFetch();
    const html = await client.fetchClassesHtml(classDate);
    const { total, classes } = parseClassesAtTime(html, {
      classTime,
      classTypes,
      date: classDate,
      timezone,
      now: now(),
      boxId: client.boxId,
      bookingWindowHours: client.bookingWindowHours,
      cancelCutoffHours: client.cancelCutoffHours,
    });
    if (total > 0) {
      return classes;
    }
    if (attempt >= emptyRetryTotal) {
      throw new NoClassesFoundError(classDate);
    }
    await sleep(emptyRetryBackoffMs * 2 ** attempt);
  }
}

export async function runOperation({
  client,
  operation = "enroll",
  classDate,
  classTime,
  classType,
  timeoutSeconds = 900,
  notOpenIsNoop = false,
  now = () => Date.now(),
  sleep = defaultSleep,
  maxPolls = 40,
  onTrace = async () => {},
} = {}) {
  if (!client || !classDate || !classTime) {
    throw new Error("client, classDate, and classTime are required");
  }
  if (operation !== "enroll" && operation !== "unenroll") {
    throw new Error(`Unsupported operation: ${operation}`);
  }
  const normalizedClassTime = String(classTime).padStart(5, "0");
  const classTypes = parseClassTypes(classType);
  if (classTypes.length === 0) {
    throw new Error("classType must include at least one class name");
  }
  const timezone = client.timezone ?? "Europe/Lisbon";
  const emitTrace = async (event) => {
    try {
      await onTrace(event);
    } catch (error) {
      console.warn("regybox: operation trace callback failed:", error);
    }
  };
  let fetches = 0;
  const beforeFetch = async () => {
    if (fetches >= maxPolls) {
      await emitTrace({
        level: "error",
        scope: "regybox",
        code: "class_fetch_limit_reached",
        message: `Stopped after ${maxPolls} class-page fetches`,
        data: { fetchCount: fetches, fetchLimit: maxPolls },
      });
      throw new RegyboxTimeoutError(timeoutSeconds);
    }
    fetches += 1;
  };
  const load = () =>
    loadClasses(client, {
      classDate,
      classTime: normalizedClassTime,
      classTypes,
      timezone,
      now,
      sleep,
      beforeFetch,
    });

  if (operation === "unenroll") {
    const classes = await load();
    let firstMatch = null;
    for (const candidate of classTypes) {
      let selected;
      try {
        selected = pickClass(classes, { classTime: normalizedClassTime, classType: candidate, classDate });
      } catch (error) {
        if (error instanceof ClassNotFoundError) {
          continue;
        }
        throw error;
      }
      firstMatch ??= selected;
      if (!selected.userIsEnrolled && !selected.userIsWaitlisted) {
        continue;
      }
      if (!selected.unenrollUrl) {
        // Regybox removes the CANCELAR button once cancelling is closed. When
        // the class shows its cutoff, only trust that before the deadline.
        if (selected.cancelDeadlineMs === null || now() >= selected.cancelDeadlineMs) {
          await emitTrace({
            level: "error",
            scope: "regybox",
            code: "cancellation_closed",
            message: "Regybox no longer offers cancelling this class; the booking stays",
          });
          throw new CancellationClosedError(cancelDetails(selected, timezone));
        }
        throw new UnparseableError("Booked class has no cancel control", { actionEndpoints: [] });
      }
      await emitTrace({
        level: "info",
        scope: "regybox",
        code: "unenrollment_attempt",
        message: "Attempting to cancel enrollment",
      });
      try {
        await client.unenroll(selected.unenrollUrl);
      } catch (error) {
        if (error instanceof CancellationClosedError && !error.cancelDeadline) {
          throw new CancellationClosedError({ ...cancelDetails(selected, timezone), message: error.regyboxMessage });
        }
        throw error;
      }
      await emitTrace({
        level: "info",
        scope: "regybox",
        code: "unenrollment_success",
        message: "Enrollment cancelled successfully",
      });
      return operationResult("unenroll", "success", selected.name);
    }
    return operationResult("unenroll", "noop", firstMatch?.name ?? classTypes[0]);
  }

  const startedAt = now();
  let predictedOpeningAt = null;
  let openingBecameImminent = false;
  let rolloverGraceStartedAt = null;
  let hasWaited = false;
  let previousTimerSeconds = null;
  while (now() - startedAt < timeoutSeconds * 1000) {
    const classes = await load();
    const selected = pickFirstClass(classes, { classTime: normalizedClassTime, classTypes, classDate });
    const resolvedClassType = selected.name || classTypes[0];
    const observedAt = now();
    await emitTrace({
      level: "info",
      scope: "regybox",
      code: "class_state_observed",
      message: "Parsed class state",
      data: {
        fetchCount: fetches,
        isOpen: selected.isOpen,
        userIsEnrolled: selected.userIsEnrolled,
        isFull: selected.isFull,
        enrollmentDeadlineExpired: selected.enrollmentDeadlineExpired,
        timerSeconds: selected.timeToEnroll,
      },
    });
    if (selected.userIsEnrolled || selected.userIsWaitlisted) {
      await emitTrace({
        level: "info",
        scope: "regybox",
        code: "already_enrolled",
        message: selected.userIsWaitlisted
          ? "Skipped because the user is already on the waitlist"
          : "Skipped because the user is already enrolled",
      });
      return operationResult("enroll", "noop", resolvedClassType, {
        ...(selected.userIsWaitlisted ? { userIsWaitlisted: true } : {}),
      });
    }
    if (selected.isOpen) {
      await emitTrace({ level: "info", scope: "regybox", code: "enrollment_attempt", message: "Attempting to enroll" });
      let enrollment;
      try {
        enrollment = await client.enroll(selected.enrollUrl);
      } catch (error) {
        if (error instanceof UserAlreadyEnrolledError) {
          await emitTrace({
            level: "info",
            scope: "regybox",
            code: "already_enrolled",
            message: "Enrollment response reported that the user is already enrolled",
          });
          return operationResult("enroll", "noop", resolvedClassType);
        }
        throw error;
      }
      // Confirm against the class list instead of trusting the toast text.
      const [verified] = (await load()).filter((class_) => class_.name === selected.name);
      if (!verified || (!verified.userIsEnrolled && !verified.userIsWaitlisted)) {
        throw new UnparseableError("Regybox accepted the booking, but the class list does not show it", {
          actionEndpoints: verified?.enrollUrl ? [verified.enrollUrl] : [],
        });
      }
      const userIsWaitlisted = verified.userIsWaitlisted || enrollment.userIsWaitlisted === true;
      await emitTrace({
        level: "info",
        scope: "regybox",
        code: "enrollment_success",
        message: userIsWaitlisted ? "Added to the waitlist" : "Enrolled successfully",
      });
      return operationResult("enroll", "success", resolvedClassType, {
        ...(userIsWaitlisted ? { userIsWaitlisted: true } : {}),
        ...(enrollment.confirmedInsideCancelWindow ? { cannotCancel: true } : {}),
        note: userIsWaitlisted
          ? undefined
          : bookingNote(selected.cancelDeadlineMs !== null ? selected : verified, {
              confirmedInsideCancelWindow: enrollment.confirmedInsideCancelWindow,
              now: now(),
              timezone,
            }),
      });
    }
    if (selected.blockedReason) {
      await emitTrace({
        level: "error",
        scope: "regybox",
        code: "class_blocked",
        message: `Regybox does not offer booking for this class: ${safeText(selected.blockedReason, 80)}`,
      });
      throw new ClassBlockedError(safeText(selected.blockedReason));
    }
    const timeToEnroll = selected.timeToEnroll;
    const hasTimer = timeToEnroll !== null && timeToEnroll !== undefined;
    if (!hasTimer && selected.isOverbooked) {
      throw new ClassIsOverbookedError("Class is full");
    }
    const observedOpeningAt = hasTimer ? observedAt + timeToEnroll * 1000 : null;
    predictedOpeningAt ??= observedOpeningAt;
    if (hasTimer && timeToEnroll <= 10) {
      openingBecameImminent = true;
    }
    const timerJumped = Boolean(
      openingBecameImminent &&
        observedOpeningAt !== null &&
        predictedOpeningAt !== null &&
        observedOpeningAt - predictedOpeningAt > OPENING_ROLLOVER_TOLERANCE_SECONDS * 1000,
    );
    const openingStateDisappeared = Boolean(
      openingBecameImminent && (selected.enrollmentDeadlineExpired || !hasTimer),
    );
    if ((timerJumped || openingStateDisappeared) && rolloverGraceStartedAt === null) {
      rolloverGraceStartedAt = observedAt;
      await emitTrace({
        level: "error",
        scope: "regybox",
        code: "opening_boundary_inconsistency",
        message: timerJumped
          ? `Timer jumped from ${previousTimerSeconds} seconds to ${timeToEnroll} seconds; treating as an opening-boundary inconsistency`
          : "Opening countdown disappeared at the enrollment boundary; treating as an opening-boundary inconsistency",
        data: {
          previousTimerSeconds,
          timerSeconds: timeToEnroll,
          enrollmentDeadlineExpired: selected.enrollmentDeadlineExpired,
        },
      });
    }
    if (rolloverGraceStartedAt !== null) {
      const graceElapsedMs = observedAt - rolloverGraceStartedAt;
      if (graceElapsedMs >= OPENING_ROLLOVER_GRACE_MS) {
        throw new UnparseableError("Enrollment state remained inconsistent after opening", {
          fetchCount: fetches,
          graceSeconds: OPENING_ROLLOVER_GRACE_MS / 1000,
          timerSeconds: timeToEnroll,
          enrollmentDeadlineExpired: selected.enrollmentDeadlineExpired,
        });
      }
      hasWaited = true;
      await emitTrace({
        level: "warn",
        scope: "regybox",
        code: "opening_boundary_grace_retry",
        message: "Opening-boundary state is inconsistent; retrying in 1 second",
        data: {
          waitSeconds: 1,
          graceRemainingSeconds: Math.ceil((OPENING_ROLLOVER_GRACE_MS - graceElapsedMs) / 1000),
        },
      });
      await sleep(1000);
      previousTimerSeconds = timeToEnroll;
      continue;
    }
    if (!hasTimer && !selected.enrollmentDeadlineExpired && selected.computedOpensIn <= 0) {
      // Booking should be open by now, yet the card has no booking button and
      // no countdown. Report it instead of silently retrying every run.
      await emitTrace({
        level: "error",
        scope: "regybox",
        code: "class_not_bookable",
        message: "Booking should be open, but Regybox shows no booking button for this class",
      });
      throw new ClassBlockedError(selected.info ? safeText(selected.info) : "no booking button after booking opened");
    }
    const elapsedSeconds = Math.max(0, Math.ceil((observedAt - startedAt) / 1000));
    const remainingSeconds = Math.max(0, timeoutSeconds - elapsedSeconds);
    const cannotWait = selected.enrollmentDeadlineExpired || !hasTimer || timeToEnroll > remainingSeconds;
    if (cannotWait) {
      if (notOpenIsNoop && !hasWaited) {
        await emitTrace({
          level: "info",
          scope: "regybox",
          code: "class_not_open",
          message: hasTimer
            ? `Enrollment opens in ${timeToEnroll} seconds, beyond this run's wait window`
            : "Class is not open and has no enrollment countdown",
          data: { timerSeconds: timeToEnroll, remainingSeconds },
        });
        return closedResult({ classType: resolvedClassType, timeToEnroll, now: observedAt, timezone });
      }
      if (selected.enrollmentDeadlineExpired || !hasTimer) {
        throw new ClassNotOpenError();
      }
      throw new RegyboxTimeoutError(timeoutSeconds, { timeToEnroll });
    }
    const waitSeconds = timeToEnroll > 60 ? 60 : timeToEnroll > 10 ? 10 : 1;
    hasWaited = true;
    await emitTrace({
      level: "info",
      scope: "regybox",
      code: "enrollment_wait",
      message: `Opening in ${timeToEnroll} seconds; retrying in ${waitSeconds} second${waitSeconds === 1 ? "" : "s"}`,
      data: { timerSeconds: timeToEnroll, waitSeconds, remainingSeconds },
    });
    previousTimerSeconds = timeToEnroll;
    await sleep(waitSeconds * 1000);
  }
  await emitTrace({
    level: "error",
    scope: "regybox",
    code: "enrollment_wait_timeout",
    message: `Timed out after waiting ${timeoutSeconds} seconds for enrollment to open`,
    data: { fetchCount: fetches, timeoutSeconds },
  });
  throw new RegyboxTimeoutError(timeoutSeconds);
}
