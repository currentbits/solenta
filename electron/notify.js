"use strict";

/**
 * Whether a thread status change should post a desktop notification.
 * Never notify while the app window is focused.
 *
 * @param {string | undefined | null} prevStatus
 * @param {string | undefined | null} nextStatus
 * @param {boolean} windowFocused
 * @returns {boolean}
 */
function shouldNotify(prevStatus, nextStatus, windowFocused) {
  if (windowFocused) return false;
  if (prevStatus !== "working") return false;
  return nextStatus === "done" || nextStatus === "failed";
}

module.exports = { shouldNotify };
