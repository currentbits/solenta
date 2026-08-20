import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activityKindLabel, groupActivityByDay } from "../activity";
import { formatRelativeAge } from "../format";
import type { ActivityItem, ProjectInfo } from "../shared/ipc";
import styles from "./ActivityView.module.css";

export interface ActivityViewProps {
  projects: ProjectInfo[];
  /** Sidebar project scope: only show this project's activity. Null/omitted shows all. */
  projectScope?: string | null;
  listActivity: () => Promise<ActivityItem[]>;
  onSelectThread: (id: string) => void;
}

export function ActivityView({
  projects,
  projectScope = null,
  listActivity,
  onSelectThread,
}: ActivityViewProps) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const loadGen = useRef(0);

  const loadAll = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
    try {
      const next = await listActivity();
      if (gen !== loadGen.current) return;
      setItems(Array.isArray(next) ? next : []);
      setNow(Date.now());
    } catch {
      if (gen !== loadGen.current) return;
      setItems([]);
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
  const empty = !loading && scoped.length === 0;

  return (
    <main className={styles.main} data-activity="">
      <header className={styles.header}>
        <h1 className={styles.title}>Activity</h1>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void loadAll()}
          disabled={loading}
          title="Refresh"
        >
          Refresh
        </button>
      </header>

      {loading && items.length === 0 ? (
        <p className={styles.hint} aria-live="polite">
          Loading activity…
        </p>
      ) : empty ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No activity yet</p>
          <p className={styles.emptyHint}>
            Runs, replies, and thread updates will show up here.
          </p>
        </div>
      ) : (
        <div className={styles.list}>
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
                return (
                  <div
                    key={item.id}
                    className={styles.row}
                    data-activity-row={item.id}
                  >
                    <button
                      type="button"
                      className={styles.rowSelect}
                      aria-label={`Select thread: ${item.threadTitle}`}
                      onClick={() => onSelectThread(item.threadId)}
                    />
                    <div className={styles.rowBody}>
                      <div className={styles.rowTop}>
                        <span className={styles.slug}>{slug}</span>
                        <span className={styles.threadTitle}>
                          {item.threadTitle}
                        </span>
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
    </main>
  );
}
