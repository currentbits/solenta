import { useEffect, useMemo, useState } from "react";
import { isKanbanEmpty, kanbanColumns } from "../kanban";
import {
  AUTO_SETTLE_AFTER_DAYS,
  type SettleOpts,
} from "../threadSettle";
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../shared/ipc";
import { buildWaitStates } from "../waiting";
import { ThreadCard } from "./Sidebar";
import styles from "./KanbanView.module.css";

const TICK_MS = 5000;

export interface KanbanViewProps {
  threads: ThreadInfo[];
  projects: ProjectInfo[];
  providers: ProviderInfo[];
  onSelectThread: (id: string) => void;
  onCreateThread?: () => void;
  autoSettleAfterDays?: number | null;
}

export function KanbanView({
  threads,
  projects,
  providers,
  onSelectThread,
  onCreateThread,
  autoSettleAfterDays,
}: KanbanViewProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const settleOpts: SettleOpts = useMemo(
    () => ({
      now,
      autoSettleAfterDays:
        autoSettleAfterDays === undefined
          ? AUTO_SETTLE_AFTER_DAYS
          : autoSettleAfterDays,
    }),
    [now, autoSettleAfterDays],
  );

  const columns = useMemo(
    () => kanbanColumns(threads, settleOpts),
    [threads, settleOpts],
  );
  const empty = isKanbanEmpty(columns);
  const waitStates = useMemo(() => buildWaitStates(threads), [threads]);

  const slugFor = (thread: ThreadInfo): string =>
    projects.find((p) => p.id === thread.projectId)?.slug ?? "unknown";

  return (
    <main className={styles.main} data-kanban="">
      <header className={styles.header}>
        <h1 className={styles.title}>Kanban</h1>
      </header>
      {empty ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No threads on the board</p>
          <p className={styles.emptyHint}>
            Start one with New thread in the sidebar.
          </p>
          {onCreateThread ? (
            <button
              type="button"
              className={styles.newThread}
              onClick={onCreateThread}
              title="New thread"
            >
              New thread
            </button>
          ) : null}
        </div>
      ) : (
        <div className={styles.columns}>
          {columns.map((column) => (
            <section
              key={column.id}
              className={styles.column}
              data-kanban-column={column.id}
            >
              <header className={styles.columnHeader}>
                <span>{column.title}</span>
                <span className={styles.count}>{column.threads.length}</span>
              </header>
              <div className={styles.columnBody}>
                {column.threads.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    slug={slugFor(thread)}
                    providers={providers}
                    active={false}
                    now={now}
                    onSelect={(id) => onSelectThread(id)}
                    wait={waitStates.get(thread.id) ?? null}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
