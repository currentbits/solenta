"use strict";

const { fmRun } = require("./fm.js");
const { cleanSubject } = require("./commitmsg.js");

/**
 * Labs opt-in (#1806): "Suggest a next prompt after each turn". After a
 * turn finishes successfully on the open thread, one cheap completion over
 * the SAME fm path fm-title.js uses guesses a short next instruction the
 * user is likely to give. Shown as a ghost suggestion in the empty
 * composer (src/components/Composer.tsx); never a cloud model call, same
 * "degrades to null everywhere" contract as fm.js.
 *
 * Gated entirely here (settings flag, automation, one-in-flight) so the
 * runner's turn-end hook (electron/runner-verify-gate.js) can call this
 * unconditionally, matching maybeApplyFmTitle's shape.
 */

/** Prompt body cap per side: the gist, not the whole transcript. */
const SUGGEST_PROMPT_LIMIT = 2000;
/** A "next prompt" is one short instruction, not a paragraph. */
const SUGGESTION_MAX = 200;

/** Threads with a suggestion request already in flight. */
const inFlight = new Set();

/**
 * @param {string} userText - the thread's last user message
 * @param {string} assistantText - the final assistant reply that just landed
 * @returns {string}
 */
function buildSuggestPrompt(userText, assistantText) {
  const user = String(userText || "").slice(0, SUGGEST_PROMPT_LIMIT);
  const asst = String(assistantText || "").slice(0, SUGGEST_PROMPT_LIMIT);
  return [
    "A coding assistant just finished a turn for a user.",
    "Suggest ONE short next instruction the user is likely to give next.",
    "Reply with ONLY that instruction: no quotes, no numbering, no explanation.",
    "If no single next instruction clearly fits, reply with exactly: NONE",
    "",
    "User asked:",
    user || "(empty)",
    "",
    "Assistant replied:",
    asst || "(empty)",
  ].join("\n");
}

/**
 * Raw fm output -> a short instruction, or "" when fm declined (NONE) or
 * said nothing usable.
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeSuggestion(raw) {
  let s = cleanSubject(raw);
  if (!s) return "";
  if (/^none\.?$/i.test(s)) return "";
  if (s.endsWith(".")) s = s.slice(0, -1).trim();
  if (s.length > SUGGESTION_MAX) s = s.slice(0, SUGGESTION_MAX);
  return s;
}

/**
 * Best-effort: never throws. Writes thread.nextPromptSuggestion (null when
 * fm declined) so the composer can show or clear its ghost.
 *
 * Skips: the setting is off, the thread is gone, the thread is an
 * automation thread, the triggering turn chain was machine-delivered
 * (isAutoTurn), one is already running for this thread, or either side of
 * the turn has no text yet.
 *
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   fmRun?: typeof fmRun,
 *   isAutoTurn?: (threadId: string) => boolean,
 * }} [opts]
 * @returns {Promise<string | null>} the saved suggestion, or null
 */
async function maybeSuggestNextPrompt(store, threadId, opts = {}) {
  try {
    const settings = store.getSettings ? store.getSettings() : null;
    if (!settings || settings.suggestNextPrompt !== true) return null;

    const thread = store.getThread(threadId);
    if (!thread) return null;
    // Never for automation threads, and never for a turn chain the machine
    // delivered (worker-finished / peer notice / inbound drain) rather than
    // a human send.
    if (thread.automationId) return null;
    if (typeof opts.isAutoTurn === "function" && opts.isAutoTurn(threadId)) {
      return null;
    }
    if (inFlight.has(threadId)) return null;

    const msgs = store.getMessages(threadId) || [];
    const lastUser = [...msgs]
      .reverse()
      .find((m) => m && m.role === "user" && String(m.text || "").trim());
    const lastAssistant = [...msgs]
      .reverse()
      .find((m) => m && m.role === "assistant" && String(m.text || "").trim());
    if (!lastUser || !lastAssistant) return null;

    inFlight.add(threadId);
    try {
      const run = opts.fmRun || fmRun;
      const raw = await run(
        buildSuggestPrompt(lastUser.text, lastAssistant.text),
        { env: opts.env },
      );
      if (!raw) return null;
      const suggestion = sanitizeSuggestion(raw);
      // A newer turn may have landed while fm ran; its own suggestion (or
      // the turn-start clear) wins over this now-stale one.
      if ((store.getMessages(threadId) || []).length !== msgs.length) {
        return null;
      }
      if (!store.getThread(threadId)) return null;
      const value = suggestion || null;
      // No touch: a suggestion is not activity (would re-unread/re-sort).
      store.updateThread(threadId, { nextPromptSuggestion: value });
      store.save();
      return value;
    } finally {
      inFlight.delete(threadId);
    }
  } catch {
    return null;
  }
}

module.exports = {
  SUGGEST_PROMPT_LIMIT,
  SUGGESTION_MAX,
  buildSuggestPrompt,
  sanitizeSuggestion,
  maybeSuggestNextPrompt,
};
