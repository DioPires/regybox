const fallbackPayload = {
  errorCode: "unexpected_failure",
  userTitle: "Unexpected enrollment failure",
  userMessage: "The enrollment failed with an unexpected error.",
  userNextSteps: [
    "Retry the workflow once.",
    "If it fails again, share the technical details with support.",
  ],
};

const typedPayloads = {
  RegyboxLoginError: {
    errorCode: "login_error",
    userTitle: "Unable to log in to Regybox",
    userMessage: "The bot could not sign in to Regybox, so it could not reach your account.",
    userNextSteps: [
      "Open the status page: it shows whether Regybox rejected the email or password.",
      "If your password changed, update REGIBOX_EMAIL or REGIBOX_PASSWORD under Settings → Variables and Secrets.",
      "After a rejected password the bot waits until a secret changes (or 12 hours pass) before trying again, so it cannot lock your account.",
    ],
  },
  ClassBlockedError: {
    errorCode: "class_blocked",
    userTitle: "Regybox won't let you book this class",
    userMessage: "Regybox lists the class but does not offer a booking button for it.",
    userNextSteps: [
      "Open the class in the Regybox app to see why.",
      "Common reasons: one class per type per day, a time clash with another booking, or no weekly credits left.",
      "The bot keeps checking, so it books the class if the restriction goes away before class starts.",
    ],
  },
  BookingRejectedError: {
    errorCode: "booking_rejected",
    userTitle: "Regybox refused the booking change",
    userMessage: "Regybox answered the request but did not make the change.",
    userNextSteps: [
      "Read Regybox's message in the technical details below.",
      "Check the class in the Regybox app.",
    ],
  },
  CancellationClosedError: {
    errorCode: "cancellation_closed",
    userTitle: "Too late to cancel this class",
    userMessage:
      "The calendar event was removed, but Regybox only allows cancelling until 8 hours before class, so the booking is still active.",
    userNextSteps: [
      "Open the Regybox app and cancel there if it still lets you, or go to the class.",
      "Next time, delete the calendar event at least 8 hours before class.",
    ],
  },
  ClassNotFoundError: {
    errorCode: "class_not_found",
    userTitle: "Requested class was not found",
    userMessage: "No matching class was found for the requested date and time.",
    userNextSteps: [
      "Check the class name and time in your workflow configuration.",
      "Confirm the class exists in Regybox for that date.",
      "Retry the workflow.",
    ],
  },
  NoClassesFoundError: {
    errorCode: "no_classes_found",
    userTitle: "No classes found for the selected date",
    userMessage: "Regybox did not list any classes for the selected date.",
    userNextSteps: [
      "Check if the gym has published that day's schedule.",
      "Confirm the selected date offset is correct in the workflow.",
      "Retry later when classes are available.",
    ],
  },
  ClassNotOpenError: {
    errorCode: "class_not_open",
    userTitle: "Enrollment is not open yet",
    userMessage: "The class exists, but enrollment is still closed.",
    userNextSteps: [
      "Wait until enrollment opens and run the workflow again.",
      "Start the workflow closer to the enrollment opening time.",
    ],
  },
  ClassIsOverbookedError: {
    errorCode: "class_overbooked",
    userTitle: "Class and waitlist are full",
    userMessage: "The class is overbooked, so no additional spots are available.",
    userNextSteps: [
      "Try a different class time.",
      "Retry later in case a spot becomes available.",
    ],
  },
  RegyboxTimeoutError: {
    errorCode: "timeout_waiting_for_enrollment",
    userTitle: "Timed out waiting for enrollment",
    userMessage: "The workflow waited too long and enrollment never opened.",
    userNextSteps: [
      "Start the workflow closer to the opening time for enrollment.",
      "Increase timeout-seconds if your schedule requires a longer wait.",
      "Retry the workflow.",
    ],
  },
  UnparseableError: {
    errorCode: "unparseable_response",
    userTitle: "Regybox returned an unexpected response",
    userMessage:
      "The website answered, but its response format was different from what the automation expects.",
    userNextSteps: [
      "Retry once in case this was temporary.",
      "If it keeps failing, share the technical details with support.",
    ],
  },
};

const bookrPayloads = {
  BookrLoginError: {
    errorCode: "login_error",
    userTitle: "Unable to log in to Bookr.fit",
    userMessage:
      "The saved Bookr.fit login session was rejected, so the automation could not access your account.",
    userNextSteps: [
      "Sign in to bookr.fit and copy every sb-…-auth-token cookie chunk.",
      "Update BOOKR_AUTH_COOKIE under Settings → Variables and Secrets.",
      "Refresh the status page and run the scheduler again.",
    ],
  },
  BookrAuthError: {
    errorCode: "login_error",
    userTitle: "Unable to log in to Bookr.fit",
    userMessage:
      "The saved Bookr.fit login session was rejected, so the automation could not access your account.",
    userNextSteps: [
      "Sign in to bookr.fit and copy every sb-…-auth-token cookie chunk.",
      "Update BOOKR_AUTH_COOKIE under Settings → Variables and Secrets.",
      "Refresh the status page and run the scheduler again.",
    ],
  },
  BookrRefreshError: {
    errorCode: "session_refresh_failed",
    userTitle: "Bookr.fit session refresh was unavailable",
    userMessage:
      "Bookr.fit could not refresh the saved session right now, so the scheduler did not change your saved cookie.",
    userNextSteps: [
      "Retry the scheduler later; this may be a temporary Bookr.fit or authentication-service failure.",
      "Keep BOOKR_AUTH_COOKIE unchanged unless a later run reports that Bookr.fit rejected the session.",
    ],
  },
  BookrSubscriptionError: {
    errorCode: "subscription_error",
    userTitle: "No active Bookr.fit subscription",
    userMessage: "Bookr.fit did not provide an active subscription for this account.",
    userNextSteps: [
      "Check that your Bookr.fit membership is active.",
      "Refresh the status page and retry the workflow.",
    ],
  },
  BookrBookingError: {
    errorCode: "booking_restricted",
    userTitle: "Bookr.fit rejected the booking change",
    userMessage: "Bookr.fit did not allow the requested enrollment or cancellation.",
    userNextSteps: [
      "Open Bookr.fit and check the class booking or cancellation restrictions.",
      "Retry only after the current booking state is clear.",
    ],
  },
  BookrClassNotFoundError: {
    errorCode: "class_not_found",
    userTitle: "Requested class was not found",
    userMessage: "No matching class was found in Bookr.fit for the requested date and time.",
    userNextSteps: [
      "Check the class name and time in your calendar configuration.",
      "Confirm the class exists in Bookr.fit for that date.",
      "Retry the workflow.",
    ],
  },
  ClassNotFoundError: {
    errorCode: "class_not_found",
    userTitle: "Requested class was not found",
    userMessage: "No matching class was found in Bookr.fit for the requested date and time.",
    userNextSteps: [
      "Check the class name and time in your calendar configuration.",
      "Confirm the class exists in Bookr.fit for that date.",
      "Retry the scheduler.",
    ],
  },
  BookrNotOpenError: {
    errorCode: "class_not_open",
    userTitle: "Enrollment is not open yet",
    userMessage: "The Bookr.fit class exists, but enrollment is still closed.",
    userNextSteps: [
      "Wait until enrollment opens and run the workflow again.",
      "Start the workflow closer to the enrollment opening time.",
    ],
  },
  ClassNotOpenError: {
    errorCode: "class_not_open",
    userTitle: "Enrollment is not open yet",
    userMessage: "The Bookr.fit class exists, but enrollment is still closed.",
    userNextSteps: [
      "Wait until enrollment opens and run the scheduler again.",
      "Schedule the calendar event closer to the enrollment opening time.",
    ],
  },
  BookrOverbookedError: {
    errorCode: "class_overbooked",
    userTitle: "Class and waitlist are full",
    userMessage: "The Bookr.fit class and waitlist are full, so no spot is available.",
    userNextSteps: [
      "Try a different class time.",
      "Retry later in case a spot becomes available.",
    ],
  },
  ClassIsOverbookedError: {
    errorCode: "class_overbooked",
    userTitle: "Class and waitlist are full",
    userMessage: "The Bookr.fit class and waitlist are full, so no spot is available.",
    userNextSteps: [
      "Try a different class time.",
      "Retry later in case a spot becomes available.",
    ],
  },
  RegyboxTimeoutError: {
    errorCode: "timeout_waiting_for_enrollment",
    userTitle: "Timed out waiting for Bookr.fit enrollment",
    userMessage: "The scheduler waited too long and Bookr.fit enrollment never opened.",
    userNextSteps: [
      "Schedule the calendar event closer to the enrollment opening time.",
      "Retry the scheduler.",
    ],
  },
  BookrUnparseableError: {
    errorCode: "unparseable_response",
    userTitle: "Bookr.fit returned an unexpected response",
    userMessage:
      "Bookr.fit answered, but its response format was different from what the automation expects.",
    userNextSteps: [
      "Retry once in case this was temporary.",
      "If it keeps failing, share the technical details with support.",
    ],
  },
  UnparseableError: {
    errorCode: "unparseable_response",
    userTitle: "Bookr.fit returned an unexpected response",
    userMessage:
      "Bookr.fit answered, but its response format was different from what the automation expects.",
    userNextSteps: [
      "Retry once in case this was temporary.",
      "If it keeps failing, share the sanitized technical details with support.",
    ],
  },
  BookrMutationVerificationError: {
    errorCode: "mutation_not_verified",
    userTitle: "Bookr.fit could not confirm the booking change",
    userMessage:
      "Bookr.fit did not confirm whether the requested booking change completed.",
    userNextSteps: [
      "Check your Bookr.fit bookings before trying again.",
      "Retry the workflow once the current booking state is clear.",
    ],
  },
};

const bookrRestrictionMessages = {
  booking_daily_category_limit_exceeded: "The daily class-category booking limit has been reached.",
  booking_overlapping_session: "This class overlaps another Bookr.fit booking.",
  booking_pack_limit_exceeded: "The current membership pack has no booking available for this class.",
  booking_restricted: "Bookr.fit reports that this account cannot book the class.",
  booking_weekly_limit_exceeded: "The weekly booking limit has been reached.",
  booking_window_not_open: "The Bookr.fit booking window is not open yet.",
  cancellation_window_closed: "The Bookr.fit cancellation window has closed.",
  no_show_penalty_active: "A Bookr.fit no-show restriction is currently active.",
  registration_deadline_passed: "The Bookr.fit registration deadline has passed.",
};

function isBookrError(error, platform) {
  return platform === "bookr" || error?.platform === "bookr" || /^Bookr/.test(String(error?.name ?? ""));
}

/**
 * Return a console-safe error description without changing legacy Regybox
 * log output. Bookr responses can contain credentials, URLs, request bodies,
 * and participant identifiers, so their raw message is never logged.
 */
export function safeErrorMessage(error, { platform } = {}) {
  if (!isBookrError(error, platform)) {
    return error?.message ?? String(error ?? "");
  }
  const payload = errorPayload(error, { platform });
  const status = Number.isInteger(error?.status) ? ` HTTP ${error.status}` : "";
  return `Bookr.fit error (${payload.errorCode}${status})`;
}

/** Preserve legacy Error objects for non-Bookr diagnostics while redacting Bookr values. */
export function safeErrorValue(error, { platform } = {}) {
  return isBookrError(error, platform) ? safeErrorMessage(error, { platform }) : error;
}

function sanitizeBookrMessage(value) {
  return String(value ?? "")
    .replace(/\bBOOKR_AUTH_COOKIE\s*[:=]\s*[^\r\n]+/gi, "BOOKR_AUTH_COOKIE=[redacted]")
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, "[redacted credential]")
    .replace(/\b(?:sb-[a-z0-9-]+-auth-token)(?:\.\d+)?\s*=\s*[^;\s]+/gi, "[redacted auth cookie]")
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "[redacted credential]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[redacted id]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function formatDuration(seconds) {
  const totalSeconds = Number(seconds);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return String(seconds);
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = Math.floor(totalSeconds % 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

/**
 * Turn a Regybox client error into the user-facing failure contract used by
 * the composite action's notifications.
 */
export function errorPayload(error, { platform } = {}) {
  const bookr = isBookrError(error, platform);
  const payload = {
    ...(bookr ? (bookrPayloads[error?.name] ?? fallbackPayload) : (typedPayloads[error?.name] ?? fallbackPayload)),
  };
  const message = bookr ? sanitizeBookrMessage(error?.message) : error?.message ?? "";
  if (bookr && error?.name === "BookrBookingError") {
    const reason = String(error?.reason ?? "booking_restricted");
    if (Object.hasOwn(bookrRestrictionMessages, reason)) {
      payload.errorCode = reason;
      payload.userMessage = bookrRestrictionMessages[reason];
    }
  } else if (!bookr && error?.name === "ClassNotFoundError") {
    const match = message.match(/^Unable to find class '(.+)' at (.+) on (.+)$/);
    if (match) {
      const [, classType, classTime, classDate] = match;
      payload.userMessage = `No class matching '${classType}' at ${classTime} was found on ${classDate}.`;
    }
  } else if (!bookr && error?.name === "RegyboxLoginError") {
    const reason = String(error?.reason ?? "");
    if (reason === "rejected" || reason === "rejected_recently") {
      payload.userTitle = "Regybox rejected your email or password";
      payload.userMessage =
        "Regybox said the saved email or password is wrong, so the bot stopped signing in to avoid locking your account.";
    }
  } else if (!bookr && error?.name === "ClassBlockedError" && error?.reason) {
    payload.userMessage = `Regybox lists the class but does not offer booking. It shows: "${String(error.reason).slice(0, 120)}".`;
  } else if (!bookr && error?.name === "CancellationClosedError") {
    const hours = Number(error?.cutoffHours) || 8;
    payload.userMessage =
      `The calendar event was removed, but Regybox only allows cancelling until ${hours} hours before class` +
      `${error?.cancelDeadline ? ` (${error.cancelDeadline})` : ""}, so the booking is still active.`;
  } else if (!bookr && error?.name === "NoClassesFoundError") {
    const match = message.match(/^No classes found on (.+)$/);
    if (match) {
      payload.userMessage = `Regybox did not list any classes on ${match[1]}.`;
    }
  } else if (!bookr && error?.name === "RegyboxTimeoutError") {
    const delayedOpening = message.match(/^Enrollment opens in (.+) seconds, which exceeds (.+) seconds$/);
    const timedOut = message.match(/^Timed out waiting for enrollment to open after (.+) seconds$/);
    if (delayedOpening) {
      const [, openingSeconds, timeoutSeconds] = delayedOpening;
      payload.userTitle = "Enrollment window opens later than expected";
      payload.userMessage = `The class opens in ${formatDuration(openingSeconds)}, but the workflow is configured to wait only ${timeoutSeconds} seconds.`;
    } else if (timedOut) {
      payload.userMessage = `The workflow waited ${timedOut[1]} seconds, but enrollment never opened.`;
    }
  }
  return {
    ...payload,
    technicalMessage: message,
  };
}

/** Build the stable failure-notification identity used by the Python action. */
export function buildFailureFingerprint({ operation, error, platform } = {}) {
  const payload = errorPayload(error, { platform });
  return `failure:${String(operation || "enroll").toLowerCase()}:${payload.errorCode}:${payload.userTitle}`;
}
