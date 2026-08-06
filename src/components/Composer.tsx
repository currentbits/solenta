import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PermissionMode, ProviderInfo } from "../shared/ipc";
import {
  PERMISSION_MODE_LABELS,
  PERMISSION_MODES,
  providerDisplayName,
  shortModelName,
  shortSessionId,
} from "../format";
import styles from "./Composer.module.css";

interface ComposerProps {
  /** Thread branch when known; null omits the branch chip (no invented default). */
  branch: string | null;
  /** Sticky permission mode for this thread. */
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void | Promise<void>;
  /** Current thread provider id. */
  provider: string;
  /** Thread model override; null means provider default. */
  model: string | null;
  /** Registry from providers.list(). */
  providers: ProviderInfo[];
  onSetProvider: (input: {
    provider?: string;
    model?: string | null;
  }) => void | Promise<void>;
  /** Provider session id (short form shown in meta). */
  sessionId: string | null;
  /** Whether a worktree has been set up. */
  hasWorktree: boolean;
  disabled?: boolean;
  /** Single session turn (send arrow + ⌘Enter). */
  onSend: (prompt: string) => void | Promise<void>;
  /** Multi-phase Build workflow (Build pill). */
  onBuild: (prompt: string) => void | Promise<void>;
  placeholder?: string;
  /** Run-scope error from the parent hook (e.g. already active). */
  error?: string | null;
  onDismissError?: () => void;
}

const STATIC = {
  effort: "High · 1M",
  mode: "Build",
};

export function Composer({
  branch,
  permissionMode,
  onPermissionModeChange,
  provider,
  model,
  providers,
  onSetProvider,
  sessionId,
  hasWorktree,
  disabled = false,
  onSend,
  onBuild,
  placeholder = "Ask anything, @tag files/folders, $use skills, or / for commands",
  error = null,
  onDismissError,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const providerWrapRef = useRef<HTMLDivElement>(null);
  const modelWrapRef = useRef<HTMLDivElement>(null);

  const hasPrompt = value.trim().length > 0;
  const isClaude = provider === "claude";
  const canSend = !disabled && !sending && hasPrompt;
  /** Build requires Claude; non-claude stays dimmed with a tooltip. */
  const canBuild = !disabled && !sending && hasPrompt && isClaude;
  const buildDimmed = !isClaude;
  const shownError = error ?? localError;
  const shortSess = shortSessionId(sessionId);
  const sessionLocked = Boolean(sessionId);
  const providerName = providerDisplayName(provider, providers);
  const currentProviderInfo = providers.find((p) => p.id === provider);
  const providerModels = currentProviderInfo?.models ?? [];
  const showModelPill = providerModels.length > 0;
  const modelLabel = model ? shortModelName(model) : "default";

  useEffect(() => {
    if (!modeOpen && !providerOpen && !modelOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (modeOpen && !modeWrapRef.current?.contains(t)) {
        setModeOpen(false);
      }
      if (providerOpen && !providerWrapRef.current?.contains(t)) {
        setProviderOpen(false);
      }
      if (modelOpen && !modelWrapRef.current?.contains(t)) {
        setModelOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modeOpen, providerOpen, modelOpen]);

  const runAction = async (
    action: (prompt: string) => void | Promise<void>,
    failLabel: string,
  ) => {
    if (!hasPrompt || disabled || sending) return;
    const prompt = value.trim();
    setSending(true);
    setLocalError(null);
    try {
      await action(prompt);
      setValue("");
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : failLabel;
      setLocalError(msg);
    } finally {
      setSending(false);
    }
  };

  const submitSend = () => {
    if (!canSend) return;
    void runAction(onSend, "Failed to start run");
  };

  const submitBuild = () => {
    if (!canBuild) return;
    void runAction(onBuild, "Failed to start workflow");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submitSend();
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

  const pickProvider = async (nextId: string) => {
    setProviderOpen(false);
    if (nextId === provider) return;
    try {
      await onSetProvider({ provider: nextId });
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to set provider";
      setLocalError(msg);
    }
  };

  const pickModel = async (next: string | null) => {
    setModelOpen(false);
    if (next === model) return;
    try {
      await onSetProvider({ model: next });
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to set model";
      setLocalError(msg);
    }
  };

  const lockedTitle = sessionLocked
    ? `Session started with ${providerName}. New thread to switch.`
    : undefined;

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
            <div className={styles.modeWrap} ref={providerWrapRef}>
              <button
                type="button"
                className={styles.pill}
                disabled={disabled}
                title={lockedTitle}
                aria-haspopup={sessionLocked ? undefined : "listbox"}
                aria-expanded={sessionLocked ? undefined : providerOpen}
                onClick={() => {
                  if (disabled || sessionLocked) return;
                  setProviderOpen((v) => !v);
                  setModelOpen(false);
                  setModeOpen(false);
                }}
              >
                {providerName}
                {!sessionLocked && <span className={styles.caret}>▾</span>}
              </button>
              {providerOpen && !sessionLocked && (
                <ul
                  className={styles.modeMenu}
                  role="listbox"
                  aria-label="Provider"
                >
                  {providers.map((p) => {
                    const unavailable = !p.available;
                    return (
                      <li
                        key={p.id}
                        role="option"
                        aria-selected={p.id === provider}
                        aria-disabled={unavailable}
                      >
                        <button
                          type="button"
                          className={styles.modeOption}
                          data-active={p.id === provider}
                          data-disabled={unavailable ? "true" : undefined}
                          disabled={unavailable}
                          onClick={() => {
                            if (!unavailable) void pickProvider(p.id);
                          }}
                        >
                          {p.name}
                          {unavailable && (
                            <span className={styles.optionHint}>
                              {" "}
                              not installed
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {showModelPill && (
              <div className={styles.modeWrap} ref={modelWrapRef}>
                <button
                  type="button"
                  className={styles.pill}
                  disabled={disabled}
                  aria-haspopup="listbox"
                  aria-expanded={modelOpen}
                  onClick={() => {
                    if (disabled) return;
                    setModelOpen((v) => !v);
                    setProviderOpen(false);
                    setModeOpen(false);
                  }}
                >
                  {modelLabel}
                  <span className={styles.caret}>▾</span>
                </button>
                {modelOpen && (
                  <ul
                    className={styles.modeMenu}
                    role="listbox"
                    aria-label="Model"
                  >
                    <li role="option" aria-selected={model == null}>
                      <button
                        type="button"
                        className={styles.modeOption}
                        data-active={model == null}
                        onClick={() => void pickModel(null)}
                      >
                        Default
                      </button>
                    </li>
                    {providerModels.map((m) => (
                      <li
                        key={m}
                        role="option"
                        aria-selected={m === model}
                      >
                        <button
                          type="button"
                          className={styles.modeOption}
                          data-active={m === model}
                          onClick={() => void pickModel(m)}
                        >
                          {shortModelName(m)}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <button type="button" className={styles.pill} disabled={disabled}>
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
                  if (!disabled) {
                    setModeOpen((v) => !v);
                    setProviderOpen(false);
                    setModelOpen(false);
                  }
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
                    <li
                      key={mode}
                      role="option"
                      aria-selected={mode === permissionMode}
                    >
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
              className={`${styles.pill} ${styles.pillAccent}${
                buildDimmed ? ` ${styles.pillDimmed}` : ""
              }`}
              onClick={() => submitBuild()}
              disabled={!canBuild}
              title={
                buildDimmed
                  ? "Workflow runs require the Claude provider"
                  : "Build workflow"
              }
            >
              {STATIC.mode}
              <span className={styles.caret}>▾</span>
            </button>
          </div>
          <button
            type="button"
            className={styles.send}
            aria-label="Send"
            disabled={!canSend}
            title="Send (⌘Enter)"
            onClick={() => submitSend()}
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
