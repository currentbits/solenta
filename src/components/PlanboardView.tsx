import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeAge } from "../format";
import {
  badgeLabels,
  isPlanEmpty,
  issueUpdatedMs,
  planColumns,
} from "../planboard";
import type { ListIssuesResult, ProjectInfo } from "../shared/ipc";
import styles from "./PlanboardView.module.css";

export interface PlanboardViewProps {
  projects: ProjectInfo[];
  listIssues: (projectPath: string) => Promise<ListIssuesResult>;
}

export function PlanboardView({ projects, listIssues }: PlanboardViewProps) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [result, setResult] = useState<ListIssuesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const loadGen = useRef(0);

  const project =
    projects.find((p) => p.id === projectId) ?? projects[0] ?? null;

  const load = useCallback(async () => {
    if (!project) return;
    const gen = ++loadGen.current;
    setLoading(true);
    const res = await listIssues(project.path);
    // Drop a stale response if the selector moved on meanwhile.
    if (gen !== loadGen.current) return;
    setResult(res);
    setLoading(false);
    setNow(Date.now());
  }, [project, listIssues]);

  useEffect(() => {
    setResult(null);
    void load();
  }, [load]);

  const columns = useMemo(
    () => planColumns(result && result.ok ? result.issues : []),
    [result],
  );
  const empty = result?.ok === true && isPlanEmpty(columns);

  return (
    <main className={styles.main} data-planboard="">
      <header className={styles.header}>
        <h1 className={styles.title}>Planboard</h1>
        <div className={styles.controls}>
          {projects.length > 0 ? (
            <select
              className={styles.projectSelect}
              value={project?.id ?? ""}
              onChange={(e) => setProjectId(e.target.value)}
              aria-label="Project"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.slug}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            className={styles.refresh}
            onClick={() => void load()}
            disabled={loading || !project}
            title="Refresh"
          >
            Refresh
          </button>
        </div>
      </header>

      {!project ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No projects</p>
          <p className={styles.emptyHint}>
            Add a project to see its plan here.
          </p>
        </div>
      ) : loading && !result ? (
        <p className={styles.hint} aria-live="polite">
          Loading plan…
        </p>
      ) : result && !result.ok ? (
        <div className={styles.empty} data-planboard-error="">
          <p className={styles.emptyTitle}>Couldn&apos;t load the plan</p>
          <p className={styles.emptyHint}>{result.reason}</p>
          <button
            type="button"
            className={styles.retry}
            onClick={() => void load()}
            title="Retry"
          >
            Retry
          </button>
        </div>
      ) : empty ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing on the plan yet</p>
          <p className={styles.emptyHint}>
            Agents track plan items as GitHub issues in this repo, labeled
            plan:todo, plan:doing, and plan:done.
          </p>
        </div>
      ) : (
        <div className={styles.columns}>
          {columns.map((column) => (
            <section
              key={column.id}
              className={styles.column}
              data-plan-column={column.id}
            >
              <header className={styles.columnHeader}>
                <span>{column.title}</span>
                <span className={styles.count}>{column.issues.length}</span>
              </header>
              <div className={styles.columnBody}>
                {column.issues.map((issue) => {
                  const updatedMs = issueUpdatedMs(issue);
                  return (
                    <a
                      key={issue.number}
                      className={styles.card}
                      href={issue.url}
                      target="_blank"
                      rel="noreferrer"
                      title={issue.url}
                      data-plan-issue={issue.number}
                    >
                      <span className={styles.cardTop}>
                        <span className={styles.number}>#{issue.number}</span>
                        <span className={styles.cardTitle}>{issue.title}</span>
                      </span>
                      <span className={styles.cardMeta}>
                        {badgeLabels(issue).map((label) => (
                          <span key={label} className={styles.badge}>
                            {label}
                          </span>
                        ))}
                        {updatedMs != null ? (
                          <span className={styles.age}>
                            {formatRelativeAge(updatedMs, now)}
                          </span>
                        ) : null}
                      </span>
                    </a>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
