import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeAge } from "../format";
import {
  badgeLabels,
  formatLineCount,
  isPlanEmpty,
  issueUpdatedMs,
  planColumns,
  reviewLoad,
} from "../planboard";
import type { PlanSort } from "../planboard";
import type {
  ListIssuesResult,
  ListPrsResult,
  ProjectInfo,
  ThreadInfo,
} from "../shared/ipc";
import styles from "./PlanboardView.module.css";

/** How the Planboard's Start task button creates its thread. */
export type ThreadStartMode = "default" | "plain" | "worktree" | "orchestrator";

export interface PlanboardViewProps {
  projects: ProjectInfo[];
  /** Seed the project selector. Sidebar scope passes this on open (#597). */
  initialProjectId?: string | null;
  listIssues: (projectPath: string) => Promise<ListIssuesResult>;
  /**
   * Open PRs for the selected project (review-load meter, issue #402).
   * Omitted by older tests, which keeps the meter off those boards.
   */
  listPrs?: (projectPath: string) => Promise<ListPrsResult>;
  /**
   * Threads of every project; those of the selected one with a mirrored plan
   * (ThreadInfo.planSteps) render under the issue columns. Omitted by older
   * tests, which keeps that section off those boards.
   */
  threads?: ThreadInfo[];
  onSelectThread?: (id: string) => void;
  /**
   * Start a thread on a Todo issue and move it to plan:doing. Omitted by
   * existing tests, which keeps the button off those boards.
   */
  onStartTask?: (input: {
    projectId: string;
    projectPath: string;
    ref: string;
    mode: ThreadStartMode;
  }) => Promise<{ ok: true; warning?: string } | { ok: false; reason: string }>;
}

export function PlanboardView({
  projects,
  listIssues,
  listPrs,
  threads,
  onSelectThread,
  onStartTask,
  initialProjectId,
}: PlanboardViewProps) {
  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? null);
  const [result, setResult] = useState<ListIssuesResult | null>(null);
  const [prs, setPrs] = useState<ListPrsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** Issue number whose start is in flight, and the last start's message. */
  const [starting, setStarting] = useState<number | null>(null);
  const [startNote, setStartNote] = useState<string | null>(null);
  /** Thread mode for Start task; "default" follows the app setting. */
  const [startMode, setStartMode] = useState<ThreadStartMode>("default");
  /** Column ordering; "updated" is the long-standing default. */
  const [sort, setSort] = useState<PlanSort>("updated");
  const loadGen = useRef(0);

  useEffect(() => {
    if (initialProjectId !== undefined) {
      setProjectId(initialProjectId ?? null);
    }
  }, [initialProjectId]);

  const project =
    projects.find((p) => p.id === projectId) ?? projects[0] ?? null;

  const load = useCallback(async () => {
    if (!project) return;
    const gen = ++loadGen.current;
    setLoading(true);
    // Issues and PRs load together; a PR-list failure only costs the meter.
    const [res, prRes] = await Promise.all([
      listIssues(project.path),
      listPrs ? listPrs(project.path) : Promise.resolve(null),
    ]);
    // Drop a stale response if the selector moved on meanwhile.
    if (gen !== loadGen.current) return;
    setResult(res);
    setPrs(prRes);
    setLoading(false);
    setNow(Date.now());
  }, [project, listIssues, listPrs]);

  useEffect(() => {
    setResult(null);
    setPrs(null);
    void load();
  }, [load]);

  const startTask = useCallback(
    async (issueNumber: number) => {
      if (!onStartTask || !project || starting != null) return;
      setStarting(issueNumber);
      setStartNote(null);
      const res = await onStartTask({
        projectId: project.id,
        projectPath: project.path,
        ref: String(issueNumber),
        mode: startMode,
      });
      setStarting(null);
      if (!res.ok) {
        setStartNote(`#${issueNumber}: ${res.reason}`);
        return;
      }
      if (res.warning) setStartNote(`#${issueNumber}: ${res.warning}`);
      // Card moved to In progress on GitHub; pull the board back in sync.
      void load();
    },
    [onStartTask, project, starting, load, startMode],
  );

  const columns = useMemo(
    () => planColumns(result && result.ok ? result.issues : [], sort),
    [result, sort],
  );
  // Review-load meter: open non-draft PRs consume the human review budget.
  const review = useMemo(
    () => (prs && prs.ok ? reviewLoad(prs.prs) : null),
    [prs],
  );
  // Live agent plans for this project, newest thread first.
  const plans = useMemo(
    () =>
      (threads ?? [])
        .filter(
          (t) =>
            t.projectId === project?.id &&
            !t.archived &&
            (t.planSteps?.length ?? 0) > 0,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [threads, project],
  );
  const empty =
    result?.ok === true && isPlanEmpty(columns) && plans.length === 0;

  return (
    <main className={styles.main} data-planboard="">
      <header className={styles.header}>
        <h1 className={styles.title}>Planboard</h1>
        {review ? (
          <span
            className={styles.reviewLoad}
            data-review-load={review.level}
            title="Open, non-draft PRs awaiting human review and their combined size — the reviewer is the bottleneck, not the agents"
          >
            Review load: {review.openPrs} PR{review.openPrs === 1 ? "" : "s"} ·{" "}
            {formatLineCount(review.totalLines)} lines
          </span>
        ) : null}
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
          {onStartTask ? (
            <select
              className={styles.startMode}
              value={startMode}
              onChange={(e) =>
                setStartMode(e.target.value as ThreadStartMode)
              }
              data-plan-start-mode=""
              aria-label="Start tasks as"
              title="How Start task creates its thread"
            >
              <option value="default">Start as: Default</option>
              <option value="plain">Start as: Plain</option>
              <option value="worktree">Start as: Worktree</option>
              <option value="orchestrator">Start as: Orchestrator</option>
            </select>
          ) : null}
          <select
            className={styles.sort}
            value={sort}
            onChange={(e) => setSort(e.target.value as PlanSort)}
            data-plan-sort=""
            aria-label="Sort issues"
            title="Order the cards in every column"
          >
            <option value="updated">Sort: Recently updated</option>
            <option value="number-asc">Sort: Low to high</option>
            <option value="created-desc">Sort: Newest added</option>
            <option value="created-asc">Sort: Oldest added</option>
          </select>
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

      {startNote ? (
        <p className={styles.startNote} aria-live="polite" data-plan-start-note="">
          {startNote}
        </p>
      ) : null}

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
                  const canStart = onStartTask && column.id === "todo";
                  return (
                    <div key={issue.number} className={styles.cardWrap}>
                    <a
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
                    {canStart ? (
                      <button
                        type="button"
                        className={
                          starting === issue.number
                            ? `${styles.start} ${styles.startActive}`
                            : styles.start
                        }
                        onClick={() => void startTask(issue.number)}
                        disabled={starting != null}
                        data-plan-start={issue.number}
                        title={`Start a thread on #${issue.number}`}
                      >
                        {starting === issue.number ? "Starting…" : "Start task"}
                      </button>
                    ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {plans.length > 0 ? (
        <section className={styles.plans} data-thread-plans="">
          <header className={styles.columnHeader}>
            <span>Thread plans</span>
            <span className={styles.count}>{plans.length}</span>
          </header>
          <div className={styles.plansBody}>
            {plans.map((thread) => (
              <div
                key={thread.id}
                className={styles.planCard}
                data-thread-plan={thread.id}
              >
                <button
                  type="button"
                  className={styles.planTitle}
                  onClick={() => onSelectThread?.(thread.id)}
                  disabled={!onSelectThread}
                  title={`Open ${thread.title}`}
                >
                  {thread.title}
                </button>
                <ol className={styles.steps}>
                  {(thread.planSteps ?? []).map((s, i) => (
                    <li
                      key={`${i}-${s.step}`}
                      className={styles.step}
                      data-plan-step={s.status}
                    >
                      {s.step}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
