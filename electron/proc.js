"use strict";

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
  if (opts.env) out.env = opts.env;
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

/**
 * SIGTERM the child's process group, then SIGKILL after `sigkillAfterMs`.
 * Returns the escalation timer so callers can clearTimeout in finish().
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} sigkillAfterMs
 * @returns {ReturnType<typeof setTimeout>}
 */
function killTree(child, sigkillAfterMs) {
  signalGroup(child, "SIGTERM");
  const timer = setTimeout(() => {
    signalGroup(child, "SIGKILL");
  }, sigkillAfterMs);
  // Unref'd like devservers.js: the escalation still fires while the app runs,
  // but app quit (which kills without clearing the timer) is not held open 3s.
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = { killTree, agentSpawnOptions };
