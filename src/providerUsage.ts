import { formatElapsed, formatRelativeAge } from "./format.ts";
import type { ProviderUsage, ProviderUsageWindow } from "./shared/ipc.ts";

export type { ProviderUsage, ProviderUsageWindow } from "./shared/ipc.ts";

export const QUOTA_STALE_MS = 5 * 60 * 1000;
export const QUOTA_CLOCK_MS = 30_000;

export type ProviderLimitsLoader = () => Promise<ProviderUsage[]>;

const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** Name an unlabeled window from its reported duration. Never invents a period. */
export function formatWindowDuration(windowSeconds: number | null): string | null {
  if (windowSeconds == null || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return null;
  }
  if (windowSeconds === FIVE_HOURS_SECONDS) return "5 hours";
  if (windowSeconds === WEEK_SECONDS) return "Weekly";
  const hours = windowSeconds / 3600;
  if (Number.isInteger(hours) && hours >= 1 && hours < 48) {
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const days = windowSeconds / 86400;
  if (Number.isInteger(days) && days >= 1) {
    return days === 1 ? "1 day" : `${days} days`;
  }
  return null;
}

export function displayWindowLabel(win: ProviderUsageWindow): string {
  const label = win.label?.trim() ?? "";
  if (label) return label;
  return formatWindowDuration(win.windowSeconds) ?? "Window";
}

export function formatUsedPercent(usedPercent: number): string {
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return "unavailable";
  return `${Math.round(usedPercent)}% used`;
}

/** Fill width only. Text may exceed 100 when the provider reports overage. */
export function usedBarWidth(usedPercent: number): number {
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return 0;
  return Math.min(100, usedPercent);
}

/**
 * Issue #1755: the thread-view strip reads every row as % LEFT, the inverse
 * of the quota dialog's % used. Clamped to 0..100 (overage reads as 0 left).
 */
export function usagePercentLeft(usedPercent: number): number {
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return 0;
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export type UsageSeverity = "" | "warn" | "danger";

/** 20% left or less turns amber, 10% or less turns red. */
export function usageSeverity(percentLeft: number): UsageSeverity {
  if (percentLeft <= 10) return "danger";
  if (percentLeft <= 20) return "warn";
  return "";
}

/**
 * Issue #1764: where in the window a user who spent at a constant rate
 * would be right now, as a percent USED (same framing as the quota
 * dialog's bar). Null when the window never reported a reset time or
 * duration, same honesty rule as the rest of this file: never invent a
 * position from data the provider did not give us.
 */
export function evenPacePercent(
  win: Pick<ProviderUsageWindow, "resetsAt" | "windowSeconds">,
  now = Date.now(),
): number | null {
  const { resetsAt, windowSeconds } = win;
  if (
    resetsAt == null ||
    !Number.isFinite(resetsAt) ||
    windowSeconds == null ||
    !Number.isFinite(windowSeconds) ||
    windowSeconds <= 0
  ) {
    return null;
  }
  const elapsedSeconds = windowSeconds - (resetsAt - now) / 1000;
  const clamped = Math.max(0, Math.min(windowSeconds, elapsedSeconds));
  return (clamped / windowSeconds) * 100;
}

export function isResetExpired(
  resetsAt: number | null,
  now = Date.now(),
): boolean {
  return resetsAt != null && Number.isFinite(resetsAt) && resetsAt <= now;
}

export function formatResetAt(
  resetsAt: number | null,
  now = Date.now(),
): string | null {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return null;
  if (isResetExpired(resetsAt, now)) return "reset time passed";
  return `resets in ${formatElapsed(now, resetsAt)}`;
}

export function isQuotaStale(
  fetchedAt: number | null,
  now = Date.now(),
): boolean {
  if (fetchedAt == null || !Number.isFinite(fetchedAt)) return false;
  return now - fetchedAt >= QUOTA_STALE_MS;
}

export function formatFetchedAt(
  fetchedAt: number | null,
  now = Date.now(),
): string | null {
  if (fetchedAt == null || !Number.isFinite(fetchedAt)) return null;
  const age = formatRelativeAge(fetchedAt, now);
  return age === "now" ? "Updated just now" : `Updated ${age} ago`;
}

export function sortProviderUsage(
  rows: readonly ProviderUsage[],
  active?: string | null,
): ProviderUsage[] {
  return rows.slice().sort((a, b) => {
    if (active) {
      if (a.provider === active && b.provider !== active) return -1;
      if (b.provider === active && a.provider !== active) return 1;
    }
    return a.provider.localeCompare(b.provider);
  });
}

