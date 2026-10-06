/**
 * Per-window back/forward over opened threads (#1506). Browser-shaped: a
 * visit after going back drops the forward tail. Steps skip threads that no
 * longer exist (deleted), so Back never lands on a blank view.
 */
export interface ThreadHistory {
  stack: readonly string[];
  index: number;
}

export const EMPTY_HISTORY: ThreadHistory = { stack: [], index: -1 };

const CAP = 50;

export function visitThread(h: ThreadHistory, id: string): ThreadHistory {
  if (h.stack[h.index] === id) return h;
  const stack = [...h.stack.slice(0, h.index + 1), id].slice(-CAP);
  return { stack, index: stack.length - 1 };
}

/** Next live entry in `delta`'s direction, or null at the end of the stack. */
export function stepThread(
  h: ThreadHistory,
  delta: 1 | -1,
  exists: (id: string) => boolean,
): { history: ThreadHistory; id: string } | null {
  for (let i = h.index + delta; i >= 0 && i < h.stack.length; i += delta) {
    const id = h.stack[i]!;
    if (id !== h.stack[h.index] && exists(id)) {
      return { history: { stack: h.stack, index: i }, id };
    }
  }
  return null;
}
