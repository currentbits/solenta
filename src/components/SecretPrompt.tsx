import { useId, useState } from "react";
import type { PendingSecretCard } from "../shared/ipc";
import styles from "./ThreadView.module.css";

/**
 * Secret request card (issue #1531): the coder-threads secret_request tool.
 * The value only ever travels to threads.answerSecret; the agent sees $NAME.
 */
export function SecretPrompt({ card, onAnswer }: {
  card: PendingSecretCard;
  onAnswer: (value: string | null) => void | Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  async function respond(next: string | null) {
    if (sent) return;
    setSent(true);
    setError("");
    try { await onAnswer(next); }
    catch (err) {
      setSent(false);
      setError(err instanceof Error ? err.message : "Could not send secret");
    }
  }
  return <form className={styles.permissionCard} aria-labelledby={`${id}-title`} data-secret-prompt=""
    onSubmit={(event) => { event.preventDefault(); if (value) void respond(value); }}>
    <div className={styles.permissionHead} id={`${id}-title`}>Secret requested: {card.name}</div>
    {card.prompt && <p className={styles.questionDesc}>{card.prompt}</p>}
    <div className={styles.questionBlock}>
      <label htmlFor={`${id}-value`}>Value</label>
      <input id={`${id}-value`} type="password" className={styles.questionOther} value={value} required
        disabled={sent} autoComplete="off" spellCheck={false} onChange={(e) => setValue(e.target.value)} />
      <div className={styles.questionDesc}>
        Set as ${card.name} for this thread&apos;s next runs. Never saved or shown to the agent. Gone after restart or archive.
      </div>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className={styles.permissionActions}>
      <button type="submit" className={styles.permissionAllow} disabled={sent || !value}>Provide secret</button>
      <button type="button" className={styles.permissionDeny} disabled={sent} onClick={() => void respond(null)}>Decline</button>
    </div>
  </form>;
}
