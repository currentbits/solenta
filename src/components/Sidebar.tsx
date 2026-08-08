import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../shared/ipc";
import {
  formatRelativeAge,
  formatWorkingLabel,
  providerDisplayName,
} from "../format";
import { sidebarPrBadge } from "../prUi";
import { buildSidebarGroups } from "../sidebarGroups";
import styles from "./Sidebar.module.css";

const TICK_MS = 5000;
const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LEN = 2;

interface SidebarProps {
  appName: string;
  searchPlaceholder: string;
  projectsHeader: string;
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  /** Provider registry for display names on thread cards. */
  providers: ProviderInfo[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  /** Global + uses selected project; per-group New thread passes that projectId. */
  onCreateThread: (projectId?: string) => void;
  onAddProject: () => void;
  projectError?: string | null;
  onDismissProjectError?: () => void;
  /** Opens the Settings modal. */
  onOpenSettings?: () => void;
  /** Aggregated spend today (USD); null while loading. */
  spendTodayUsd?: number | null;
  /** Daily budget cap; null = no cap. */
  dailyBudgetUsd?: number | null;
  /**
   * Full-content thread search (titles + message text). Called only for
   * queries of 2+ chars after debounce; empty / 1-char stays local.
   */
  searchThreads: (input: { query: string }) => Promise<ThreadInfo[]>;
}

function formatUsd(n: number): string {
  return n.toFixed(2);
}

function spendMeterLabel(
  spend: number,
  budget: number | null | undefined,
): string {
  if (budget != null && budget > 0) {
    return `Today: $${formatUsd(spend)} / $${formatUsd(budget)}`;
  }
  return `Today: $${formatUsd(spend)}`;
}

function spendMeterTone(
  spend: number,
  budget: number | null | undefined,
): "ok" | "warn" | "over" {
  if (budget == null || budget <= 0) return "ok";
  const ratio = spend / budget;
  if (ratio >= 1) return "over";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

function StatusBadge({
  thread,
  now,
}: {
  thread: ThreadInfo;
  now: number;
}) {
  if (thread.status === "working") {
    const label =
      thread.runStartedAt != null
        ? formatWorkingLabel(thread.runStartedAt, now)
        : "Working";
    return (
      <span className={`${styles.badge} ${styles.badgeWorking}`}>
        <span className={styles.spinner} aria-hidden />
        {label}
      </span>
    );
  }

  if (thread.status === "done") {
    return (
      <span className={`${styles.badge} ${styles.badgeDone}`}>
        <span className={styles.check} aria-hidden>
          ✓
        </span>
        Done
      </span>
    );
  }

  if (thread.status === "failed") {
    return (
      <span className={`${styles.badge} ${styles.badgeFailed}`}>
        Failed
      </span>
    );
  }

  return null;
}

function ThreadCard({
  thread,
  slug,
  providers,
  active,
  now,
  onSelect,
  contentMatch,
}: {
  thread: ThreadInfo;
  slug: string;
  providers: ProviderInfo[];
  active: boolean;
  now: number;
  onSelect: (id: string) => void;
  /** True when hit is on message text, not title (search mode only). */
  contentMatch?: boolean;
}) {
  const branch = thread.branch ?? "";
  const prBadge = sidebarPrBadge({
    prNumber: thread.prNumber,
    prUrl: thread.prUrl,
  });
  const providerLabel = providerDisplayName(thread.provider, providers);

  // Card is a div (not a button) so the PR link is not nested interactive.
  // Selection lives on a sibling button that covers the non-link content.
  return (
    <div
      className={styles.card}
      data-active={active}
      data-archived={thread.archived ? "true" : undefined}
    >
      <button
        type="button"
        className={styles.cardSelect}
        onClick={() => onSelect(thread.id)}
      >
        <div className={styles.cardTop}>
          <span className={styles.repo}>{slug}</span>
          <span className={styles.age}>
            {formatRelativeAge(thread.updatedAt, now)}
          </span>
        </div>
        <div className={styles.cardTitle}>{thread.title}</div>
        <div className={styles.cardTags}>
          <span className={styles.providerTag}>{providerLabel}</span>
          {thread.worktreePath && (
            <span className={styles.worktreeTag}>wt</span>
          )}
          {thread.archived && (
            <span className={styles.archivedTag}>archived</span>
          )}
          {contentMatch && (
            <span className={styles.inMessagesTag}>in messages</span>
          )}
        </div>
      </button>
      <div className={styles.cardMeta}>
        <span className={styles.branch}>
          {branch}
          {branch && prBadge ? " · " : null}
          {prBadge?.href ? (
            <a
              className={styles.prLink}
              href={prBadge.href}
              target="_blank"
              rel="noreferrer"
              title={prBadge.href}
            >
              {prBadge.label}
            </a>
          ) : prBadge ? (
            <span>{prBadge.label}</span>
          ) : null}
        </span>
        <button
          type="button"
          className={styles.metaSelect}
          onClick={() => onSelect(thread.id)}
          aria-label="Select thread"
        >
          <StatusBadge thread={thread} now={now} />
        </button>
      </div>
    </div>
  );
}

export function Sidebar({
  appName,
  searchPlaceholder,
  projectsHeader,
  projects,
  threads,
  providers,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  onAddProject,
  projectError = null,
  onDismissProjectError,
  onOpenSettings,
  spendTodayUsd = null,
  dailyBudgetUsd = null,
  searchThreads,
}: SidebarProps) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /** Project ids whose archived threads are shown inline (normal view only). */
  const [showArchived, setShowArchived] = useState<Set<string>>(() => new Set());
  /** Full-content search results; null means not in active search mode. */
  const [searchResults, setSearchResults] = useState<ThreadInfo[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  const searchGen = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One shared interval for the whole list (age + working elapsed).
  useEffect(() => {
    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => window.clearInterval(handle);
  }, []);

  const projectById = useMemo(() => {
    const m = new Map<string, ProjectInfo>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const liveById = useMemo(() => {
    const m = new Map<string, ThreadInfo>();
    for (const t of threads) m.set(t.id, t);
    return m;
  }, [threads]);

  const trimmedQuery = query.trim();
  /** Active full-content search mode (2+ chars). */
  const searching = trimmedQuery.length >= MIN_SEARCH_LEN;

  const runSearch = useCallback(
    async (q: string) => {
      const gen = ++searchGen.current;
      setSearchLoading(true);
      try {
        const list = await searchThreads({ query: q });
        if (!mountedRef.current || searchGen.current !== gen) return;
        setSearchResults(list);
      } catch {
        if (!mountedRef.current || searchGen.current !== gen) return;
        setSearchResults([]);
      } finally {
        if (mountedRef.current && searchGen.current === gen) {
          setSearchLoading(false);
        }
      }
    },
    [searchThreads],
  );

  // Debounced full-content search for 2+ chars; 0–1 char restores local view.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_SEARCH_LEN) {
      // Instant restore: bump gen so in-flight results are ignored.
      searchGen.current += 1;
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }

    const handle = window.setTimeout(() => {
      void runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, runSearch]);

  /**
   * Threads shown in the list: normal view uses full list; search mode uses
   * server results with live status overlaid from the threads prop. While
   * waiting for the first response, show nothing (loading hint covers it).
   */
  const displayThreads = useMemo(() => {
    if (!searching) return threads;
    if (searchResults == null) return [];
    return searchResults.map((t) => liveById.get(t.id) ?? t);
  }, [searching, searchResults, threads, liveById]);

  const groups = useMemo(() => {
    // While searching, only surface projects that still have matching threads
    // (empty projects stay hidden so the empty-search state can show).
    if (searching) {
      const projectsWithHits = projects.filter((p) =>
        displayThreads.some((t) => t.projectId === p.id),
      );
      return buildSidebarGroups(projectsWithHits, displayThreads);
    }
    return buildSidebarGroups(projects, displayThreads);
  }, [projects, displayThreads, searching]);

  const toggleArchived = (groupKey: string) => {
    setShowArchived((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const canCreate = projects.length > 0;
  const queryLower = trimmedQuery.toLowerCase();
  const sectionCount = searching ? displayThreads.length : projects.length;
  /** Debounce window or in-flight request: show subtle "Searching…" hint. */
  const searchInFlight = searching && (searchLoading || searchResults == null);
  /** Search finished with zero hits (not still loading the first response). */
  const searchEmpty =
    searching &&
    !searchInFlight &&
    searchResults != null &&
    searchResults.length === 0;

  return (
    <aside className={styles.sidebar}>
      <div className={styles.dragRegion} />
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>◇</span>
          <span className={styles.brandName}>{appName}</span>
        </div>
        <button
          type="button"
          className={styles.headerAdd}
          onClick={() => onCreateThread()}
          disabled={!canCreate}
          title={
            canCreate
              ? "New thread"
              : "Add a project before creating a thread"
          }
          aria-label="New thread"
        >
          +
        </button>
      </header>

      <div className={styles.searchRow}>
        <span className={styles.searchIcon} aria-hidden>
          ⌕
        </span>
        <input
          className={styles.searchInput}
          type="search"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search threads"
        />
      </div>

      <button
        type="button"
        className={styles.sectionHeader}
        onClick={() => setProjectsOpen((v) => !v)}
        aria-expanded={projectsOpen}
      >
        <span className={styles.chevron} data-open={projectsOpen}>
          ▸
        </span>
        <span>{projectsHeader}</span>
        <span className={styles.count}>{sectionCount}</span>
      </button>

      <div className={styles.list}>
        {projectsOpen && projects.length === 0 && (
          <button
            type="button"
            className={styles.addProjectRow}
            onClick={onAddProject}
          >
            Add project
          </button>
        )}

        {projectsOpen && searchInFlight && (
          <p className={styles.searchHint} aria-live="polite">
            Searching…
          </p>
        )}

        {projectsOpen && projects.length > 0 && searchEmpty && (
          <p className={styles.emptySearch}>No threads match</p>
        )}

        {projectsOpen &&
          groups.map(({ project, threads: groupThreads }) => {
            const groupKey =
              project?.id ?? groupThreads[0]?.projectId ?? "orphan";
            const slug =
              project?.slug ??
              (groupThreads[0]
                ? projectById.get(groupThreads[0].projectId)?.slug
                : undefined) ??
              "unknown";
            const activeThreads = groupThreads.filter((t) => !t.archived);
            const archivedThreads = groupThreads.filter((t) => t.archived);
            // During search, archived hits render inline (no toggle required).
            const archivedExpanded = searching
              ? true
              : showArchived.has(groupKey);
            const hasAnyThreads = groupThreads.length > 0;

            return (
              <div key={groupKey} className={styles.group}>
                <div className={styles.groupHeader}>
                  <span className={styles.groupSlug}>{slug}</span>
                  <span className={styles.groupCount}>
                    {searching ? groupThreads.length : activeThreads.length}
                  </span>
                </div>

                {!hasAnyThreads ? (
                  <div className={styles.emptyGroup}>
                    <span className={styles.emptyThreads}>No threads yet</span>
                    {project && !searching && (
                      <button
                        type="button"
                        className={styles.groupNewThread}
                        onClick={() => onCreateThread(project.id)}
                      >
                        New thread
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    {activeThreads.map((thread) => (
                      <ThreadCard
                        key={thread.id}
                        thread={thread}
                        slug={slug}
                        providers={providers}
                        active={thread.id === activeThreadId}
                        now={now}
                        onSelect={onSelectThread}
                        contentMatch={
                          searching &&
                          !thread.title.toLowerCase().includes(queryLower)
                        }
                      />
                    ))}
                    {archivedExpanded &&
                      archivedThreads.map((thread) => (
                        <ThreadCard
                          key={thread.id}
                          thread={thread}
                          slug={slug}
                          providers={providers}
                          active={thread.id === activeThreadId}
                          now={now}
                          onSelect={onSelectThread}
                          contentMatch={
                            searching &&
                            !thread.title.toLowerCase().includes(queryLower)
                          }
                        />
                      ))}
                    {!searching && archivedThreads.length > 0 && (
                      <button
                        type="button"
                        className={styles.archivedToggle}
                        onClick={() => toggleArchived(groupKey)}
                        aria-expanded={archivedExpanded}
                      >
                        {archivedExpanded
                          ? "Hide archived"
                          : `${archivedThreads.length} archived`}
                      </button>
                    )}
                    {project && !searching && (
                      <button
                        type="button"
                        className={styles.groupNewThread}
                        onClick={() => onCreateThread(project.id)}
                      >
                        New thread
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
      </div>

      <footer className={styles.footer}>
        {projectError && (
          <div className={styles.errorBanner} role="alert">
            <span className={styles.errorText}>{projectError}</span>
            <button
              type="button"
              className={styles.errorDismiss}
              onClick={onDismissProjectError}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
        {spendTodayUsd != null && (
          <div
            className={styles.spendMeter}
            data-tone={spendMeterTone(spendTodayUsd, dailyBudgetUsd)}
            title="Spend today across all providers"
          >
            {spendMeterLabel(spendTodayUsd, dailyBudgetUsd)}
          </div>
        )}
        <div className={styles.footerRow}>
          <button
            type="button"
            className={styles.settings}
            onClick={() => onOpenSettings?.()}
          >
            <span className={styles.settingsIcon} aria-hidden>
              ⚙
            </span>
            Settings
          </button>
          {projects.length > 0 && (
            <button
              type="button"
              className={styles.footerAdd}
              onClick={onAddProject}
              title="Add project"
              aria-label="Add project"
            >
              +
            </button>
          )}
        </div>
      </footer>
    </aside>
  );
}
