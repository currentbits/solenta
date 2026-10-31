import {
  useMemo,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import type { ProjectInfo } from "../../shared/ipc";
import { browseMatchTier } from "../../browsePath";
import { ProjectIcon } from "../ProjectIcon";
import { Icon } from "./Icon";
import styles from "../Sidebar.module.css";

/**
 * Best (lowest, i.e. strongest) match tier across a project's slug, name and
 * path; null when none of them match. Reuses browseMatchTier (#1747's folder
 * browse ranking) instead of a second fuzzy matcher.
 */
function projectMatchTier(p: ProjectInfo, lowerQuery: string): number | null {
  let best: number | null = null;
  for (const value of [p.slug, p.name, p.path]) {
    if (!value) continue;
    const tier = browseMatchTier(value, lowerQuery);
    if (tier >= 0 && (best === null || tier < best)) best = tier;
  }
  return best;
}

/**
 * Project scope menu: a filter box, All projects (always pinned), each
 * project (edit / remove), New project (#1793).
 */
export function ScopeMenu({
  projects,
  setScope,
  onEditProject,
  onRemoveProject,
  setScopeMenuOpen,
  setRemoveConfirmId,
  onAddProject,
}: {
  projects: ProjectInfo[];
  setScope: (id: string | null) => void;
  onEditProject: ((projectId: string) => void) | undefined;
  onRemoveProject: ((projectId: string) => void | Promise<void>) | undefined;
  setScopeMenuOpen: Dispatch<SetStateAction<boolean>>;
  setRemoveConfirmId: Dispatch<SetStateAction<string | null>>;
  onAddProject: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects
      .map((p) => ({ p, tier: projectMatchTier(p, q) }))
      .filter((r): r is { p: ProjectInfo; tier: number } => r.tier !== null)
      .sort((a, b) => a.tier - b.tier)
      .map((r) => r.p);
  }, [projects, query]);

  // Index 0 is the pinned "All projects" row; 1..n are the filtered projects.
  const itemCount = filtered.length + 1;
  const activeAt = Math.min(activeIndex, itemCount - 1);

  const selectActive = () => {
    if (activeAt === 0) {
      setScope(null);
      return;
    }
    const p = filtered[activeAt - 1];
    if (p) setScope(p.id);
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (Math.min(i, itemCount - 1) + 1) % itemCount);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(
        (i) => (Math.min(i, itemCount - 1) - 1 + itemCount) % itemCount,
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      selectActive();
      return;
    }
    if (e.key === "Escape" && query !== "") {
      // Clear the query first; a second Escape (bubbling, query already
      // empty) falls through to the menu's own close handler.
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
      setActiveIndex(0);
    }
  };

  return (
    <div className={styles.menu} role="menu" data-scope-menu="">
      <input
        type="text"
        className={styles.scopeSearchInput}
        data-scope-search=""
        placeholder="Filter projects"
        aria-label="Filter projects"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onInputKeyDown}
        autoFocus
      />
      <button
        type="button"
        className={styles.scopeItem}
        role="menuitem"
        data-scope-item="all"
        data-scope-active={activeAt === 0 ? "true" : undefined}
        onClick={() => setScope(null)}
      >
        All projects
      </button>
      {filtered.length === 0 ? (
        <p className={styles.viewEmpty} data-scope-empty="">
          No matching projects
        </p>
      ) : (
        filtered.map((p, i) => (
          <div key={p.id} className={styles.scopeItemRow}>
            <button
              type="button"
              className={styles.scopeItem}
              role="menuitem"
              data-scope-item={p.id}
              data-scope-active={activeAt === i + 1 ? "true" : undefined}
              onClick={() => setScope(p.id)}
            >
              <ProjectIcon
                url={p.iconUrl}
                name={p.slug || p.name}
                seed={p.id}
                size={16}
              />
              {p.slug || p.name}
              {p.folders?.length ? (
                <span
                  className={styles.folderChip}
                  data-project-folders={p.folders.length}
                  title={p.folders.join("\n")}
                >
                  +{p.folders.length}{" "}
                  {p.folders.length === 1 ? "folder" : "folders"}
                </span>
              ) : null}
              {p.scm?.kind === "jj" ? (
                <span
                  className={styles.scmChip}
                  data-scm-badge={p.scm.support}
                  title={p.scm.detail || "Jujutsu"}
                >
                  jj
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              data-copy-project-link={p.id}
              aria-label={`Copy link to project ${p.slug || p.name}`}
              title="Copy link"
              onClick={(e) => {
                e.stopPropagation();
                setScopeMenuOpen(false);
                void navigator.clipboard
                  ?.writeText(`solenta://project/${p.id}`)
                  .catch(() => {});
              }}
            >
              <Icon size={12}>
                <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
              </Icon>
            </button>
            {onEditProject && (
              <button
                type="button"
                className={styles.iconBtn}
                data-scope-edit={p.id}
                aria-label={`Edit project ${p.slug || p.name}`}
                title="Edit project"
                onClick={(e) => {
                  e.stopPropagation();
                  setScopeMenuOpen(false);
                  onEditProject(p.id);
                }}
              >
                <Icon size={12}>
                  <path d="M12.3 6.7a1.4 1.4 0 0 1 2 2L8 15H6v-2l6.3-6.3Z" />
                </Icon>
              </button>
            )}
            {onRemoveProject && (
              <button
                type="button"
                className={styles.iconBtn}
                data-project-remove={p.id}
                aria-label={`Remove project ${p.slug || p.name}`}
                title="Remove project"
                onClick={(e) => {
                  e.stopPropagation();
                  setRemoveConfirmId(p.id);
                }}
              >
                <Icon size={12}>
                  <path d="M18 6 6 18M6 6l12 12" />
                </Icon>
              </button>
            )}
          </div>
        ))
      )}
      <div className={styles.menuSep} />
      <button
        type="button"
        className={styles.scopeItem}
        role="menuitem"
        data-new-project=""
        onClick={() => {
          setScopeMenuOpen(false);
          onAddProject();
        }}
      >
        <Icon size={14}>
          <path d="M12 10v8" />
          <path d="M8 14h8" />
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </Icon>
        New project…
      </button>
    </div>
  );
}
