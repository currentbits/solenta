import { useEffect, useMemo, useRef, useState } from "react";
import {
  originFromRowKey,
  useViewRestore,
  type ThreadOpenOrigin,
  type ViewReturnState,
} from "../viewReturn";
import { isKanbanEmpty, kanbanColumns } from "../kanban";
import {
  AUTO_SETTLE_AFTER_DAYS,
  type SettleOpts,
} from "../threadSettle";
import type {
  ConflictForecast,
  ProjectInfo,
  ProviderInfo,
  ThreadInfo,
} from "../shared/ipc";
import { buildWaitStates } from "../waiting";
import { ThreadCard } from "./Sidebar";
import {
  ProjectScopeSelect,
  projectScopeLabel,
} from "./ProjectScopeSelect";
import styles from "./KanbanView.module.css";

const TICK_MS = 5000;

export interface KanbanViewProps {
  threads: ThreadInfo[];
  projects: ProjectInfo[];
  /** Sidebar project scope: only show this project's threads. Null/omitted shows all. */
  projectScope?: string | null;
  providers: ProviderInfo[];
  onSelectThread: (id: string, origin?: ThreadOpenOrigin) => void;
  onProjectScopeChange?: (id: string | null) => void;
  restore?: ViewReturnState | null;
  onRestoreApplied?: () => void;
  onCreateThread?: () => void;
  autoSettleAfterDays?: number | null;
  autoSettleOnMerge?: boolean;
  conflictForecast?: ConflictForecast | null;
}

export function KanbanView({
  threads,
  projects,
  projectScope = null,
  providers,
  onSelectThread,
  onProjectScopeChange,
  restore = null,
  onRestoreApplied,
  onCreateThread,
  autoSettleAfterDays,
  autoSettleOnMerge,
  conflictForecast = null,
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
      autoSettleOnMerge: autoSettleOnMerge !== false,
    }),
    [now, autoSettleAfterDays, autoSettleOnMerge],
  );

  const scoped = useMemo(
    () =>
      projectScope
        ? threads.filter((t) => t.projectId === projectScope)
        : threads,
    [threads, projectScope],
  );
  const columns = useMemo(
    () => kanbanColumns(scoped, settleOpts),
    [scoped, settleOpts],
  );
  const empty = isKanbanEmpty(columns);
  const scope = projectScopeLabel(projects, projectScope);
  const waitStates = useMemo(() => buildWaitStates(threads), [threads]);
  const threadTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const t of threads) titles.set(t.id, t.title);
    return titles;
  }, [threads]);

  const slugFor = (thread: ThreadInfo): string =>
    projects.find((p) => p.id === thread.projectId)?.slug ?? "unknown";
  const rootRef = useRef<HTMLElement>(null);
  useViewRestore(true, restore, rootRef, onRestoreApplied);

  return (
    <main className={styles.main} data-kanban="" ref={rootRef}>
      <header className={styles.header}>
        <h1 className={styles.title}>Kanban</h1>
        <div className={styles.controls}>
          <ProjectScopeSelect
            projects={projects}
            value={projectScope}
            onChange={onProjectScopeChange}
          />
        </div>
      </header>
      {empty ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle} data-scope-empty={scope.kind}>
            {scope.kind === "removed"
              ? "Removed project"
              : scope.kind === "project"
                ? `No threads in ${scope.name}`
                : "No threads on the board"}
          </p>
          <p className={styles.emptyHint}>
            {scope.kind === "removed"
              ? "This project is no longer in the workspace."
              : "Start one with New thread in the sidebar."}
          </p>
          {scope.kind !== "all" ? (
            <button
              type="button"
              className={styles.showAll}
              onClick={() => onProjectScopeChange?.(null)}
            >
              Show all projects
            </button>
          ) : null}
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
              <div className={styles.columnBody} data-return-scroll={column.id}>
                {column.threads.map((thread) => (
                  <div key={thread.id} data-return-row={thread.id}>
                    <ThreadCard
                      thread={thread}
                      slug={slugFor(thread)}
                      providers={providers}
                      active={false}
                      now={now}
                      onSelect={(id) =>
                        onSelectThread(
                          id,
                          originFromRowKey(rootRef.current, id, {
                            projectId: projectScope ?? null,
                          }),
                        )
                      }
                      wait={waitStates.get(thread.id) ?? null}
                      conflictForecast={conflictForecast}
                      threadTitles={threadTitles}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
