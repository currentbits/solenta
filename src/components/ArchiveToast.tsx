import { useEffect } from "react";
import styles from "./ArchiveToast.module.css";

/** How long the undo / error window stays open (Synara-style). */
export const ARCHIVE_TOAST_MS = 6000;

type ArchiveToastProps = (
  | {
      /** Default: archive undo after an immediate archive. */
      variant?: "archive";
      /** Message line; defaults to "Archived". Bulk clear passes "N archived". */
      message?: string;
      /** Restore the archived thread(s). */
      onUndo: () => void;
      /** Dismiss without undoing (timeout or explicit close). */
      onDismiss: () => void;
      /** Undo window; defaults to ARCHIVE_TOAST_MS. */
      durationMs?: number;
    }
  | {
      /** Error surface (e.g. failed projects.remove). */
      variant: "error";
      /** Title line, e.g. Failed to remove "acme/ledger". */
      title: string;
      onDismiss: () => void;
    }
) & {
  /**
   * Render inside a positioned dock instead of fixed to the viewport
   * (#1758: App's sidebar-footer / thread-pane docks). Callers that mount
   * their own toast without a dock (Composer's stash/restore toast) must
   * leave this unset to keep the original fixed bottom-center placement.
   */
  docked?: boolean;
};

/**
 * Local toast. No toast framework: one component, one timer.
 * Archive variant: undo window after immediate archive.
 * Error variant: titled failure (e.g. remove project) without an undo action.
 */
export function ArchiveToast(props: ArchiveToastProps) {
  const { onDismiss, docked } = props;
  const durationMs =
    (props.variant !== "error" && props.durationMs) || ARCHIVE_TOAST_MS;
  useEffect(() => {
    const handle = window.setTimeout(() => {
      onDismiss();
    }, durationMs);
    return () => window.clearTimeout(handle);
  }, [onDismiss, durationMs]);

  const toastClass = docked
    ? `${styles.toast} ${styles.toastDocked}`
    : styles.toast;

  if (props.variant === "error") {
    return (
      <div
        className={`${toastClass} ${styles.toastError}`}
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
          title="Dismiss"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div
      className={toastClass}
      role="status"
      aria-live="polite"
      data-toast="archive"
    >
      <span className={styles.message}>{props.message ?? "Archived"}</span>
      <button type="button" className={styles.undo} onClick={props.onUndo}>
        Undo
      </button>
      <button
        type="button"
        className={styles.dismiss}
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
