import type { PermissionMode, ProviderInfo } from "./shared/ipc";

/** Relative age like "3h", "1d", "12m" from a unix-ms timestamp. */
export function formatRelativeAge(updatedAt: number, now = Date.now()): string {
  const diff = Math.max(0, now - updatedAt);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Elapsed duration since a unix-ms stamp: "12s", "3m", "1h 4m". */
export function formatElapsed(from: number, now = Date.now()): string {
  const diff = Math.max(0, now - from);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (remMin === 0) return `${hours}h`;
  return `${hours}h ${remMin}m`;
}

/**
 * Elapsed working label from runStartedAt.
 * Examples: "Working 12s", "Working 3m", "Working 1h 4m".
 */
export function formatWorkingLabel(runStartedAt: number, now = Date.now()): string {
  return `Working ${formatElapsed(runStartedAt, now)}`;
}

/** Token sum like "Σ 52.0k". */
export function formatTokenSum(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000;
    const text = k >= 100 ? k.toFixed(0) : k.toFixed(1);
    return `Σ ${text}k`;
  }
  return `Σ ${tokens}`;
}

/** Human labels for PermissionMode (composer + session card). */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: "Ask first",
  acceptEdits: "Accept edits",
  plan: "Plan mode",
  bypassPermissions: "Full access",
};

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

export function permissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_LABELS[mode] ?? mode;
}

/**
 * Cost display: four decimals under $1 ($0.0123), two decimals at/above ($12.34).
 */
export function formatCostUsd(costUsd: number): string {
  if (!Number.isFinite(costUsd)) return "$0.00";
  if (Math.abs(costUsd) < 1) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

/** Short session id for UI (first 8 chars); null/empty → null. */
export function shortSessionId(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return sessionId.slice(0, 8);
}

/**
 * Compact model label for the composer pill: "claude-fable-5" → "fable-5".
 * Drops the first hyphen-delimited segment when present.
 */
export function shortModelName(model: string): string {
  const idx = model.indexOf("-");
  if (idx <= 0) return model;
  return model.slice(idx + 1);
}

/** Provider display name from the registry; falls back to the raw id. */
export function providerDisplayName(
  providerId: string,
  providers: readonly ProviderInfo[],
): string {
  return providers.find((p) => p.id === providerId)?.name ?? providerId;
}
