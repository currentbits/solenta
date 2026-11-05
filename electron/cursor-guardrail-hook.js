#!/usr/bin/env node
"use strict";

/**
 * Cursor preToolUse hook (#813). Copied into the plugin so asar cannot
 * break require. Deny JSON; ask is deny (--force does not enforce ask),
 * except on a Full access thread (#1853).
 */

const {
  hookGuardrailDecision,
  runStdinHook,
} = require("./guardrail-hook-core.js");

runStdinHook((payload) => {
  const worktree = process.env.SOLENTA_WORKTREE || process.cwd();
  const out = hookGuardrailDecision(payload, worktree);
  if (out.decision === "deny") {
    return {
      permission: "deny",
      user_message: out.message,
      agent_message: out.message,
    };
  }
  return { permission: "allow" };
});
