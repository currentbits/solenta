"use strict";

/**
 * OpenCode tool.execute.before plugin (#813). Copied into
 * OPENCODE_CONFIG_DIR/plugins. Throw denies; ask is deny (no native prompt),
 * except on a Full access thread (#1853).
 */

const { hookGuardrailDecision } = require("./guardrail-hook-core.js");

module.exports = async function solentaGuardrailPlugin() {
  return {
    "tool.execute.before": async (input, output) => {
      const worktree = process.env.SOLENTA_WORKTREE || process.cwd();
      const out = hookGuardrailDecision(
        { tool: input && input.tool, args: output && output.args },
        worktree,
      );
      if (out.decision === "deny") {
        throw new Error(out.message);
      }
    },
  };
};
