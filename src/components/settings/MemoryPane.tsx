import type { AppStatus } from "../../shared/ipc";
import { MemoryProjectTools } from "../MemoryTab";
import styles from "../SettingsModal.module.css";
import type { SettingsModalProps } from "../SettingsModal";
import { ProjectPicker } from "./shared";

export function MemoryPane({
  status,
  projects,
  projectTools,
  toolsProjectId,
  setToolsProjectId,
}: {
  status: AppStatus | null;
  projects: SettingsModalProps["projects"];
  projectTools: SettingsModalProps["projectTools"];
  toolsProjectId: string | null;
  setToolsProjectId: (projectId: string) => void;
}) {
  const toolsProject =
    projects?.find((p) => p.id === toolsProjectId) ?? projects?.[0] ?? null;
  const memory = status?.memory;
  const memoryLabel =
    memory?.running && memory.port != null
      ? `Memory server: running on port ${memory.port}${
          memory.adopted ? " (adopted)" : ""
        }`
      : "Memory server: not running";

  return (
    <>
      <section className={styles.section}>
        <div className={styles.memoryRow}>
          <span
            className={styles.memoryDot}
            data-on={memory?.running ? "true" : undefined}
            aria-hidden
          />
          <span>{memoryLabel}</span>
        </div>
        {memory?.running && (
          <p className={styles.note}>
            {memory.entries != null ? `${memory.entries} entries` : "entries unknown"}
            {memory.vectors != null ? `, ${memory.vectors} embedded` : ""}
          </p>
        )}
        {memory?.lastError && (
          <p className={styles.fieldError} role="alert">
            Janitor error: {memory.lastError}
          </p>
        )}
        <p className={styles.note}>
          Shared memory is project-scoped and injected into agents
          automatically.
        </p>
      </section>

      {projectTools && projects && toolsProject && (
        <section className={styles.section} data-project-tools="">
          <h3 className={styles.sectionLabel}>Project tools</h3>
          <ProjectPicker
            id="project-tools-project"
            projects={projects}
            value={toolsProject.id}
            onChange={setToolsProjectId}
          />
          <MemoryProjectTools
            projectId={toolsProject.id}
            projectSlug={toolsProject.path}
            {...projectTools}
          />
        </section>
      )}
    </>
  );
}
