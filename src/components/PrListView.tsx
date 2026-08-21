import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeAge } from "../format";
import {
  allPrsEmpty,
  formatPrDiff,
  groupPrsByProject,
  matchThreadForPr,
  prUpdatedMs,
} from "../prList";
import { forgeReadiness } from "../sourceControl";
import type {
  CheckoutPrResult,
  CoderApi,
  ListPrsResult,
  ProjectInfo,
  SourceControlDiscovery,
  ThreadInfo,
} from "../shared/ipc";
import styles from "./PrListView.module.css";

export interface PrListViewProps {
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  listPrs: (projectPath: string) => Promise<ListPrsResult>;
  onSelectThread: (id: string) => void;
  onCheckoutPr?: (input: {
    projectId: string;
    prNumber: number;
  }) => Promise<CheckoutPrResult>;
  /** Optional forge probe (#608). When omitted, the view discovers itself. */
  github?: { ready: boolean; hint: string | null } | null;
}

export function PrListView({
  projects,
  threads,
  listPrs,
  onSelectThread,
  onCheckoutPr,
  github: githubProp,
}: PrListViewProps) {
  const [results, setResults] = useState<Map<string, ListPrsResult>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [discoveredGithub, setDiscoveredGithub] = useState<{
    ready: boolean;
    hint: string | null;
  } | null>(null);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [checkoutErrors, setCheckoutErrors] = useState<Map<string, string>>(
    () => new Map(),
  );
  const loadGen = useRef(0);
  const github = githubProp !== undefined ? githubProp : discoveredGithub;

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

  useEffect(() => {
    if (githubProp !== undefined) return;
    let cancelled = false;
    const existing = (window as unknown as { coder?: CoderApi }).coder;
    const discover = existing?.sourceControl?.discover;
    if (typeof discover !== "function") return;
    void discover()
      .then((next: SourceControlDiscovery) => {
        if (!cancelled) setDiscoveredGithub(forgeReadiness(next, "github"));
      })
      .catch(() => {
        /* leave Check out on the click-and-fail path */
      });
    return () => {
      cancelled = true;
    };
  }, [githubProp]);

  const handleCheckout = useCallback(
    async (projectId: string, prNumber: number) => {
      if (!onCheckoutPr) return;
      const key = `${projectId}:${prNumber}`;
      if (checkingOut) return;
      setCheckingOut(key);
      setCheckoutErrors((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      try {
        const result = await onCheckoutPr({ projectId, prNumber });
        if (!result.ok) {
          setCheckoutErrors((prev) => {
            const next = new Map(prev);
            next.set(key, result.reason);
            return next;
          });
        }
      } finally {
        setCheckingOut(null);
      }
    },
    [onCheckoutPr, checkingOut],
  );

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
          <p className={styles.emptyHint}>
            Open pull requests across your projects will show up here.
          </p>
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
                  const checkoutKey = `${group.project.id}:${pr.number}`;
                  const checkoutBusy = checkingOut === checkoutKey;
                  const checkoutErr = checkoutErrors.get(checkoutKey);
                  const githubBlocked = github != null && github.ready === false;
                  const showCheckout = Boolean(onCheckoutPr) && !matched;
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
                          <div className={styles.rowActions}>
                            {showCheckout ? (
                              <button
                                type="button"
                                className={styles.checkout}
                                data-pr-checkout-btn=""
                                disabled={checkoutBusy || githubBlocked}
                                title={
                                  githubBlocked
                                    ? (github?.hint ?? "GitHub is not ready")
                                    : "Check out this pull request into a worktree thread"
                                }
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  void handleCheckout(
                                    group.project.id,
                                    pr.number,
                                  );
                                }}
                              >
                                {checkoutBusy ? "Checking out…" : "Check out"}
                              </button>
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
                        {checkoutErr ? (
                          <p
                            className={styles.checkoutError}
                            data-pr-checkout-error=""
                          >
                            {checkoutErr}
                          </p>
                        ) : null}
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
