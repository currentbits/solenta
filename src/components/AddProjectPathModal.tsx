import { useCallback, useState } from "react";
import { useEscapeClose } from "../useEscapeClose";
import styles from "./SettingsModal.module.css";

interface AddProjectPathModalProps {
  onClose: () => void;
  onSubmit: (path: string) => Promise<unknown>;
}

/**
 * Web fallback for projects.addViaDialog. Reuses the Settings modal chrome
 * so we do not invent a second dialog system.
 */
export function AddProjectPathModal({
  onClose,
  onSubmit,
}: AddProjectPathModalProps) {
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [onClose, pending]);

  useEscapeClose(true, handleClose);

  const submit = async () => {
    const trimmed = path.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const added = await onSubmit(trimmed);
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
              disabled={pending || path.trim() === ""}
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
