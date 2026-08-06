import { useState, type KeyboardEvent } from "react";
import styles from "./Composer.module.css";

interface ComposerProps {
  /** Thread branch when known; null omits the branch chip (no invented default). */
  branch: string | null;
  disabled?: boolean;
  onBuild: (prompt: string) => void | Promise<void>;
  placeholder?: string;
  /** Run-scope error from the parent hook (e.g. already active). */
  error?: string | null;
  onDismissError?: () => void;
}

const STATIC = {
  model: "Claude Opus 5",
  effort: "High · 1M",
  access: "Full access",
  mode: "Build",
  sessionId: "bb-1",
  worktreeLabel: "Worktree",
};

export function Composer({
  branch,
  disabled = false,
  onBuild,
  placeholder = "Ask anything, @tag files/folders, $use skills, or / for commands",
  error = null,
  onDismissError,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const canSend = !disabled && !sending && value.trim().length > 0;
  const shownError = error ?? localError;

  const submit = async () => {
    if (!canSend) return;
    const prompt = value.trim();
    setSending(true);
    setLocalError(null);
    try {
      await onBuild(prompt);
      setValue("");
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to start run";
      setLocalError(msg);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  const dismiss = () => {
    setLocalError(null);
    onDismissError?.();
  };

  return (
    <div className={styles.composer}>
      {shownError && (
        <div className={styles.errorBanner} role="alert">
          <span className={styles.errorText}>{shownError}</span>
          <button
            type="button"
            className={styles.errorDismiss}
            onClick={dismiss}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
      <div className={styles.card}>
        <textarea
          className={styles.textarea}
          placeholder={placeholder}
          rows={3}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || sending}
        />
        <div className={styles.controls}>
          <div className={styles.pills}>
            <button type="button" className={styles.pill}>
              {STATIC.model}
              <span className={styles.caret}>▾</span>
            </button>
            <button type="button" className={styles.pill}>
              {STATIC.effort}
            </button>
            <button type="button" className={styles.pill}>
              {STATIC.access}
            </button>
            <button
              type="button"
              className={`${styles.pill} ${styles.pillAccent}`}
              onClick={() => void submit()}
              disabled={!canSend}
              title="Build (⌘Enter)"
            >
              {STATIC.mode}
              <span className={styles.caret}>▾</span>
            </button>
          </div>
          <button
            type="button"
            className={styles.send}
            aria-label="Build"
            disabled={!canSend}
            onClick={() => void submit()}
          >
            ↑
          </button>
        </div>
      </div>
      <div className={styles.meta}>
        <span className={styles.chip}>{STATIC.sessionId}</span>
        <span className={styles.chip}>{STATIC.worktreeLabel}</span>
        {branch != null && branch !== "" && (
          <span className={`${styles.chip} ${styles.chipMono}`}>{branch}</span>
        )}
      </div>
    </div>
  );
}
