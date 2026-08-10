import { useEffect } from "react";
import styles from "./ArchiveToast.module.css";

/** How long the undo / error window stays open (Synara-style). */
export const ARCHIVE_TOAST_MS = 6000;

type ArchiveToastProps =
  | {
      /** Default: archive undo after an immediate archive. */
      variant?: "archive";
      /** Restore the archived thread. */
      onUndo: () => void;
      /** Dismiss without undoing (timeout or explicit close). */
      onDismiss: () => void;
    }
  | {
      /** Error surface (e.g. failed projects.remove). */
      variant: "error";
      /** Title line, e.g. Failed to remove "acme/ledger". */
      title: string;
      onDismiss: () => void;
    };

/**
 * Local toast. No toast framework: one component, one timer.
 * Archive variant: undo window after immediate archive.
 * Error variant: titled failure (e.g. remove project) without an undo action.
 */
export function ArchiveToast(props: ArchiveToastProps) {
  const { onDismiss } = props;
  useEffect(() => {
    const handle = window.setTimeout(() => {
      onDismiss();
    }, ARCHIVE_TOAST_MS);
    return () => window.clearTimeout(handle);
  }, [onDismiss]);

  if (props.variant === "error") {
    return (
      <div
        className={`${styles.toast} ${styles.toastError}`}
        role="alert"
        aria-live="assertive"
        data-toast="error"
      >
        <span className={styles.message}>{props.title}</span>
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

  return (
    <div
      className={styles.toast}
      role="status"
      aria-live="polite"
      data-toast="archive"
    >
      <span className={styles.message}>Archived</span>
      <button type="button" className={styles.undo} onClick={props.onUndo}>
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
