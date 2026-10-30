"use strict";

const { fmRun } = require("./fm.js");
const { cleanSubject } = require("./commitmsg.js");
const { THREAD_TITLE_MAX, isTrashed } = require("./services.js");

/** Prompt body cap: same idea as commitmsg.PROMPT_PATCH_LIMIT, tighter. */
const TITLE_PROMPT_LIMIT = 4000;
/** Regenerate (#1774): how many of the latest messages feed the digest. */
const REGEN_DIGEST_COUNT = 6;
/** Per-message cap inside the digest; the prompt needs the gist, not it all. */
const REGEN_DIGEST_MSG_LIMIT = 300;
/** Regenerate (#1774): at most this many fm calls in flight at once. */
const REGEN_CONCURRENCY = 2;

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
 * @param {string} [instructions] - user's titleInstructions setting (#1765)
 * @returns {string}
 */
function buildTitlePrompt(userText, assistantText, instructions) {
  const user = String(userText || "").slice(0, TITLE_PROMPT_LIMIT);
  const asst = String(assistantText || "").slice(0, TITLE_PROMPT_LIMIT);
  const parts = [
    "Write a title of at most 6 words describing this task.",
    "Reply with ONLY the title: no quotes, no trailing period, no explanation.",
  ];
  const extra = String(instructions || "").trim();
  if (extra) parts.push("", "Extra instructions:", extra);
  parts.push("", "User:", user || "(empty)");
  if (asst) {
    parts.push("", "Assistant:", asst);
  }
  return parts.join("\n");
}

/**
 * Role-prefixed digest of the latest messages, for the regenerate prompt
 * (#1774): a thread that drifted needs its recent activity, not just the
 * opening request, to get a title for what it is actually about now.
 *
 * @param {Array<{ role?: string, text?: string }>} msgs
 * @returns {string}
 */
function buildRecentDigest(msgs) {
  return (msgs || [])
    .slice(-REGEN_DIGEST_COUNT)
    .map((m) => {
      const role =
        m && m.role === "user"
          ? "User"
          : m && m.role === "assistant"
            ? "Assistant"
            : null;
      if (!role) return null;
      const text = String((m && m.text) || "")
        .slice(0, REGEN_DIGEST_MSG_LIMIT)
        .trim();
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * @param {string} firstUserText
 * @param {string} digest - buildRecentDigest output
 * @param {string} [instructions] - user's titleInstructions setting
 * @returns {string}
 */
function buildRegenerateTitlePrompt(firstUserText, digest, instructions) {
  const user = String(firstUserText || "").slice(0, TITLE_PROMPT_LIMIT);
  const parts = [
    "Write a title of at most 6 words describing what this task is actually about now.",
    "The task may have drifted since it started; prefer the recent activity over the opening request when they differ.",
    "Reply with ONLY the title: no quotes, no trailing period, no explanation.",
  ];
  const extra = String(instructions || "").trim();
  if (extra) parts.push("", "Extra instructions:", extra);
  parts.push("", "First request:", user || "(empty)");
  if (digest) parts.push("", "Recent activity:", digest);
  return parts.join("\n");
}

/**
 * Regenerate one thread's title from its first user message plus a digest
 * of its latest messages (issue #1774), via the same fm completion path and
 * sanitization/cap as the automatic one-shot title.
 *
 * Always explicit: callers are the thread action menu and the sidebar bulk
 * action, so unlike maybeApplyFmTitle this overwrites any existing title,
 * including one the user set by hand — the user picked this thread.
 *
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<string>} the saved title; throws on any failure
 */
async function regenerateTitle(store, threadId, opts = {}) {
  const thread = store.getThread(threadId);
  if (!thread) throw new Error(`Unknown thread: ${threadId}`);
  if (isTrashed(thread)) {
    throw new Error("Cannot regenerate a trashed thread's title");
  }

  const msgs = store.getMessages(threadId) || [];
  const firstUser = msgs.find((m) => m && m.role === "user");
  const firstUserText = firstUser ? String(firstUser.text || "") : "";
  if (!firstUserText) throw new Error("Thread has no messages to title");

  const digest = buildRecentDigest(msgs);
  const instructions = store.getSettings
    ? store.getSettings().titleInstructions
    : "";
  const raw = await fmRun(
    buildRegenerateTitlePrompt(firstUserText, digest, instructions),
    { env: opts.env },
  );
  if (!raw) throw new Error("Title generator is not available");

  const title = sanitizeTitle(raw);
  if (!title) throw new Error("Title generator returned an empty title");

  store.updateThread(threadId, { title, fmTitleAt: Date.now() }, { touch: true });
  store.save();
  return title;
}

/**
 * Regenerate titles for several threads at once (menu item or sidebar bulk
 * action), at most REGEN_CONCURRENCY at a time. One thread's failure does
 * not stop the rest; each result reports success or a reason.
 *
 * @param {import("./store").Store} store
 * @param {string[]} threadIds
 * @param {{ env?: NodeJS.ProcessEnv, concurrency?: number }} [opts]
 * @returns {Promise<Array<{ threadId: string, title?: string, error?: string }>>}
 */
async function regenerateTitles(store, threadIds, opts = {}) {
  const ids = Array.from(
    new Set((threadIds || []).map((id) => String(id))),
  );
  const results = [];
  const queue = [...ids];
  const worker = async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      try {
        const title = await regenerateTitle(store, id, { env: opts.env });
        results.push({ threadId: id, title });
      } catch (err) {
        results.push({
          threadId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  const lanes = Math.max(
    1,
    Math.min(opts.concurrency ?? REGEN_CONCURRENCY, ids.length),
  );
  await Promise.all(Array.from({ length: lanes }, worker));
  return results;
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

    const instructions = store.getSettings
      ? store.getSettings().titleInstructions
      : "";
    const raw = await fmRun(
      buildTitlePrompt(userText, assistantText, instructions),
      { env: opts.env },
    );
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
  REGEN_CONCURRENCY,
  autoTitleFromPrompt,
  isPlaceholderTitle,
  sanitizeTitle,
  buildTitlePrompt,
  maybeApplyFmTitle,
  buildRecentDigest,
  buildRegenerateTitlePrompt,
  regenerateTitle,
  regenerateTitles,
};
