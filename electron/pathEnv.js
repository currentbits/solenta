"use strict";

const fs = require("node:fs");
const os = require("node:os");
const { execFile, execFileSync } = require("node:child_process");

/**
 * GUI apps on macOS launch with a bare launchd PATH (/usr/bin:/bin:...), so
 * `which claude` fails in the packaged app even when every CLI is installed.
 * Dev works because the terminal's PATH is inherited. This module rebuilds a
 * real user PATH at startup:
 *   1. PATH captured from the user's login shell (covers nvm/volta/mise and
 *      anything else rc files set up),
 *   2. the existing process PATH (kept; launchd entries and whatever the
 *      embedding environment set),
 *   3. well-known bin dirs that exist on disk (homebrew, ~/.local/bin, ...).
 * Everything is best-effort: a slow or noisy shell costs one 3s timeout, not
 * a startup failure.
 */

const SHELL_TIMEOUT_MS = 3000;
const MARK_BEGIN = "__CODER_PATH_BEGIN__";
const MARK_END = "__CODER_PATH_END__";

/**
 * Parse PATH entries out of login-shell output between the markers. rc files
 * may print arbitrary noise around them; without both markers we take nothing.
 *
 * @param {string} out
 * @returns {string[] | null}
 */
function parseLoginPath(out) {
  const text = String(out || "");
  const begin = text.indexOf(MARK_BEGIN);
  const end = text.indexOf(MARK_END, begin + MARK_BEGIN.length);
  if (begin === -1 || end === -1) return null;
  const raw = text.slice(begin + MARK_BEGIN.length, end);
  const entries = raw.split(":").filter(Boolean);
  return entries.length > 0 ? entries : null;
}

/** Well-known bin dirs, filtered to those that exist. */
function fallbackBinDirs(home, existsFn = fs.existsSync) {
  const candidates = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.local/bin`,
    `${home}/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.volta/bin`,
    `${home}/.bun/bin`,
    `${home}/.deno/bin`,
    `${home}/.asdf/shims`,
    `${home}/.local/share/mise/shims`,
    `${home}/.grok/bin`,
    `${home}/.kimi-code/bin`,
  ];
  // nvm installs live under a versioned dir; take the newest version's bin.
  const nvmBin = newestNvmBin(home);
  if (nvmBin) candidates.push(nvmBin);
  return candidates.filter((d) => {
    try {
      return existsFn(d);
    } catch {
      return false;
    }
  });
}

/**
 * Newest ~/.nvm/versions/node/<vX.Y.Z>/bin, or null. Version compare is
 * numeric per dotted part so v26 beats v9.
 *
 * @param {string} home
 * @returns {string | null}
 */
function newestNvmBin(home) {
  const versionsDir = `${home}/.nvm/versions/node`;
  let names;
  try {
    names = fs.readdirSync(versionsDir);
  } catch {
    return null;
  }
  const versions = names.filter((n) => /^v\d+(\.\d+)*$/.test(n));
  if (versions.length === 0) return null;
  versions.sort((a, b) => {
    const pa = a.slice(1).split(".").map(Number);
    const pb = b.slice(1).split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  return `${versionsDir}/${versions[versions.length - 1]}/bin`;
}

/**
 * PATH from the user's login shell, or null on any failure (missing SHELL,
 * timeout, rc noise swallowing the markers).
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof execFileSync} [execFn] - test hook
 * @param {NodeJS.Platform} [platform]
 * @returns {string[] | null}
 */
function captureLoginPath(env, execFn = execFileSync, platform = process.platform) {
  // Windows GUI apps inherit the user's PATH. There is no login shell of
  // the macOS/launchd kind; spawning SHELL || /bin/zsh would only fail
  // closed after SHELL_TIMEOUT_MS. Honest no-op, not a pretend try.
  if (platform === "win32") return null;
  try {
    return parseLoginPath(execFn(...loginShellCall(env)));
  } catch {
    return null;
  }
}

/** @param {NodeJS.ProcessEnv} env */
function loginShellCall(env) {
  return /** @type {const} */ ([
    env.SHELL || "/bin/zsh",
    ["-lic", `printf '%s' '${MARK_BEGIN}'"$PATH"'${MARK_END}'`],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SHELL_TIMEOUT_MS,
      env,
    },
  ]);
}

/**
 * captureLoginPath without blocking the event loop (#1475): the user's rc
 * files cost ~0.7 s on a typical oh-my-zsh/nvm setup. Never rejects.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof execFile} [execFn] - test hook, execFile-shaped
 * @param {NodeJS.Platform} [platform]
 * @returns {Promise<string[] | null>}
 */
function captureLoginPathAsync(env, execFn = execFile, platform = process.platform) {
  if (platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const [file, args, opts] = loginShellCall(env);
      execFn(file, args, opts, (err, stdout) => {
        resolve(err ? null : parseLoginPath(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Order-preserving dedupe of path entries across lists, earlier lists win.
 * @param {...string[]} lists
 * @returns {string[]}
 */
function mergePathEntries(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const entry of list) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Rebuild process.env.PATH for a GUI launch. Login-shell entries first (user
 * intent), then the current PATH, then existing fallback dirs. No-op entries
 * are skipped silently; the result always contains at least the old PATH.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof execFileSync} [opts.execFn]
 * @param {(p: string) => boolean} [opts.existsFn]
 * @param {string} [opts.home]
 * @param {NodeJS.Platform} [opts.platform]
 * @returns {{ source: "login-shell" | "fallback" | "win32", entries: number }}
 */
function enrichProcessPath(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  if (platform === "win32") {
    // ponytail: do not split PATH on ':'. Windows uses ';' and a drive
    // letter would become a fake entry (`C`). Leave PATH alone.
    const n = String(env.PATH || "").split(";").filter(Boolean).length;
    return { source: "win32", entries: n };
  }
  const home = opts.home || os.homedir();
  const current = String(env.PATH || "").split(":").filter(Boolean);
  const login = captureLoginPath(env, opts.execFn, platform);
  const fallback = fallbackBinDirs(home, opts.existsFn);
  const merged = login
    ? mergePathEntries(login, current, fallback)
    : mergePathEntries(current, fallback);
  env.PATH = merged.join(":");
  return { source: login ? "login-shell" : "fallback", entries: merged.length };
}

/**
 * Boot-time PATH state (#1475). primeProcessPath applies the login PATH the
 * last launch captured, synchronously and without a shell; refreshLoginPath
 * re-captures it in the background and rewrites the cache. Spawns that need
 * the real PATH await whenPathReady() first, so a fresh install (no cache)
 * or a changed rc file still gets the shell's PATH.
 *
 * @type {null | { env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform, launch: string[], cacheFile: string, execFn?: typeof execFile, existsFn?: (p: string) => boolean }}
 */
let primed = null;
/** @type {Promise<string[] | null> | null} */
let refreshing = null;
let refreshed = false;

/** @param {string} file @returns {string[] | null} */
function readCachedPath(file) {
  try {
    const entries = JSON.parse(fs.readFileSync(file, "utf8")).path;
    if (!Array.isArray(entries)) return null;
    const clean = entries.filter((e) => typeof e === "string" && e);
    return clean.length > 0 ? clean : null;
  } catch {
    return null;
  }
}

/**
 * Same result shape as enrichProcessPath, from the cached login PATH instead
 * of a blocking shell. Arms refreshLoginPath / whenPathReady.
 *
 * @param {object} opts
 * @param {string} opts.cacheFile
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof execFile} [opts.execFn]
 * @param {(p: string) => boolean} [opts.existsFn]
 * @param {string} [opts.home]
 * @param {NodeJS.Platform} [opts.platform]
 * @returns {{ source: "cache" | "fallback" | "win32", entries: number }}
 */
function primeProcessPath(opts) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  primed = null;
  refreshing = null;
  refreshed = false;
  if (platform === "win32") {
    const r = enrichProcessPath({ env, platform });
    return { source: "win32", entries: r.entries };
  }
  const home = opts.home || os.homedir();
  const launch = String(env.PATH || "").split(":").filter(Boolean);
  const cached = readCachedPath(opts.cacheFile);
  const merged = mergePathEntries(
    cached || [],
    launch,
    fallbackBinDirs(home, opts.existsFn),
  );
  env.PATH = merged.join(":");
  primed = {
    env,
    home,
    platform,
    launch,
    cacheFile: opts.cacheFile,
    execFn: opts.execFn,
    existsFn: opts.existsFn,
  };
  return { source: cached ? "cache" : "fallback", entries: merged.length };
}

/**
 * Start (once) the background login-shell capture. On success PATH becomes
 * login + launch PATH + fallback dirs, exactly what enrichProcessPath built,
 * and the cache is rewritten. On failure the primed PATH stays. Never rejects.
 *
 * @returns {Promise<string[] | null>}
 */
function refreshLoginPath() {
  if (!primed) return Promise.resolve(null);
  if (!refreshing) {
    const p = primed;
    refreshing = captureLoginPathAsync(p.env, p.execFn, p.platform)
      .then((login) => {
        if (login) {
          p.env.PATH = mergePathEntries(
            login,
            p.launch,
            fallbackBinDirs(p.home, p.existsFn),
          ).join(":");
          try {
            fs.writeFileSync(p.cacheFile, JSON.stringify({ path: login }));
          } catch {
            // next launch just re-captures
          }
        }
        return login;
      })
      .catch(() => null)
      .finally(() => {
        refreshed = true;
      });
  }
  return refreshing;
}

/**
 * The in-flight (or not yet started) capture to await before a provider
 * spawn, or null once it has settled or when nothing was primed (tests,
 * win32), so callers skip the await and keep their synchronous prefix.
 *
 * @returns {Promise<unknown> | null}
 */
function whenPathReady() {
  if (!primed || refreshed) return null;
  return refreshLoginPath();
}

module.exports = {
  enrichProcessPath,
  primeProcessPath,
  refreshLoginPath,
  whenPathReady,
  captureLoginPath,
  captureLoginPathAsync,
  parseLoginPath,
  fallbackBinDirs,
  newestNvmBin,
  mergePathEntries,
  SHELL_TIMEOUT_MS,
};
