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

