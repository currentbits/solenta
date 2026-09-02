"use strict";

/**
 * Shared classifyTool decision for provider PreToolUse hooks (#813).
 *
 * Copied into each isolated overlay/plugin so packaging/asar does not
 * break `require`. Ask is deny: Cursor does not enforce ask under
 * --force, Codex treat ask as a hook failure and continues the tool,
 * OpenCode cannot raise a native prompt from tool.execute.before.
 */

const fs = require("node:fs");
const path = require("node:path");
const { classifyTool, guardrailsEnabled } = require("./guardrails.js");

/**
 * @param {unknown} payload
 * @returns {{ toolName: string, input: Record<string, unknown> }}
 */
function normalizeToolCall(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { toolName: "", input: {} };
  }
  const p = /** @type {Record<string, unknown>} */ (payload);
  const toolName = String(p.tool_name || p.toolName || p.tool || "");
  const raw = p.tool_input || p.toolInput || p.input || p.args;
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? /** @type {Record<string, unknown>} */ (raw)
      : {};
  return { toolName, input };
}

/**
 * @param {unknown} payload
 * @param {string | null | undefined} worktreePath
 */
function decideGuardrail(payload, worktreePath) {
  if (!guardrailsEnabled()) {
    return { decision: "allow", rule: null, reason: "", message: "" };
  }
  let verdict;
  try {
    const { toolName, input } = normalizeToolCall(payload);
    verdict = classifyTool({ toolName, input, worktreePath });
  } catch {
    return { decision: "allow", rule: null, reason: "", message: "" };
  }
  if (verdict.decision !== "deny" && verdict.decision !== "ask") {
    return { decision: "allow", rule: null, reason: "", message: "" };
  }
  const rule = verdict.rule || "policy";
  const reason = verdict.reason || "blocked";
  return {
    decision: "deny",
    rule,
    reason,
    asked: verdict.decision === "ask",
    message: `Blocked by Solenta guardrails (${rule}): ${reason}`,
  };
}

/**
 * Parse one hook payload. Cursor/Codex may leave stdin open; accept a
 * complete object or the first JSON line.
 * @param {string} raw
 * @returns {unknown | null}
 */
function parseHookPayload(raw) {
  const s = String(raw || "").replace(/^\uFEFF/, "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const line = s.split(/\r?\n/).find((l) => l.trim());
    if (!line || line === s) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
}

/**
 * Stdin wrapper: reply as soon as one JSON object is parseable.
 * Do not wait for EOF (Cursor #691).
 * @param {(payload: unknown) => object | null | undefined} handler
 */
function runStdinHook(handler) {
  function failOpen() {
    process.exit(0);
  }

  let raw = "";
  let done = false;
  const timer = setTimeout(() => {
    if (!done) failOpen();
  }, 2000);
  if (typeof timer.unref === "function") timer.unref();

  function finish(payload) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      const out = handler(payload);
      if (out != null) {
        process.stdout.write(JSON.stringify(out) + "\n");
      }
      process.exit(0);
    } catch {
      failOpen();
    }
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
    const payload = parseHookPayload(raw);
    if (payload != null) finish(payload);
  });
  process.stdin.on("error", failOpen);
  process.stdin.on("end", () => {
    if (done) return;
    const payload = parseHookPayload(raw);
    if (payload != null) finish(payload);
    else failOpen();
  });
}

/** Copy classifyTool + this module next to a hook script (asar-safe). */
function copyGuardrailRuntime(destDir) {
  const dest = path.resolve(String(destDir || ""));
  if (!dest) throw new Error("copyGuardrailRuntime: destDir required");
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ["guardrails.js", "guardrail-hook-core.js"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(dest, name));
  }
  return dest;
}

/**
 * Keep the prompt last. Mutates `args`.
 * @param {string[]} args
 * @param {string[]} extras
 */
function insertBeforeLast(args, extras) {
  if (!Array.isArray(args)) return args;
  if (args.length === 0) {
    args.push(...extras);
    return args;
  }
  const last = args.pop();
  args.push(...extras, last);
  return args;
}

/**
 * Transcript line matching the Claude / grok Guardrail event.
 * @param {string} toolName
 * @param {unknown} input
 * @param {string | null | undefined} worktreePath
 * @returns {string | null}
 */
function guardrailNotice(toolName, input, worktreePath) {
  let parsed = input;
  if (typeof input === "string") {
    try {
      const o = JSON.parse(input);
      parsed =
        o && typeof o === "object" && !Array.isArray(o)
          ? o
          : { command: input };
    } catch {
      parsed = { command: input };
    }
  } else if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    parsed = {};
  }
  const rawName = String(toolName || "tool");
  const out = decideGuardrail(
    { tool_name: rawName, tool_input: parsed },
    worktreePath,
  );
  if (out.decision !== "deny") return null;
  return `Guardrail blocked ${rawName}: ${out.rule}: ${out.reason}`;
}

module.exports = {
  normalizeToolCall,
  decideGuardrail,
  parseHookPayload,
  runStdinHook,
  copyGuardrailRuntime,
  insertBeforeLast,
  guardrailNotice,
};
