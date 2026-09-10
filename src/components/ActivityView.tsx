import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  originFromRowKey,
  useViewRestore,
  type ThreadOpenOrigin,
  type ViewReturnState,
} from "../viewReturn";
import { activityKindLabel, groupActivityByDay } from "../activity";
import { formatRelativeAge } from "../format";
import type { ActivityItem, ProjectInfo } from "../shared/ipc";
import {
  ProjectScopeSelect,
  projectScopeLabel,
} from "./ProjectScopeSelect";
import styles from "./ActivityView.module.css";

export interface ActivityViewProps {
  projects: ProjectInfo[];
  /** Sidebar project scope: only show this project's activity. Null/omitted shows all. */
  projectScope?: string | null;
  listActivity: () => Promise<ActivityItem[]>;
  onSelectThread: (id: string, origin?: ThreadOpenOrigin) => void;
  onProjectScopeChange?: (id: string | null) => void;
  restore?: ViewReturnState | null;
  onRestoreApplied?: () => void;
  /** Live sidebar ids. Omitted means the list is still loading — treat rows as openable. */
  existingThreadIds?: Iterable<string>;
}

export function ActivityView({
  projects,
  projectScope = null,
  listActivity,
  onSelectThread,
  onProjectScopeChange,
  existingThreadIds,
  restore = null,
  onRestoreApplied,
}: ActivityViewProps) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLastSuccess, setHasLastSuccess] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const loadGen = useRef(0);

  const loadAll = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    try {
      const next = await listActivity();
      if (gen !== loadGen.current) return;
      setItems(Array.isArray(next) ? next : []);
      setHasLastSuccess(true);
      setNow(Date.now());
    } catch (err) {
      if (gen !== loadGen.current) return;
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to load activity";
      setError(msg);
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [listActivity]);

  useEffect(() => {
    void loadAll();
    return () => {
      loadGen.current += 1;
    };
  }, [loadAll]);

  const projectSlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.slug);
    return map;
  }, [projects]);

  const scoped = useMemo(
    () =>
      projectScope
        ? items.filter((i) => i.projectId === projectScope)
        : items,
    [items, projectScope],
  );
  const groups = useMemo(() => groupActivityByDay(scoped, now), [scoped, now]);
  const liveThreadIds = useMemo(() => {
    if (existingThreadIds == null) return null;
    return new Set(existingThreadIds);
  }, [existingThreadIds]);
  const empty = hasLastSuccess && scoped.length === 0;
  const showLoading = loading && !hasLastSuccess && !error;
  const initialError = Boolean(error && !hasLastSuccess);
  const scope = projectScopeLabel(projects, projectScope);
  const rootRef = useRef<HTMLElement>(null);
  useViewRestore(hasLastSuccess, restore, rootRef, onRestoreApplied);

  return (
    <main className={styles.main} data-activity="" ref={rootRef}>
      <header className={styles.header}>
        <h1 className={styles.title}>Activity</h1>
        <div className={styles.controls}>
          <ProjectScopeSelect
            projects={projects}
            value={projectScope}
            onChange={onProjectScopeChange}
          />
          <button
            type="button"
            className={styles.refresh}
            onClick={() => void loadAll()}
            disabled={loading}
            title="Refresh"
          >
            Refresh
          </button>
        </div>
      </header>

      {showLoading ? (
        <p className={styles.hint} aria-live="polite">
          Loading activity…
        </p>
      ) : initialError ? (
        <div className={styles.empty} data-activity-error="">
          <p className={styles.emptyTitle}>Could not load activity</p>
          <p className={styles.emptyHint} role="alert">
            {error}
          </p>
          <button
            type="button"
            className={styles.retry}
            onClick={() => void loadAll()}
            disabled={loading}
            title="Retry"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {error ? (
            <div className={styles.refreshStatus} data-activity-error="">
              <p className={styles.hint} role="alert">
                {error}
              </p>
              <p className={styles.hint} data-activity-stale="" data-stale="">
                Last successful activity · stale
              </p>
              <button
                type="button"
                className={styles.retry}
                onClick={() => void loadAll()}
                disabled={loading}
                title="Retry"
              >
                Retry
              </button>
            </div>
          ) : null}
          {empty ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle} data-scope-empty={scope.kind}>
            {scope.kind === "removed"
              ? "Removed project"
              : scope.kind === "project"
                ? `No activity in ${scope.name}`
                : "No activity yet"}
          </p>
          <p className={styles.emptyHint}>
            {scope.kind === "removed"
              ? "This project is no longer in the workspace."
              : "Runs, replies, and thread updates will show up here."}
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
        </div>
          ) : (
        <div className={styles.list} data-return-scroll="">
          {groups.map((group) => (
            <section
              key={group.key}
              className={styles.group}
              data-activity-group={group.label}
            >
              <h2 className={styles.groupHeader}>{group.label}</h2>
              {group.items.map((item) => {
                const slug = projectSlug.get(item.projectId) ?? item.projectId;
                const kind = activityKindLabel(item.kind);
                const missing =
                  liveThreadIds != null && !liveThreadIds.has(item.threadId);
                return (
                  <div
                    key={item.id}
                    className={styles.row}
                    data-activity-row={item.id}
                    data-return-row={item.id}
                    data-thread-unavailable={missing ? "" : undefined}
                  >
                    {missing ? null : (
                      <button
                        type="button"
                        className={styles.rowSelect}
                        aria-label={`Select thread: ${item.threadTitle}`}
                        onClick={() =>
                          onSelectThread(
                            item.threadId,
                            originFromRowKey(rootRef.current, item.id, {
                              projectId: projectScope ?? null,
                            }),
                          )
                        }
                      />
                    )}
                    <div className={styles.rowBody}>
                      <div className={styles.rowTop}>
                        <span className={styles.slug}>{slug}</span>
                        <span className={styles.threadTitle}>
                          {item.threadTitle}
                        </span>
                        {missing ? (
                          <span className={styles.unavailable}>
                            Transcript unavailable
                          </span>
                        ) : null}
                      </div>
                      <div className={styles.rowMeta}>
                        <span className={styles.kind} data-kind={item.kind}>
                          {kind}
                        </span>
                        <span className={styles.age}>
                          {formatRelativeAge(item.at, now)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
          )}
        </>
      )}
    </main>
  );
}
