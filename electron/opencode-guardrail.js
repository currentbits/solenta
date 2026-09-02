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
const { guardrailsEnabled } = require("./guardrails.js");
const {
  remoteOverlayDest,
  probeRemoteHome,
  writeRemoteOverlay,
} = require("./remote-overlay.js");

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

/**
 * Plugin files for a dest on the far side of wrapCommand.
 * @returns {Record<string, string>}
 */
function opencodeGuardrailPluginFiles() {
  return {
    "plugins/solenta-guardrail.js": fs.readFileSync(
      path.join(__dirname, "opencode-guardrail-plugin.js"),
      "utf8",
    ),
    "plugins/guardrails.js": fs.readFileSync(
      path.join(__dirname, "guardrails.js"),
      "utf8",
    ),
    "plugins/guardrail-hook-core.js": fs.readFileSync(
      path.join(__dirname, "guardrail-hook-core.js"),
      "utf8",
    ),
  };
}

/**
 * Deploy the #813 classifyTool plugin onto an ssh/WSL host (#835).
 * Returns the remote OPENCODE_CONFIG_DIR path, or null when skipped.
 *
 * @param {object} opts
 * @param {{ remoteHost?: string, path?: string } | null} opts.project
 * @param {string} opts.threadId
 * @returns {string | null}
 */
function deployOpencodeGuardrailOverlay(opts) {
  const project = opts && opts.project;
  const threadId = opts && opts.threadId;
  if (!project || !threadId) return null;
  if (!guardrailsEnabled()) return null;
  const dest = remoteOverlayDest(
    probeRemoteHome(project),
    threadId,
    "opencode-guardrails",
  );
  if (!dest) throw new Error("remote OPENCODE_CONFIG_DIR dest unusable");
  writeRemoteOverlay(project, dest, opencodeGuardrailPluginFiles());
  return dest;
}

module.exports = {
  materializeOpencodeGuardrailDir,
  opencodeGuardrailPluginFiles,
  deployOpencodeGuardrailOverlay,
};
