"use strict";

/**
 * Codex classifyTool overlay (#813).
 *
 * `codex exec` has no control_request. PreToolUse in an isolated
 * CODEX_HOME is the pre-exec gate. Ask is deny: Codex parses ask then
 * continues the tool. --dangerously-bypass-hook-trust is added by the
 * runner so noninteractive exec does not skip an untrusted hook.
 */

const fs = require("node:fs");
const path = require("node:path");
const { copyGuardrailRuntime } = require("./guardrail-hook-core.js");

function linkOrSkip(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return;
  try {
    fs.symlinkSync(src, dst);
  } catch {
    // Windows without symlink privilege: overlay still holds; auth/resume
    // just will not share with the user's real home.
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dest
 * @param {string} [opts.sourceHome]
 * @returns {string} dest
 */
function materializeCodexGuardrailHome(opts) {
  const dest = path.resolve(String((opts && opts.dest) || ""));
  if (!dest) throw new Error("materializeCodexGuardrailHome: dest required");
  fs.mkdirSync(dest, { recursive: true });

  const sourceHome = String((opts && opts.sourceHome) || "");
  if (sourceHome && fs.existsSync(sourceHome)) {
    let names = [];
    try {
      names = fs.readdirSync(sourceHome);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name || name === "hooks.json" || name !== path.basename(name)) {
        continue;
      }
      linkOrSkip(path.join(sourceHome, name), path.join(dest, name));
    }
  }

  const hookDir = path.join(dest, "solenta-hooks");
  copyGuardrailRuntime(hookDir);
  const scriptPath = path.join(hookDir, "guardrail-hook.js");
  fs.copyFileSync(
    path.join(__dirname, "codex-guardrail-hook.js"),
    scriptPath,
  );
  try {
    fs.chmodSync(scriptPath, 0o755);
  } catch {
    // win32
  }

  const command = "node " + JSON.stringify(scriptPath);
  fs.writeFileSync(
    path.join(dest, "hooks.json"),
    JSON.stringify(
      {
        description: "Solenta classifyTool PreToolUse (#813)",
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command,
                  timeout: 10,
                  statusMessage: "Solenta guardrails",
                },
              ],
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

module.exports = {
  materializeCodexGuardrailHome,
};
