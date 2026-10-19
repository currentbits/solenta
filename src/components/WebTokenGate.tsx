import { useCallback, useRef, useState } from "react";
import { needsWebTokenGate, persistWebToken, webNavigation } from "../coderApi";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import styles from "./SettingsModal.module.css";

/**
 * Token gate for Solenta Web. Without a reason it opens only when
 * needsWebTokenGate() is true (production web, no token); Vite DEV and a
 * resolved token stay closed. With a reason (the host rejected the saved
 * token) it always opens. Submitting persists the token and reloads so the
 * wire client picks it up.
 */
export function WebTokenGate({ reason }: { reason?: string } = {}) {
  const [token, setToken] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => {
    if (reason) return true;
    try {
      return needsWebTokenGate();
    } catch {
      return true;
    }
  });
  const handleClose = useCallback(() => setOpen(false), []);
  useEscapeClose(open, handleClose);
  useModalFocus(open, dialogRef);

  if (!open) return null;

  const submit = () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    persistWebToken(trimmed);
    webNavigation.reload();
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-web-token-gate=""
    >
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="web-token-title"
        tabIndex={-1}
        data-web-token-gate-dialog=""
      >
        <div className={styles.header}>
          <h2 id="web-token-title" className={styles.title}>
            Connect to Solenta
          </h2>
        </div>
        <div className={styles.body}>
          {reason ? (
            <p className={styles.note} data-web-token-reason="">
              {reason}
            </p>
          ) : null}
          <p className={styles.note}>
            Open the pairing link or scan the QR code from the computer running
            Solenta, or paste its token here. On that computer, Settings &gt;
            Connections &gt; Add device makes a token for this device. If
            Solenta was started from a terminal, the token is printed there.
          </p>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="web-token-input">
              Session token
            </label>
            <input
              id="web-token-input"
              className={styles.input}
              data-web-token-input=""
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste token"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              data-web-token-submit=""
              disabled={token.trim() === ""}
              onClick={submit}
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
