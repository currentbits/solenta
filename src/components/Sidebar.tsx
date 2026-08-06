import { useState } from "react";
import type { ThreadCard } from "../mockData";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  appName: string;
  searchPlaceholder: string;
  projectsHeader: string;
  threads: ThreadCard[];
  activeThreadId: string;
}

function StatusBadge({ thread }: { thread: ThreadCard }) {
  if (thread.status === "working") {
    return (
      <span className={`${styles.badge} ${styles.badgeWorking}`}>
        <span className={styles.spinner} aria-hidden />
        {thread.workingLabel ?? "Working"}
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

  return null;
}

export function Sidebar({
  appName,
  searchPlaceholder,
  projectsHeader,
  threads,
  activeThreadId,
}: SidebarProps) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(activeThreadId);

  const filtered = threads.filter((t) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      t.title.toLowerCase().includes(q) ||
      t.repoSlug.toLowerCase().includes(q) ||
      t.branch.toLowerCase().includes(q)
    );
  });

  return (
    <aside className={styles.sidebar}>
      <div className={styles.dragRegion} />
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>◇</span>
          <span className={styles.brandName}>{appName}</span>
        </div>
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
        <span className={styles.count}>{threads.length}</span>
      </button>

      <div className={styles.list}>
        {projectsOpen &&
          filtered.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className={styles.card}
              data-active={thread.id === activeId}
              onClick={() => setActiveId(thread.id)}
            >
              <div className={styles.cardTop}>
                <span className={styles.repo}>{thread.repoSlug}</span>
                <span className={styles.age}>{thread.age}</span>
              </div>
              <div className={styles.cardTitle}>{thread.title}</div>
              <div className={styles.cardMeta}>
                <span className={styles.branch}>
                  {thread.branch}
                  {thread.prNumber != null ? ` · #${thread.prNumber}` : ""}
                </span>
                <StatusBadge thread={thread} />
              </div>
            </button>
          ))}
      </div>

      <footer className={styles.footer}>
        <button type="button" className={styles.settings}>
          <span className={styles.settingsIcon} aria-hidden>
            ⚙
          </span>
          Settings
        </button>
      </footer>
    </aside>
  );
}
