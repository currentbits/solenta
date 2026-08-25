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
 * Modes this provider's adapter actually honours. Missing `permissionModes`
 * keeps the full set so legacy fixtures stay clickable; an explicit empty
 * array means none can be sent.
 */
export function providerPermissionModes(
  info: ProviderInfo | null | undefined,
): PermissionMode[] {
  if (!info || info.permissionModes == null) return PERMISSION_MODES.slice();
  return info.permissionModes.slice();
}

/** True when picking `mode` would actually change this provider's argv. */
export function permissionModeHonoured(
  mode: PermissionMode,
  info: ProviderInfo | null | undefined,
): boolean {
  return providerPermissionModes(info).includes(mode);
}

/**
 * Modes the permission menu lists: honoured ones, plus the current stored
 * mode when it is not honoured (shown disabled so the lie is visible).
 */
export function permissionPickerModes(
  current: PermissionMode,
  honoured: PermissionMode[],
): PermissionMode[] {
  if (honoured.includes(current)) return honoured.slice();
  return [current, ...honoured.filter((m) => m !== current)];
}

/**
 * Nearest honoured mode for a stored value this provider cannot send.
 * Keep in lockstep with electron/providers.js snapPermissionMode.
 */
export function snapToHonouredPermissionMode(
  honoured: PermissionMode[],
  mode: PermissionMode,
): PermissionMode {
  if (honoured.length === 0) return mode;
  if (honoured.includes(mode)) return mode;
  if (mode === "acceptEdits") {
    if (honoured.includes("bypassPermissions")) return "bypassPermissions";
    if (honoured.includes("default")) return "default";
  }
  if (mode === "default") {
    if (honoured.includes("bypassPermissions")) return "bypassPermissions";
  }
  if (mode === "plan") {
    if (honoured.includes("default")) return "default";
    if (honoured.includes("bypassPermissions")) return "bypassPermissions";
  }
  if (mode === "bypassPermissions") {
    if (honoured.includes("default")) return "default";
  }
  return honoured[0] ?? mode;
}

/**
 * Cost display: always cents. A real cost below one cent renders "<$0.01"
 * so a nonzero spend never reads as "$0.00" (issue #364).
 */
export function formatCostUsd(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd === 0) return "$0.00";
  if (Math.abs(costUsd) < 0.01) return "<$0.01";
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

/** Project worktree rollup: "worktrees 57.3 GB · 119" or "worktrees · 119". */
export function formatWorktreeUsage(worktrees: number, bytes = 0): string {
  if (bytes > 0) return `worktrees ${formatBytes(bytes)} · ${worktrees}`;
  return `worktrees · ${worktrees}`;
}

/** Human file size: "512 B", "1.5 KB", "12 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const text = value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}
