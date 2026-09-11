"use strict";

/**
 * Codex classifyTool overlay (#813).
 *
 * `codex exec` has no control_request. PreToolUse in an isolated
 * CODEX_HOME is the pre-exec gate. Ask is deny: Codex parses ask then
 * continues the tool. --dangerously-bypass-hook-trust is added by
 * workflow `codex exec` so noninteractive exec does not skip an
 * untrusted hook. Interactive `app-server` rejects that flag (#1309);
 * persist hooks.state trusted_hash in the isolated home instead (#1311).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { posixQuote } = require("./ssh.js");
const { copyGuardrailRuntime } = require("./guardrail-hook-core.js");
const { guardrailsEnabled } = require("./guardrails.js");
const { ensurePrivateWriterLockDir } = require("./codexWriterLock.js");
const {
  remoteOverlayDest,
  probeRemoteHome,
  writeRemoteOverlay,
} = require("./remote-overlay.js");

const OVERLAY_HOOK_TIMEOUT_SEC = 10;
const OVERLAY_HOOK_STATUS = "Solenta guardrails";
const OVERLAY_HOOK_MATCHER = "*";

function hookEventKeyLabel(eventName) {
  return String(eventName || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalJson(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Live Codex 0.153.4 `version_for_toml`: SHA-256 of canonical JSON
 * (sorted object keys) of a NormalizedHookIdentity.
 * @param {object} identity
 * @returns {string} sha256:<hex>
 */
function versionForIdentity(identity) {
  const hex = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalJson(identity)))
    .digest("hex");
  return `sha256:${hex}`;
}

/**
 * @param {object} opts
 * @param {string} [opts.eventName]
 * @param {string | null} [opts.matcher]
 * @param {string} opts.command
 * @param {number} opts.timeoutSec
 * @param {boolean} [opts.async]
 * @param {string | null} [opts.statusMessage]
 * @returns {string}
 */
function commandHookTrustedHash(opts) {
  const hook = {
    type: "command",
    command: String((opts && opts.command) || ""),
    timeout: Number(opts && opts.timeoutSec) || 0,
    async: !!(opts && opts.async),
  };
  if (opts && opts.statusMessage != null && opts.statusMessage !== "") {
    hook.statusMessage = String(opts.statusMessage);
  }
  /** @type {Record<string, unknown>} */
  const identity = {
    event_name: hookEventKeyLabel((opts && opts.eventName) || "PreToolUse"),
    hooks: [hook],
  };
  if (opts && opts.matcher != null) identity.matcher = String(opts.matcher);
  return versionForIdentity(identity);
}

/**
 * User-home hook key: `<realpath(hooks.json)>:<event>:<matcherIdx>:<hookIdx>`.
 * Plugin keys use `plugin@marketplace:rel:event:i:j` instead.
 * @param {string} hooksJsonPath
 * @param {string} eventName
 * @param {number} matcherIndex
 * @param {number} hookIndex
 * @returns {string}
 */
function hookTrustKey(hooksJsonPath, eventName, matcherIndex, hookIndex) {
  let resolved = path.resolve(String(hooksJsonPath || ""));
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // hooks.json not on disk yet; path.resolve is the unlinked form.
  }
  return `${resolved}:${hookEventKeyLabel(eventName)}:${Number(matcherIndex) || 0}:${Number(hookIndex) || 0}`;
}

function tomlQuotedKey(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * @param {object} opts
 * @param {string} opts.dest
 * @param {string} opts.command
 * @param {number} [opts.timeoutSec]
 * @param {string} [opts.statusMessage]
 * @param {string} [opts.eventName]
 * @param {string} [opts.matcher]
 * @returns {{ key: string, hash: string, toml: string }}
 */
function overlayHooksPath(dest) {
  const d = String(dest || "").replace(/[/\\]+$/, "");
  if (d.startsWith("/")) return `${d}/hooks.json`;
  return path.join(path.resolve(d), "hooks.json");
}

function hookTrustTomlBlock(opts) {
  const dest = String((opts && opts.dest) || "");
  const eventName = (opts && opts.eventName) || "PreToolUse";
  const matcher =
    opts && Object.prototype.hasOwnProperty.call(opts, "matcher")
      ? opts.matcher
      : OVERLAY_HOOK_MATCHER;
  const timeoutSec =
    opts && opts.timeoutSec != null ? opts.timeoutSec : OVERLAY_HOOK_TIMEOUT_SEC;
  const statusMessage =
    opts && opts.statusMessage != null ? opts.statusMessage : OVERLAY_HOOK_STATUS;
  const key = hookTrustKey(overlayHooksPath(dest), eventName, 0, 0);
  const hash = commandHookTrustedHash({
    eventName,
    matcher,
    command: opts && opts.command,
    timeoutSec,
    async: false,
    statusMessage,
  });
  const toml =
    `[hooks.state.${tomlQuotedKey(key)}]\n` + `trusted_hash = "${hash}"\n`;
  return { key, hash, toml };
}

function unlinkIfSymlink(p) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
  } catch {
    // missing
  }
}

/**
 * Copy the user's config.toml (do not symlink) and append overlay hook
 * trust so Codex 0.153.4 will run PreToolUse without the exec-only flag.
 * @param {string} dest
 * @param {string} [sourceHome]
 * @param {string} trustToml
 */
function writeOverlayConfigToml(dest, sourceHome, trustToml) {
  const destCfg = path.join(dest, "config.toml");
  unlinkIfSymlink(destCfg);
  let body = "";
  const sourceCfg = sourceHome ? path.join(sourceHome, "config.toml") : "";
  if (sourceCfg && fs.existsSync(sourceCfg)) {
    try {
      if (!fs.statSync(sourceCfg).isDirectory()) {
        body = fs.readFileSync(sourceCfg, "utf8");
      }
    } catch {
      body = "";
    }
  }
  if (body && !body.endsWith("\n")) body += "\n";
  if (body) body += "\n";
  fs.writeFileSync(destCfg, body + String(trustToml || ""), "utf8");
}

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
      // hooks.json is Solenta's PreToolUse (#813). thread-writer-locks is
      // Codex's single-writer flock dir: sharing it with ~/.codex means
      // Desktop (or another CLI) blocks Solenta resume (#950). config.toml
      // holds hooks.state: a symlink would write overlay trust into the
      // user's real home (#1311).
      if (
        !name ||
        name === "hooks.json" ||
        name === "config.toml" ||
        name === "thread-writer-locks" ||
        name !== path.basename(name)
      ) {
        continue;
      }
      linkOrSkip(path.join(sourceHome, name), path.join(dest, name));
    }
  }

  // Skip above does not repair overlays that already symlink this dir
  // onto ~/.codex (#1226). Always replace that leftover with a real dir.
  ensurePrivateWriterLockDir(dest);

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
  writeOverlayHooksJson(dest, command);
  const { toml } = hookTrustTomlBlock({
    dest,
    command,
    timeoutSec: OVERLAY_HOOK_TIMEOUT_SEC,
    statusMessage: OVERLAY_HOOK_STATUS,
    matcher: OVERLAY_HOOK_MATCHER,
  });
  writeOverlayConfigToml(dest, sourceHome, toml);

  return dest;
}

function overlayHooksJsonBody(command) {
  return (
    JSON.stringify(
      {
        description: "Solenta classifyTool PreToolUse (#813)",
        hooks: {
          PreToolUse: [
            {
              matcher: OVERLAY_HOOK_MATCHER,
              hooks: [
                {
                  type: "command",
                  command,
                  timeout: OVERLAY_HOOK_TIMEOUT_SEC,
                  statusMessage: OVERLAY_HOOK_STATUS,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function writeOverlayHooksJson(dest, command) {
  fs.writeFileSync(path.join(dest, "hooks.json"), overlayHooksJsonBody(command), "utf8");
}

/**
 * Overlay files for a dest whose hook command uses posix `node`.
 * @param {string} dest  posix dest on the far side
 * @returns {Record<string, string>}
 */
function codexGuardrailHomeFiles(dest) {
  const scriptPath = `${dest}/solenta-hooks/guardrail-hook.js`;
  const command = `node ${JSON.stringify(scriptPath)}`;
  return {
    "hooks.json": overlayHooksJsonBody(command),
    "solenta-hooks/guardrail-hook.js": fs.readFileSync(
      path.join(__dirname, "codex-guardrail-hook.js"),
      "utf8",
    ),
    "solenta-hooks/guardrails.js": fs.readFileSync(
      path.join(__dirname, "guardrails.js"),
      "utf8",
    ),
    "solenta-hooks/guardrail-hook-core.js": fs.readFileSync(
      path.join(__dirname, "guardrail-hook-core.js"),
      "utf8",
    ),
  };
}

/**
 * Deploy the #813 classifyTool overlay onto an ssh/WSL host (#835).
 * Returns the remote CODEX_HOME path, or null when skipped.
 *
 * @param {object} opts
 * @param {{ remoteHost?: string, path?: string } | null} opts.project
 * @param {string} opts.threadId
 * @returns {string | null}
 */
function deployCodexGuardrailOverlay(opts) {
  const project = opts && opts.project;
  const threadId = opts && opts.threadId;
  if (!project || !threadId) return null;
  if (!guardrailsEnabled()) return null;
  const dest = remoteOverlayDest(
    probeRemoteHome(project),
    threadId,
    "codex-homes",
  );
  if (!dest) throw new Error("remote CODEX_HOME dest unusable");
  const files = codexGuardrailHomeFiles(dest);
  const command = `node ${JSON.stringify(`${dest}/solenta-hooks/guardrail-hook.js`)}`;
  const { toml } = hookTrustTomlBlock({
    dest,
    command,
    timeoutSec: OVERLAY_HOOK_TIMEOUT_SEC,
    statusMessage: OVERLAY_HOOK_STATUS,
    matcher: OVERLAY_HOOK_MATCHER,
  });
  writeRemoteOverlay(project, dest, files, [
    `for f in auth.json sessions history.json; do src="$HOME/.codex/$f"; dst=${posixQuote(dest)}/"$f"; if [ -e "$src" ] && [ ! -e "$dst" ]; then ln -s "$src" "$dst"; fi; done`,
    `cfg=${posixQuote(dest)}/config.toml; if [ -e "$HOME/.codex/config.toml" ]; then cp "$HOME/.codex/config.toml" "$cfg"; else : > "$cfg"; fi; printf '%s\\n' ${posixQuote(toml.replace(/\n$/, ""))} >> "$cfg"`,
  ]);
  return dest;
}

module.exports = {
  materializeCodexGuardrailHome,
  codexGuardrailHomeFiles,
  deployCodexGuardrailOverlay,
  commandHookTrustedHash,
  hookTrustKey,
  hookTrustTomlBlock,
  hookEventKeyLabel,
};
