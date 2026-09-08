"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { wslTarget } = require("./wsl.js");

const REMOTE_OVERLAY = "/tmp/solenta-dev-homes";

/**
 * Safe directory name for a thread id. Drops path separators and `..`.
 * @param {unknown} id
 * @returns {string}
 */
function safeId(id) {
  const raw = String(id || "thread")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  return raw || "thread";
}

/**
 * @param {unknown} project
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
function isRemoteProject(project, platform) {
  if (!project || typeof project !== "object") return false;
  if (typeof project.remoteHost === "string" && project.remoteHost.trim()) {
    return true;
  }
  return Boolean(wslTarget(project, platform));
}

/**
 * Per-project env map (#188). Invalid names, non-strings, and PATH
 * (which would clobber the login-shell PATH) are dropped.
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function normalizeProjectEnv(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (k === "PATH") continue;
    if (typeof v !== "string") continue;
    out[k] = v;
  }
  return out;
}

/**
 * Data-dir (+ optional identity) overlay for a thread's dev server.
 * Does not set PORT — that is mergeQueue.laneEnv (#346).
 *
 * @param {{
 *   threadId?: string,
 *   worktreePath?: string,
 *   userDataPath?: string,
 *   project?: { name?: string, path?: string, remoteHost?: string, remotePath?: string, iconPath?: string } | null,
 *   identity?: boolean | { name?: string, icon?: string },
 *   platform?: NodeJS.Platform,
 * }} [opts]
 * @returns {Record<string, string>}
 */
function isolationEnv(opts = {}) {
  const platform = opts.platform || process.platform;
  const threadId = String(opts.threadId || "");
  const slug = safeId(threadId);
  const project = opts.project || {};
  const remote = isRemoteProject(project, platform);
  /** @type {Record<string, string>} */
  const env = {};
  if (threadId) env.SOLENTA_THREAD_ID = threadId;
  if (opts.worktreePath) env.SOLENTA_WORKTREE = String(opts.worktreePath);

  let dataRoot = "";
  if (remote) {
    dataRoot = path.posix.join(REMOTE_OVERLAY, slug);
  } else if (opts.userDataPath) {
    dataRoot = path.join(opts.userDataPath, "dev-homes", slug);
  }
  if (dataRoot) {
    const join = remote ? path.posix.join.bind(path.posix) : path.join;
    env.SOLENTA_DATA_DIR = dataRoot;
    env.XDG_DATA_HOME = join(dataRoot, "share");
    env.XDG_CONFIG_HOME = join(dataRoot, "config");
    env.XDG_CACHE_HOME = join(dataRoot, "cache");
    env.XDG_STATE_HOME = join(dataRoot, "state");
    env.TMPDIR = join(dataRoot, "tmp");
    if (!remote && platform === "win32") {
      env.APPDATA = path.join(dataRoot, "AppData", "Roaming");
      env.LOCALAPPDATA = path.join(dataRoot, "AppData", "Local");
      env.TEMP = env.TMPDIR;
      env.TMP = env.TMPDIR;
    }
  }

  const identity = opts.identity;
  if (identity) {
    const givenName = typeof identity === "object" ? identity.name : "";
    const name = givenName || project.name;
    if (name) env.SOLENTA_APP_NAME = `${name} · ${threadId.slice(0, 8)}`;
    const icon = typeof identity === "object" ? identity.icon : "";
    if (icon) {
      try {
        if (fs.existsSync(icon)) env.SOLENTA_APP_ICON = icon;
      } catch {
        // ignore
      }
    }
  }
  return env;
}

/**
 * project.env (#188) then isolation then extra (lane PORT wins).
 *
 * @param {{
 *   projectEnv?: unknown,
 *   isolation?: Record<string, string>,
 *   extra?: Record<string, string>,
 * }} [opts]
 * @returns {Record<string, string>}
 */
function mergeDevServerEnv(opts = {}) {
  return {
    ...normalizeProjectEnv(opts.projectEnv),
    ...(opts.isolation || {}),
    ...(opts.extra || {}),
  };
}

/**
 * True when the overlay lives on the far side of ssh/WSL.
 * @param {Record<string, string> | null | undefined} env
 */
function isRemoteOverlay(env) {
  const dir = env && env.SOLENTA_DATA_DIR;
  return (
    typeof dir === "string" &&
    (dir === REMOTE_OVERLAY || dir.startsWith(`${REMOTE_OVERLAY}/`))
  );
}

/**
 * mkdir the local overlay dirs. Remote `/tmp/solenta-dev-homes` is left
 * for the far side — we cannot create it from this host.
 *
 * @param {Record<string, string> | null | undefined} env
 */
function ensureIsolationDirs(env) {
  if (!env || isRemoteOverlay(env)) return;
  const keys = [
    "SOLENTA_DATA_DIR",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "TMPDIR",
    "APPDATA",
    "LOCALAPPDATA",
  ];
  for (const key of keys) {
    const dir = env[key];
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // best-effort; the app may create it on first write
    }
  }
}

/**
 * Resolve a project.iconPath against the checkout. Absolute paths stay
 * as-is; missing files return "".
 *
 * @param {{ path?: string, iconPath?: string } | null | undefined} project
 * @returns {string}
 */
function resolveProjectIcon(project) {
  if (!project || typeof project.iconPath !== "string" || !project.iconPath.trim()) {
    return "";
  }
  const raw = project.iconPath.trim();
  const full = path.isAbsolute(raw)
    ? raw
    : project.path
      ? path.join(project.path, raw)
      : "";
  if (!full) return "";
  try {
    return fs.existsSync(full) ? full : "";
  } catch {
    return "";
  }
}

/**
 * PORT overlay from a claimed merge-queue lane (#346). Missing
 * mergeQueue.js is not an error — this tree may land isolation first.
 *
 * @param {{ lane?: { n?: number, port?: number, portBase?: number } } | null | undefined} thread
 * @returns {Record<string, string>}
 */
function laneEnvExtra(thread) {
  const lane = thread && thread.lane;
  if (!lane || typeof lane !== "object") return {};
  const n = Number(lane.n);
  if (!Number.isInteger(n) || n < 1) return {};
  try {
    const { laneEnv } = require("./mergeQueue.js");
    if (typeof laneEnv !== "function") return {};
    const port = Number(lane.port);
    const portBase =
      lane.portBase != null
        ? lane.portBase
        : Number.isInteger(port) && port > n
          ? port - n
          : undefined;
    return laneEnv(n, portBase);
  } catch {
    return {};
  }
}

const CHROMIUM_CMD_RE =
  /\b(electron|chromium|google-chrome|chrome|msedge|brave)(\.exe|\.cmd)?\b/i;

/**
 * True when a package.json script or argv looks like Electron/Chromium.
 * `chromedriver` is not a match (`chrome` is a whole token).
 *
 * @param {unknown} text
 */
function looksLikeChromiumCommand(text) {
  return CHROMIUM_CMD_RE.test(String(text || ""));
}

/**
 * Chromium profile dir for a lane. Lives under SOLENTA_DATA_DIR so two
 * claimed lanes do not share cookies / localStorage. Remote overlays
 * stay posix.
 *
 * @param {Record<string, string> | null | undefined} env
 * @returns {string}
 */
function chromiumUserDataDir(env) {
  const dataDir = env && env.SOLENTA_DATA_DIR;
  if (!dataDir || typeof dataDir !== "string") return "";
  if (isRemoteOverlay(env)) return path.posix.join(dataDir, "chrome-profile");
  return path.join(dataDir, "chrome-profile");
}

/**
 * Extra argv for a detected Electron/Chromium child.
 *
 * @param {Record<string, string> | null | undefined} env
 * @param {unknown} command
 * @returns {string[]}
 */
function chromiumSpawnArgs(env, command) {
  const dir = chromiumUserDataDir(env);
  if (!dir || !looksLikeChromiumCommand(command)) return [];
  return [`--user-data-dir=${dir}`];
}

/**
 * @param {unknown[]} args
 * @param {unknown} command
 */
function hasUserDataDir(args, command) {
  if (
    (Array.isArray(args) ? args : []).some(
      (a) =>
        String(a) === "--user-data-dir" ||
        String(a).startsWith("--user-data-dir="),
    )
  ) {
    return true;
  }
  return /--user-data-dir(?:=|\s)/.test(String(command || ""));
}

/**
 * `npm run <script>` argv, with or without the npm binary (raw start()
 * args are just `run`, script). Also matches a WSL-wrapped npm run.
 *
 * @param {unknown[]} args
 */
function isNpmRunArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  if (args[0] === "run") return true;
  const run = args.lastIndexOf("run");
  if (run < 1) return false;
  const bin = String(args[run - 1] || "");
  return /(?:^|[/\\])npm(?:\.cmd|\.exe)?$/i.test(bin);
}

const PROCESS_WRAPPER_RE =
  /\b(concurrently|npm-run-all2?|run-p|run-s)(?:\.cmd|\.exe)?\b/i;

/**
 * True when a package.json script launches children through concurrently
 * (or similar). Extra argv after `npm run --` land on the wrapper, not
 * the inner Electron/Chromium child.
 *
 * @param {unknown} text
 */
function looksLikeProcessWrapper(text) {
  return PROCESS_WRAPPER_RE.test(String(text || ""));
}

/**
 * Put `--user-data-dir` on inner Electron/Chromium tokens inside a
 * wrapper script body (`concurrently "vite" "electron ."`). Vite stays
 * untouched. Direct `electron .` scripts keep the argv path.
 *
 * @param {unknown} script
 * @param {Record<string, string> | null | undefined} env
 * @returns {string}
 */
function rewriteChromiumScriptBody(script, env) {
  const body = String(script || "");
  const dir = chromiumUserDataDir(env);
  if (!dir || !body || !looksLikeChromiumCommand(body)) return body;
  if (hasUserDataDir([], body)) return body;
  return body.replace(/(["'])((?:\\.|[^\\])*?)\1/g, (full, quote, inner) => {
    if (!looksLikeChromiumCommand(inner) || hasUserDataDir([], inner)) {
      return full;
    }
    const flag = /[\s'"\\]/.test(dir)
      ? quote === '"'
        ? `--user-data-dir='${String(dir).replace(/'/g, `'\\''`)}'`
        : `--user-data-dir="${String(dir).replace(/"/g, '\\"')}"`
      : `--user-data-dir=${dir}`;
    return `${quote}${inner.replace(/\s+$/, "")} ${flag}${quote}`;
  });
}

/**
 * Append `--user-data-dir` for a Chromium-like child. Adds `--` before
 * the flag when the argv is `npm run` so npm forwards it to the script.
 * Wrapper scripts (concurrently / npm-run-all / run-p) skip the append:
 * those extras never reach the inner child — rewrite the script body.
 *
 * @param {unknown[]} args
 * @param {Record<string, string> | null | undefined} env
 * @param {unknown} command
 * @returns {string[]}
 */
function withChromiumUserDataDir(args, env, command) {
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  if (looksLikeProcessWrapper(command) && looksLikeChromiumCommand(command)) {
    return list;
  }
  const extra = chromiumSpawnArgs(env, command);
  if (!extra.length || hasUserDataDir(list, command)) return list;
  if (isNpmRunArgs(list)) {
    const run = list.lastIndexOf("run");
    const afterScript = list.slice(run + 2);
    if (!afterScript.includes("--")) list.push("--");
  }
  list.push(...extra);
  return list;
}

const ELECTRON_CMD_RE = /\belectron(\.exe|\.cmd)?\b/i;

/**
 * True when a package.json script or argv is Electron itself.
 * Chrome/Chromium still get --user-data-dir, but not a stub .app.
 *
 * @param {unknown} text
 */
function looksLikeElectronCommand(text) {
  return ELECTRON_CMD_RE.test(String(text || ""));
}

/**
 * Per-lane stub .app so macOS dock / Spotlight / menu read CFBundleName
 * from this lane instead of the shared Electron.app.
 *
 * @param {Record<string, string> | null | undefined} env
 * @returns {string}
 */
function electronIdentityBundleDir(env) {
  const dataDir = env && env.SOLENTA_DATA_DIR;
  if (!dataDir || typeof dataDir !== "string") return "";
  if (isRemoteOverlay(env)) return path.posix.join(dataDir, "Electron.app");
  return path.join(dataDir, "Electron.app");
}

/**
 * @param {Record<string, string> | null | undefined} env
 * @returns {string}
 */
function electronIdentityBinDir(env) {
  const dataDir = env && env.SOLENTA_DATA_DIR;
  if (!dataDir || typeof dataDir !== "string") return "";
  if (isRemoteOverlay(env)) return path.posix.join(dataDir, "bin");
  return path.join(dataDir, "bin");
}

/**
 * @param {unknown} value
 */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Write a darwin stub .app whose Info.plist carries SOLENTA_APP_NAME
 * (and optional icon). Returns the bundle path, or "".
 *
 * @param {Record<string, string> | null | undefined} env
 * @param {{ platform?: NodeJS.Platform }} [opts]
 * @returns {string}
 */
function materializeElectronIdentity(env, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== "darwin") return "";
  if (!env || isRemoteOverlay(env)) return "";
  const name = env.SOLENTA_APP_NAME;
  const dataDir = env.SOLENTA_DATA_DIR;
  if (!name || !dataDir) return "";
  const bundle = electronIdentityBundleDir(env);
  const binDir = electronIdentityBinDir(env);
  if (!bundle || !binDir) return "";
  const macos = path.join(bundle, "Contents", "MacOS");
  const resources = path.join(bundle, "Contents", "Resources");
  try {
    fs.mkdirSync(macos, { recursive: true });
    fs.mkdirSync(resources, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
  } catch {
    return "";
  }
  const threadSlug = safeId(env.SOLENTA_THREAD_ID || path.basename(dataDir));
  const iconSrc = env.SOLENTA_APP_ICON;
  let iconFile = "";
  if (iconSrc) {
    try {
      if (fs.existsSync(iconSrc)) {
        iconFile = "app.icns";
        fs.copyFileSync(iconSrc, path.join(resources, iconFile));
      }
    } catch {
      iconFile = "";
    }
  }
  const iconXml = iconFile
    ? `  <key>CFBundleIconFile</key>\n  <string>${xmlEscape(iconFile)}</string>\n`
    : "";
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${xmlEscape(name)}</string>
  <key>CFBundleDisplayName</key>
  <string>${xmlEscape(name)}</string>
  <key>CFBundleIdentifier</key>
  <string>dev.solenta.lane.${xmlEscape(threadSlug)}</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
${iconXml}</dict>
</plist>
`;
  const launcher = path.join(macos, "launcher");
  const shim = path.join(binDir, "electron");
  const launcherBody = `#!/bin/sh
SHIM="\${SOLENTA_ELECTRON_SHIM_DIR:-}"
if [ -n "$SHIM" ]; then
  PATH_CLEAN=""
  OLD_IFS="$IFS"
  IFS=":"
  for part in $PATH; do
    if [ "$part" != "$SHIM" ]; then
      if [ -z "$PATH_CLEAN" ]; then
        PATH_CLEAN="$part"
      else
        PATH_CLEAN="$PATH_CLEAN:$part"
      fi
    fi
  done
  IFS="$OLD_IFS"
  export PATH="$PATH_CLEAN"
fi
exec electron "$@"
`;
  const shimBody = `#!/bin/sh
exec "${launcher.replace(/"/g, '\\"')}" "$@"
`;
  try {
    fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), plist);
    fs.writeFileSync(launcher, launcherBody, { mode: 0o755 });
    fs.writeFileSync(shim, shimBody, { mode: 0o755 });
    fs.chmodSync(launcher, 0o755);
    fs.chmodSync(shim, 0o755);
  } catch {
    return "";
  }
  return bundle;
}

/**
 * Prepend a per-lane \`electron\` shim to PATH so \`npm run\` launches the
 * stub .app (dock / Spotlight / menu name) instead of the shared binary.
 *
 * @param {Record<string, string> | null | undefined} env
 * @param {unknown} command
 * @param {{ platform?: NodeJS.Platform, path?: string }} [opts]
 * @returns {Record<string, string>}
 */
function electronIdentityEnv(env, command, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== "darwin") return {};
  if (!looksLikeElectronCommand(command)) return {};
  if (!env || !env.SOLENTA_APP_NAME || isRemoteOverlay(env)) return {};
  const bundle = materializeElectronIdentity(env, { platform });
  if (!bundle) return {};
  const binDir = electronIdentityBinDir(env);
  if (!binDir) return {};
  const basePath = opts.path != null ? String(opts.path) : process.env.PATH || "";
  return {
    PATH: `${binDir}${path.delimiter}${basePath}`,
    SOLENTA_ELECTRON_SHIM_DIR: binDir,
  };
}

/**
 * Overlay ready to pass as `devservers.start(..., { env })`.
 *
 * @param {{
 *   project?: { name?: string, path?: string, env?: unknown, iconPath?: string, remoteHost?: string, remotePath?: string } | null,
 *   thread?: { id?: string, worktreePath?: string } | null,
 *   userDataPath?: string,
 *   extra?: Record<string, string>,
 *   identity?: boolean | { name?: string, icon?: string },
 *   platform?: NodeJS.Platform,
 * }} [opts]
 * @returns {Record<string, string>}
 */
function spawnEnvForDevServer(opts = {}) {
  const project = opts.project || {};
  const thread = opts.thread || {};
  const identity =
    opts.identity === false
      ? false
      : {
          ...(typeof opts.identity === "object" && opts.identity ? opts.identity : {}),
        };
  if (identity && !identity.icon) {
    const icon = resolveProjectIcon(project);
    if (icon) identity.icon = icon;
  }
  const isolation = isolationEnv({
    threadId: thread.id,
    worktreePath: thread.worktreePath || project.path || "",
    userDataPath: opts.userDataPath,
    project,
    identity,
    platform: opts.platform,
  });
  ensureIsolationDirs(isolation);
  return mergeDevServerEnv({
    projectEnv: project.env,
    isolation,
    extra: opts.extra,
  });
}

module.exports = {
  safeId,
  normalizeProjectEnv,
  isolationEnv,
  mergeDevServerEnv,
  ensureIsolationDirs,
  spawnEnvForDevServer,
  resolveProjectIcon,
  laneEnvExtra,
  looksLikeChromiumCommand,
  chromiumUserDataDir,
  chromiumSpawnArgs,
  withChromiumUserDataDir,
  looksLikeProcessWrapper,
  rewriteChromiumScriptBody,
  looksLikeElectronCommand,
  electronIdentityBundleDir,
  electronIdentityBinDir,
  materializeElectronIdentity,
  electronIdentityEnv,
  REMOTE_OVERLAY,
};
