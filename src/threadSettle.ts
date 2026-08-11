import type { ThreadInfo } from "./shared/ipc";

/**
 * Default inactivity window (days) before a quiet thread auto-settles.
 * Single knob: inject via opts so a future setting needs no rework.
 */
export const AUTO_SETTLE_AFTER_DAYS = 3;

/**
 * Global settled tail paging (t3-style).
 * Initial visible count when the tail is expanded; each "Show more" adds a page.
 */
export const SETTLED_TAIL_INITIAL_COUNT = 10;
export const SETTLED_TAIL_PAGE_COUNT = 25;

export interface SettleOpts {
  /** Epoch ms clock; Sidebar's existing `now` tick is the source. */
  now: number;
  /**
   * Days of silence before inactivity settle. null disables the path
   * entirely (no quiet thread ever auto-settles).
   */
  autoSettleAfterDays: number | null;
}

/**
 * t3-style computed settle resolution, adapted to our ThreadInfo fields.
 *
 * Round 38 used status==="done". Round 39: a freshly-done thread is NOT
 * settled — it stays visible until PR resolution, inactivity, or a manual
 * settle override. Live work and open PRs always win attention.
 */
export function effectiveSettled(
  thread: ThreadInfo,
  opts: SettleOpts,
): boolean {
  // Live work always wins attention. Settling a running thread would hide
  // the thing the user is watching; backend refuses settle while working too.
  if (thread.status === "working") return false;

  // Round 44: a pin NEVER auto-settles (t3). pinnedAt is the pin clock;
  // mutual exclusion with settle is enforced by setPinned/setSettled.
  if (thread.pinnedAt != null && Number.isFinite(thread.pinnedAt)) {
    return false;
  }

  // Explicit pin into the fold (manual settle, or a prior auto that the user
  // has not undone). Beats PR and inactivity so a deliberate settle sticks.
  if (thread.settledOverride === "settled") return true;

  // Explicit pin OUT of the fold. Suppresses MERGED/CLOSED and inactivity so
  // the user can keep a closed-PR thread visible for follow-up.
  if (thread.settledOverride === "active") return false;

  // Terminal PR states: the branch's job is finished. MERGED and CLOSED both
  // mean "no more work on this PR", so fold them.
  if (thread.prState === "MERGED" || thread.prState === "CLOSED") return true;

  // Open PR is unfinished business. Also blocks the inactivity path below —
  // a quiet open PR is still open work, not settled.
  if (thread.prState === "OPEN") return false;

  // No inactivity window configured → never auto-settle on silence alone.
  if (opts.autoSettleAfterDays == null) return false;

  // Malformed clocks must never settle a thread. NaN comparisons are false
  // in JS, but an explicit guard documents the intent and covers Infinity.
  const updatedAt = thread.updatedAt;
  const now = opts.now;
  const days = opts.autoSettleAfterDays;
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now) || !Number.isFinite(days)) {
    return false;
  }
  if (days < 0) return false;

  const windowMs = days * 24 * 60 * 60 * 1000;
  // Quiet long enough → settle. Applies to done, failed, AND idle alike: a
  // quiet thread is a quiet thread. Freshly-done work stays visible until
  // this window (or PR/manual) moves it.
  return updatedAt < now - windowMs;
}

/**
 * Single clock for settled rows: label and newest-first sort must agree.
 * Prefer settledAt (when the pin/auto-settle took effect); fall back to
 * updatedAt for threads that settled without an explicit pin timestamp.
 * Malformed settledAt is ignored so a bad store value cannot invent order.
 */
export function resolveSettledTimestamp(thread: ThreadInfo): number {
  const pin = thread.settledAt;
  if (pin != null && Number.isFinite(pin)) return pin;
  return thread.updatedAt;
}

/** Newest-settled first. Use with Array.sort. */
export function compareSettledNewestFirst(a: ThreadInfo, b: ThreadInfo): number {
  return resolveSettledTimestamp(b) - resolveSettledTimestamp(a);
}
