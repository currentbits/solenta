"use strict";

/**
 * OpenCode classifyTool plugin (#813).
 *
 * `opencode run --auto` auto-approves non-denied permissions. The real
 * pre-exec gate is tool.execute.before. Loaded via OPENCODE_CONFIG_DIR
 * (not worktree .opencode/, which the agent can delete). Ask is deny:
 * the plugin cannot raise a native permission prompt.
 */

const fs = require("node:fs");
const path = require("node:path");
const { copyGuardrailRuntime } = require("./guardrail-hook-core.js");

/**
 * @param {string} destDir
 * @returns {string} dest
 */
function materializeOpencodeGuardrailDir(destDir) {
  const dest = path.resolve(String(destDir || ""));
  if (!dest) throw new Error("materializeOpencodeGuardrailDir: destDir required");

  const plugins = path.join(dest, "plugins");
  copyGuardrailRuntime(plugins);
  fs.copyFileSync(
    path.join(__dirname, "opencode-guardrail-plugin.js"),
    path.join(plugins, "solenta-guardrail.js"),
  );
  return dest;
}

module.exports = {
  materializeOpencodeGuardrailDir,
};
