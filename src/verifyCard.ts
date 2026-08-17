import { formatElapsed, formatRelativeAge } from "./format";
import type { VerifyResult } from "./shared/ipc";

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
