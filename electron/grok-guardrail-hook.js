"use strict";

/**
 * Grok PreToolUse hook (#812).
 *
 * Grok `-p` has no permission-prompt channel. Asking modes remap to
 * `--always-approve` (#578), so `can_use_tool` control_request never
 * arrives and runner.js classifyTool never runs. The isolated GROK_HOME
 * overlay registers this script as a config.toml `[[hooks.PreToolUse]]`
 * handler — official grok docs: PreToolUse still denies under
 * always-approve. Live grok 1.0.13 loads that overlay table as
 * `source.type=configToml` (#826).
 *
 * stdout JSON `{ decision, reason }` is the grok contract. Exit 2 is a
 * backup deny. ask is treated as deny: a hook `ask` is auto-approved
 * when the client is in always-approve / YOLO.
 */

const path = require("node:path");
const { classifyTool } = require("./guardrails.js");

const HOOK_MARK = "# solenta-guardrail-hook";

/** Grok / Claude names → classifyTool's set (aliases plus native names). */
const GROK_TOOL_ALIAS = {
  run_terminal_command: "Bash",
  run_terminal_cmd: "Bash",
  search_replace: "Edit",
  read_file: "Read",
  list_dir: "Glob",
  grep: "Grep",
};

function mapGrokToolName(name) {
  const raw = String(name || "");
  return GROK_TOOL_ALIAS[raw] || raw;
}

function parseToolInput(input) {
  if (!input) return {};
  if (typeof input === "object") return input;
  const s = String(input);
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // grok sometimes strings a bare command
  }
  return { command: s };
}

/**
 * @param {object} payload
 * @returns {{ decision: "allow" | "deny", reason: string }}
 */
function decideGrokGuardrail(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const toolName = mapGrokToolName(p.toolName || p.tool_name || "");
  const input = parseToolInput(p.toolInput || p.tool_input || p.input);
  const worktreePath =
    p.cwd || p.workspaceRoot || process.env.CODER_GROK_WORKTREE || null;
  let verdict;
  try {
    verdict = classifyTool({ toolName, input, worktreePath });
  } catch {
    return { decision: "allow", reason: "" };
  }
  if (!verdict || verdict.decision === "allow") {
    return { decision: "allow", reason: "" };
  }
  const rule = verdict.rule || "policy";
  const reason = verdict.reason || "blocked";
  return {
    decision: "deny",
    reason: `Blocked by Solenta guardrails (${rule}): ${reason}`,
  };
}

/**
 * Event line for the Solenta transcript (same wording as the Claude seam).
 * @param {{ toolName: string, input?: unknown, worktreePath?: string | null }} opts
 * @returns {string | null}
 */
function grokGuardrailNotice({ toolName, input, worktreePath }) {
  const out = decideGrokGuardrail({
    toolName,
    toolInput: input,
    cwd: worktreePath,
  });
  if (out.decision !== "deny") return null;
  const rawName = String(toolName || "tool");
  const m = /Blocked by Solenta guardrails \(([^)]+)\): (.*)$/.exec(out.reason);
  if (!m) return `Guardrail blocked ${rawName}: ${out.reason}`;
  return `Guardrail blocked ${rawName}: ${m[1]}: ${m[2]}`;
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Live grok 1.0.13 shape (#826): matcher = "" plus an inline command hook.
 * Do not write this into GROK_HOME_LINKS "hooks" — that symlink is the
 * user's ~/.grok/hooks.
 */
function hookBlock(command, timeout) {
  const seconds = Number(timeout);
  const t = Number.isFinite(seconds) && seconds > 0 ? seconds : 15;
  return [
    HOOK_MARK,
    "[[hooks.PreToolUse]]",
    'matcher = ""',
    "hooks = [",
    `  { type = "command", command = ${tomlString(command)}, timeout = ${t} },`,
    "]",
    "",
  ].join("\n");
}

const MARKED_BLOCK =
  /(?:^|\n)# solenta-guardrail-hook\n\[\[hooks\.PreToolUse\]\]\nmatcher = ""\nhooks = \[\n  \{ type = "command", command = "(?:\\.|[^"\\])*", timeout = \d+ \},\n\]\n?/;

function injectGrokGuardrailHook(toml, command, timeout = 15) {
  const stripped = String(toml || "").replace(MARKED_BLOCK, "\n");
  const body = stripped.replace(/\s+$/, "\n");
  const prefix = !body || body.endsWith("\n") ? body : `${body}\n`;
  return `${prefix}${hookBlock(command, timeout)}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function winQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/**
 * Command written into overlay config.toml [[hooks.PreToolUse]].
 * In the packaged app, Electron must run as Node so require() works.
 * @param {{ nodePath?: string, hookPath?: string, posix?: boolean }} [opts]
 */
function grokGuardrailHookCommand(opts = {}) {
  const nodePath = opts.nodePath || process.execPath;
  const hookPath =
    opts.hookPath || path.join(__dirname, "grok-guardrail-hook.js");
  const asElectron = Boolean(process.versions.electron);
  if (!opts.posix && process.platform === "win32") {
    const prefix = asElectron ? "set ELECTRON_RUN_AS_NODE=1&& " : "";
    return `${prefix}${winQuote(nodePath)} ${winQuote(hookPath)}`;
  }
  const prefix = asElectron ? "ELECTRON_RUN_AS_NODE=1 " : "";
  return `${prefix}${shellQuote(nodePath)} ${shellQuote(hookPath)}`;
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

if (require.main === module) {
  readStdin().then((raw) => {
    let payload = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      process.exit(0);
      return;
    }
    const out = decideGrokGuardrail(payload);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out.decision === "deny" ? 2 : 0);
  });
}

module.exports = {
  HOOK_MARK,
  mapGrokToolName,
  decideGrokGuardrail,
  grokGuardrailNotice,
  injectGrokGuardrailHook,
  grokGuardrailHookCommand,
};
