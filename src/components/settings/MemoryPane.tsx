import { useState } from "react";
import type { AppStatus, CoderApi } from "../../shared/ipc";
import { resolveCoderApi } from "../../coderApi";
import { MemoryProjectTools } from "../MemoryTab";
import styles from "../SettingsModal.module.css";
import type { SettingsModalProps } from "../SettingsModal";
import { ProjectPicker } from "./shared";

/**
 * Repos sharing a folder name each get their own memory scope (#179); the
 * first keeps the bare name and inherits rows merged before scopes split.
 * Renaming moves a scope's rows with it.
 */
function MemoryScopeCollisions({
  collisions,
  onRename,
}: {
  collisions: { root: string; key: string }[];
  onRename?: CoderApi["memory"]["renameScope"];
}) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rename = async (root: string) => {
    const key = (drafts[root] ?? "").trim();
    if (!key) return;
    setBusy(root);
    setError(null);
    try {
      const run = onRename ?? ((i) => resolveCoderApi().memory.renameScope(i));
      const res = await run({ root, key });
      setKeys((k) => ({ ...k, [root]: res.key }));
      setDrafts((d) => ({ ...d, [root]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-memory-collisions="">
      <h3 className={styles.sectionLabel}>Same-named repos</h3>
      <p className={styles.note}>
        These repos share a folder name, so each has its own memory scope.
        Memory saved before scopes were split stays with the bare name.
        Rename a scope to move it and its memories.
      </p>
      {collisions.map(({ root, key }) => (
        <div className={styles.field} key={root}>
          <label className={styles.fieldLabel} htmlFor={`scope-${root}`}>
            <span className={styles.monoNote}>{root}</span>
          </label>
          <div className={styles.fieldRow}>
            <input
              id={`scope-${root}`}
              className={styles.input}
              placeholder={keys[root] ?? key}
              value={drafts[root] ?? ""}
              disabled={busy != null}
              onChange={(e) => {
                const value = e.target.value;
                setDrafts((d) => ({ ...d, [root]: value }));
              }}
            />
            <button
              type="button"
              className={styles.btn}
              disabled={busy != null || !(drafts[root] ?? "").trim()}
              onClick={() => void rename(root)}
            >
              Rename
            </button>
          </div>
        </div>
      ))}
      {error && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function MemoryPane({
  status,
  projects,
  projectTools,
  toolsProjectId,
  setToolsProjectId,
  onRenameScope,
}: {
  status: AppStatus | null;
  projects: SettingsModalProps["projects"];
  projectTools: SettingsModalProps["projectTools"];
  toolsProjectId: string | null;
  setToolsProjectId: (projectId: string) => void;
  onRenameScope?: CoderApi["memory"]["renameScope"];
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
        {memory?.collisions && memory.collisions.length > 0 && (
          <MemoryScopeCollisions
            collisions={memory.collisions}
            onRename={onRenameScope}
          />
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
