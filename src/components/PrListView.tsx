import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeAge } from "../format";
import {
  allPrsEmpty,
  formatPrDiff,
  groupPrsByProject,
  matchThreadForPr,
  prUpdatedMs,
} from "../prList";
import type { ListPrsResult, ProjectInfo, ThreadInfo } from "../shared/ipc";
import styles from "./PrListView.module.css";

export interface PrListViewProps {
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  listPrs: (projectPath: string) => Promise<ListPrsResult>;
  onSelectThread: (id: string) => void;
}

export function PrListView({
  projects,
  threads,
  listPrs,
  onSelectThread,
}: PrListViewProps) {
  const [results, setResults] = useState<Map<string, ListPrsResult>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const loadGen = useRef(0);

  const loadAll = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
    const entries = await Promise.all(
      projects.map(async (project) => {
        const result = await listPrs(project.path);
        return [project.id, result] as const;
      }),
    );
    if (gen !== loadGen.current) return;
    setResults(new Map(entries));
    setLoading(false);
    setNow(Date.now());
  }, [projects, listPrs]);

  useEffect(() => {
    void loadAll();
    return () => {
      loadGen.current += 1;
    };
  }, [loadAll]);

  const retryProject = useCallback(
    async (project: ProjectInfo) => {
      const result = await listPrs(project.path);
      setResults((prev) => {
        const next = new Map(prev);
        next.set(project.id, result);
        return next;
      });
      setNow(Date.now());
    },
    [listPrs],
  );

  const groups = useMemo(
    () => groupPrsByProject(projects, results),
    [projects, results],
  );
  const empty = !loading && allPrsEmpty(groups);
  const noProjects = projects.length === 0 && !loading;

  return (
    <main className={styles.main} data-pr-list="">
      <header className={styles.header}>
        <h1 className={styles.title}>Pull requests</h1>
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

      {loading && results.size === 0 ? (
        <p className={styles.hint} aria-live="polite">
          Loading pull requests…
        </p>
      ) : empty || noProjects ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No open pull requests</p>
        </div>
      ) : (
        <div className={styles.list}>
          {groups.map((group) => (
            <section
              key={group.project.id}
              className={styles.group}
              data-pr-group={group.project.slug}
            >
              <h2 className={styles.groupHeader}>{group.project.slug}</h2>
              {!group.ok ? (
                <div className={styles.errorRow} data-pr-error="">
                  <span>Couldn&apos;t load PR data</span>
                  <button
                    type="button"
                    className={styles.retry}
                    onClick={() => void retryProject(group.project)}
                    title="Retry"
                  >
                    Retry
                  </button>
                </div>
              ) : group.prs.length === 0 ? (
                <p className={styles.hint}>No open pull requests</p>
              ) : (
                group.prs.map((pr) => {
                  const matched = matchThreadForPr(
                    pr,
                    threads,
                    group.project.id,
                  );
                  const diff = formatPrDiff(pr);
                  const updatedMs = prUpdatedMs(pr);
                  return (
                    <div
                      key={`${group.project.id}-${pr.number}`}
                      className={styles.row}
                      data-pr-row={pr.number}
                    >
                      <button
                        type="button"
                        className={styles.rowSelect}
                        disabled={!matched}
                        aria-label={`Select thread for PR #${pr.number}`}
                        onClick={() => {
                          if (matched) onSelectThread(matched.id);
                        }}
                      />
                      <div className={styles.rowBody}>
                        <div className={styles.rowTop}>
                          <span className={styles.number}>#{pr.number}</span>
                          <span className={styles.prTitle}>{pr.title}</span>
                          {pr.isDraft ? (
                            <span className={styles.draft}>Draft</span>
                          ) : null}
                        </div>
                        <div className={styles.rowMeta}>
                          {pr.headRefName ? (
                            <span className={styles.branch}>
                              {pr.headRefName}
                            </span>
                          ) : null}
                          {diff ? (
                            <span className={styles.diff}>{diff}</span>
                          ) : null}
                          {updatedMs != null ? (
                            <span className={styles.age}>
                              {formatRelativeAge(updatedMs, now)}
                            </span>
                          ) : null}
                          <a
                            className={styles.prLink}
                            href={pr.url}
                            target="_blank"
                            rel="noreferrer"
                            title={pr.url}
                          >
                            Open
                          </a>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
