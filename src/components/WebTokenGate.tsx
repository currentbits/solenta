import { useState } from "react";
import styles from "./SettingsModal.module.css";

const TOKEN_KEY = "coder.webToken";

/**
 * Visual token gate for Coder Web. Worker B owns the transport auth handshake;
 * this is the reachable form that handshake can show. A submitted token is
 * stored on sessionStorage under coder.webToken so the client can pick it up.
 */
export function WebTokenGate() {
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(() => {
    try {
      return !sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return true;
    }
  });

  if (!open) return null;

  const submit = () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    try {
      sessionStorage.setItem(TOKEN_KEY, trimmed);
    } catch {
      // Private mode can throw; still dismiss so the shell is usable.
    }
    setOpen(false);
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-web-token-gate=""
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="web-token-title"
      >
        <div className={styles.header}>
          <h2 id="web-token-title" className={styles.title}>
            Connect to Coder
          </h2>
        </div>
        <div className={styles.body}>
          <p className={styles.note}>
            This browser session needs the token printed when the web server
            started.
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
