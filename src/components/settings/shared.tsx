import type { ProjectInfo } from "../../shared/ipc";
import styles from "../SettingsModal.module.css";

/** Project select shared by Git → Spotlight and Memory → Project tools. */
export function ProjectPicker({
  id,
  projects,
  value,
  onChange,
}: {
  id: string;
  projects: ProjectInfo[];
  value: string;
  onChange: (projectId: string) => void;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        Project
      </label>
      <select
        id={id}
        className={styles.input}
        data-project-picker={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
