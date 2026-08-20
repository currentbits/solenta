"use strict";

/**
 * `/btw` side question (issue #471): a cheap, read-only answer that does
 * not occupy the live turn, does not steer it, and does not become the
 * next queued follow-up. Reuses Ask mode's prompt pack + completion
 * (electron/ask.js, issue #392).
 *
 * Pure parse + prompt. The runner owns the in-flight handle; services
 * owns the cards on the thread. Same split as orchcommands.js / ask.js.
 */

const BTW_QUESTION_MAX = 4000;
const BTW_ANSWER_MAX = 16 * 1024;
const BTW_MAX = 8;
const BTW_RUNNING_MAX = 3;

const BTW_STATUSES = new Set(["running", "done", "error"]);
const BTW_SOURCES = new Set(["fm", "print", "retrieval"]);

/**
 * The question after `/btw`, or null. A bare `/btw` (no task) falls
 * through so it is not dispatched as an empty side question — same rule
 * as `/advisor` in orchcommands.
 *
 * @param {unknown} prompt
 * @returns {string | null}
 */
function parseBtwCommand(prompt) {
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  const m = /^\/btw(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const question = (m[1] || "").trim();
  return question || null;
}

/**
 * Strip a leading `/btw` if present; otherwise the string is the question.
 * Empty after trim → null.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeBtwQuestion(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return null;
  const parsed = parseBtwCommand(text.startsWith("/") ? text : `/btw ${text}`);
  if (parsed) return parsed.slice(0, BTW_QUESTION_MAX);
  if (/^\/btw\b/.test(text)) return null;
  return text.slice(0, BTW_QUESTION_MAX);
}

/**
 * Ask-mode pack with a side-question preamble so the helper does not
 * continue the parent turn.
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {string} [opts.indexNote]
 * @param {string} [opts.memoryNote]
 * @param {string} [opts.digestNote]
 * @param {string} [opts.matchNote]
 * @returns {string}
 */
function buildBtwPrompt(opts) {
  const ask = require("./ask.js");
  const question = String((opts && opts.question) || "").trim();
  return ask.buildAskPrompt({
    question:
      "[Side question] Another agent is still working on the main task. " +
      "Answer briefly from the context below. Do not continue their work, " +
      "do not plan, and do not edit files.\n\n" +
      (question || "(empty)"),
    indexNote: opts && opts.indexNote,
    memoryNote: opts && opts.memoryNote,
    digestNote: opts && opts.digestNote,
    matchNote: opts && opts.matchNote,
  });
}

/**
 * Heal a persisted `thread.btw` array. Running cards become errors: the
 * completeAsk process is gone after a crash. Absent / junk → undefined
 * so old rows stay sparse.
 *
 * @param {unknown} raw
 * @returns {object[] | undefined}
 */
function normalizeBtwCards(raw) {
  if (!Array.isArray(raw)) return undefined;
  /** @type {object[]} */
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const id = typeof c.id === "string" && c.id ? c.id : "";
    const question =
      typeof c.question === "string" ? c.question.trim() : "";
    if (!id || !question) continue;
    let status = BTW_STATUSES.has(c.status) ? c.status : "done";
    /** @type {string | undefined} */
    let error = typeof c.error === "string" && c.error ? c.error : undefined;
    if (status === "running") {
      status = "error";
      error = error || "Interrupted";
    }
    /** @type {object} */
    const card = {
      id,
      question: question.slice(0, BTW_QUESTION_MAX),
      status,
      createdAt:
        typeof c.createdAt === "number" && Number.isFinite(c.createdAt)
          ? c.createdAt
          : 0,
    };
    if (typeof c.answer === "string" && c.answer) {
      card.answer = c.answer.slice(0, BTW_ANSWER_MAX);
    }
    if (error) card.error = error;
    if (BTW_SOURCES.has(c.source)) card.source = c.source;
    out.push(card);
  }
  if (out.length > BTW_MAX) out.splice(0, out.length - BTW_MAX);
  return out.length ? out : undefined;
}

module.exports = {
  parseBtwCommand,
  normalizeBtwQuestion,
  buildBtwPrompt,
  normalizeBtwCards,
  BTW_QUESTION_MAX,
  BTW_ANSWER_MAX,
  BTW_MAX,
  BTW_RUNNING_MAX,
};
