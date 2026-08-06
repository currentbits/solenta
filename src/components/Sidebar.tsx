import { useEffect, useMemo, useState } from "react";
import type { ProjectInfo, ThreadInfo } from "../shared/ipc";
import { formatRelativeAge, formatWorkingLabel } from "../format";
import { buildSidebarGroups } from "../sidebarGroups";
import styles from "./Sidebar.module.css";

const TICK_MS = 5000;

interface SidebarProps {
  appName: string;
  searchPlaceholder: string;
  projectsHeader: string;
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  /** Global + uses selected project; per-group New thread passes that projectId. */
  onCreateThread: (projectId?: string) => void;
  onAddProject: () => void;
  projectError?: string | null;
  onDismissProjectError?: () => void;
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
  active,
  now,
  onSelect,
}: {
  thread: ThreadInfo;
  slug: string;
  active: boolean;
  now: number;
  onSelect: (id: string) => void;
}) {
  const branch = thread.branch ?? "";
  const pr =
    thread.prNumber != null ? `PR #${thread.prNumber}` : "";
  const branchLine =
    branch && pr ? `${branch} · ${pr}` : branch || pr;

  return (
    <button
      type="button"
      className={styles.card}
      data-active={active}
      data-archived={thread.archived ? "true" : undefined}
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
        <span className={styles.providerTag}>{thread.provider}</span>
        {thread.worktreePath && (
          <span className={styles.worktreeTag}>wt</span>
        )}
        {thread.archived && (
          <span className={styles.archivedTag}>archived</span>
        )}
      </div>
      <div className={styles.cardMeta}>
        <span className={styles.branch}>{branchLine}</span>
        <StatusBadge thread={thread} now={now} />
      </div>
    </button>
  );
}

export function Sidebar({
  appName,
  searchPlaceholder,
  projectsHeader,
  projects,
  threads,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  onAddProject,
  projectError = null,
  onDismissProjectError,
}: SidebarProps) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /** Project ids whose archived threads are shown inline. */
  const [showArchived, setShowArchived] = useState<Set<string>>(() => new Set());

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => {
      const slug = projectById.get(t.projectId)?.slug ?? "";
      return (
        t.title.toLowerCase().includes(q) ||
        slug.toLowerCase().includes(q) ||
        (t.branch?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [threads, query, projectById]);

  const searching = query.trim() !== "";

  const groups = useMemo(() => {
    // While searching, only surface projects that still have matching threads
    // (empty projects stay hidden so the empty-search state can show).
    if (searching) {
      const projectsWithHits = projects.filter((p) =>
        filtered.some((t) => t.projectId === p.id),
      );
      return buildSidebarGroups(projectsWithHits, filtered);
    }
    return buildSidebarGroups(projects, filtered);
  }, [projects, filtered, searching]);

  const toggleArchived = (groupKey: string) => {
    setShowArchived((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const canCreate = projects.length > 0;

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
        <span className={styles.count}>{projects.length}</span>
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

        {projectsOpen &&
          projects.length > 0 &&
          searching &&
          filtered.length === 0 && (
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
            const archivedExpanded = showArchived.has(groupKey);
            const hasAnyThreads = groupThreads.length > 0;

            return (
              <div key={groupKey} className={styles.group}>
                <div className={styles.groupHeader}>
                  <span className={styles.groupSlug}>{slug}</span>
                  <span className={styles.groupCount}>
                    {activeThreads.length}
                  </span>
                </div>

                {!hasAnyThreads ? (
                  <div className={styles.emptyGroup}>
                    <span className={styles.emptyThreads}>No threads yet</span>
                    {project && (
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
                        active={thread.id === activeThreadId}
                        now={now}
                        onSelect={onSelectThread}
                      />
                    ))}
                    {archivedExpanded &&
                      archivedThreads.map((thread) => (
                        <ThreadCard
                          key={thread.id}
                          thread={thread}
                          slug={slug}
                          active={thread.id === activeThreadId}
                          now={now}
                          onSelect={onSelectThread}
                        />
                      ))}
                    {archivedThreads.length > 0 && (
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
                    {project && (
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
        <div className={styles.footerRow}>
          <button type="button" className={styles.settings}>
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
