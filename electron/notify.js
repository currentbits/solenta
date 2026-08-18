"use strict";

/**
 * Whether a thread state change should post a desktop notification.
 * Never notify while the app window is focused.
 *
 * States are thread.status plus the synthetic "waiting" (working, but blocked
 * on a permission prompt): a run that stalls on a prompt is as much a "come
 * back to me" moment as one that finished, and unattended orchestration
 * workers stall there invisibly otherwise (issue #31).
 *
 * @param {string | undefined | null} prevStatus
 * @param {string | undefined | null} nextStatus
 * @param {boolean} windowFocused
 * @returns {boolean}
 */
function shouldNotify(prevStatus, nextStatus, windowFocused) {
  if (windowFocused) return false;
  if (prevStatus === nextStatus) return false;
  // A thread that lands "failed" with no run of its own — an orchestrator
  // wake-up the budget gate rejected (issue #34) — is exactly the stall the
  // user must hear about. A never-seen thread (no prev) stays quiet.
  if (nextStatus === "failed" && prevStatus) return true;
  if (prevStatus !== "working" && prevStatus !== "waiting") return false;
  return (
    nextStatus === "done" || nextStatus === "failed" || nextStatus === "waiting"
  );
}

/**
 * Twin of src/threadSnooze.ts effectiveSnoozed. Electron stays CJS and
 * does not import the renderer module; keep the two in lockstep.
 * A live snooze silences desktop notifications until the timer elapses
 * or the thread raises its hand (fresh done/failed, or awaitingInput).
 *
 * @param {{ snoozedUntil?: number | null, snoozedAt?: number | null, status?: string, updatedAt?: number, awaitingInput?: boolean } | null | undefined} thread
 * @param {number} now
 * @returns {boolean}
 */
function isEffectivelySnoozed(thread, now) {
  if (!thread) return false;
  const until = thread.snoozedUntil;
  if (until == null || !Number.isFinite(until) || !Number.isFinite(now)) {
    return false;
  }
  if (until <= now) return false;
  if (thread.awaitingInput) return false;
  const at = thread.snoozedAt;
  if (at != null && Number.isFinite(at) && Number.isFinite(thread.updatedAt)) {
    if (
      (thread.status === "failed" || thread.status === "done") &&
      thread.updatedAt > at
    ) {
      return false;
    }
  }
  return true;
}

module.exports = { shouldNotify, isEffectivelySnoozed };
