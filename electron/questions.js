"use strict";

/**
 * Shared shape for agent-asked multiple-choice questions (issue #647).
 *
 * Four call sites route through here, which is the whole point: claude's
 * AskUserQuestion permission prompt, grok's native ask_user_question tool_use,
 * the coder-threads `ask_user` MCP tool, and the store's load-time heal. Every
 * one of them takes its input from an agent, so none of them may trust it.
 */

/** Longest question / label / description we keep. Cards are not documents. */
const TEXT_MAX = 400;
/** Caps: a picker with 40 questions is a bug, not a UI. */
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;

/**
 * @param {unknown} value
 * @param {number} [max]
 */
function text(value, max = TEXT_MAX) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Agent-supplied questions -> the renderer's contract, or null when nothing
 * usable survives. A question with no labelled options cannot be answered by
 * clicking, so it is dropped rather than rendered as an empty card.
 *
 * @param {unknown} raw - the `questions` array from a tool input
 * @returns {{ question: string, header: string, multiSelect: boolean,
 *   options: { label: string, description: string }[] }[] | null}
 */
function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const q of raw.slice(0, MAX_QUESTIONS)) {
    if (!q || typeof q !== "object") continue;
    const question = text(q.question);
    if (!question || !Array.isArray(q.options)) continue;
    const options = [];
    for (const o of q.options.slice(0, MAX_OPTIONS)) {
      if (!o || typeof o !== "object") continue;
      const label = text(o.label);
      if (!label) continue;
      options.push({ label, description: text(o.description) });
    }
    if (options.length === 0) continue;
    out.push({
      question,
      header: text(q.header, 40),
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Heal a persisted pendingQuestion row (store load). Anything that does not
 * still hold answerable questions becomes null — a card the user cannot
 * dismiss by answering would be a permanent stuck badge.
 * @param {unknown} value
 */
function normalizePendingQuestion(value) {
  if (!value || typeof value !== "object") return null;
  const questions = normalizeQuestions(value.questions);
  if (!questions) return null;
  const askedAt =
    typeof value.askedAt === "number" && Number.isFinite(value.askedAt)
      ? value.askedAt
      : 0;
  return { id: text(value.id, 64) || "q", questions, askedAt };
}

module.exports = {
  normalizeQuestions,
  normalizePendingQuestion,
};
