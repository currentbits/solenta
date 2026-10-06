import { useCallback, useRef, useState } from "react";

/** How long ⌘Z (and the toast's Undo) can reverse the last action. */
export const UNDO_WINDOW_MS = 10_000;

/** Same verb within this window joins one entry: sidebar batches are bursts of single calls. */
const BURST_MS = 500;

interface UndoEntry {
  key: number;
  verb: string;
  count: number;
  at: number;
  reverse: Array<() => unknown>;
}

/**
 * One-slot undo for settle / snooze / archive and their inverses (#1506).
 * Not a general undo system: each entry is just the IPC calls that put the
 * thread back. A newer action replaces the slot.
 */
export function useUndoLast() {
  const [entry, setEntry] = useState<UndoEntry | null>(null);
  const entryRef = useRef(entry);

  const offerUndo = useCallback((verb: string, reverse: () => unknown) => {
    const now = Date.now();
    const cur = entryRef.current;
    const next =
      cur && cur.verb === verb && now - cur.at < BURST_MS
        ? { ...cur, count: cur.count + 1, at: now, reverse: [...cur.reverse, reverse] }
        : { key: now, verb, count: 1, at: now, reverse: [reverse] };
    entryRef.current = next;
    setEntry(next);
  }, []);

  const dismissUndo = useCallback(() => {
    entryRef.current = null;
    setEntry(null);
  }, []);

  /** Reverses the slot; false when there was nothing to undo. */
  const runUndo = useCallback(async () => {
    const cur = entryRef.current;
    if (!cur) return false;
    dismissUndo();
    for (const reverse of cur.reverse) await reverse();
    return true;
  }, [dismissUndo]);

  const undoMessage = entry
    ? entry.count > 1
      ? `${entry.count} ${entry.verb.toLowerCase()}`
      : entry.verb
    : null;

  return { undoKey: entry?.key ?? null, undoMessage, offerUndo, dismissUndo, runUndo };
}
