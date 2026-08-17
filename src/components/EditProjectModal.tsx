import { useCallback, useState } from "react";
import { useEscapeClose } from "../useEscapeClose";
import type { ProjectInfo, ProjectUpdateInput, SpaceInfo } from "../shared/ipc";
import styles from "./SettingsModal.module.css";

interface EditProjectModalProps {
  project: ProjectInfo;
  spaces?: SpaceInfo[];
  onClose: () => void;
  onSubmit: (input: ProjectUpdateInput) => Promise<unknown>;
}

/**
 * Edit an existing project: display name and the SSH remote fields. The local
 * checkout path is shown read-only (it is the project's identity on disk).
 * Clearing the host turns the project local again. Reuses the Settings modal
 * chrome, same as AddProjectPathModal.
 */
export function EditProjectModal({
  project,
  spaces = [],
  onClose,
  onSubmit,
}: EditProjectModalProps) {
  const [name, setName] = useState(project.name);
  const [remoteHost, setRemoteHost] = useState(project.remoteHost ?? "");
  const [remotePath, setRemotePath] = useState(project.remotePath ?? "");
  const [spaceId, setSpaceId] = useState(project.spaceId ?? "");
  const [autoDispatch, setAutoDispatch] = useState(
    project.autoDispatch ?? false,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [onClose, pending]);

  useEscapeClose(true, handleClose);

  const host = remoteHost.trim();
  const rpath = remotePath.trim();
  const canSubmit = name.trim().length > 0 && (host ? Boolean(rpath) : true);

  const submit = async () => {
    if (pending || !canSubmit) return;
    if (host && !rpath.startsWith("/")) {
      setError("Remote path must be an absolute path (start with /).");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const updated = await onSubmit({
        projectId: project.id,
        name: name.trim(),
        remoteHost: host,
        remotePath: rpath,
        ...(spaces.length > 0 ? { spaceId } : {}),
        autoDispatch,
      });
      if (!updated) {
        setError("Could not save the project.");
      }
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Could not save the project.",
      );
    } finally {
      setPending(false);
    }
  };

  const enterToSubmit = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-edit-project=""
      onClick={handleClose}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-project-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="edit-project-title" className={styles.title}>
            Edit project
          </h2>
          <button
            type="button"
            className={styles.close}
            onClick={handleClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className={styles.body}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="edit-project-name">
              Name
            </label>
            <input
              id="edit-project-name"
              className={styles.input}
              data-edit-project-name=""
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={enterToSubmit}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="edit-project-path">
              Local path
            </label>
            <input
              id="edit-project-path"
              className={styles.input}
              data-edit-project-path=""
              value={project.path}
              readOnly
              disabled
            />
          </div>
          {spaces.length > 0 && (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="edit-project-space">
                Space
              </label>
              <select
                id="edit-project-space"
                className={styles.input}
                data-edit-project-space=""
                value={spaceId}
                onChange={(e) => setSpaceId(e.target.value)}
                disabled={pending}
              >
                <option value="">No space</option>
                {spaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="edit-project-remote-host">
              Remote host (user@host)
            </label>
            <input
              id="edit-project-remote-host"
              className={styles.input}
              data-edit-project-remote-host=""
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
              placeholder="empty = local project"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={enterToSubmit}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="edit-project-remote-path">
              Remote path
            </label>
            <input
              id="edit-project-remote-path"
              className={styles.input}
              data-edit-project-remote-path=""
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              placeholder="/absolute/path/on/the/remote"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={enterToSubmit}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldRow} htmlFor="edit-project-auto-dispatch">
              <input
                id="edit-project-auto-dispatch"
                type="checkbox"
                data-edit-project-auto-dispatch=""
                checked={autoDispatch}
                disabled={pending}
                onChange={(e) => setAutoDispatch(e.target.checked)}
              />
              <span>Auto-start threads from plan:todo</span>
            </label>
            <p className={styles.note}>
              Starts a thread for each issue that enters plan:todo.
            </p>
          </div>
          {error && (
            <p className={styles.fieldError} role="alert">
              {error}
            </p>
          )}
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              data-edit-project-submit=""
              disabled={pending || !canSubmit}
              onClick={() => void submit()}
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className={styles.btn}
              disabled={pending}
              onClick={handleClose}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
