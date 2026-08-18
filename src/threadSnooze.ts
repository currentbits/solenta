import type { ThreadInfo } from "./shared/ipc";

/**
 * t3-style snooze visibility (round 44) + shared presets / Woke (issue #383).
 *
 * Contract (ThreadInfo.snoozedUntil): snooze is VISIBILITY ONLY — never
 * touches the agent. It suspends a pin without clearing it and beats settle.
 *
 * Raised hand (t3 exact rule, quoted): a thread wakes early when it "raises
 * its hand" — a FRESH failure or a run completion newer than snoozedAt, or
 * the agent blocked on the user (awaitingInput). A thread snoozed while
 * already failed stays snoozed ("I saw it, not now").
 *
 * Timer wakes are client-derived: when snoozedUntil passes, effectiveSnoozed
 * flips false; no IPC event. Stale snooze fields then feed the Woke pill
 * until the user visits (lastVisitedAt >= wokeAt).
 */

export type SnoozePresetId =
  | "hour"
  | "three-hours"
  | "evening"
  | "tomorrow"
  | "next-week";

export interface SnoozePreset {
  id: SnoozePresetId;
  label: string;
  /** Menu-row time column. Complements the label: "Tomorrow" + "9am". */
  whenLabel: string;
  until: number;
}

const HOUR_MS = 60 * 60 * 1000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

/** Catalog of every preset id (menus use resolveSnoozePresets, which hides evening when too close). */
export const SNOOZE_PRESETS: ReadonlyArray<{
  id: SnoozePresetId;
  label: string;
}> = [
  { id: "hour", label: "In 1 hour" },
  { id: "three-hours", label: "In 3 hours" },
  { id: "evening", label: "This evening" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "next-week", label: "Next week" },
];

type SnoozeFields = Pick<
  ThreadInfo,
  "snoozedUntil" | "snoozedAt" | "status" | "updatedAt" | "awaitingInput"
>;

/**
 * Whether the thread is currently hidden under a live snooze.
 * NaN/malformed until/now → never snoozed.
 */
export function effectiveSnoozed(thread: SnoozeFields, now: number): boolean {
  const until = thread.snoozedUntil;
  if (until == null || !Number.isFinite(until) || !Number.isFinite(now)) {
    return false;
  }
  if (until <= now) return false;
  return !threadRaisedHand(thread);
}

/**
 * Something outranks the snooze: blocked-on-you, or a fresh failure /
 * completion after the snooze was set.
 */
export function threadRaisedHand(thread: SnoozeFields): boolean {
  if (thread.awaitingInput) return true;
  const at = thread.snoozedAt;
  if (at != null && Number.isFinite(at) && Number.isFinite(thread.updatedAt)) {
    if (
      (thread.status === "failed" || thread.status === "done") &&
      thread.updatedAt > at
    ) {
      return true;
    }
  }
  return false;
}

/**
 * When a previously-snoozed thread woke, or null if it never snoozed / is
 * still snoozed. Timer wakes report snoozedUntil; raised-hand wakes report
 * the triggering updatedAt so a visit BEFORE the early wake does not
 * suppress the Woke pill.
 */
export function threadWokeAt(thread: SnoozeFields, now: number): number | null {
  const until = thread.snoozedUntil;
  if (until == null || !Number.isFinite(until) || !Number.isFinite(now)) {
    return null;
  }
  if (threadRaisedHand(thread)) {
    if (Number.isFinite(thread.updatedAt)) return thread.updatedAt;
    return thread.snoozedAt != null && Number.isFinite(thread.snoozedAt)
      ? thread.snoozedAt
      : until;
  }
  return until <= now ? until : null;
}

/**
 * Show the Woke pill: the thread woke (timer or raised hand) and the user
 * has not visited since. Null lastVisitedAt is legacy — do not light up
 * every historical row on upgrade (same upgrade rule as unread).
 */
export function showWokePill(
  thread: SnoozeFields & Pick<ThreadInfo, "lastVisitedAt">,
  now: number,
): boolean {
  const wokeAt = threadWokeAt(thread, now);
  if (wokeAt == null) return false;
  const visited = thread.lastVisitedAt;
  if (visited == null || !Number.isFinite(visited)) return false;
  return visited < wokeAt;
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

  const time = timeOfDayLabel(until);

  if (sameDay) return time;
  if (isTomorrow) return `tomorrow ${time}`;
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${weekday} ${time}`;
}

function timeOfDayLabel(ms: number): string {
  const d = new Date(ms);
  const hours = d.getHours();
  const mins = d.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return mins === 0
    ? `${h12}${ampm}`
    : `${h12}:${String(mins).padStart(2, "0")}${ampm}`;
}

function atHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

/** Calendar-day advance (not +DAY_MS) so DST does not skip a local day. */
function addSnoozeDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Shared "snooze until" choices for every client (electron + web).
 * "This evening" only appears while it is meaningfully before evening
 * (more than an hour away); after that the calendar choices start at
 * "Tomorrow".
 */
export function resolveSnoozePresets(now: number): ReadonlyArray<SnoozePreset> {
  const d = new Date(now);
  const inAnHour = now + HOUR_MS;
  const inThreeHours = now + 3 * HOUR_MS;
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeOfDayLabel(inAnHour),
      until: inAnHour,
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: timeOfDayLabel(inThreeHours),
      until: inThreeHours,
    },
  ];

  const evening = atHour(d, EVENING_HOUR);
  if (evening.getTime() - now > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeOfDayLabel(evening.getTime()),
      until: evening.getTime(),
    });
  }

  const tomorrow = atHour(addSnoozeDays(d, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeOfDayLabel(tomorrow.getTime()),
    until: tomorrow.getTime(),
  });

  const daysUntilMonday = (1 - d.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addSnoozeDays(d, daysUntilMonday), MORNING_HOUR);
  presets.push({
    id: "next-week",
    label: "Next week",
    whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeOfDayLabel(nextWeek.getTime())}`,
    until: nextWeek.getTime(),
  });

  return presets;
}

/**
 * Snooze preset → epoch ms.
 *
 * Local calendar boundaries (t3):
 * - "hour" / "three-hours": elapsed duration from `now`.
 * - "evening": today 18:00 local, or tomorrow 18:00 if that instant is
 *   already past (including exact 18:00:00.000 — `<=` so "now" is not future).
 * - "tomorrow": ALWAYS calendar-tomorrow 09:00 local. The label wins
 *   over a "next 09:00" reading: at 07:00, next-09:00 would be only two hours
 *   away, which is absurd for a control named "Tomorrow".
 * - "next-week": next Monday 09:00 local (7 days later when today is Monday).
 *
 * `now` is injectable so tests pin rollover edges without real time.
 */
export function snoozePresetUntil(id: SnoozePresetId, now: number): number {
  if (id === "hour") return now + HOUR_MS;
  if (id === "three-hours") return now + 3 * HOUR_MS;
  if (id === "evening") {
    const evening = atHour(new Date(now), EVENING_HOUR);
    if (evening.getTime() <= now) {
      evening.setDate(evening.getDate() + 1);
    }
    return evening.getTime();
  }
  if (id === "tomorrow") {
    return atHour(addSnoozeDays(new Date(now), 1), MORNING_HOUR).getTime();
  }
  const d = new Date(now);
  const daysUntilMonday = (1 - d.getDay() + 7) % 7 || 7;
  return atHour(addSnoozeDays(d, daysUntilMonday), MORNING_HOUR).getTime();
}
