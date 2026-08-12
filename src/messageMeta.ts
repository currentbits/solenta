/**
 * Meta line under an assistant message, e.g. "Opus 5 · high · 1m 45s · 9:15 PM".
 * Pure so the omission rules are testable without a DOM.
 *
 * Rules:
 * 1. Time is always shown (every message has createdAt).
 * 2. Model, effort, and duration appear only when known; null/empty omit.
 * 3. Duration arrives as workLogDurationLabel output ("Worked for 1m 45s");
 *    the footer wants the bare span, so the prefix is stripped here.
 */
export interface MessageMetaInput {
  createdAt: number;
  model?: string | null;
  effort?: string | null;
  duration?: string | null;
}

/** "1m 45s" from "Worked for 1m 45s"; null when there is no real span. */
export function stripDurationPrefix(
  duration: string | null | undefined,
): string | null {
  if (duration == null) return null;
  const stripped = duration.replace(/^Worked for\s+/i, "").trim();
  return stripped === "" ? null : stripped;
}

/** "9:15 PM" in local time. */
export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  const h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm} ${ampm}`;
}

export function messageMetaLine(input: MessageMetaInput): string {
  const segments: string[] = [];
  if (input.model != null && input.model !== "") segments.push(input.model);
  if (input.effort != null && input.effort !== "") segments.push(input.effort);
  const duration = stripDurationPrefix(input.duration);
  if (duration != null) segments.push(duration);
  segments.push(formatClock(input.createdAt));
  return segments.join(" · ");
}
