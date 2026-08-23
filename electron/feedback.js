"use strict";
/**
 * `/feedback` sender (issue #681). Posts to the Solenta endpoint from the main
 * process: the renderer never makes a cross-origin call, and the payload can
 * carry the app version and platform, which is what makes a report actionable.
 *
 * The endpoint is `feedback-api/` in this repo.
 */

const { randomUUID } = require("node:crypto");

const ENDPOINT =
  process.env.SOLENTA_FEEDBACK_URL || "https://feedback.solenta.app/api/feedback";

/** Matches the server's cap, so an over-long report fails here with a clear reason. */
const MAX_TEXT = 4000;
const TIMEOUT_MS = 15000;

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeFeedback(value) {
  return typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "";
}

/**
 * POST the report. Rejects with a sentence the composer can show as-is.
 *
 * @param {{text: string, version?: string, platform?: string}} input
 * @param {{fetch?: typeof fetch}} [deps] injectable for tests
 * @returns {Promise<void>}
 */
async function sendFeedback(input, deps = {}) {
  const text = normalizeFeedback(input && input.text);
  if (!text) throw new Error("Feedback is empty");

  const doFetch = deps.fetch || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        version: input.version || "",
        platform: input.platform || "",
      }),
      signal: controller.signal,
    });
  } catch {
    // Offline, DNS, TLS, timeout — all the same to the person typing.
    throw new Error("Could not reach Solenta. Check your connection.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The endpoint's own message is already user-facing; fall back on status.
    let message = "";
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      // Non-JSON error page.
    }
    throw new Error(message || `Feedback was rejected (${res.status})`);
  }
}

/**
 * Confirmation in the transcript where the person typed it, so the send is
 * visible without a toast that disappears.
 *
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {string} text
 */
function appendFeedbackEvent(store, threadId, text) {
  if (!threadId || !store.getThread(threadId)) return;
  store.appendMessage(threadId, {
    id: randomUUID(),
    role: "event",
    text,
    createdAt: Date.now(),
  });
}

module.exports = {
  ENDPOINT,
  MAX_TEXT,
  normalizeFeedback,
  sendFeedback,
  appendFeedbackEvent,
};
