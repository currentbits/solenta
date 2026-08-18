import { formatElapsed, formatRelativeAge } from "./format";
import type { PostMergeVerify, VerifyResult } from "./shared/ipc";

/**
 * Duration of one verify run. formatElapsed is a from/now pair, so we
 * treat the elapsed ms as a clock interval starting at 0.
 */
export function formatVerifyDuration(durationMs: number): string {
  return formatElapsed(0, Math.max(0, durationMs));
}

/**
 * Age of the latest evidence. "3m ago" not "3m", because the duration
 * label already uses that shape and the two would collide in the summary.
 */
export function formatVerifyAge(at: number, now = Date.now()): string {
  const age = formatRelativeAge(at, now);
  return age === "now" ? "now" : `${age} ago`;
}

export function formatVerifyExit(result: VerifyResult): string {
  if (result.timedOut || result.exitCode == null) return "timed out";
  return `exit ${result.exitCode}`;
}

export function formatVerifySha(sha: string | null): string | null {
  if (!sha) return null;
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/** One-line evidence: outcome, command, exit, duration, age, short sha. */
export function formatVerifySummary(
  result: VerifyResult,
  now = Date.now(),
): string {
  const parts = [
    result.ok ? "Passed" : "Failed",
    result.command,
    formatVerifyExit(result),
    formatVerifyDuration(result.durationMs),
    formatVerifyAge(result.at, now),
  ];
  const sha = formatVerifySha(result.sha);
  if (sha) parts.push(sha);
  return parts.join(" · ");
}

/** A pass needs no reading; a failure is the whole point. */
export function verifyLogStartsCollapsed(result: VerifyResult): boolean {
  return result.ok;
}

/**
 * Verify now cannot run without a command, and runVerify rejects while
 * a thread run is active. In-flight is local UI, not a server rule.
 */
export function verifyNowDisabled(input: {
  command: string | null | undefined;
  runActive: boolean;
  verifying: boolean;
}): boolean {
  return (
    !String(input.command ?? "").trim() || input.runActive || input.verifying
  );
}

/** Remaining delay until a scheduled post-merge check: "18h", "3d", "2m". */
export function formatPostMergeRemaining(
  dueAt: number,
  now = Date.now(),
): string {
  const ms = Math.max(0, dueAt - now);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * One-line status for the delayed re-check after merge (issue #420).
 * Null when the thread has never been armed.
 */
export function formatPostMergeLine(
  check: PostMergeVerify | null | undefined,
  now = Date.now(),
): string | null {
  if (!check) return null;
  if (check.status === "scheduled") {
    return `Post-merge check in ${formatPostMergeRemaining(check.dueAt, now)}`;
  }
  if (check.status === "running") return "Post-merge check running…";
  const age = check.at != null ? formatVerifyAge(check.at, now) : null;
  if (check.status === "passed") {
    return age ? `Post-merge check passed · ${age}` : "Post-merge check passed";
  }
  if (check.status === "failed") {
    const bits = ["Post-merge check failed"];
    if (check.fixThreadId) bits.push("fix thread started");
    if (age) bits.push(age);
    return bits.join(" · ");
  }
  if (check.status === "skipped") {
    return check.skipReason
      ? `Post-merge check skipped · ${check.skipReason}`
      : "Post-merge check skipped";
  }
  return null;
}
