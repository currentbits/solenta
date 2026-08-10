import { useEffect } from "react";
import styles from "./ArchiveToast.module.css";

/** How long the undo window stays open (Synara-style). */
export const ARCHIVE_TOAST_MS = 6000;

interface ArchiveToastProps {
  /** Restore the archived thread. */
  onUndo: () => void;
  /** Dismiss without undoing (timeout or explicit close). */
  onDismiss: () => void;
}

/**
 * Local archive undo toast. No toast framework: one component, one timer.
 * Appears after an immediate archive so the user can reverse without a confirm dialog.
 */
export function ArchiveToast({ onUndo, onDismiss }: ArchiveToastProps) {
  useEffect(() => {
    const handle = window.setTimeout(() => {
      onDismiss();
    }, ARCHIVE_TOAST_MS);
    return () => window.clearTimeout(handle);
  }, [onDismiss]);

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span className={styles.message}>Archived</span>
      <button type="button" className={styles.undo} onClick={onUndo}>
        Undo
      </button>
      <button
        type="button"
        className={styles.dismiss}
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
