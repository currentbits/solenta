import { useEffect, useState } from "react";
import { resolveCoderApi } from "../coderApi";
import type { CoderApi, SshPromptInfo } from "../shared/ipc";
import styles from "./SettingsModal.module.css";

// Main gives up after 75 s (electron/sshAskpass.js); drop the dialog with it.
const PROMPT_TIMEOUT_MS = 75_000;

/** In-app answer to an ssh password or new-host-key prompt (#1818). */
export function SshPromptDialog() {
  const [queue, setQueue] = useState<SshPromptInfo[]>([]);
  const [answer, setAnswer] = useState("");
  const current = queue[0] ?? null;

  const api = (): CoderApi | null => {
    try {
      const existing = (window as unknown as { coder?: CoderApi }).coder;
      if (existing && typeof existing.app?.answerSshPrompt === "function") return existing;
      const resolved = resolveCoderApi();
      return typeof resolved.app?.answerSshPrompt === "function" ? resolved : null;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    const coder = api();
    if (!coder?.on) return;
    try {
      return coder.on("ssh:prompt", (next) => setQueue((q) => q.concat(next)));
    } catch {
      return undefined;
    }
  }, []);

  const reply = (value: string | null) => {
    if (!current) return;
    void api()?.app.answerSshPrompt({ id: current.id, answer: value }).catch(() => {});
    setQueue((q) => q.slice(1));
    setAnswer("");
  };

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => {
      setQueue((q) => q.filter((p) => p.id !== current.id));
      setAnswer("");
    }, PROMPT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [current]);

  if (!current) return null;
  const hostkey = current.kind === "hostkey";

  return (
    <div className={styles.backdrop} data-ssh-prompt="" role="presentation">
      <form
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-prompt-title"
        onSubmit={(e) => {
          e.preventDefault();
          reply(hostkey ? "yes" : answer);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            reply(null);
          }
        }}
      >
        <div className={styles.header}>
          <h2 id="ssh-prompt-title" className={styles.title}>
            {hostkey ? `Trust ${current.host}?` : `SSH to ${current.host}`}
          </h2>
        </div>
        <div className={styles.section}>
          {hostkey ? (
            <p className={styles.note}>
              Solenta has not connected to this computer before. Check the
              fingerprint matches the one on {current.host} before you trust it.
            </p>
          ) : null}
          <pre className={styles.note} data-ssh-prompt-text="" style={{ whiteSpace: "pre-wrap" }}>
            {current.prompt.trim()}
          </pre>
          {hostkey ? null : (
            <input
              type={current.kind === "password" ? "password" : "text"}
              className={styles.input}
              data-ssh-prompt-input=""
              aria-label={current.prompt.trim()}
              autoFocus
              autoComplete="off"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          )}
          <div className={styles.fieldRow}>
            <button type="button" className={styles.btn} data-ssh-prompt-cancel="" onClick={() => reply(null)}>
              Cancel
            </button>
            <button type="submit" className={styles.btnPrimary} data-ssh-prompt-ok="" autoFocus={hostkey}>
              {hostkey ? "Trust" : "Continue"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
