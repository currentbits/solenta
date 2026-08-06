import { useMemo, useState } from "react";
import type { ProjectInfo, ThreadInfo } from "../shared/ipc";
import { formatRelativeAge, formatWorkingLabel } from "../format";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  appName: string;
  searchPlaceholder: string;
  projectsHeader: string;
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  onCreateThread: () => void;
  onAddProject: () => void;
  projectError?: string | null;
  onDismissProjectError?: () => void;
}

function StatusBadge({ thread }: { thread: ThreadInfo }) {
  if (thread.status === "working") {
    return (
      <span className={`${styles.badge} ${styles.badgeWorking}`}>
        <span className={styles.spinner} aria-hidden />
        {formatWorkingLabel(thread.updatedAt)}
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

  /** Group filtered threads by project slug, preserving project list order. */
  const groups = useMemo(() => {
    const byProject = new Map<string, ThreadInfo[]>();
    for (const t of filtered) {
      const list = byProject.get(t.projectId) ?? [];
      list.push(t);
      byProject.set(t.projectId, list);
    }

    const ordered: { project: ProjectInfo | null; threads: ThreadInfo[] }[] =
      [];
    for (const p of projects) {
      const list = byProject.get(p.id);
      if (list?.length) ordered.push({ project: p, threads: list });
    }
    // Orphan threads (project missing)
    for (const [projectId, list] of byProject) {
      if (!projects.some((p) => p.id === projectId)) {
        ordered.push({ project: null, threads: list });
      }
    }
    return ordered;
  }, [filtered, projects]);

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
          onClick={onCreateThread}
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
        <span className={styles.count}>{filtered.length}</span>
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
          filtered.length === 0 &&
          query.trim() !== "" && (
            <p className={styles.emptySearch}>No threads match</p>
          )}

        {projectsOpen &&
          groups.map(({ project, threads: groupThreads }) => (
            <div
              key={project?.id ?? groupThreads[0]?.projectId ?? "orphan"}
              className={styles.group}
            >
              {groupThreads.map((thread) => {
                const slug =
                  project?.slug ??
                  projectById.get(thread.projectId)?.slug ??
                  "unknown";
                return (
                  <button
                    key={thread.id}
                    type="button"
                    className={styles.card}
                    data-active={thread.id === activeThreadId}
                    onClick={() => onSelectThread(thread.id)}
                  >
                    <div className={styles.cardTop}>
                      <span className={styles.repo}>{slug}</span>
                      <span className={styles.age}>
                        {formatRelativeAge(thread.updatedAt)}
                      </span>
                    </div>
                    <div className={styles.cardTitle}>{thread.title}</div>
                    <div className={styles.cardMeta}>
                      <span className={styles.branch}>
                        {thread.branch ?? ""}
                        {thread.prNumber != null
                          ? `${thread.branch ? " · " : ""}#${thread.prNumber}`
                          : ""}
                      </span>
                      <StatusBadge thread={thread} />
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
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
