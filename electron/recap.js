"use strict";

const { fmRun } = require("./fm.js");

/**
 * Thread recap (#239): a short cached "what was asked / what changed /
 * where it stands / open questions" card for a thread the user returns to.
 *
 * Built after every successful turn (so new activity regenerates it) and
 * stored on the thread as `recap: { text, at }`. The extractive version is
 * free and always works; on-device fm (#340) rewrites it into prose when the
 * machine has it. No cloud provider is ever charged for a recap.
 */

/** Opening a thread idle at least this long shows its recap. */
const RECAP_IDLE_MS = 30 * 60 * 1000;
const LINE_MAX = 160;
const FILES_MAX = 6;
const QUESTIONS_MAX = 3;
const PROMPT_LIMIT = 6000;

// ponytail: tool-name match on the one-line summary ("Edit: src/a.ts"). Covers
// Claude-style names and the common snake_case ones; git diff is the upgrade
// if other providers' edits go missing here.
const EDIT_TOOL =
  /^(Edit|MultiEdit|Write|NotebookEdit|edit_file|write_file|create_file|apply_patch|str_replace_editor):\s*(\S.*)$/;

/**
 * @param {string} text
 * @param {number} [max]
 */
function oneLine(text, max = LINE_MAX) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Extractive recap: no model, deterministic, "" when there is nothing to say.
 *
 * @param {Array<{ role?: string, text?: string, fromNotice?: boolean }>} messages
 * @returns {string}
 */
function buildExtractiveRecap(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const users = msgs.filter(
    (m) => m && m.role === "user" && !m.fromNotice && String(m.text || "").trim(),
  );
  const lastAssistant = [...msgs]
    .reverse()
    .find((m) => m && m.role === "assistant" && String(m.text || "").trim());
  if (!users.length || !lastAssistant) return "";

  const lines = [`Asked: ${oneLine(users[0].text)}`];
  const latest = users[users.length - 1];
  if (latest !== users[0]) lines.push(`Latest ask: ${oneLine(latest.text)}`);

  /** @type {string[]} */
  const files = [];
  for (const m of msgs) {
    if (!m || m.role !== "tool") continue;
    const hit = EDIT_TOOL.exec(String(m.text || ""));
    if (hit && !files.includes(hit[2])) files.push(hit[2]);
  }
  if (files.length) {
    const more = files.length > FILES_MAX ? ` (+${files.length - FILES_MAX} more)` : "";
    lines.push(`Changed: ${files.slice(0, FILES_MAX).join(", ")}${more}`);
  }

  const reply = String(lastAssistant.text);
  lines.push(`Now: ${oneLine(reply, 280)}`);
  const questions = (reply.match(/[^.!?\n]*\?/g) || [])
    .map((q) => oneLine(q))
    .filter((q) => q.length > 8)
    .slice(0, QUESTIONS_MAX);
  if (questions.length) lines.push(`Open: ${questions.join(" ")}`);
  return lines.join("\n");
}

/**
 * @param {string} extractive
 * @param {string} lastReply
 */
function buildRecapPrompt(extractive, lastReply) {
  return [
    "Summarize this coding-agent thread for someone returning to it.",
    "Use at most 4 short lines, each starting with one of: Asked:, Changed:, Now:, Open:.",
    "Omit a line when there is nothing for it. Reply with ONLY those lines.",
    "",
    "Notes:",
    extractive,
    "",
    "Agent's last reply:",
    String(lastReply || "").slice(0, PROMPT_LIMIT),
  ].join("\n");
}

/**
 * Rebuild and cache the thread's recap. Best-effort: never throws.
 *
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {{ env?: NodeJS.ProcessEnv, fmRun?: typeof fmRun }} [opts]
 * @returns {Promise<{ text: string, at: number } | null>} the saved recap
 */
async function refreshRecap(store, threadId, opts = {}) {
  try {
    const msgs = store.getMessages(threadId) || [];
    const extractive = buildExtractiveRecap(msgs);
    if (!extractive) return null;
    const lastReply = [...msgs]
      .reverse()
      .find((m) => m && m.role === "assistant" && String(m.text || "").trim());
    const run = opts.fmRun || fmRun;
    const fm = await run(buildRecapPrompt(extractive, lastReply ? lastReply.text : ""), {
      env: opts.env,
    });
    // A newer turn may have landed while fm ran; its own refresh wins.
    if ((store.getMessages(threadId) || []).length !== msgs.length) return null;
    if (!store.getThread(threadId)) return null;
    const recap = { text: (fm && fm.trim()) || extractive, at: Date.now() };
    // No touch: a recap is not activity (would re-unread and re-sort).
    store.updateThread(threadId, { recap });
    store.markDirty();
    return recap;
  } catch {
    return null;
  }
}

/**
 * The recap to show on a user visit, or null. Due when the thread sat
 * unvisited for RECAP_IDLE_MS, or when it is a fresh fork/hand-off with no
 * recap of its own yet (shows the source thread's). Call BEFORE stamping
 * lastVisitedAt.
 *
 * @param {import("./store").Store} store
 * @param {{ recap?: { text: string, at: number } | null, lastVisitedAt?: number | null, status?: string, handoffFrom?: string | null }} thread
 * @param {number} [now]
 * @returns {{ text: string, at: number } | null}
 */
function dueRecap(store, thread, now = Date.now()) {
  if (!thread || thread.status === "working") return null;
  if (thread.recap) {
    const seen = thread.lastVisitedAt;
    return seen != null && now - seen >= RECAP_IDLE_MS ? thread.recap : null;
  }
  if (thread.handoffFrom) {
    const source = store.getThread(String(thread.handoffFrom));
    return (source && source.recap) || null;
  }
  return null;
}

module.exports = {
  RECAP_IDLE_MS,
  buildExtractiveRecap,
  buildRecapPrompt,
  refreshRecap,
  dueRecap,
};
