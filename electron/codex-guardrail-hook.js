#!/usr/bin/env node
"use strict";

/**
 * Codex PreToolUse hook (#813). Copied into the isolated CODEX_HOME.
 * Exit 2 + stderr blocks; ask is deny (Codex ask fail-opens), except on a
 * Full access thread, where only deny rules block (#1841).
 * User hooks (#1724) run after an allow and can only add a block.
 */

const {
  decideGuardrail,
  normalizeToolCall,
  runStdinHook,
} = require("./guardrail-hook-core.js");

// The hook cannot raise a prompt, so tell the agent retrying is pointless
// and which user setting would allow it (#1841).
const ASK_HINT =
  " Codex cannot show an approval prompt for this rule, so retrying, even" +
  " with escalated sandbox permissions, is blocked again. Ask the user to" +
  " run it, or to set this thread's permissions to Full access (or turn" +
  " guardrails off in Settings > Advanced).";

runStdinHook(async (payload) => {
  const worktree = process.env.SOLENTA_WORKTREE || process.cwd();
  const out = decideGuardrail(payload, worktree);
  const fullAccessAsk =
    out.asked && process.env.SOLENTA_PERMISSION_MODE === "bypassPermissions";
  if (out.decision === "deny" && !fullAccessAsk) {
    process.stderr.write(out.message + (out.asked ? ASK_HINT : "") + "\n");
    process.exit(2);
  }
  // Lazy: remote overlays (#835) ship without the user-hook runtime.
  const file = process.env.SOLENTA_USER_HOOKS;
  if (file) {
    const { runResolved } = require("./user-hooks-run.js");
    const user = await runResolved(
      file,
      "PreToolUse",
      payload,
      normalizeToolCall(payload),
    );
    if (user && user.blocked) {
      process.stderr.write(user.reason + "\n");
      process.exit(2);
    }
  }
  return null;
});
