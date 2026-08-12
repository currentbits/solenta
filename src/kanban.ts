/**
 * Kanban columns derived from thread.status. No drag-and-drop: the board
 * is a view of machine-driven status, not a place to persist order.
 */
import type { ThreadInfo, ThreadStatus } from "./shared/ipc";
import {
  AUTO_SETTLE_AFTER_DAYS,
  effectiveSettled,
  type SettleOpts,
} from "./threadSettle";

export type KanbanColumnId = ThreadStatus;

export interface KanbanColumn {
  id: KanbanColumnId;
  title: string;
  threads: ThreadInfo[];
}

const COLUMN_ORDER: { id: KanbanColumnId; title: string }[] = [
  { id: "working", title: "Working" },
  { id: "idle", title: "Idle" },
  { id: "done", title: "Done" },
  { id: "failed", title: "Failed" },
];

function defaultSettleOpts(): SettleOpts {
  return {
    now: Date.now(),
    autoSettleAfterDays: AUTO_SETTLE_AFTER_DAYS,
  };
}

/**
 * Working / Idle / Done / Failed. Archived threads and threads the sidebar
 * already shelves as settled (effectiveSettled) are excluded. Each column
 * is newest-updated first.
 */
export function kanbanColumns(
  threads: readonly ThreadInfo[],
  settleOpts: SettleOpts = defaultSettleOpts(),
): KanbanColumn[] {
  const visible = threads.filter(
    (t) => !t.archived && !effectiveSettled(t, settleOpts),
  );
  const buckets: Record<KanbanColumnId, ThreadInfo[]> = {
    working: [],
    idle: [],
    done: [],
    failed: [],
  };
  for (const thread of visible) {
    buckets[thread.status].push(thread);
  }
  return COLUMN_ORDER.map(({ id, title }) => ({
    id,
    title,
    threads: buckets[id]
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }));
}

export function isKanbanEmpty(columns: readonly KanbanColumn[]): boolean {
  return columns.every((c) => c.threads.length === 0);
}
