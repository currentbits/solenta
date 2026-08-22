/**
 * Tail-window for the open transcript (#564). Not a virtualizer: users land
 * at the bottom, so we mount the last N timeline entries and grow upward
 * on demand. State is one integer (the first visible index).
 */

/** Last N entries on first paint. Covers several screens of a typical thread. */
export const TRANSCRIPT_WINDOW = 120;

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
 * Raise the window so `index` is included. Streaming appends do not call
 * this — they keep the start index and grow the tail.
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
