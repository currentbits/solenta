#!/usr/bin/env node
"use strict";

/**
 * User lifecycle hooks runtime (#1724). Self-contained (node built-ins
 * only): it is copied next to the guardrail hook scripts, so it runs
 * inside a provider CLI's hook process as well as in Solenta itself.
 *
 * Contract, after Claude Code's: JSON payload on stdin; exit 0 continues
 * (stdout may carry additionalContext for UserPromptSubmit), exit 2
 * blocks with stderr as the reason, anything else is a warning. argv
 * only, never a shell; a timeout kills the whole process group.
 *
 * As a CLI (Claude's native PreToolUse):
 *   node user-hooks-run.js PreToolUse   (resolved file in SOLENTA_USER_HOOKS)
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CAPTURE = 64 * 1024;
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

/**
 * Anchored full-name match; absent, "" and "*" match every tool.
 * @param {{ event: string, matcher?: string }} hook
 * @param {string} event
 * @param {string} [toolName]
 */
function hookMatches(hook, event, toolName) {
  if (!hook || hook.event !== event) return false;
  if (!TOOL_EVENTS.has(event)) return true;
  const m = hook.matcher;
  if (m == null || m === "" || m === "*") return true;
  try {
    return new RegExp(`^(?:${m})$`).test(String(toolName || ""));
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      // detached spawn made the child a group leader: -pid is the tree.
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

/** First lines of what the hook said, for the Settings "last run" column. */
function snippet(text) {
  return String(text || "")
    .trim()
    .split(/\r?\n/)
    .slice(0, 5)
    .join("\n")
    .slice(0, 500);
}

/**
 * #1737: the first approved repo script whose checkout copy no longer has
 * its approved hash (edited, swapped or gone), or null.
 * @param {{ verify?: Array<{ path: string, abs: string, sha256: string }> }} hook
 */
function changedScript(hook) {
  for (const s of hook.verify || []) {
    let hash = null;
    try {
      hash = crypto.createHash("sha256").update(fs.readFileSync(s.abs)).digest("hex");
    } catch {
      // gone
    }
    if (hash !== s.sha256) return s.path;
  }
  return null;
}

/**
 * Run one hook. Never rejects.
 * @param {{ id?: string, event: string, command: string[], timeoutMs?: number }} hook
 * @param {object} payload
 * @param {string} cwd
 * @returns {Promise<{ id: string, event: string, exitCode: number | null, durationMs: number, timedOut: boolean, error: string | null, stdout: string, stderr: string, output: string, at: number }>}
 */
function runOne(hook, payload, cwd) {
  return new Promise((resolve) => {
    const at = Date.now();
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1, Number(hook.timeoutMs) || DEFAULT_TIMEOUT_MS),
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const errText = timedOut ? `timed out after ${timeoutMs} ms` : error || null;
      resolve({
        id: String(hook.id || ""),
        event: hook.event,
        exitCode: timedOut ? null : exitCode,
        durationMs: Date.now() - at,
        timedOut,
        error: errText,
        stdout,
        stderr,
        output: snippet(errText || stderr || stdout),
        at,
      });
    };
    const changed = changedScript(hook);
    if (changed) {
      finish(
        null,
        `did not run: ${changed} changed since the project hooks were approved. Re-approve them in Settings › Hooks.`,
      );
      return;
    }
    let child;
    try {
      const argv = hook.command;
      child = spawn(argv[0], argv.slice(1), {
        cwd: cwd || process.cwd(),
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish(null, String((err && err.message) || err));
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // A pipe held by something outside the group would stall "close".
      timer = setTimeout(() => finish(null, null), 1000);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_CAPTURE) stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_CAPTURE) stderr += d;
    });
    child.on("error", (err) => finish(null, String(err.message || err)));
    child.on("close", (code) => finish(code, null));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload) + "\n");
  });
}

/** Claude Code's two shapes: JSON (either nesting) or plain stdout. */
function contextFromStdout(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return "";
  try {
    const o = JSON.parse(s);
    if (o && typeof o === "object") {
      const v =
        o.additionalContext ??
        (o.hookSpecificOutput && o.hookSpecificOutput.additionalContext);
      return typeof v === "string" ? v : "";
    }
  } catch {
    // plain text
  }
  return s;
}

/**
 * Run every matching hook in order; the first exit 2 stops the rest.
 * @param {object} opts
 * @param {Array<object>} opts.hooks
 * @param {string} opts.event
 * @param {object} opts.payload
 * @param {string} [opts.toolName]
 * @param {string} [opts.cwd]
 * @param {(r: object) => void} [opts.onResult]
 */
async function runHooks(opts) {
  const out = {
    blocked: false,
    reason: "",
    blockedBy: "",
    contexts: /** @type {string[]} */ ([]),
    warnings: /** @type {string[]} */ ([]),
    results: /** @type {object[]} */ ([]),
  };
  const list = (opts.hooks || []).filter((h) =>
    hookMatches(h, opts.event, opts.toolName),
  );
  for (const hook of list) {
    const r = await runOne(hook, opts.payload, opts.cwd || "");
    out.results.push(r);
    if (opts.onResult) {
      try {
        opts.onResult(r);
      } catch {
        // recording is best-effort
      }
    }
    if (r.exitCode === 0) {
      if (opts.event === "UserPromptSubmit") {
        const ctx = contextFromStdout(r.stdout);
        if (ctx) out.contexts.push(ctx);
      }
    } else if (r.exitCode === 2) {
      out.blocked = true;
      out.blockedBy = r.id;
      out.reason = String(r.stderr || "").trim() || `Blocked by hook ${r.id}`;
      break;
    } else {
      out.warnings.push(`Hook ${r.id} ${r.error || `exited ${r.exitCode}`}${r.output && !r.error ? `: ${r.output}` : ""}`);
    }
  }
  return out;
}

/**
 * The per-thread file Solenta writes at run start (user-hooks.js).
 * @param {string} file
 */
function readResolved(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    return o && Array.isArray(o.hooks) ? o : null;
  } catch {
    return null;
  }
}

function appendResult(resultsPath, r) {
  if (!resultsPath) return;
  const row = {
    id: r.id,
    event: r.event,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    timedOut: r.timedOut,
    error: r.error,
    output: r.output,
    at: r.at,
  };
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.appendFileSync(resultsPath, JSON.stringify(row) + "\n");
}

/**
 * Native-hook entry: merge the CLI's payload with Solenta's thread facts
 * and run the matching hooks for one event.
 * @param {string} file  resolved thread hooks file
 * @param {string} event
 * @param {object} cliPayload  what the provider CLI sent
 * @param {{ toolName: string, input: object }} tool
 */
async function runResolved(file, event, cliPayload, tool) {
  const resolved = file ? readResolved(file) : null;
  if (!resolved) return null;
  const payload = {
    ...(cliPayload && typeof cliPayload === "object" ? cliPayload : {}),
    event,
    hook_event_name: event,
    thread_id: resolved.threadId || null,
    provider: resolved.provider || null,
    model: resolved.model || null,
    cwd: resolved.cwd || process.cwd(),
    tool_name: tool.toolName,
    tool_input: tool.input,
  };
  return runHooks({
    hooks: resolved.hooks,
    event,
    payload,
    toolName: tool.toolName,
    cwd: resolved.cwd,
    onResult: (r) => appendResult(resolved.resultsPath, r),
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  TOOL_EVENTS,
  hookMatches,
  changedScript,
  runOne,
  runHooks,
  runResolved,
  readResolved,
  appendResult,
  contextFromStdout,
};

if (require.main === module) {
  // Claude native PreToolUse. Guardrail hard denies stay Solenta's (they
  // would be denied in can_use_tool anyway); an "ask" verdict is left to
  // Claude's permission card, so user hooks still run for it.
  const core = require("./guardrail-hook-core.js");
  const event = process.argv[2] || "PreToolUse";
  core.runStdinHook(async (payload) => {
    const worktree = process.env.SOLENTA_WORKTREE || process.cwd();
    const g = core.decideGuardrail(payload, worktree);
    if (g.decision === "deny" && !g.asked) {
      process.stderr.write(g.message + "\n");
      process.exit(2);
    }
    const out = await runResolved(
      process.env.SOLENTA_USER_HOOKS || "",
      event,
      payload,
      core.normalizeToolCall(payload),
    );
    if (out && out.blocked) {
      process.stderr.write(out.reason + "\n");
      process.exit(2);
    }
    return null;
  });
}
