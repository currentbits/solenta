"use strict";

const { spawnSync } = require("node:child_process");
const { cacheEnv } = require("./verifyEfficiency.js");

/**
 * Spawn options for agent CLIs (claude, codex, kimi, opencode, generic).
 *
 * POSIX: detached so killTree can signal the process group.
 * Win32: do NOT detach. `detached: true` is CREATE_NEW_PROCESS_GROUP |
 * DETACHED_PROCESS. Combined with cross-spawn of a `.cmd` shim, the parent
 * waits on cmd.exe (exit 0, empty pipes) while the node grandchild's stdout
 * never arrives — smoke pass C, issue #480. Tree kill on Windows is
 * `taskkill /T` from signalGroup, not `process.kill(-pid)`.
 *
 * `platform` is injectable so tests can lock the win32 branch on macOS.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {import("node:child_process").StdioOptions} [opts.stdio]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {NodeJS.Platform} [opts.platform]
 */
function agentSpawnOptions(opts = {}) {
  const platform = opts.platform || process.platform;
  const out = {
    cwd: opts.cwd,
    shell: false,
    detached: platform !== "win32",
    windowsHide: platform === "win32",
    stdio: opts.stdio,
  };
  const extra = opts.cwd
    ? cacheEnv({ cwd: opts.cwd, env: opts.env || process.env })
    : {};
  if (Object.keys(extra).length) {
    out.env = { ...(opts.env || process.env), ...extra };
  } else if (opts.env) {
    out.env = opts.env;
  }
  return out;
}

/**
 * Win32 has no killable process group: agent CLIs stay attached (#480).
 * `child.kill` / `process.kill(pid)` stop cmd.exe and leave the node
 * grandchild holding stdout. Node's SIGTERM is already TerminateProcess
 * there, so every Windows signal is `taskkill /T /F`. A failed or timed-out
 * taskkill must not then kill the parent: that drops the pid the next tree
 * walk would have used. Tests pass `{ platform, spawn }` and never launch
 * taskkill.
 */
const WINDOWS_TREE_KILL_TIMEOUT_MS = 5000;

/**
 * @param {unknown} opts
 * @returns {{ platform?: NodeJS.Platform, spawn?: typeof spawnSync }}
 */
function signalOpts(opts) {
  if (!opts || typeof opts !== "object") return {};
  return /** @type {{ platform?: NodeJS.Platform, spawn?: typeof spawnSync }} */ (
    opts
  );
}

/**
 * @param {number} pid
 * @param {NodeJS.Signals} sig
 * @param {() => void} direct one process, used only when the group signal throws
 */
function posixGroupSignal(pid, sig, direct) {
  try {
    process.kill(-pid, sig);
  } catch {
    direct();
  }
}

/**
 * @param {number} pid
 * @param {typeof spawnSync} [spawnImpl]
 * @returns {boolean}
 */
function windowsTreeSignal(pid, spawnImpl) {
  const spawn = spawnImpl || spawnSync;
  try {
    const result = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: WINDOWS_TREE_KILL_TIMEOUT_MS,
    });
    return Boolean(result && result.status === 0);
  } catch {
    return false;
  }
}

/**
 * Tree signal when the caller only has a pid (writer-lock holder).
 * On win32 a failed taskkill leaves the pid untouched.
 *
 * @param {number} pid
 * @param {NodeJS.Signals} sig
 * @param {{ platform?: NodeJS.Platform, spawn?: typeof spawnSync }} [opts]
 * @returns {boolean}
 */
function signalPid(pid, sig, opts) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  const o = signalOpts(opts);
  if ((o.platform || process.platform) === "win32") {
    return windowsTreeSignal(n, o.spawn);
  }
  posixGroupSignal(n, sig, () => {
    try {
      process.kill(n, sig);
    } catch {
      // already dead
    }
  });
  return true;
}

/**
 * Signal a child and its process group. Group kill needs the child to be
 * a group leader (`detached: true` at spawn). On win32 this is
 * `taskkill /T /F` and never `child.kill`.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} sig
 * @param {{ platform?: NodeJS.Platform, spawn?: typeof spawnSync }} [opts]
 * @returns {boolean}
 */
function signalGroup(child, sig, opts) {
  const pid = child && child.pid;
  if (!pid) return false;
  const o = signalOpts(opts);
  if ((o.platform || process.platform) === "win32") {
    return windowsTreeSignal(pid, o.spawn);
  }
  posixGroupSignal(pid, sig, () => {
    try {
      child.kill(sig);
    } catch {
      // already dead
    }
  });
  return true;
}

/** Quit path only (#1233): once set, killTree SIGKILLs immediately. */
let shuttingDown = false;

/**
 * Mark process teardown. Agent CLIs spawn detached on POSIX, so an unref'd
 * SIGKILL timer dies with Electron and a SIGTERM-ignorer is left behind.
 * installShutdown calls this before cleanup so every killTree during quit
 * reaps the group before app.exit. In-app Stop does not set this.
 */
function beginShutdown() {
  shuttingDown = true;
}

/** Test isolation: node:test may reuse a process across cases in one file. */
function resetShutdownForTests() {
  shuttingDown = false;
}

/**
 * SIGTERM the child's process group, then SIGKILL after `sigkillAfterMs`.
 * During app quit (`beginShutdown`), SIGKILL immediately — the unref'd
 * fallback never fires after `app.exit`. Returns the escalation timer so
 * callers can clearTimeout in finish(), or null when no timer was armed.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} sigkillAfterMs
 * @returns {ReturnType<typeof setTimeout> | null}
 */
function killTree(child, sigkillAfterMs) {
  if (shuttingDown) {
    signalGroup(child, "SIGKILL");
    return null;
  }
  signalGroup(child, "SIGTERM");
  const timer = setTimeout(() => {
    signalGroup(child, "SIGKILL");
  }, sigkillAfterMs);
  // Unref'd like devservers.js: the escalation still fires while the app runs,
  // but app quit is not held open 3s. Quit calls beginShutdown() first so
  // this timer is never armed on the path that used to leak SIGTERM-ignorers.
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = {
  killTree,
  agentSpawnOptions,
  signalGroup,
  signalPid,
  beginShutdown,
  resetShutdownForTests,
  WINDOWS_TREE_KILL_TIMEOUT_MS,
};
