import type { ThreadInfo } from "./shared/ipc";

/**
 * t3-style snooze visibility (round 44).
 *
 * Contract (ThreadInfo.snoozedUntil): snooze is VISIBILITY ONLY — never
 * touches the agent. It suspends a pin without clearing it and beats settle.
 *
 * Raised hand (t3 exact rule, quoted): a thread wakes early when it "raises
 * its hand" — a FRESH failure or a run completion newer than snoozedAt. A
 * thread snoozed while already failed stays snoozed ("I saw it, not now").
 *
 * Timer wakes are client-derived: when snoozedUntil passes, effectiveSnoozed
 * flips false; no IPC event.
 */

export type SnoozePresetId = "this-evening" | "tomorrow-morning" | "in-3-days";

export const SNOOZE_PRESETS: ReadonlyArray<{
  id: SnoozePresetId;
  label: string;
}> = [
  { id: "this-evening", label: "This evening" },
  { id: "tomorrow-morning", label: "Tomorrow morning" },
  { id: "in-3-days", label: "In 3 days" },
];

/**
 * Whether the thread is currently hidden under a live snooze.
 * NaN/malformed until/now → never snoozed.
 */
export function effectiveSnoozed(
  thread: Pick<
    ThreadInfo,
    "snoozedUntil" | "snoozedAt" | "status" | "updatedAt"
  >,
  now: number,
): boolean {
  const until = thread.snoozedUntil;
  if (until == null || !Number.isFinite(until) || !Number.isFinite(now)) {
    return false;
  }
  if (until <= now) return false;

  // Raised hand: fresh failure or completion after the snooze was set.
  // Snoozed-while-already-failed has updatedAt <= snoozedAt → stays snoozed.
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

/** Whether the thread is currently pinned (finite pinnedAt). */
export function isPinned(
  thread: Pick<ThreadInfo, "pinnedAt">,
): boolean {
  return thread.pinnedAt != null && Number.isFinite(thread.pinnedAt);
}

/** Oldest pin first (stable shelf order). */
export function comparePinnedOldestFirst(
  a: Pick<ThreadInfo, "pinnedAt">,
  b: Pick<ThreadInfo, "pinnedAt">,
): number {
  const pa = a.pinnedAt ?? 0;
  const pb = b.pinnedAt ?? 0;
  return pa - pb;
}

/** Wake-soonest first. Same clock as formatSnoozeWakeLabel. */
export function compareSnoozedWakeSoonest(
  a: Pick<ThreadInfo, "snoozedUntil">,
  b: Pick<ThreadInfo, "snoozedUntil">,
): number {
  return resolveSnoozeUntil(a) - resolveSnoozeUntil(b);
}

/**
 * Single clock for snoozed rows: label and sort must agree (round-40 lesson).
 * Malformed → 0 so they sort first and label falls back honestly.
 */
export function resolveSnoozeUntil(
  thread: Pick<ThreadInfo, "snoozedUntil">,
): number {
  const u = thread.snoozedUntil;
  if (u != null && Number.isFinite(u)) return u;
  return 0;
}

/**
 * Human wake label from the same resolver the shelf sorts on.
 * Examples: "until 6pm", "until tomorrow", "until Mon 9am".
 * Local calendar — t3 uses local boundaries, not UTC day cuts.
 */
export function formatSnoozeWakeLabel(
  thread: Pick<ThreadInfo, "snoozedUntil">,
  now: number,
): string {
  const until = resolveSnoozeUntil(thread);
  if (!until) return "until —";
  return `until ${formatWakeTime(until, now)}`;
}

function formatWakeTime(until: number, now: number): string {
  const d = new Date(until);
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  const tomorrow = new Date(n);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();

  const hours = d.getHours();
  const mins = d.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  const time =
    mins === 0 ? `${h12}${ampm}` : `${h12}:${String(mins).padStart(2, "0")}${ampm}`;

  if (sameDay) return time;
  if (isTomorrow) return `tomorrow ${time}`;
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${weekday} ${time}`;
}

/**
 * Snooze preset → epoch ms.
 *
 * Local calendar boundaries (t3):
 * - "This evening": today 18:00 local, or tomorrow 18:00 if that instant is
 *   already past (including exact 18:00:00.000 — `<=` so "now" is not future).
 * - "Tomorrow morning": ALWAYS calendar-tomorrow 09:00 local. The label wins
 *   over a "next 09:00" reading: at 07:00, next-09:00 would be only two hours
 *   away, which is absurd for a control named "Tomorrow morning".
 * - "In 3 days": now + 3×24h of elapsed time (not three calendar midnights).
 *   Across a DST transition the wall-clock time of day can shift by an hour;
 *   that is intentional for a fixed-duration snooze, not a calendar target.
 *
 * `now` is injectable so tests pin rollover edges without real time.
 */
export function snoozePresetUntil(
  id: SnoozePresetId,
  now: number,
): number {
  const d = new Date(now);
  if (id === "this-evening") {
    const evening = new Date(d);
    evening.setHours(18, 0, 0, 0);
    // Exact 18:00:00.000 is not strictly in the future — roll to tomorrow.
    if (evening.getTime() <= now) {
      evening.setDate(evening.getDate() + 1);
    }
    return evening.getTime();
  }
  if (id === "tomorrow-morning") {
    // Label wins: always calendar tomorrow 09:00, even before 09:00 today.
    const morning = new Date(d);
    morning.setDate(morning.getDate() + 1);
    morning.setHours(9, 0, 0, 0);
    return morning.getTime();
  }
  // Fixed elapsed duration (3×24h), not three local midnights — see JSDoc.
  return now + 3 * 24 * 60 * 60 * 1000;
}
