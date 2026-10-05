/**
 * Tail-window for the open transcript (#564). Not a virtualizer: users land
 * at the bottom, so we mount the last N timeline entries and grow upward
 * on demand. State is one integer (the first visible index).
 */
import type { TimelineEntry } from "./timeline";

/** Last N entries on first paint. Covers several screens of a typical thread. */
export const TRANSCRIPT_WINDOW = 120;

/**
 * Message text the tail window keeps mounted (#1475). A count alone let six
 * streamed 45 KB answers grow one open transcript to 62k DOM nodes; rendered
 * markdown runs ~140 nodes per KB, so this caps the window near 15k nodes.
 * Tool output is not counted: tool cards mount collapsed.
 */
export const TRANSCRIPT_CHAR_BUDGET = 100_000;

/**
 * First index of the tail window: at most `windowSize` entries and at most
 * `budget` characters of message text, but always the last entry.
 */
export function tailWindowStart(
  timeline: readonly TimelineEntry[],
  windowSize = TRANSCRIPT_WINDOW,
  budget = TRANSCRIPT_CHAR_BUDGET,
): number {
  const min = initialWindowStart(timeline.length, windowSize);
  let chars = 0;
  for (let i = timeline.length - 1; i >= min; i--) {
    const entry = timeline[i]!;
    if (entry.kind === "message") chars += entry.message.text.length;
    if (chars > budget && i < timeline.length - 1) return i + 1;
  }
  return min;
}

/** First index to mount so the tail window is N entries (0 when it all fits). */
export function initialWindowStart(
  length: number,
  windowSize = TRANSCRIPT_WINDOW,
): number {
  if (!(length > windowSize)) return 0;
  return length - windowSize;
}

/** Move the window start earlier by one chunk, never past 0. */
export function extendWindowStart(
  start: number,
  chunk = TRANSCRIPT_WINDOW,
): number {
  if (!(start > 0)) return 0;
  return Math.max(0, start - chunk);
}

/**
 * Lower the window start so `index` is included.
 */
export function ensureVisibleStart(start: number, index: number): number {
  if (!Number.isFinite(index) || index < 0) return start;
  return Math.min(start, Math.floor(index));
}

/**
 * Keep the start index on the current timeline. A rewind that drops the
 * tail (start past the new length) resets to a fresh tail window.
 */
export function clampWindowStart(
  start: number,
  length: number,
  windowSize = TRANSCRIPT_WINDOW,
): number {
  if (!(length > 0)) return 0;
  if (start >= length) return initialWindowStart(length, windowSize);
  if (start < 0) return 0;
  return start;
}
