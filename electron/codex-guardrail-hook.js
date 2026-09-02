#!/usr/bin/env node
"use strict";

/**
 * Codex PreToolUse hook (#813). Copied into the isolated CODEX_HOME.
 * Exit 2 + stderr blocks; ask is deny (Codex ask fail-opens).
 */

const {
  decideGuardrail,
  runStdinHook,
} = require("./guardrail-hook-core.js");

runStdinHook((payload) => {
  const worktree = process.env.SOLENTA_WORKTREE || process.cwd();
  const out = decideGuardrail(payload, worktree);
  if (out.decision === "deny") {
    process.stderr.write(out.message + "\n");
    process.exit(2);
  }
  return null;
});
