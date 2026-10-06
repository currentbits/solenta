"use strict";

const { execFile } = require("node:child_process");
const { getProvider, resolveBin } = require("./providers.js");

/**
 * Provider CLI sign-in state (#1501 G1).
 *
 * Each probe is the CLI's own read-only status command, checked against
 * claude 2.1.283, codex 0.159.2, cursor-agent 2026.09.10 and opencode
 * 1.17.12 under a scratch HOME. grok, kimi and muse have no status command,
 * so they stay "unknown" instead of a guess.
 *
 * Results are cached. `refresh()` re-probes at most once per TTL_MS and
 * shares the inflight run, so opening the picker repeatedly costs nothing.
 */

const TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

/** @typedef {"signedIn" | "signedOut" | "unknown"} AuthState */

/**
 * @type {Record<string, {
 *   args: string[],
 *   parse: (r: { code: number | null, stdout: string, stderr: string }) => AuthState,
 *   keyEnv?: string[],
 * }>}
 */
const PROBES = {
  // JSON on stdout either way; exit 1 when signed out. Counts an API key too.
  claude: {
    args: ["auth", "status", "--json"],
    parse: ({ stdout }) => {
      const j = JSON.parse(stdout);
      if (j.loggedIn === true) return "signedIn";
      return j.loggedIn === false ? "signedOut" : "unknown";
    },
  },
  // "Logged in using ChatGPT" / exit 0, "Not logged in" / exit 1, on stderr.
  codex: {
    args: ["login", "status"],
    parse: ({ code, stdout, stderr }) => {
      const text = `${stdout}\n${stderr}`;
      if (/not logged in/i.test(text)) return "signedOut";
      return code === 0 && /logged in/i.test(text) ? "signedIn" : "unknown";
    },
    // The status command ignores these, but runs still authenticate with them.
    keyEnv: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  },
  cursor: {
    args: ["status", "--format", "json"],
    parse: ({ stdout }) => {
      const j = JSON.parse(stdout);
      if (j.isAuthenticated === true) return "signedIn";
      return j.isAuthenticated === false ? "signedOut" : "unknown";
    },
    keyEnv: ["CURSOR_API_KEY"],
  },
  // Only lists stored credentials. Zero may still mean env keys or free
  // models, so zero is "unknown", not signed out.
  opencode: {
    args: ["auth", "list"],
    parse: ({ stdout }) => {
      const m = stdout.replace(/\x1b\[[0-9;]*m/g, "").match(/(\d+)\s+credentials?/i);
      return m && Number(m[1]) > 0 ? "signedIn" : "unknown";
    },
  },
};

/** What the Sign in button types into a terminal, after the binary. */
const LOGIN_ARGS = {
  claude: ["auth", "login"],
  codex: ["login"],
  cursor: ["login"],
  opencode: ["auth", "login"],
  grok: ["login"],
  kimi: ["login"],
  muse: ["login"],
};

/** @type {Map<string, AuthState>} */
const cache = new Map();
let probedAt = 0;
/** @type {Promise<void> | null} */
let inflight = null;

/** @type {typeof execFile} */
let execFileImpl = execFile;

/** Test hook. Pass null to restore. @param {typeof execFile | null} fn */
function setExecFile(fn) {
  execFileImpl = fn || execFile;
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string } | null>}
 */
function run(bin, args, env) {
  return new Promise((resolve) => {
    execFileImpl(
      bin,
      args,
      { env, timeout: PROBE_TIMEOUT_MS, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        // Spawn failure or timeout: nothing to read.
        if (err && code == null) return resolve(null);
        resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

/**
 * @param {string} id
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<AuthState>}
 */
async function probeOne(id, env) {
  const probe = PROBES[id];
  const entry = getProvider(id);
  if (!probe || !entry) return "unknown";
  const res = await run(resolveBin(entry, env), probe.args, env);
  if (!res) return "unknown";
  let state;
  try {
    state = probe.parse(res);
  } catch {
    return "unknown";
  }
  if (state === "signedOut" && (probe.keyEnv || []).some((k) => env[k])) {
    return "unknown";
  }
  return state;
}

/**
 * Re-probe every provider unless the last probe is younger than TTL_MS.
 *
 * @param {{ env?: NodeJS.ProcessEnv, force?: boolean, now?: number }} [opts]
 * @returns {Promise<void>}
 */
function refresh(opts = {}) {
  const now = opts.now ?? Date.now();
  if (inflight) return inflight;
  if (!opts.force && probedAt && now - probedAt < TTL_MS) return Promise.resolve();
  const env = opts.env || process.env;
  probedAt = now;
  inflight = Promise.all(
    Object.keys(PROBES).map(async (id) => {
      cache.set(id, await probeOne(id, env));
    }),
  ).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** True once any probe has started; the first list must not wait on it. */
function started() {
  return probedAt > 0;
}

/** Forget the last probe so the next refresh runs (after a Sign in). */
function invalidate() {
  probedAt = 0;
}

/**
 * Cached state, or undefined before the first probe lands.
 * @param {string} id
 * @returns {AuthState | undefined}
 */
function get(id) {
  if (cache.has(id)) return cache.get(id);
  return started() && getProvider(id) ? "unknown" : undefined;
}

/**
 * Shell line that starts the provider's login flow, or null.
 *
 * @param {string} id
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [opts]
 * @returns {string | null}
 */
function loginCommand(id, opts = {}) {
  const entry = getProvider(id);
  const args = LOGIN_ARGS[/** @type {keyof typeof LOGIN_ARGS} */ (id)];
  if (!entry || !args) return null;
  const bin = resolveBin(entry, opts.env || process.env);
  if (!bin) return null;
  const win = (opts.platform || process.platform) === "win32";
  const quoted = /^[\w.-]+$/.test(bin)
    ? bin
    : win
      ? `"${bin}"`
      : `'${bin.replace(/'/g, `'\\''`)}'`;
  return [quoted, ...args].join(" ");
}

/** Test hook: drop all state. */
function reset() {
  cache.clear();
  probedAt = 0;
  inflight = null;
}

module.exports = {
  refresh,
  started,
  invalidate,
  get,
  loginCommand,
  setExecFile,
  reset,
  TTL_MS,
};
