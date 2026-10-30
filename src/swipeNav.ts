/**
 * Trackpad swipe back/forward over the thread pane (#1752). A two-finger
 * horizontal swipe arrives as a run of wheel events; this accumulates their
 * deltaX until it clears a threshold, then commits once and goes quiet for
 * the rest of the gesture. A gap with no wheel events starts a fresh one.
 */
export interface SwipeState {
  dx: number;
  committed: boolean;
  lastTs: number;
}

export const SWIPE_THRESHOLD = 120;
export const SWIPE_RESET_MS = 150;

/**
 * `wheel` is whatever a WheelEvent gives you. Swipe right (deltaX < 0)
 * commits back (-1), swipe left commits forward (1). Vertical-dominant or
 * ctrl+wheel (pinch-zoom) events pass through untouched.
 */
export function accumulateSwipe(
  state: SwipeState | null,
  wheel: { deltaX: number; deltaY: number; ctrlKey: boolean },
  now: number,
): { state: SwipeState | null; commit: -1 | 1 | null } {
  if (wheel.ctrlKey || Math.abs(wheel.deltaX) <= Math.abs(wheel.deltaY)) {
    return { state, commit: null };
  }
  const fresh = !state || now - state.lastTs > SWIPE_RESET_MS;
  if (!fresh && state!.committed) {
    return { state: { ...state!, lastTs: now }, commit: null };
  }
  const dx = (fresh ? 0 : state!.dx) + wheel.deltaX;
  if (Math.abs(dx) > SWIPE_THRESHOLD) {
    return { state: { dx, committed: true, lastTs: now }, commit: dx < 0 ? -1 : 1 };
  }
  return { state: { dx, committed: false, lastTs: now }, commit: null };
}

/** True when `el` or an ancestor actually scrolls horizontally (code blocks, diffs). */
export function hasHorizontalScrollAncestor(el: Element | null): boolean {
  for (let node = el; node; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth) continue;
    const overflowX = getComputedStyle(node).overflowX;
    if (overflowX === "auto" || overflowX === "scroll") return true;
  }
  return false;
}
