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

module.exports = { shouldNotify };
