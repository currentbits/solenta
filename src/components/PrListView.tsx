import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeAge } from "../format";
import {
  allPrsEmpty,
  filterPrGroups,
  formatPrDiff,
  groupPrsByProject,
  matchThreadForPr,
  PR_LIST_MAX_LIMIT,
  PR_LIST_PAGE_SIZE,
  prUpdatedMs,
} from "../prList";
import { forgeReadiness } from "../sourceControl";
import type {
  CheckoutPrResult,
  CoderApi,
  ListPrsOptions,
  ListPrsResult,
  ProjectInfo,
  SourceControlDiscovery,
  ThreadInfo,
} from "../shared/ipc";
import styles from "./PrListView.module.css";

export interface PrListViewProps {
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  listPrs: (
    projectPath: string,
    opts?: ListPrsOptions,
  ) => Promise<ListPrsResult>;
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
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
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

  const loadMore = useCallback(
    async (project: ProjectInfo) => {
      if (loadingMore) return;
      const current = results.get(project.id);
      const currentLimit =
        current && current.ok
          ? (current.limit ?? PR_LIST_PAGE_SIZE)
          : PR_LIST_PAGE_SIZE;
      if (currentLimit >= PR_LIST_MAX_LIMIT) return;
      const limit = Math.min(PR_LIST_MAX_LIMIT, currentLimit + PR_LIST_PAGE_SIZE);
      setLoadingMore(project.id);
      try {
        const result = await listPrs(project.path, { limit });
        setResults((prev) => {
          const next = new Map(prev);
          next.set(project.id, result);
          return next;
        });
        setNow(Date.now());
      } finally {
        setLoadingMore(null);
      }
    },
    [listPrs, loadingMore, results],
  );

  const groups = useMemo(
    () => groupPrsByProject(projects, results),
    [projects, results],
  );
  const scoped = useMemo(
    () => filterPrGroups(groups, { projectId: projectFilter || null }),
    [groups, projectFilter],
  );
  const filtered = useMemo(
    () => filterPrGroups(scoped, { query }),
    [scoped, query],
  );
  const loadedCount = scoped.reduce(
    (n, group) => n + (group.ok ? group.prs.length : 0),
    0,
  );
  const matchCount = filtered.reduce(
    (n, group) => n + (group.ok ? group.prs.length : 0),
    0,
  );
  const incomplete = scoped.some((group) => group.ok && !group.complete);
  const filtering = Boolean(query.trim() || projectFilter);
  const sourceEmpty = allPrsEmpty(groups);
  const hasVisibleError = filtered.some((group) => !group.ok);
  const noMatch =
    !loading && !sourceEmpty && filtering && matchCount === 0 && !hasVisibleError;
  const empty = !loading && sourceEmpty;
  const noProjects = projects.length === 0 && !loading;

  const resetFilters = () => {
    setQuery("");
    setProjectFilter("");
  };

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

      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.search}
          data-pr-search=""
          placeholder="Search number, title, or branch"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            }
          }}
          aria-label="Search pull requests"
        />
        <select
          className={styles.projectFilter}
          data-pr-project-filter=""
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
          aria-label="Filter by project"
        >
          <option value="">All projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.slug}
            </option>
          ))}
        </select>
        <span className={styles.count} aria-live="polite">
          {filtering ? `${matchCount} of ${loadedCount}` : `${loadedCount}`}
        </span>
        {filtering ? (
          <button
            type="button"
            className={styles.reset}
            onClick={resetFilters}
          >
            Reset
          </button>
        ) : null}
      </div>

      {query.trim() && incomplete ? (
        <p
          className={styles.partial}
          data-pr-partial-search=""
          aria-live="polite"
        >
          Searching the first {loadedCount} loaded pull requests. More may
          exist.
        </p>
      ) : null}

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
      ) : noMatch ? (
        <div className={styles.empty} data-pr-no-match="">
          <p className={styles.emptyTitle}>No matching pull requests</p>
          <p className={styles.emptyHint}>
            {incomplete
              ? "No matches in the loaded subset. Load more or clear the search."
              : "Try another number, title, branch, or project."}
          </p>
          {incomplete
            ? scoped
                .filter(
                  (group) =>
                    group.ok &&
                    !group.complete &&
                    group.limit < PR_LIST_MAX_LIMIT,
                )
                .map((group) => (
                  <button
                    key={group.project.id}
                    type="button"
                    className={styles.retry}
                    data-pr-load-more=""
                    disabled={loadingMore === group.project.id}
                    onClick={() => void loadMore(group.project)}
                  >
                    {loadingMore === group.project.id
                      ? "Loading…"
                      : `Load more in ${group.project.slug}`}
                  </button>
                ))
            : null}
        </div>
      ) : (
        <div className={styles.list}>
          {filtered.map((group) => {
            if (group.ok && group.prs.length === 0 && query.trim()) return null;
            return (
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
              {group.ok && !group.complete ? (
                <div className={styles.moreRow}>
                  <p className={styles.moreHint}>
                    Showing {group.limit} loaded pull requests. More may exist.
                  </p>
                  {group.limit < PR_LIST_MAX_LIMIT ? (
                    <button
                      type="button"
                      className={styles.retry}
                      data-pr-load-more=""
                      disabled={loadingMore === group.project.id}
                      onClick={() => void loadMore(group.project)}
                    >
                      {loadingMore === group.project.id
                        ? "Loading…"
                        : "Load more"}
                    </button>
                  ) : (
                    <p className={styles.moreHint}>
                      Showing the first {PR_LIST_MAX_LIMIT} open pull requests.
                    </p>
                  )}
                </div>
              ) : null}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
