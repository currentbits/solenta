import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../shared/ipc";
import {
  formatRelativeAge,
  formatWorkingLabel,
  providerDisplayName,
} from "../format";
import { sidebarPrBadge } from "../prUi";
import {
  buildSidebarGroups,
  groupHeaderSummary,
  partitionSidebar,
} from "../sidebarGroups";
import {
  AUTO_SETTLE_AFTER_DAYS,
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
  effectiveSettled,
  resolveSettledTimestamp,
} from "../threadSettle";
import styles from "./Sidebar.module.css";

const TICK_MS = 5000;
const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LEN = 2;
const COLLAPSED_KEY = "coder.sidebar.collapsedGroups";

/** localStorage set, defensive: private mode / quota / bad JSON all mean "empty". */
function loadKeySet(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveKeySet(key: string, set: Set<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    // Quota/private mode: collapse state just stops persisting.
  }
}

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
  /**
   * Pin or unpin settle override for a thread card (hover action).
   * override "settled" folds it; "active" keeps it out of the fold.
   */
  onSetSettled?: (
    threadId: string,
    override: "settled" | "active",
  ) => void | Promise<void>;
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

/** Exported for render tests that need a card without the archived-collapse gate. */
export function ThreadCard({
  thread,
  slug,
  providers,
  active,
  now,
  onSelect,
  contentMatch,
  isSettled = false,
  onSetSettled,
}: {
  thread: ThreadInfo;
  slug: string;
  providers: ProviderInfo[];
  active: boolean;
  now: number;
  onSelect: (id: string) => void;
  /** True when hit is on message text, not title (search mode only). */
  contentMatch?: boolean;
  /** Whether this card is currently settled (drives unsettle pin). */
  isSettled?: boolean;
  onSetSettled?: (
    threadId: string,
    override: "settled" | "active",
  ) => void | Promise<void>;
}) {
  const branch = thread.branch ?? "";
  const prBadge = sidebarPrBadge({
    prNumber: thread.prNumber,
    prUrl: thread.prUrl,
  });
  const providerLabel = providerDisplayName(thread.provider, providers);
  const working = thread.status === "working";
  // Settled cards offer "keep active"; attention cards offer "settle".
  const settleOverride = isSettled ? ("active" as const) : ("settled" as const);
  const settleLabel = isSettled ? "Keep thread active" : "Settle thread";

  // Card is a non-interactive shell. Stretch select + optional settle action
  // are separate focusables. Content sits in a sibling with pointer-events:none
  // so clicks fall through to select; PR <a> and settle re-enable pointer-events.
  // Never nest interactive controls inside the select button.
  return (
    <div
      className={styles.card}
      data-thread-card={thread.id}
      data-active={active}
      data-archived={thread.archived ? "true" : undefined}
      data-settled={isSettled ? "true" : undefined}
    >
      <button
        type="button"
        className={styles.cardSelect}
        onClick={() => onSelect(thread.id)}
        aria-label={`Select thread: ${thread.title}`}
      />
      <div className={styles.cardBody}>
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
        <div className={styles.cardMeta}>
          <div className={styles.branchRow}>
            {/* Truncation applies only to the branch name; PR chip is a sibling. */}
            <span className={styles.branch}>{branch}</span>
            {branch && prBadge ? (
              <span className={styles.branchSep} aria-hidden>
                {" · "}
              </span>
            ) : null}
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
              <span className={styles.prLabel}>{prBadge.label}</span>
            ) : null}
          </div>
          <StatusBadge thread={thread} now={now} />
        </div>
      </div>
      {onSetSettled && (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.settleBtn}
            aria-label={settleLabel}
            title={
              working
                ? "Cannot settle while a run is active"
                : settleLabel
            }
            disabled={working}
            onClick={(e) => {
              e.stopPropagation();
              void onSetSettled(thread.id, settleOverride);
            }}
          >
            {isSettled ? "↑" : "↓"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Slim settled tail row (t3-style): title + project slug + wrap-up age.
 * Dimmed at rest, restored on hover. Selectable; Keep-active hover pin only
 * (opening a settled thread does NOT un-settle).
 */
export function SettledRow({
  thread,
  slug,
  active,
  now,
  onSelect,
  onSetSettled,
}: {
  thread: ThreadInfo;
  slug: string;
  active: boolean;
  now: number;
  onSelect: (id: string) => void;
  onSetSettled?: (
    threadId: string,
    override: "settled" | "active",
  ) => void | Promise<void>;
}) {
  const wrapUpAt = resolveSettledTimestamp(thread);
  return (
    <div
      className={styles.settledRow}
      data-thread-card={thread.id}
      data-settled="true"
      data-active={active}
    >
      <button
        type="button"
        className={styles.cardSelect}
        onClick={() => onSelect(thread.id)}
        aria-label={`Select thread: ${thread.title}`}
      />
      <div className={styles.settledBody}>
        <span className={styles.settledTitle}>{thread.title}</span>
        <span className={styles.settledSlug}>{slug}</span>
        <span className={styles.settledAge}>
          {formatRelativeAge(wrapUpAt, now)}
        </span>
      </div>
      {onSetSettled && (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.settleBtn}
            aria-label="Keep thread active"
            title="Keep thread active"
            onClick={(e) => {
              e.stopPropagation();
              void onSetSettled(thread.id, "active");
            }}
          >
            ↑
          </button>
        </div>
      )}
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
  onSetSettled,
}: SidebarProps) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /** Project ids whose archived threads are shown inline (normal view only). */
  const [showArchived, setShowArchived] = useState<Set<string>>(() => new Set());
  /** Group keys the user collapsed. Survives restarts: collapsing a noisy
   *  project is a lasting choice, not a per-session whim. */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    loadKeySet(COLLAPSED_KEY),
  );
  /**
   * Global settled tail open state. Session-only (t3: out of the way, never
   * gone). Collapsed by default so attention work stays scannable.
   */
  const [settledTailOpen, setSettledTailOpen] = useState(false);
  /** How many settled rows to show when the tail is expanded. */
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    SETTLED_TAIL_INITIAL_COUNT,
  );
  const settleOpts = useMemo(
    () => ({ now, autoSettleAfterDays: AUTO_SETTLE_AFTER_DAYS }),
    [now],
  );
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

  const { settled: globalSettled } = useMemo(
    () => partitionSidebar(displayThreads, settleOpts),
    [displayThreads, settleOpts],
  );

  /**
   * Project groups for the main list.
   * Normal view: only attention + archived (settled pulled into the global tail).
   * Search: full hit list including settled, so settled hits surface inline
   * and never hide behind a collapsed tail.
   */
  const groups = useMemo(() => {
    if (searching) {
      const projectsWithHits = projects.filter((p) =>
        displayThreads.some((t) => t.projectId === p.id),
      );
      return buildSidebarGroups(projectsWithHits, displayThreads);
    }
    // Non-search: feed groups attention + archived only (drop settled).
    const forGroups = displayThreads.filter(
      (t) => t.archived || !effectiveSettled(t, settleOpts),
    );
    return buildSidebarGroups(projects, forGroups);
  }, [projects, displayThreads, searching, settleOpts]);

  const toggleCollapsed = (groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      saveKeySet(COLLAPSED_KEY, next);
      return next;
    });
  };

  const toggleSettledTail = () => {
    setSettledTailOpen((open) => {
      if (open) {
        // Collapse: reset paging so the next open starts at the initial page.
        setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
      }
      return !open;
    });
  };

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

  // Carve-out: the open thread must never vanish behind the collapsed shelf.
  const selectedSettled =
    !searching &&
    !settledTailOpen &&
    activeThreadId != null
      ? globalSettled.find((t) => t.id === activeThreadId) ?? null
      : null;

  const visibleSettled = settledTailOpen
    ? globalSettled.slice(0, settledVisibleCount)
    : [];
  const settledHasMore =
    settledTailOpen && globalSettled.length > settledVisibleCount;

  const slugFor = (t: ThreadInfo) =>
    projectById.get(t.projectId)?.slug ?? "unknown";

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
            // Attention only in normal view (settled are global); search shows all.
            const attentionThreads = groupThreads.filter((t) => !t.archived);
            const archivedThreads = groupThreads.filter((t) => t.archived);
            const archivedExpanded = searching
              ? true
              : showArchived.has(groupKey);
            const hasAnyThreads = groupThreads.length > 0;
            // A collapsed project shows only its header. Search overrides the
            // collapse: hiding hits inside a collapsed group makes results lie.
            const collapsed = !searching && collapsedGroups.has(groupKey);
            const summary = groupHeaderSummary(attentionThreads);

            return (
              <div key={groupKey} className={styles.group}>
                <button
                  type="button"
                  className={styles.groupHeader}
                  onClick={() => toggleCollapsed(groupKey)}
                  aria-expanded={!collapsed}
                >
                  <span
                    className={styles.chevron}
                    data-open={!collapsed}
                    aria-hidden="true"
                  >
                    ▸
                  </span>
                  <span className={styles.groupSlug}>{slug}</span>
                  {summary && (
                    <span className={styles.groupSummary}>{summary}</span>
                  )}
                  <span className={styles.groupCount}>
                    {searching
                      ? groupThreads.length
                      : attentionThreads.length}
                  </span>
                </button>

                {collapsed ? null : !hasAnyThreads ? (
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
                    {attentionThreads.map((thread) => (
                      <ThreadCard
                        key={thread.id}
                        thread={thread}
                        slug={slug}
                        providers={providers}
                        active={thread.id === activeThreadId}
                        now={now}
                        onSelect={onSelectThread}
                        isSettled={
                          searching
                            ? effectiveSettled(thread, settleOpts)
                            : false
                        }
                        onSetSettled={onSetSettled}
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
                          isSettled={effectiveSettled(thread, settleOpts)}
                          onSetSettled={onSetSettled}
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

        {/* Global settled tail (t3-style): one section at the bottom, all projects. */}
        {projectsOpen && !searching && globalSettled.length > 0 && (
          <div className={styles.settledTail} data-settled-tail="">
            {selectedSettled && (
              <SettledRow
                thread={selectedSettled}
                slug={slugFor(selectedSettled)}
                active
                now={now}
                onSelect={onSelectThread}
                onSetSettled={onSetSettled}
              />
            )}
            <button
              type="button"
              className={styles.settledTailHeader}
              onClick={toggleSettledTail}
              aria-expanded={settledTailOpen}
            >
              <span className={styles.chevron} data-open={settledTailOpen}>
                ▸
              </span>
              <span>
                Settled · {globalSettled.length}
              </span>
            </button>
            {settledTailOpen &&
              visibleSettled.map((thread) => (
                <SettledRow
                  key={thread.id}
                  thread={thread}
                  slug={slugFor(thread)}
                  active={thread.id === activeThreadId}
                  now={now}
                  onSelect={onSelectThread}
                  onSetSettled={onSetSettled}
                />
              ))}
            {settledHasMore && (
              <button
                type="button"
                className={styles.settledShowMore}
                onClick={() =>
                  setSettledVisibleCount(
                    (n) => n + SETTLED_TAIL_PAGE_COUNT,
                  )
                }
              >
                Show more
              </button>
            )}
          </div>
        )}
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
