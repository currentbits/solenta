"use strict";

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

module.exports = { killTree };
