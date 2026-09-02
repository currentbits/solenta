"use strict";

/**
 * Kimi PreToolUse hook (#834).
 *
 * Official kimi-code docs: [[hooks]] in $KIMI_CODE_HOME/config.toml.
 * event = "PreToolUse" runs before the tool (and before permission
 * checks). Exit 2 or stdout
 * `{ hookSpecificOutput: { permissionDecision: "deny" } }` blocks.
 * Fail-open on crash. Ask is deny: kimi has no Solenta prompt channel.
 */

const path = require("node:path");
const {
  decideGuardrail,
  runStdinHook,
} = require("./guardrail-hook-core.js");

const HOOK_MARK = "# solenta-guardrail-hook";

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hookBlock(command, timeout) {
  const seconds = Number(timeout);
  const t = Number.isFinite(seconds) && seconds > 0 ? seconds : 15;
  return [
    HOOK_MARK,
    "[[hooks]]",
    'event = "PreToolUse"',
    `command = ${tomlString(command)}`,
    `timeout = ${t}`,
    "",
  ].join("\n");
}

const MARKED_BLOCK =
  /(?:^|\n)# solenta-guardrail-hook\n\[\[hooks\]\]\nevent = "PreToolUse"\ncommand = "(?:\\.|[^"\\])*"\ntimeout = \d+\n?/;

function injectKimiGuardrailHook(toml, command, timeout = 15) {
  const stripped = String(toml || "").replace(MARKED_BLOCK, "\n");
  const body = stripped.replace(/\s+$/, "\n");
  const prefix = !body || body.endsWith("\n") ? body : `${body}\n`;
  return `${prefix}${hookBlock(command, timeout)}`;
}

/**
 * Command written into overlay config.toml [[hooks]].
 * Remote deploy uses posix `node`, not Electron execPath.
 * @param {{ nodePath?: string, hookPath?: string }} [opts]
 */
function kimiGuardrailHookCommand(opts = {}) {
  const nodePath = opts.nodePath || "node";
  const hookPath =
    opts.hookPath || path.join(__dirname, "kimi-guardrail-hook.js");
  return `${shellQuote(nodePath)} ${shellQuote(hookPath)}`;
}

if (require.main === module) {
  runStdinHook((payload) => {
    const worktree = process.env.SOLENTA_WORKTREE || process.cwd();
    const out = decideGuardrail(payload, worktree);
    if (out.decision === "deny") {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: out.message,
          },
        }) + "\n",
      );
      process.stderr.write(out.message + "\n");
      process.exit(2);
    }
    return null;
  });
}

module.exports = {
  HOOK_MARK,
  injectKimiGuardrailHook,
  kimiGuardrailHookCommand,
};
