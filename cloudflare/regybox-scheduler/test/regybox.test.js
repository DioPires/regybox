import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BookingRejectedError,
  CancellationClosedError,
  ClassBlockedError,
  ClassIsOverbookedError,
  ClassNotFoundError,
  LOGIN_REJECTED_KEY,
  NoClassesFoundError,
  RegyboxLoginError,
  SESSION_KEY,
  UnparseableError,
  createCookieJar,
  createRegyboxClient,
  parseCapacity,
  parseClasses,
  parseLoginForm,
  pickClass,
  pickFirstClass,
  runOperation,
  sampleClasses,
  zonedEpochMs,
} from "../src/regybox.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const LOGIN_FORM_URL =
  "https://www.regibox.pt/php8/app3/pwa/999999/pages/login/login.php?id_box=180&pwa=999999&lang=pt&v=";
const LOGGED_OUT =
  '<script type="text/javascript">window.location.replace("/php8/app3/pwa//pages/login/index.php?type=direct&lang=en&id_box=&pwa=");</script>';
const CLASS_DATE = "2026-11-27";
// Lisbon is on UTC in November, so 06:30 local is 06:30Z.
const CLASS_START_MS = Date.parse("2026-11-27T06:30:00Z");
const OPENS_MS = CLASS_START_MS - 48 * 3_600_000;

async function loginForm() {
  // Captured from Regybox's app3 login page with session tokens replaced.
  return readFile(join(testDirectory, "fixtures", "app3_login_form.html"), "utf8");
}

function card({
  id = 101,
  name = "WOD",
  start = "06:30",
  end = "07:30",
  booked = 5,
  capacity = 16,
  info = "",
  timer,
  abre,
  action,
}) {
  const timerHtml =
    timer === undefined
      ? ""
      : `<input type="hidden" class="timers" id="timer${id}"${abre === undefined ? "" : ` data-abre="${abre}"`} value="${timer}">`;
  const buttons = {
    book: `<button class="button buts_inscrever but_insc${id}" onclick="inscreve_aula('pages/classes/scripts/book_classes.php?id_aula=${id}&amp;plano=0&amp;acs=aa${id}&amp;x=bb${id}')">RESERVAR</button>`,
    cancel: `<button class="button buts_inscrever but_insc${id}" onclick="cancela_aula('pages/classes/scripts/cancel_class.php?id_aula=${id}&amp;acs=cc${id}&amp;x=dd${id}')">CANCELAR</button>`,
    evil: `<button class="button buts_inscrever" onclick="go('https://evil.example/php8/app3/pages/classes/scripts/book_classes.php?id_aula=${id}')">RESERVAR</button>`,
  };
  return `<div class="filtro0" id="feed_time_slot1764225000">
    <div class="row"><div class="col a_nome_aula">${name}</div><div class="col a_hora">${start} - ${end}</div></div>
    <div class="a_insc">${booked} de ${capacity}</div>
    <div class="a_info">${info}</div>
    ${timerHtml}${action ? buttons[action] : ""}
  </div>`;
}

function page(...cards) {
  return `<div class="list">${cards.join("\n")}</div>`;
}

function makeKv(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    puts: [],
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, options) {
      this.puts.push({ key, value, options });
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

/** A fake Regybox app3 server that tracks sessions by PHPSESSID. */
function fakeRegibox({
  pages = {},
  actions = {},
  loginResponse = { action: "verifica_acesso_fun", id: "180", pwa: "180", v: "" },
  validSessions = [],
} = {}) {
  const requests = [];
  const sessions = new Set(validSessions);
  let issued = 0;
  const pageFor = (date) => {
    const value = pages[date];
    return typeof value === "function" ? value() : value ?? "";
  };
  async function fetchImpl(href, options) {
    const url = new URL(href);
    requests.push({ url, options });
    const cookie = options.headers.Cookie ?? "";
    const session = cookie.match(/PHPSESSID=([^;]+)/)?.[1];
    const headers = new Headers();
    if (url.pathname.endsWith("/pages/login/index.php")) {
      issued += 1;
      headers.append("set-cookie", `PHPSESSID=fresh${issued}; path=/`);
      return new Response("<html>login shell</html>", { headers });
    }
    if (url.pathname.endsWith("/pages/login/login.php")) {
      return new Response(session ? await loginForm() : (await loginForm()).replace("csrf-test-token", ""));
    }
    if (url.pathname.endsWith("/pages/login/scripts/verifica_acesso.php")) {
      if (loginResponse.action === "verifica_acesso_fun") {
        sessions.add(session);
      }
      return Response.json(loginResponse);
    }
    if (url.pathname === "/php8/app3/pwa/180/") {
      return new Response(sessions.has(session) ? "<html>app</html>" : LOGGED_OUT);
    }
    if (!sessions.has(session)) {
      return new Response(LOGGED_OUT);
    }
    if (url.pathname === "/php8/app3/pages/classes/classes_list.php") {
      return new Response(pageFor(url.searchParams.get("date")));
    }
    const action = url.pathname.split("/").pop();
    const handler = actions[action];
    if (handler) {
      return Response.json(handler(url));
    }
    return new Response("not found", { status: 404 });
  }
  return { fetchImpl, requests, sessions, expire: () => sessions.clear() };
}

function clock(startMs) {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

function client(server, options = {}) {
  return createRegyboxClient({
    email: "member@example.test",
    password: "s3cret-pass",
    fetchImpl: server.fetchImpl,
    retryTotal: 0,
    sleep: async () => {},
    ...options,
  });
}

test("parseCapacity accepts digits and infinity", () => {
  assert.equal(parseCapacity("12"), 12);
  assert.equal(parseCapacity("∞"), null);
  assert.throws(() => parseCapacity("x"), UnparseableError);
});

test("zonedEpochMs handles Lisbon winter and summer time", () => {
  assert.equal(zonedEpochMs("2026-11-27", "06:30", "Europe/Lisbon"), Date.parse("2026-11-27T06:30:00Z"));
  assert.equal(zonedEpochMs("2026-07-15", "06:30", "Europe/Lisbon"), Date.parse("2026-07-15T05:30:00Z"));
});

test("the real app3 login form yields its hidden fields and obfuscated credential names", async () => {
  const form = parseLoginForm(await loginForm(), LOGIN_FORM_URL);
  assert.equal(
    form.action,
    "https://www.regibox.pt/php8/app3/pwa/999999/pages/login/scripts/verifica_acesso.php?pwa=999999&id_box=180&pwa=999999&v=",
  );
  assert.equal(form.emailField, "login5f3a91c");
  assert.equal(form.passwordField, "password5f3a91c");
  assert.deepEqual(
    [...form.fields.keys()],
    ["csrf_token", "id_box", "login", "pwa", "lingua", "acs", "v", "login5f3a91c", "password5f3a91c"],
  );
  assert.equal(form.fields.get("csrf_token"), "csrf-test-token");
  assert.equal(form.fields.get("id_box"), "180");
});

test("a login form without a CSRF token is refused before posting credentials", async () => {
  const html = (await loginForm()).replace("csrf-test-token", "");
  assert.throws(() => parseLoginForm(html, LOGIN_FORM_URL), /CSRF/);
});

test("the cookie jar keeps, replaces and expires cookies", () => {
  const jar = createCookieJar();
  jar.update(new Headers([["set-cookie", "PHPSESSID=one; path=/"]]));
  assert.equal(jar.header(), "PHPSESSID=one");
  jar.update(new Headers([["set-cookie", "PHPSESSID=two; path=/"], ["set-cookie", "lang=pt"]]));
  assert.equal(jar.header(), "PHPSESSID=two; lang=pt");
  jar.update(new Headers([["set-cookie", "lang=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT"]]));
  assert.equal(jar.header(), "PHPSESSID=two");
});

test("the client signs in with the form fields, then reuses the session for class lists", async () => {
  const server = fakeRegibox({ pages: { [CLASS_DATE]: page(card({ action: "book" })) } });
  const kv = makeKv();
  const regybox = client(server, { kv, versionId: "v1" });
  const html = await regybox.fetchClassesHtml(CLASS_DATE);
  assert.match(html, /a_nome_aula/);
  const paths = server.requests.map(({ url }) => url.pathname.replace("/php8/app3/", ""));
  assert.deepEqual(paths, [
    "pwa/999999/pages/login/index.php",
    "pwa/999999/pages/login/login.php",
    "pwa/999999/pages/login/scripts/verifica_acesso.php",
    "pwa/180/",
    "pages/classes/classes_list.php",
  ]);
  assert.equal(server.requests[0].options.headers.Cookie, undefined);
  assert.equal(server.requests[1].options.headers.Cookie, "PHPSESSID=fresh1");
  const post = server.requests[2].options;
  assert.equal(post.method, "POST");
  assert.equal(post.headers["Content-Type"], "application/x-www-form-urlencoded");
  const body = new URLSearchParams(post.body);
  assert.equal(body.get("csrf_token"), "csrf-test-token");
  assert.equal(body.get("acs"), "acs-test-token");
  assert.equal(body.get("login5f3a91c"), "member@example.test");
  assert.equal(body.get("password5f3a91c"), "s3cret-pass");
  assert.equal(body.has("but_dados"), false);
  assert.equal(server.requests[4].url.searchParams.get("date"), CLASS_DATE);
  const saved = JSON.parse(kv.store.get(SESSION_KEY));
  assert.deepEqual(saved.cookies, { PHPSESSID: "fresh1" });
  assert.equal(saved.versionId, "v1");
  assert.ok(!kv.store.get(SESSION_KEY).includes("s3cret-pass"));
  assert.ok(!kv.store.get(SESSION_KEY).includes("member@example.test"));

  // A later run (new client) reuses the saved session without signing in.
  server.requests.length = 0;
  await client(server, { kv, versionId: "v1" }).fetchClassesHtml(CLASS_DATE);
  assert.deepEqual(server.requests.map(({ url }) => url.pathname), ["/php8/app3/pages/classes/classes_list.php"]);
  assert.equal(server.requests[0].options.headers.Cookie, "PHPSESSID=fresh1");
});

test("an ended session signs in again and retries the request once", async () => {
  const server = fakeRegibox({ pages: { [CLASS_DATE]: page(card({})) } });
  const kv = makeKv({
    [SESSION_KEY]: JSON.stringify({ cookies: { PHPSESSID: "stale" }, versionId: null }),
  });
  const traces = [];
  const html = await client(server, { kv, onTrace: async (event) => traces.push(event.code) }).fetchClassesHtml(
    CLASS_DATE,
  );
  assert.match(html, /a_nome_aula/);
  assert.equal(server.requests[0].options.headers.Cookie, "PHPSESSID=stale");
  assert.ok(traces.includes("regybox_session_expired"));
  assert.ok(traces.includes("regybox_login_succeeded"));
  assert.deepEqual(JSON.parse(kv.store.get(SESSION_KEY)).cookies, { PHPSESSID: "fresh1" });
});

test("a session saved by another Worker version is not reused", async () => {
  const server = fakeRegibox({ pages: { [CLASS_DATE]: page(card({})) }, validSessions: ["old"] });
  const kv = makeKv({ [SESSION_KEY]: JSON.stringify({ cookies: { PHPSESSID: "old" }, versionId: "v1" }) });
  await client(server, { kv, versionId: "v2" }).fetchClassesHtml(CLASS_DATE);
  assert.equal(server.requests[0].url.pathname, "/php8/app3/pwa/999999/pages/login/index.php");
});

test("a rejected password pauses sign-in until the Worker version changes", async () => {
  const server = fakeRegibox({
    loginResponse: { toast: { text: "Acesso negado", icon: "info" }, action: "login_falhou" },
  });
  const kv = makeKv();
  await assert.rejects(
    () => client(server, { kv, versionId: "v1" }).fetchClassesHtml(CLASS_DATE),
    (error) => error instanceof RegyboxLoginError && error.reason === "rejected",
  );
  const guard = kv.puts.find(({ key }) => key === LOGIN_REJECTED_KEY);
  assert.equal(guard.options.expirationTtl, 12 * 60 * 60);
  assert.ok(!guard.value.includes("s3cret-pass"));

  server.requests.length = 0;
  await assert.rejects(
    () => client(server, { kv, versionId: "v1" }).fetchClassesHtml(CLASS_DATE),
    (error) => error instanceof RegyboxLoginError && error.reason === "rejected_recently",
  );
  assert.equal(server.requests.length, 0, "no sign-in attempt while paused");

  await assert.rejects(
    () => client(server, { kv, versionId: "v2" }).fetchClassesHtml(CLASS_DATE),
    (error) => error.reason === "rejected",
  );
  assert.ok(server.requests.length > 0, "a new version (changed secret) tries again");
});

test("a successful sign-in clears an old rejection", async () => {
  const server = fakeRegibox({ pages: { [CLASS_DATE]: page(card({})) } });
  const kv = makeKv({ [LOGIN_REJECTED_KEY]: JSON.stringify({ at: "x", versionId: "v1" }) });
  await client(server, { kv, versionId: "v2" }).fetchClassesHtml(CLASS_DATE);
  assert.equal(kv.store.has(LOGIN_REJECTED_KEY), false);
});

test("an unexpected sign-in answer is a login error carrying Regybox's message", async () => {
  const server = fakeRegibox({ loginResponse: { toast: { text: "Token CSRF inválido" } } });
  await assert.rejects(
    () => client(server).fetchClassesHtml(CLASS_DATE),
    (error) => error instanceof RegyboxLoginError && error.reason === "unexpected" && /CSRF/.test(error.message),
  );
});

test("missing credentials fail before any request", () => {
  assert.throws(
    () => createRegyboxClient({ email: "", password: "x", fetchImpl: () => assert.fail("no fetch") }),
    (error) => error instanceof RegyboxLoginError && error.reason === "missing_credentials",
  );
});

test("class cards parse into booking state", () => {
  const now = OPENS_MS + 60_000;
  const html = page(
    card({ id: 1, name: "WOD", start: "06:30", action: "book", timer: 172000, abre: "0" }),
    card({ id: 2, name: "OPEN BOX", start: "08:30", end: "10:00", info: "Reserva confirmada", action: "cancel" }),
    card({ id: 3, name: "MAT", start: "12:00", info: "Limite diário por tipo" }),
    card({ id: 4, name: "EMOM CLUB", start: "20:15", end: "21:00", timer: 3600, abre: "1" }),
    card({ id: 5, name: "WOD", start: "19:00", end: "20:00", booked: 16, capacity: 16 }),
    card({ id: 6, name: "WEIGHTLIFTING", start: "17:00", info: "Lista de espera", action: "cancel" }),
  );
  const [open, booked, blocked, waiting, full, waitlisted] = parseClasses(html, { date: CLASS_DATE, now });
  assert.equal(open.isOpen, true);
  assert.match(open.enrollUrl, /^https:\/\/www\.regibox\.pt\/php8\/app3\/pages\/classes\/scripts\/book_classes\.php\?id_aula=1&plano=0&acs=aa1&x=bb1$/);
  assert.equal(open.timeToEnroll, null);
  assert.equal(open.curCapacity, 5);
  assert.equal(open.maxCapacity, 16);
  assert.equal(open.startsAt, "2026-11-27T06:30:00+00:00");

  assert.equal(booked.userIsEnrolled, true);
  assert.match(booked.unenrollUrl, /cancel_class\.php\?id_aula=2&acs=cc2&x=dd2$/);
  assert.equal(booked.cancelDeadlineMs, Date.parse("2026-11-27T00:30:00Z"));

  assert.equal(blocked.userIsBlocked, true);
  assert.equal(blocked.blockedReason, "Limite diário por tipo");

  assert.equal(waiting.isOpen, false);
  assert.equal(waiting.timeToEnroll, 3600);

  assert.equal(full.isFull, true);
  assert.equal(full.isOverbooked, true);

  assert.equal(waitlisted.userIsWaitlisted, true);
  assert.equal(waitlisted.userIsEnrolled, false);
});

test("a closed class without a countdown falls back to the 48-hour opening", () => {
  const now = OPENS_MS - 600_000;
  const [selected] = parseClasses(page(card({})), { date: CLASS_DATE, now });
  assert.equal(selected.timeToEnroll, 600);
});

test("class actions pointing anywhere but Regybox app3 are rejected", () => {
  assert.throws(
    () => parseClasses(page(card({ action: "evil" })), { date: CLASS_DATE, now: OPENS_MS }),
    UnparseableError,
  );
});

test("a card missing its name or time is unparseable", () => {
  assert.throws(
    () => parseClasses('<div class="filtro0"><div class="a_hora">06:30 - 07:30</div></div>', { date: CLASS_DATE }),
    UnparseableError,
  );
});

test("pickClass and pickFirstClass match name, time and date", () => {
  const classes = parseClasses(page(card({ name: "WOD" }), card({ id: 2, name: "OPEN BOX" })), {
    date: CLASS_DATE,
    now: OPENS_MS,
  });
  assert.equal(pickClass(classes, { classTime: "06:30", classType: "wod", classDate: CLASS_DATE }).name, "WOD");
  assert.equal(
    pickFirstClass(classes, { classTime: "06:30", classTypes: "MAT, OPEN BOX", classDate: CLASS_DATE }).name,
    "OPEN BOX",
  );
  assert.throws(() => pickClass(classes, { classTime: "07:30", classType: "WOD", classDate: CLASS_DATE }), ClassNotFoundError);
});

function bookingServer({ opensAtMs, time, bookResponses = [], afterBook = "booked", startPage } = {}) {
  let booked = false;
  let calls = 0;
  const bookUrls = [];
  const server = fakeRegibox({
    pages: {
      [CLASS_DATE]: () => {
        if (booked) {
          return page(
            afterBook === "booked"
              ? card({ info: "Reserva confirmada", action: "cancel" })
              : afterBook === "waitlist"
                ? card({ info: "Lista de espera", action: "cancel" })
                : card({ action: "book" }),
          );
        }
        if (startPage) {
          return startPage;
        }
        return time.now() >= opensAtMs
          ? page(card({ action: "book" }))
          : page(card({ timer: Math.round((opensAtMs - time.now()) / 1000), abre: "1" }));
      },
    },
    actions: {
      "book_classes.php": (url) => {
        bookUrls.push(url.href);
        const response = bookResponses[calls] ?? { success: true, message: "Reservado com sucesso" };
        calls += 1;
        if (response.success) {
          booked = true;
        }
        return response;
      },
      "cancel_class.php": () => ({ success: true, message: "Cancelado" }),
    },
  });
  return { server, bookUrls };
}

test("enroll waits for the opening countdown, books, and verifies the class list", async () => {
  const time = clock(OPENS_MS - 125_000);
  const { server, bookUrls } = bookingServer({ opensAtMs: OPENS_MS, time });
  const traces = [];
  const result = await runOperation({
    client: client(server, { now: time.now }),
    classDate: CLASS_DATE,
    classTime: "06:30",
    classType: "WOD",
    now: time.now,
    sleep: time.sleep,
    timeoutSeconds: 600,
    onTrace: async (event) => traces.push(event.code),
  });
  assert.equal(result.status, "success");
  assert.equal(result.classType, "WOD");
  assert.match(result.note, /delete the calendar event before Thu 26 Nov, 22:30/);
  assert.equal(bookUrls.length, 1);
  assert.ok(time.now() >= OPENS_MS);
  assert.ok(time.now() - OPENS_MS < 2_000, "books within a second or two of opening");
  assert.ok(traces.includes("enrollment_wait"));
  assert.ok(traces.includes("enrollment_success"));
});

test("enroll returns not_open with the opening time when it is beyond this run", async () => {
  const time = clock(OPENS_MS - 3 * 3_600_000);
  const { server } = bookingServer({ opensAtMs: OPENS_MS, time });
  const result = await runOperation({
    client: client(server, { now: time.now }),
    classDate: CLASS_DATE,
    classTime: "06:30",
    classType: "WOD",
    now: time.now,
    sleep: time.sleep,
    timeoutSeconds: 600,
    notOpenIsNoop: true,
  });
  assert.equal(result.status, "noop");
  assert.equal(result.cacheState, "not_open");
  assert.equal(result.enrollmentOpensAt, "2026-11-25T06:30:00+00:00");
});

test("a booking inside the no-cancel window is confirmed and flagged", async () => {
  const time = clock(CLASS_START_MS - 2 * 3_600_000);
  const { server, bookUrls } = bookingServer({
    opensAtMs: OPENS_MS,
    time,
    bookResponses: [{ success: false, conf: "s", message: "Não poderá cancelar" }],
  });
  const result = await runOperation({
    client: client(server, { now: time.now }),
    classDate: CLASS_DATE,
    classTime: "06:30",
    classType: "WOD",
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(result.status, "success");
  assert.equal(result.cannotCancel, true);
  assert.match(result.note, /will not let you cancel/);
  assert.equal(bookUrls.length, 2);
  assert.equal(new URL(bookUrls[1]).searchParams.get("conf"), "ok");
});

test("a refused booking surfaces Regybox's message", async () => {
  const time = clock(OPENS_MS + 1_000);
  const { server } = bookingServer({
    opensAtMs: OPENS_MS,
    time,
    bookResponses: [{ success: false, message: "Não tens créditos disponíveis" }],
  });
  await assert.rejects(
    () =>
      runOperation({
        client: client(server, { now: time.now }),
        classDate: CLASS_DATE,
        classTime: "06:30",
        classType: "WOD",
        now: time.now,
        sleep: time.sleep,
      }),
    (error) => error instanceof BookingRejectedError && /créditos/.test(error.message),
  );
});

test("a full class with a waitlist offer is reported as full", async () => {
  const time = clock(OPENS_MS + 1_000);
  const { server } = bookingServer({
    opensAtMs: OPENS_MS,
    time,
    bookResponses: [{ success: false, message: "Aula lotada", wait_url: "pages/classes/scripts/wait.php" }],
  });
  await assert.rejects(
    () =>
      runOperation({
        client: client(server, { now: time.now }),
        classDate: CLASS_DATE,
        classTime: "06:30",
        classType: "WOD",
        now: time.now,
        sleep: time.sleep,
      }),
    ClassIsOverbookedError,
  );
});

test("a booking the class list does not confirm is not reported as success", async () => {
  const time = clock(OPENS_MS + 1_000);
  const { server } = bookingServer({ opensAtMs: OPENS_MS, time, afterBook: "unchanged" });
  await assert.rejects(
    () =>
      runOperation({
        client: client(server, { now: time.now }),
        classDate: CLASS_DATE,
        classTime: "06:30",
        classType: "WOD",
        now: time.now,
        sleep: time.sleep,
      }),
    /class list does not show it/,
  );
});

test("a daily-limit class is reported as blocked instead of retried silently", async () => {
  const time = clock(OPENS_MS + 1_000);
  const { server } = bookingServer({ time, startPage: page(card({ info: "Limite diário por tipo" })) });
  await assert.rejects(
    () =>
      runOperation({
        client: client(server, { now: time.now }),
        classDate: CLASS_DATE,
        classTime: "06:30",
        classType: "WOD",
        now: time.now,
        sleep: time.sleep,
        notOpenIsNoop: true,
      }),
    (error) => error instanceof ClassBlockedError && error.reason === "Limite diário por tipo",
  );
});

test("an opened class with no booking button is reported, not ignored", async () => {
  const time = clock(OPENS_MS + 60_000);
  const { server } = bookingServer({ time, startPage: page(card({ info: "" })) });
  await assert.rejects(
    () =>
      runOperation({
        client: client(server, { now: time.now }),
        classDate: CLASS_DATE,
        classTime: "06:30",
        classType: "WOD",
        now: time.now,
        sleep: time.sleep,
        notOpenIsNoop: true,
      }),
    ClassBlockedError,
  );
});

test("enroll is a noop when the class is already booked", async () => {
  const time = clock(OPENS_MS + 1_000);
  const { server, bookUrls } = bookingServer({
    time,
    startPage: page(card({ info: "Reserva confirmada", action: "cancel" })),
  });
  const result = await runOperation({
    client: client(server, { now: time.now }),
    classDate: CLASS_DATE,
    classTime: "06:30",
    classType: "WOD",
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(result.status, "noop");
  assert.equal(bookUrls.length, 0);
});

test("unenroll cancels a booked class before the cutoff", async () => {
  const time = clock(CLASS_START_MS - 9 * 3_600_000);
  const { server } = bookingServer({
    time,
    startPage: page(card({ info: "Reserva confirmada", action: "cancel" })),
  });
  const result = await runOperation({
    client: client(server, { now: time.now }),
    operation: "unenroll",
    classDate: CLASS_DATE,
    classTime: "06:30",
    classType: "WOD",
    now: time.now,
  });
  assert.equal(result.status, "success");
  assert.ok(server.requests.some(({ url }) => url.pathname.endsWith("/cancel_class.php")));
});

test("unenroll after the cutoff raises CancellationClosedError without calling Regybox", async () => {
  const time = clock(CLASS_START_MS - 2 * 3_600_000);
  const { server } = bookingServer({ time, startPage: page(card({ info: "Reserva confirmada" })) });
  await assert.rejects(
    () =>
      runOperation({
        client: client(server, { now: time.now }),
        operation: "unenroll",
        classDate: CLASS_DATE,
        classTime: "06:30",
        classType: "WOD",
        now: time.now,
      }),
    (error) =>
      error instanceof CancellationClosedError &&
      error.cutoffHours === 8 &&
      error.cancelDeadline === "Thu 26 Nov, 22:30",
  );
  assert.equal(server.requests.some(({ url }) => url.pathname.endsWith("/cancel_class.php")), false);
});

test("a cancellation Regybox refuses for its deadline becomes CancellationClosedError", async () => {
  const time = clock(CLASS_START_MS - 9 * 3_600_000);
  const server = fakeRegibox({
    pages: { [CLASS_DATE]: page(card({ info: "Reserva confirmada", action: "cancel" })) },
    actions: { "cancel_class.php": () => ({ success: false, message: "Já não é possível cancelar" }) },
  });
  await assert.rejects(
    () =>
      runOperation({
        client: client(server, { now: time.now }),
        operation: "unenroll",
        classDate: CLASS_DATE,
        classTime: "06:30",
        classType: "WOD",
        now: time.now,
      }),
    (error) => error instanceof CancellationClosedError && /Já não é possível/.test(error.message),
  );
});

test("unenroll is a noop when the class is not booked", async () => {
  const time = clock(CLASS_START_MS - 20 * 3_600_000);
  const { server } = bookingServer({ time, startPage: page(card({ action: "book" })) });
  const result = await runOperation({
    client: client(server, { now: time.now }),
    operation: "unenroll",
    classDate: CLASS_DATE,
    classTime: "06:30",
    classType: "WOD",
    now: time.now,
  });
  assert.equal(result.status, "noop");
});

test("an empty class list is retried, then reported", async () => {
  const time = clock(OPENS_MS);
  const server = fakeRegibox({ pages: { [CLASS_DATE]: "<div></div>" } });
  await assert.rejects(
    () =>
      runOperation({
        client: client(server, { now: time.now }),
        classDate: CLASS_DATE,
        classTime: "06:30",
        classType: "WOD",
        now: time.now,
        sleep: time.sleep,
      }),
    NoClassesFoundError,
  );
  const listFetches = server.requests.filter(({ url }) => url.pathname.endsWith("/classes_list.php"));
  assert.equal(listFetches.length, 4);
});

test("transient HTTP errors are retried with backoff", async () => {
  const server = fakeRegibox({ pages: { [CLASS_DATE]: page(card({})) } });
  let failures = 2;
  const sleeps = [];
  const regybox = createRegyboxClient({
    email: "member@example.test",
    password: "s3cret-pass",
    retryTotal: 3,
    retryBackoffMs: 5,
    sleep: async (ms) => sleeps.push(ms),
    fetchImpl: async (url, options) => {
      if (failures > 0) {
        failures -= 1;
        return new Response("busy", { status: 503 });
      }
      return server.fetchImpl(url, options);
    },
  });
  await regybox.fetchClassesHtml(CLASS_DATE);
  assert.deepEqual(sleeps, [5, 10]);
});

test("only cards that can match the requested time are parsed, with the same result", async () => {
  const time = clock(OPENS_MS + 1_000);
  let booked = false;
  const server = fakeRegibox({
    pages: {
      [CLASS_DATE]: () =>
        page(
          card({ id: 1, name: "WOD", start: "06:30", action: "book" }),
          card({ id: 2, name: "OPEN BOX", start: "08:30", end: "10:00" }),
          booked
            ? card({ id: 3, name: "WOD", start: "12:00", end: "13:00", info: "Reserva confirmada", action: "cancel" })
            : card({ id: 3, name: "WOD", start: "12:00", end: "13:00", action: "book" }),
        ),
    },
    actions: {
      "book_classes.php": () => {
        booked = true;
        return { success: true, message: "Reservado com sucesso" };
      },
    },
  });
  const result = await runOperation({
    client: client(server, { now: time.now }),
    classDate: CLASS_DATE,
    classTime: "12:00",
    classType: "WOD",
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(result.status, "success");
  const booking = server.requests.find(({ url }) => url.pathname.endsWith("/book_classes.php"));
  assert.equal(booking.url.searchParams.get("id_aula"), "3");
});

test("sampleClasses counts every card and parses only the first few", () => {
  const html = page(...Array.from({ length: 6 }, (_, index) => card({ id: index, start: `${10 + index}:00`, end: "23:00" })));
  const { total, sample } = sampleClasses(html, { date: CLASS_DATE, now: OPENS_MS, limit: 2 });
  assert.equal(total, 6);
  assert.deepEqual(sample.map(({ start }) => start), ["10:00", "11:00"]);
});
