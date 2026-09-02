"use strict";

/**
 * Cursor classifyTool plugin (#813).
 *
 * cursor-agent `-p --force` auto-allows unless a hook explicitly denies.
 * A second --plugin-dir (alongside #686 pin-task-parent) registers
 * preToolUse for every tool. Ask is deny: Cursor does not enforce ask
 * under --force.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { copyGuardrailRuntime } = require("./guardrail-hook-core.js");
const { guardrailsEnabled } = require("./guardrails.js");
const {
  remoteOverlayDest,
  probeRemoteHome,
  writeRemoteOverlay,
} = require("./remote-overlay.js");

const PLUGIN_NAME = "solenta-guardrails";
const USER_DATA_DIR = "cursor-guardrails";
const TMP_DIR_NAME = "solenta-cursor-guardrails";

/**
 * @param {string} [userDataPath]
 * @returns {string}
 */
function cursorGuardrailPluginDir(userDataPath) {
  const base = userDataPath == null ? "" : String(userDataPath).trim();
  if (base) return path.resolve(path.join(base, USER_DATA_DIR));
  return path.resolve(path.join(os.tmpdir(), TMP_DIR_NAME));
}

/**
 * @param {string} destDir
 * @returns {string} absolute destDir
 */
function materializeCursorGuardrailPlugin(destDir) {
  const dest = path.resolve(String(destDir || ""));
  if (!dest) throw new Error("materializeCursorGuardrailPlugin: destDir required");

  const scriptsDir = path.join(dest, "scripts");
  copyGuardrailRuntime(scriptsDir);
  const scriptRel = path.join("scripts", "guardrail-hook.js");
  const scriptPath = path.join(dest, scriptRel);
  fs.copyFileSync(
    path.join(__dirname, "cursor-guardrail-hook.js"),
    scriptPath,
  );
  try {
    fs.chmodSync(scriptPath, 0o755);
  } catch {
    // win32
  }

  fs.mkdirSync(path.join(dest, ".cursor-plugin"), { recursive: true });
  fs.mkdirSync(path.join(dest, "hooks"), { recursive: true });

  fs.writeFileSync(
    path.join(dest, ".cursor-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: PLUGIN_NAME,
        version: "1.0.0",
        description: "Solenta classifyTool deny/ask for Cursor tools",
        hooks: "./hooks/hooks.json",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const command = "node " + JSON.stringify(scriptPath);
  fs.writeFileSync(
    path.join(dest, "hooks", "hooks.json"),
    JSON.stringify(
      {
        version: 1,
        hooks: {
          preToolUse: [
            {
              command,
              timeout: 5,
            },
          ],
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return dest;
}

/**
 * Plugin files for a dest whose hook command uses posix `node`.
 * @param {string} dest  posix dest on the far side
 * @returns {Record<string, string>}
 */
function cursorGuardrailPluginFiles(dest) {
  const scriptPath = `${dest}/scripts/guardrail-hook.js`;
  const command = `node ${JSON.stringify(scriptPath)}`;
  return {
    ".cursor-plugin/plugin.json":
      JSON.stringify(
        {
          name: PLUGIN_NAME,
          version: "1.0.0",
          description: "Solenta classifyTool deny/ask for Cursor tools",
          hooks: "./hooks/hooks.json",
        },
        null,
        2,
      ) + "\n",
    "hooks/hooks.json":
      JSON.stringify(
        {
          version: 1,
          hooks: {
            preToolUse: [{ command, timeout: 5 }],
          },
        },
        null,
        2,
      ) + "\n",
    "scripts/guardrail-hook.js": fs.readFileSync(
      path.join(__dirname, "cursor-guardrail-hook.js"),
      "utf8",
    ),
    "scripts/guardrails.js": fs.readFileSync(
      path.join(__dirname, "guardrails.js"),
      "utf8",
    ),
    "scripts/guardrail-hook-core.js": fs.readFileSync(
      path.join(__dirname, "guardrail-hook-core.js"),
      "utf8",
    ),
  };
}

/**
 * Deploy the #813 classifyTool plugin onto an ssh/WSL host (#834).
 * Returns the remote --plugin-dir path, or null when skipped.
 *
 * @param {object} opts
 * @param {{ remoteHost?: string, path?: string } | null} opts.project
 * @param {string} opts.threadId
 * @returns {string | null}
 */
function deployCursorGuardrailPlugin(opts) {
  const project = opts && opts.project;
  const threadId = opts && opts.threadId;
  if (!project || !threadId) return null;
  if (!guardrailsEnabled()) return null;
  const dest = remoteOverlayDest(
    probeRemoteHome(project),
    threadId,
    "cursor-guardrails",
  );
  if (!dest) throw new Error("remote cursor plugin dest unusable");
  writeRemoteOverlay(project, dest, cursorGuardrailPluginFiles(dest));
  return dest;
}

module.exports = {
  PLUGIN_NAME,
  USER_DATA_DIR,
  TMP_DIR_NAME,
  cursorGuardrailPluginDir,
  materializeCursorGuardrailPlugin,
  cursorGuardrailPluginFiles,
  deployCursorGuardrailPlugin,
};
