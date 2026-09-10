"use strict";

const { cacheEnv } = require("./verifyEfficiency.js");

/**
 * Spawn options for agent CLIs (claude, codex, kimi, opencode, generic).
 *
 * POSIX: detached so killTree can signal the process group.
 * Win32: do NOT detach. `detached: true` is CREATE_NEW_PROCESS_GROUP |
 * DETACHED_PROCESS. Combined with cross-spawn of a `.cmd` shim, the parent
 * waits on cmd.exe (exit 0, empty pipes) while the node grandchild's stdout
 * never arrives — smoke pass C, issue #480. Process-group kill already
 * falls back on Windows (`process.kill(-pid)` throws).
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
 * Signal a child and its process group. Group kill needs the child to be
 * a group leader (`detached: true` at spawn). Falls back to the child pid
 * if the group signal throws (no group, already dead, Windows).
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} sig
 */
function signalGroup(child, sig) {
  const pid = child && child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already dead
    }
  }
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
  beginShutdown,
  resetShutdownForTests,
};
