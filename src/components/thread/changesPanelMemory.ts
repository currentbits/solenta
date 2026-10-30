/**
 * Where a thread's Changes panel was left (#1779): selected file, file-list
 * and diff-body scroll, and which tree folders were collapsed. Session-only
 * (same lifetime as the rest of ChangesPanel's local state, lost on reload)
 * and capped so a long-lived session does not grow forever.
 */
export type ChangesPanelSnap = {
  selectedPath: string | null;
  fileListScrollTop: number;
  diffScrollTop: number;
  collapsedDirs: string[];
};

const CAP = 50;

// Map iteration order is insertion order, so delete-then-set on every write
// moves a thread to the end: the oldest untouched thread is always
// snaps.keys().next() once the cap is hit. Same LRU trick as uiPrefs's
// diffScope map (src/uiPrefs.ts).
const snaps = new Map<string, ChangesPanelSnap>();

export function getChangesPanelSnap(
  threadId: string | null,
): ChangesPanelSnap | null {
  return (threadId && snaps.get(threadId)) || null;
}

export function setChangesPanelSnap(
  threadId: string,
  snap: ChangesPanelSnap,
): void {
  snaps.delete(threadId);
  snaps.set(threadId, snap);
  while (snaps.size > CAP) snaps.delete(snaps.keys().next().value!);
}

/** Tests only: start every case from an empty map. */
export function resetChangesPanelSnaps(): void {
  snaps.clear();
}
