"use strict";

const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

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
  const shell = env.SHELL || "/bin/zsh";
  try {
    const out = execFn(
      shell,
      ["-lic", `printf '%s' '${MARK_BEGIN}'"$PATH"'${MARK_END}'`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: SHELL_TIMEOUT_MS,
        env,
      },
    );
    return parseLoginPath(out);
  } catch {
    return null;
  }
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

module.exports = {
  enrichProcessPath,
  captureLoginPath,
  parseLoginPath,
  fallbackBinDirs,
  newestNvmBin,
  mergePathEntries,
  SHELL_TIMEOUT_MS,
};
