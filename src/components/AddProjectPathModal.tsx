import { useCallback, useState } from "react";
import { useEscapeClose } from "../useEscapeClose";
import styles from "./SettingsModal.module.css";

interface AddProjectPathModalProps {
  onClose: () => void;
  onSubmit: (
    path: string,
    remotes?: { remoteHost?: string; remotePath?: string },
  ) => Promise<unknown>;
}

/**
 * Web fallback for projects.addViaDialog. Reuses the Settings modal chrome
 * so we do not invent a second dialog system. Optional remotes (empty = local).
 */
export function AddProjectPathModal({
  onClose,
  onSubmit,
}: AddProjectPathModalProps) {
  const [path, setPath] = useState("");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [onClose, pending]);

  useEscapeClose(true, handleClose);

  const host = remoteHost.trim();
  const rpath = remotePath.trim();
  const canSubmit = host ? Boolean(rpath) : Boolean(path.trim());

  const submit = async () => {
    const trimmed = path.trim();
    if (pending || !canSubmit) return;
    if (host && !rpath.startsWith("/")) {
      setError("Remote path must be an absolute path (start with /).");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const remotes = host ? { remoteHost: host, remotePath: rpath } : undefined;
      const added = await onSubmit(trimmed, remotes);
      if (!added) {
        setError("Could not add that path.");
      }
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Could not add that path.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-add-project-path=""
      onClick={handleClose}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-path-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="add-project-path-title" className={styles.title}>
            Add project
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
            <label className={styles.fieldLabel} htmlFor="add-project-path-input">
              Project path
            </label>
            <input
              id="add-project-path-input"
              className={styles.input}
              data-add-project-path-input=""
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/absolute/path/to/repo"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="add-project-remote-host">
              Remote host (user@host)
            </label>
            <input
              id="add-project-remote-host"
              className={styles.input}
              data-add-project-remote-host=""
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
              placeholder="user@host"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="add-project-remote-path">
              Remote path
            </label>
            <input
              id="add-project-remote-path"
              className={styles.input}
              data-add-project-remote-path=""
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              placeholder="/absolute/path/on/the/remote"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
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
              data-add-project-path-submit=""
              disabled={pending || !canSubmit}
              onClick={() => void submit()}
            >
              {pending ? "Adding…" : "Add"}
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
