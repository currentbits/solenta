"use strict";

const { fmRun } = require("./fm.js");
const { cleanSubject } = require("./commitmsg.js");
const { THREAD_TITLE_MAX } = require("./services.js");

/** Prompt body cap: same idea as commitmsg.PROMPT_PATCH_LIMIT, tighter. */
const TITLE_PROMPT_LIMIT = 4000;

/**
 * First-line title the runner / workflow already stamp onto a still-default
 * thread at run start. Anything else is treated as user-set or already fm.
 *
 * @param {string} text
 * @returns {string}
 */
function autoTitleFromPrompt(text) {
  const firstLine = String(text || "")
    .split(/\r?\n/)[0]
    .trim();
  return firstLine.slice(0, THREAD_TITLE_MAX) || "New Thread";
}

/**
 * True when the current title is the default or the first-prompt-line stamp,
 * i.e. the thread has no title of its own.
 *
 * @param {{ title?: string } | null} thread
 * @param {string} firstUserText
 * @returns {boolean}
 */
function isPlaceholderTitle(thread, firstUserText) {
  const title = thread && thread.title != null ? String(thread.title) : "";
  if (!title || title === "New Thread") return true;
  return title === autoTitleFromPrompt(firstUserText);
}

/**
 * cleanSubject (first line, strip wrapping quotes/backticks) plus a hard cap.
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeTitle(raw) {
  let s = cleanSubject(raw);
  if (!s) return "";
  if (s.endsWith(".")) s = s.slice(0, -1).trim();
  if (s.length > THREAD_TITLE_MAX) s = s.slice(0, THREAD_TITLE_MAX);
  return s;
}

/**
 * @param {string} userText
 * @param {string} [assistantText]
 * @returns {string}
 */
function buildTitlePrompt(userText, assistantText) {
  const user = String(userText || "").slice(0, TITLE_PROMPT_LIMIT);
  const asst = String(assistantText || "").slice(0, TITLE_PROMPT_LIMIT);
  const parts = [
    "Write a title of at most 6 words describing this task.",
    "Reply with ONLY the title: no quotes, no trailing period, no explanation.",
    "",
    "User:",
    user || "(empty)",
  ];
  if (asst) {
    parts.push("", "Assistant:", asst);
  }
  return parts.join("\n");
}

/**
 * After the first assistant reply, ask fm for a short title when the thread
 * still has only the default / first-line stamp. Best-effort: never throws,
 * never overwrites a user-set or already-fm title, runs at most once.
 *
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<string | null>} the saved title, or null when unchanged
 */
async function maybeApplyFmTitle(store, threadId, opts = {}) {
  try {
    const thread = store.getThread(threadId);
    if (!thread || thread.fmTitleAt) return null;

    const msgs = store.getMessages(threadId) || [];
    let userText = "";
    let assistantText = "";
    for (const m of msgs) {
      if (!userText && m && m.role === "user") {
        userText = String(m.text || "");
      } else if (!assistantText && m && m.role === "assistant") {
        assistantText = String(m.text || "");
      }
      if (userText && assistantText) break;
    }
    if (!userText) return null;
    if (!isPlaceholderTitle(thread, userText)) return null;

    const raw = await fmRun(buildTitlePrompt(userText, assistantText), {
      env: opts.env,
    });
    // No marker on failure: fm being absent (every pre-macOS-27 machine, every
    // non-Mac) must not permanently opt the thread out of ever being titled.
    // The cost of retrying is one cached-miss `which` per successful turn.
    if (!raw) return null;

    const title = sanitizeTitle(raw);
    if (!title) return null;

    const latest = store.getThread(threadId);
    if (!latest || latest.fmTitleAt) return null;
    if (!isPlaceholderTitle(latest, userText)) return null;

    store.updateThread(
      threadId,
      { title, fmTitleAt: Date.now() },
      { touch: true },
    );
    store.save();
    return title;
  } catch {
    return null;
  }
}

module.exports = {
  TITLE_PROMPT_LIMIT,
  autoTitleFromPrompt,
  isPlaceholderTitle,
  sanitizeTitle,
  buildTitlePrompt,
  maybeApplyFmTitle,
};
