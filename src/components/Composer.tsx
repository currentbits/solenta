import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PermissionMode } from "../shared/ipc";
import {
  PERMISSION_MODE_LABELS,
  PERMISSION_MODES,
  shortSessionId,
} from "../format";
import styles from "./Composer.module.css";

interface ComposerProps {
  /** Thread branch when known; null omits the branch chip (no invented default). */
  branch: string | null;
  /** Sticky permission mode for this thread. */
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void | Promise<void>;
  /** Provider session id (short form shown in meta). */
  sessionId: string | null;
  /** Whether a worktree has been set up. */
  hasWorktree: boolean;
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
  mode: "Build",
};

export function Composer({
  branch,
  permissionMode,
  onPermissionModeChange,
  sessionId,
  hasWorktree,
  disabled = false,
  onBuild,
  placeholder = "Ask anything, @tag files/folders, $use skills, or / for commands",
  error = null,
  onDismissError,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const modeWrapRef = useRef<HTMLDivElement>(null);

  const canSend = !disabled && !sending && value.trim().length > 0;
  const shownError = error ?? localError;
  const shortSess = shortSessionId(sessionId);

  useEffect(() => {
    if (!modeOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!modeWrapRef.current?.contains(e.target as Node)) {
        setModeOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modeOpen]);

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

  const pickMode = async (mode: PermissionMode) => {
    setModeOpen(false);
    if (mode === permissionMode) return;
    try {
      await onPermissionModeChange(mode);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to set permission mode";
      setLocalError(msg);
    }
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
            <div className={styles.modeWrap} ref={modeWrapRef}>
              <button
                type="button"
                className={styles.pill}
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={modeOpen}
                onClick={() => {
                  if (!disabled) setModeOpen((v) => !v);
                }}
              >
                {PERMISSION_MODE_LABELS[permissionMode]}
                <span className={styles.caret}>▾</span>
              </button>
              {modeOpen && (
                <ul
                  className={styles.modeMenu}
                  role="listbox"
                  aria-label="Permission mode"
                >
                  {PERMISSION_MODES.map((mode) => (
                    <li key={mode} role="option" aria-selected={mode === permissionMode}>
                      <button
                        type="button"
                        className={styles.modeOption}
                        data-active={mode === permissionMode}
                        onClick={() => void pickMode(mode)}
                      >
                        {PERMISSION_MODE_LABELS[mode]}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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
        {shortSess && (
          <span className={`${styles.chip} ${styles.chipMono}`}>{shortSess}</span>
        )}
        <span className={styles.chip}>
          {hasWorktree ? "Worktree" : "Project"}
        </span>
        {branch != null && branch !== "" && (
          <span className={`${styles.chip} ${styles.chipMono}`}>{branch}</span>
        )}
      </div>
    </div>
  );
}
