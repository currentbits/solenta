#!/usr/bin/env node
"use strict";

/**
 * Codex PreToolUse hook (#813). Copied into the isolated CODEX_HOME.
 * Exit 2 + stderr blocks; ask is deny (Codex ask fail-opens), except on a
 * Full access thread, where only deny rules block (#1841).
 * User hooks (#1724) run after an allow and can only add a block.
 */

const {
  hookGuardrailDecision,
  normalizeToolCall,
  runStdinHook,
} = require("./guardrail-hook-core.js");

runStdinHook(async (payload) => {
  const worktree = process.env.SOLENTA_WORKTREE || process.cwd();
  const out = hookGuardrailDecision(payload, worktree);
  if (out.decision === "deny") {
    process.stderr.write(out.message + "\n");
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
