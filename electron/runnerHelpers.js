"use strict";

// Closure-free helpers lifted verbatim out of createRunner (runner.js, #1447).
// None of them touch runner state; anything that does stays in runner.js.

const path = require("node:path");
const { truncate } = require("./claude.js");
const { approvalResponse, DECISION_CANCEL } = require("./codexApprovals.js");
const { normalizeQuestions } = require("./questions.js");

/** Plan markdown shown in the approval panel; long enough for a real plan. */
const PLAN_TRUNCATE = 20000;

/**
 * Whether this thread should be mirrored into shared session history.
 * Never record simulate-provider runs (env override or thread provider).
 * @param {object | null | undefined} thread
 * @param {string} [providerOverride]
 */
function shouldRecordSession(thread, providerOverride) {
  if (!thread) return false;
  if (process.env.CODER_SIMULATE === "1") return false;
  const provider =
    providerOverride != null
      ? String(providerOverride)
      : String(thread.provider || "");
  if (provider === "simulate") return false;
  return true;
}

/**
 * Join queued lines into the run prompt. Lines that already start with
 * `[` (peer / caller-prefixed) keep that prefix; worker-finished lines
 * still get `[orchestration]`.
 * @param {string[]} notes
 * @returns {string}
 */
function noticePrompt(notes) {
  const body = notes.join("\n");
  const headed = /^\s*\[/.test(body) ? body : "[orchestration] " + body;
  // PR watch wake-ups (electron/prWatch.js) and the restart resume
  // (runner-auto-resume.js) are not orchestration.
  if (notes.every((n) => /^\[(pr watch|restart)\]/.test(String(n)))) {
    return headed;
  }
  return headed + "\nContinue orchestrating; thread_status has full details.";
}

function formatQueuedPrompt(queued) {
  if (queued && queued.fromThread && queued.fromThread.id) {
    const { attributedPrompt } = require("./crossThread.js");
    return attributedPrompt(queued.fromThread, queued.prompt);
  }
  return queued && queued.prompt != null ? String(queued.prompt) : "";
}

/**
 * Index of the first element that differs, by reference. The store patches
 * messages/work-log items immutably ({...old, ...patch}), so an unchanged
 * item keeps its identity and everything before the first difference is
 * already on the renderer.
 * @param {unknown[] | undefined} prev
 * @param {unknown[]} next
 */
function firstChanged(prev, next) {
  if (!prev) return 0;
  const n = Math.min(prev.length, next.length);
  let i = 0;
  while (i < n && prev[i] === next[i]) i++;
  return i;
}

/**
 * ExitPlanMode input -> the plan markdown for the renderer's plan card, or
 * null when this permission isn't a plan approval. Plans are prose, not tool
 * args, so they get their own (larger) budget than the JSON preview.
 * @param {string} toolName
 * @param {Record<string, unknown>} rawInput
 */
function planText(toolName, rawInput) {
  if (toolName !== "ExitPlanMode") return null;
  const plan = rawInput && typeof rawInput.plan === "string" ? rawInput.plan : "";
  return plan ? truncate(plan, PLAN_TRUNCATE) : null;
}

/**
 * AskUserQuestion input -> sanitized questions for the renderer's option
 * picker, or null when this permission isn't a question prompt.
 * @param {string} toolName
 * @param {Record<string, unknown>} rawInput
 */
function questionInfo(toolName, rawInput) {
  if (toolName !== "AskUserQuestion") return null;
  return normalizeQuestions(rawInput && rawInput.questions);
}

function replyCodexJsonRpc(e, id, result) {
  if (e.handle && typeof e.handle.respondJsonRpc === "function") {
    if (e.handle.respondJsonRpc(id, result) === false) throw new Error("Codex request no longer pending or connection closed");
    return;
  }
  throw new Error("Codex run has no JSON-RPC reply path");
}

function replyCodexJsonRpcError(e, id, error) {
  if (e.handle && typeof e.handle.respondJsonRpcError === "function") {
    e.handle.respondJsonRpcError(id, error);
    return;
  }
  throw new Error("Codex run has no JSON-RPC reply path");
}

function cancelCodexServerRequests(entry) {
  if (!entry || entry.kind !== "codex") return;
  const pending = Array.isArray(entry.pendingPermissions)
    ? entry.pendingPermissions.splice(0)
    : [];
  if (entry.handle && typeof entry.handle.cancelOutstanding === "function") {
    try {
      entry.handle.cancelOutstanding(DECISION_CANCEL);
    } catch {
      // ignore
    }
    return;
  }
  for (const p of pending) {
    try {
      replyCodexJsonRpc(entry, p.rpcId !== undefined ? p.rpcId : p.id,
        approvalResponse(p.method, DECISION_CANCEL));
    } catch {
      // ignore
    }
  }
}

/**
 * Keep only well-formed image/folder/file attachments (absolute paths).
 * The web bridge is remote-controlled, so never trust the wire shape.
 * @param {unknown} input
 * @returns {{ kind: "image" | "folder" | "file", path: string, name: string }[]}
 */
function sanitizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const a of input) {
    if (!a || typeof a !== "object") continue;
    const kind =
      a.kind === "folder"
        ? "folder"
        : a.kind === "image"
          ? "image"
          : a.kind === "file"
            ? "file"
            : null;
    const p = typeof a.path === "string" ? a.path : "";
    if (!kind || !p || !path.isAbsolute(p)) continue;
    out.push({
      kind,
      path: p,
      name: typeof a.name === "string" && a.name ? a.name : path.basename(p),
    });
  }
  return out;
}

/**
 * CLI-only section listing the user's attachments. The transcript message
 * keeps the raw prompt; agents read the paths with their own file tools.
 * @param {{ kind: string, path: string }[]} attachments
 * @returns {string}
 */
function attachmentPromptSection(attachments) {
  if (!attachments.length) return "";
  const lines = attachments.map((a) => {
    const label =
      a.kind === "folder" ? "Folder" : a.kind === "file" ? "File" : "Image";
    return `- ${label}: ${a.path}`;
  });
  return (
    "\n\n[The user attached the following items. Inspect them with your " +
    "file tools as needed.\n" +
    lines.join("\n") +
    "]"
  );
}

module.exports = {
  PLAN_TRUNCATE,
  shouldRecordSession,
  noticePrompt,
  formatQueuedPrompt,
  firstChanged,
  planText,
  questionInfo,
  replyCodexJsonRpc,
  replyCodexJsonRpcError,
  cancelCodexServerRequests,
  sanitizeAttachments,
  attachmentPromptSection,
};
