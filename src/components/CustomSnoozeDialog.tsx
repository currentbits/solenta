import { useRef, useState } from "react";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import {
  defaultCustomSnoozeValue,
  minCustomSnoozeValue,
  parseCustomSnoozeValue,
} from "../threadSnooze";
import styles from "./SettingsModal.module.css";

interface CustomSnoozeDialogProps {
  onCancel: () => void;
  onSnooze: (until: number) => void;
  /** Injectable for tests; defaults to the real clock. */
  now?: number;
}

/**
 * "Custom…" snooze (#1766): a date + time instead of a preset. Native
 * context menus cannot host an <input>, so this opens as a small modal in
 * the renderer after "Custom…" is picked from the (native or fallback)
 * snooze menu — same chrome as the other small dialogs (SettingsModal.module.css).
 */
export function CustomSnoozeDialog({
  onCancel,
  onSnooze,
  now = Date.now(),
}: CustomSnoozeDialogProps) {
  const [value, setValue] = useState(() => defaultCustomSnoozeValue(now));
  const min = minCustomSnoozeValue(now);
  const until = parseCustomSnoozeValue(value, now);
  const error = value && until == null ? "Pick a time at least 5 minutes from now." : null;

  const dialogRef = useRef<HTMLDivElement>(null);
  useEscapeClose(true, onCancel);
  useModalFocus(true, dialogRef);

  const submit = () => {
    if (until == null) return;
    onSnooze(until);
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-custom-snooze=""
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-snooze-title"
        tabIndex={-1}
        data-custom-snooze-dialog=""
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 id="custom-snooze-title" className={styles.title}>
            Snooze until…
          </h2>
          <button
            type="button"
            className={styles.close}
            onClick={onCancel}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className={styles.body}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="custom-snooze-input">
              Wake at
            </label>
            <input
              id="custom-snooze-input"
              type="datetime-local"
              className={styles.input}
              data-custom-snooze-input=""
              value={value}
              min={min}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          {error ? (
            <p className={styles.fieldError} role="alert" data-custom-snooze-error="">
              {error}
            </p>
          ) : null}
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              data-custom-snooze-submit=""
              disabled={until == null}
              onClick={submit}
            >
              Snooze
            </button>
            <button
              type="button"
              className={styles.btn}
              data-custom-snooze-cancel=""
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
