import type { Dispatch, SetStateAction } from "react";
import type { ProjectInfo } from "../../shared/ipc";
import { ProjectIcon } from "../ProjectIcon";
import { Icon } from "./Icon";
import styles from "../Sidebar.module.css";

/** Project scope menu: All projects, each project (edit / remove), New project. */
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
  return (
    <div className={styles.menu} role="menu" data-scope-menu="">
      <button
        type="button"
        className={styles.scopeItem}
        role="menuitem"
        data-scope-item="all"
        onClick={() => setScope(null)}
      >
        All projects
      </button>
      {projects.map((p) => (
        <div key={p.id} className={styles.scopeItemRow}>
          <button
            type="button"
            className={styles.scopeItem}
            role="menuitem"
            data-scope-item={p.id}
            onClick={() => setScope(p.id)}
          >
            <ProjectIcon
              url={p.iconUrl}
              name={p.slug || p.name}
              seed={p.id}
              size={16}
            />
            {p.slug || p.name}
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
      ))}
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
