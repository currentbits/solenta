"use strict";

/**
 * Muse Code PreToolUse hook (#873).
 *
 * Managed hooks file at settings.managed_hooks_path. Live Muse 1.0.2
 * (1.0.2-R2040.1) stdout: JSON `{ hookSpecificOutput.permissionDecision }`.
 * deny needs permissionDecisionReason; allow needs updatedInput. Legacy
 * `decision: block` is rejected. Ask is deny: no Solenta prompt channel.
 * Fail-open on crash. Whether deny still fires under `--disable-approval`
 * is unproven; live canary is later.
 *
 * Echo capture has no tool-name aliases. Map shell_command /
 * run_terminal_command / run_shell_command → Bash, write_file → Write,
 * edit_file → Edit, read_file → Read.
 */

const path = require("node:path");
const {
  decideGuardrail,
  runStdinHook,
} = require("./guardrail-hook-core.js");

const MUSE_TOOL_ALIAS = {
  shell_command: "Bash",
  run_terminal_command: "Bash",
  run_shell_command: "Bash",
  write_file: "Write",
  edit_file: "Edit",
  read_file: "Read",
};

function mapMuseToolName(name) {
  const raw = String(name || "");
  return MUSE_TOOL_ALIAS[raw] || raw;
}

function parseToolInput(input) {
  if (!input) return {};
  if (typeof input === "object" && !Array.isArray(input)) return input;
  const s = String(input);
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Muse/echo may stringify a bare command
  }
  return { command: s };
}

function payloadInput(p) {
  return parseToolInput(p.toolInput || p.tool_input || p.input || p.args);
}

/**
 * @param {object} payload
 * @returns {{ decision: "allow" | "deny", reason: string }}
 */
function decideMuseGuardrail(payload) {
  const p = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  const toolName = mapMuseToolName(p.toolName || p.tool_name || p.tool || "");
  const input = payloadInput(p);
  const worktreePath =
    p.cwd || p.workspaceRoot || process.env.SOLENTA_WORKTREE || null;
  const out = decideGuardrail(
    { toolName, tool_name: toolName, toolInput: input, tool_input: input },
    worktreePath,
  );
  if (out.decision === "deny") {
    return { decision: "deny", reason: out.message || out.reason || "blocked" };
  }
  return { decision: "allow", reason: "" };
}

/**
 * Managed-hooks JSON: array of `{ event, command, timeout }`.
 * Project/plugin schemas were unpublished; this is the Task 4 fallback.
 * @param {string | unknown} hooksDoc
 * @param {string} command
 * @param {number} [timeout]
 * @returns {string}
 */
function injectMuseGuardrailHooks(hooksDoc, command, timeout = 15) {
  const seconds = Number(timeout);
  const t = Number.isFinite(seconds) && seconds > 0 ? seconds : 15;
  const entry = {
    event: "PreToolUse",
    command: String(command || ""),
    timeout: t,
  };
  let list = [];
  if (Array.isArray(hooksDoc)) {
    list = hooksDoc;
  } else {
    const s = String(hooksDoc || "").trim();
    if (s) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        list = [];
      }
    }
  }
  const rest = list.filter((h) => !h || h.event !== "PreToolUse");
  rest.push(entry);
  return JSON.stringify(rest, null, 2) + "\n";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function winQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/**
 * Command written into overlay solenta-hooks.json.
 * Remote deploy uses posix `node`, not Electron execPath.
 * @param {{ nodePath?: string, hookPath?: string, posix?: boolean }} [opts]
 */
function museGuardrailHookCommand(opts = {}) {
  const nodePath = opts.nodePath || process.execPath;
  const hookPath =
    opts.hookPath || path.join(__dirname, "muse-guardrail-hook.js");
  const asElectron = Boolean(process.versions.electron);
  if (!opts.posix && process.platform === "win32") {
    const prefix = asElectron ? "set ELECTRON_RUN_AS_NODE=1&& " : "";
    return `${prefix}${winQuote(nodePath)} ${winQuote(hookPath)}`;
  }
  const prefix = asElectron ? "ELECTRON_RUN_AS_NODE=1 " : "";
  return `${prefix}${shellQuote(nodePath)} ${shellQuote(hookPath)}`;
}

if (require.main === module) {
  runStdinHook((payload) => {
    const p =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
    const out = decideMuseGuardrail(p);
    if (out.decision === "deny") {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: out.reason,
          },
        }) + "\n",
      );
      process.stderr.write(out.reason + "\n");
      process.exit(2);
    }
    return {
      hookSpecificOutput: {
        permissionDecision: "allow",
        updatedInput: payloadInput(p),
      },
    };
  });
}

module.exports = {
  MUSE_TOOL_ALIAS,
  mapMuseToolName,
  decideMuseGuardrail,
  injectMuseGuardrailHooks,
  museGuardrailHookCommand,
};
