import type { ProjectInfo } from "../shared/ipc";
import styles from "./ProjectScopeSelect.module.css";

const ALL = "";

export function projectScopeLabel(
  projects: readonly ProjectInfo[],
  projectScope: string | null | undefined,
): { kind: "all" | "project" | "removed"; name: string } {
  if (!projectScope) return { kind: "all", name: "All projects" };
  const project = projects.find((p) => p.id === projectScope);
  if (!project) return { kind: "removed", name: "Removed project" };
  return { kind: "project", name: project.slug || project.name };
}

export interface ProjectScopeSelectProps {
  projects: readonly ProjectInfo[];
  value?: string | null;
  onChange?: (id: string | null) => void;
}

/** Compact labelled Project <select> for Activity / Kanban headers (#944). */
export function ProjectScopeSelect({
  projects,
  value = null,
  onChange,
}: ProjectScopeSelectProps) {
  const missing =
    value != null && !projects.some((p) => p.id === value);

  return (
    <label className={styles.scope}>
      <span className={styles.label}>Project</span>
      <select
        className={styles.select}
        aria-label="Project"
        value={value ?? ALL}
        onChange={(e) => {
          const next = e.target.value;
          onChange?.(next === ALL ? null : next);
        }}
      >
        <option value={ALL}>All projects</option>
        {missing ? <option value={value}>Removed project</option> : null}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.slug || p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
