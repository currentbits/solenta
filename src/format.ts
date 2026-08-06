import type { PermissionMode } from "./shared/ipc";

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

/** Elapsed working label like "Working 2m" from updatedAt. */
export function formatWorkingLabel(updatedAt: number, now = Date.now()): string {
  const diff = Math.max(0, now - updatedAt);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Working";
  if (minutes < 60) return `Working ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Working ${hours}h`;
  return `Working ${Math.floor(hours / 24)}d`;
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

/** Split assistant text into paragraphs (blank-line separated). */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
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
