import { useState } from "react";
import { persistWebToken, resolveWebToken, webNavigation } from "../coderApi";
import styles from "./SettingsModal.module.css";

/**
 * Visual token gate for Solenta Web. Hidden when a token already resolves
 * (query param or persisted); submitting persists via the same
 * persistWebToken path boot.tsx's gate uses and reloads so the wire
 * client picks it up.
 */
export function WebTokenGate() {
  const [token, setToken] = useState("");
  const [open] = useState(() => {
    try {
      return !resolveWebToken();
    } catch {
      return true;
    }
  });

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
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="web-token-title"
      >
        <div className={styles.header}>
          <h2 id="web-token-title" className={styles.title}>
            Connect to Solenta
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
