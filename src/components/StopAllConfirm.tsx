import { useRef, useState } from "react";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import styles from "./StopAllConfirm.module.css";

/**
 * "Stop all running threads" confirm (⌘K palette action + sidebar control,
 * issue #1778). Same overlay/dialog shape as ThreadView's confirm dialogs
 * (e.g. the rewind/restore-checkpoint confirms).
 */
export function StopAllConfirm({
  open,
  count,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  count: number;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEscapeClose(open && !pending, onCancel);
  useModalFocus(open, dialogRef);
  if (!open) return null;
  const threadWord = count === 1 ? "thread" : "threads";
  return (
    <div
      className={styles.overlay}
      role="presentation"
      onClick={() => {
        if (!pending) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stop-all-title"
        tabIndex={-1}
        data-stop-all-confirm=""
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="stop-all-title" className={styles.title}>
          Stop {count} running {threadWord}?
        </h2>
        <p className={styles.body}>
          Each thread stops as if you clicked Stop on it. Crew workers under
          a stopped orchestrator stop too.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.danger}
            data-stop-all-confirm-submit=""
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={() => {
              setPending(true);
              void Promise.resolve(onConfirm())
                .catch(() => {
                  // Failure toast, if any, is the caller's job; always close.
                })
                .finally(() => {
                  setPending(false);
                  onCancel();
                });
            }}
          >
            {pending ? "Stopping…" : "Stop all"}
          </button>
          <button
            type="button"
            className={styles.cancel}
            data-stop-all-confirm-cancel=""
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
