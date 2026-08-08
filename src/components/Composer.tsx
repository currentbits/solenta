import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  PermissionMode,
  ProviderInfo,
  ReasoningEffort,
  WorkflowTemplateInfo,
} from "../shared/ipc";
import type { WorkflowSaveInput } from "../useCoder";
import {
  PERMISSION_MODE_LABELS,
  PERMISSION_MODES,
  providerDisplayName,
  shortSessionId,
} from "../format";
import {
  buildModelRows,
  clampHighlightIndex,
  detailModelRow,
  effortDisplayLabel,
  effortSegments,
  initialHighlightIndex,
  modelTriggerLabel,
  showReasoningControl,
} from "../modelPicker";
import { useEscapeClose } from "../useEscapeClose";
import { WorkflowsModal } from "./WorkflowsModal";
import styles from "./Composer.module.css";

interface ComposerProps {
  /** Selected thread id; used for per-thread last-used template. */
  threadId: string;
  /** Thread branch when known; null omits the branch chip (no invented default). */
  branch: string | null;
  /** Sticky permission mode for this thread. */
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void | Promise<void>;
  /** Current thread provider id. */
  provider: string;
  /** Thread model override; null means provider default. */
  model: string | null;
  /** Thread reasoning effort; null means provider default. */
  reasoningEffort: ReasoningEffort | null;
  /** Registry from providers.list(). */
  providers: ProviderInfo[];
  /** Workflow templates from workflows.list(). */
  workflows: WorkflowTemplateInfo[];
  onSetProvider: (input: {
    provider?: string;
    model?: string | null;
  }) => void | Promise<void>;
  onSetReasoningEffort: (effort: ReasoningEffort | null) => void | Promise<void>;
  onSaveWorkflow: (template: WorkflowSaveInput) => Promise<WorkflowTemplateInfo>;
  onRemoveWorkflow: (id: string) => Promise<void>;
  /** Provider session id (short form shown in meta). */
  sessionId: string | null;
  /** Whether a worktree has been set up. */
  hasWorktree: boolean;
  disabled?: boolean;
  /** Single session turn (send arrow + ⌘Enter). */
  onSend: (prompt: string) => void | Promise<void>;
  /** Multi-phase Build workflow (Build pill main segment). */
  onBuild: (prompt: string, templateId: string) => void | Promise<void>;
  placeholder?: string;
  /** Run-scope error from the parent hook (e.g. already active). */
  error?: string | null;
  onDismissError?: () => void;
}

const STATIC = {
  mode: "Build",
};

const DEFAULT_TEMPLATE_ID = "standard";

export function Composer({
  threadId,
  branch,
  permissionMode,
  onPermissionModeChange,
  provider,
  model,
  reasoningEffort,
  providers,
  workflows,
  onSetProvider,
  onSetReasoningEffort,
  onSaveWorkflow,
  onRemoveWorkflow,
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
  /** Empty-list providers: Custom… swaps the menu for an inline text input. */
  const [customModelOpen, setCustomModelOpen] = useState(false);
  const [customModelDraft, setCustomModelDraft] = useState("");
  /** Index of the row under keyboard/hover focus in the model list. */
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [buildMenuOpen, setBuildMenuOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  /** Per-thread last-used workflow template id. */
  const [templateByThread, setTemplateByThread] = useState<
    Record<string, string>
  >({});
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const providerWrapRef = useRef<HTMLDivElement>(null);
  const modelWrapRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelListRef = useRef<HTMLUListElement>(null);
  const customModelInputRef = useRef<HTMLInputElement>(null);
  const buildWrapRef = useRef<HTMLDivElement>(null);
  const modelListId = useId();

  // Dead ids (deleted templates) fall through like no stored selection.
  const storedTemplateId = templateByThread[threadId];
  const storedStillExists =
    storedTemplateId != null &&
    workflows.some((w) => w.id === storedTemplateId);
  const templateId = storedStillExists
    ? storedTemplateId
    : workflows.some((w) => w.id === DEFAULT_TEMPLATE_ID)
      ? DEFAULT_TEMPLATE_ID
      : (workflows[0]?.id ?? DEFAULT_TEMPLATE_ID);

  const hasPrompt = value.trim().length > 0;
  const canSend = !disabled && !sending && hasPrompt;
  /** Build is enabled for any provider; backend validates phase providers. */
  const canBuild = !disabled && !sending && hasPrompt;
  const shownError = error ?? localError;
  const shortSess = shortSessionId(sessionId);
  const sessionLocked = Boolean(sessionId);
  const providerName = providerDisplayName(provider, providers);
  const currentProviderInfo = providers.find((p) => p.id === provider);
  const providerModels = currentProviderInfo?.models ?? [];
  /**
   * Simulate/generic are not real CLIs; a model id is meaningless there.
   * Hide the whole model pill (no Default-only menu, no Custom…).
   * Other empty-list providers (e.g. codex) still get Custom….
   */
  const showModelPill = provider !== "simulate" && provider !== "generic";
  const allowCustomModel = showModelPill && providerModels.length === 0;
  const modelRows = buildModelRows(currentProviderInfo);
  const triggerLabel = modelTriggerLabel(model, currentProviderInfo);
  const highlightRow = modelRows[clampHighlightIndex(modelRows, highlightIndex)];
  const detailRow = detailModelRow(
    modelRows,
    model,
    highlightRow ? highlightRow.id : undefined,
  );
  const efforts = currentProviderInfo?.efforts ?? [];
  const reasoningVisible = showReasoningControl(efforts);
  const segments = reasoningVisible
    ? effortSegments(efforts, reasoningEffort)
    : [];
  const effortLabel = effortDisplayLabel(reasoningEffort);

  useEffect(() => {
    if (!modeOpen && !providerOpen && !modelOpen && !buildMenuOpen) return;
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
        setCustomModelOpen(false);
      }
      if (buildMenuOpen && !buildWrapRef.current?.contains(t)) {
        setBuildMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modeOpen, providerOpen, modelOpen, buildMenuOpen]);

  useEffect(() => {
    if (customModelOpen) {
      customModelInputRef.current?.focus();
      customModelInputRef.current?.select();
    }
  }, [customModelOpen]);

  // Leaving the model menu (or switching provider) drops custom-input mode.
  useEffect(() => {
    if (!modelOpen) setCustomModelOpen(false);
  }, [modelOpen]);

  useEffect(() => {
    setModelOpen(false);
    setCustomModelOpen(false);
  }, [provider]);

  // When the popover opens, seed highlight on the selected model and focus the list.
  useEffect(() => {
    if (!modelOpen || customModelOpen) return;
    setHighlightIndex(initialHighlightIndex(modelRows, model));
    // Focus the listbox so arrow keys work immediately.
    const t = window.setTimeout(() => {
      modelListRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
    // modelRows is rebuilt each render; open edge only needs modelOpen/custom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOpen, customModelOpen]);

  const closeModelPicker = useCallback((returnFocus: boolean) => {
    setModelOpen(false);
    setCustomModelOpen(false);
    if (returnFocus) {
      modelTriggerRef.current?.focus();
    }
  }, []);

  const anyMenuOpen = modeOpen || providerOpen || modelOpen || buildMenuOpen;
  const closeAllMenus = useCallback(() => {
    // Custom input owns Escape (cancel back to list); do not close the menu.
    if (customModelOpen) return;
    setModeOpen(false);
    setProviderOpen(false);
    if (modelOpen) {
      closeModelPicker(true);
    } else {
      setModelOpen(false);
    }
    setBuildMenuOpen(false);
  }, [customModelOpen, modelOpen, closeModelPicker]);
  useEscapeClose(anyMenuOpen && !customModelOpen, closeAllMenus);

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
    setBuildMenuOpen(false);
    void runAction(
      (prompt) => onBuild(prompt, templateId),
      "Failed to start workflow",
    );
  };

  const selectTemplate = (id: string) => {
    setTemplateByThread((prev) => ({ ...prev, [threadId]: id }));
    setBuildMenuOpen(false);
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
    closeModelPicker(true);
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

  const pickEffort = async (level: ReasoningEffort) => {
    // Clicking the current level clears it back to the provider default.
    // Without this the null branch is implemented at every layer and
    // unreachable from the UI: once you pick a level you can never stop.
    const next = level === reasoningEffort ? null : level;
    try {
      await onSetReasoningEffort(next);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to set reasoning effort";
      setLocalError(msg);
    }
  };

  const openCustomModel = () => {
    setCustomModelDraft(model ?? "");
    setCustomModelOpen(true);
  };

  const cancelCustomModel = () => {
    setCustomModelOpen(false);
    setCustomModelDraft("");
  };

  const commitCustomModel = async () => {
    const next = customModelDraft.trim();
    setCustomModelOpen(false);
    setModelOpen(false);
    setCustomModelDraft("");
    if (next === (model ?? "")) return;
    try {
      // Empty draft is "Default" (null); non-empty is the free-form id.
      await onSetProvider({ model: next === "" ? null : next });
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to set model";
      setLocalError(msg);
    }
  };

  const onModelListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (customModelOpen) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) =>
        clampHighlightIndex(modelRows, i + 1),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) =>
        clampHighlightIndex(modelRows, i - 1),
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = modelRows[clampHighlightIndex(modelRows, highlightIndex)];
      if (row) void pickModel(row.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeModelPicker(true);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlightIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlightIndex(Math.max(0, modelRows.length - 1));
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
                aria-disabled={disabled || sessionLocked ? "true" : undefined}
                title={lockedTitle}
                aria-haspopup={sessionLocked ? undefined : "listbox"}
                aria-expanded={sessionLocked ? undefined : providerOpen}
                onClick={() => {
                  if (disabled || sessionLocked) return;
                  setProviderOpen((v) => !v);
                  setModelOpen(false);
                  setModeOpen(false);
                  setBuildMenuOpen(false);
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
                  ref={modelTriggerRef}
                  type="button"
                  className={styles.pill}
                  disabled={disabled}
                  aria-disabled={disabled ? "true" : undefined}
                  aria-haspopup="dialog"
                  aria-expanded={modelOpen}
                  aria-controls={modelOpen ? modelListId : undefined}
                  aria-label={`Model: ${triggerLabel}`}
                  onClick={() => {
                    if (disabled) return;
                    if (modelOpen) {
                      closeModelPicker(false);
                    } else {
                      setModelOpen(true);
                      setCustomModelOpen(false);
                      setProviderOpen(false);
                      setModeOpen(false);
                      setBuildMenuOpen(false);
                    }
                  }}
                >
                  <span className={styles.modelIcon} aria-hidden="true">
                    ◇
                  </span>
                  {triggerLabel}
                  <span className={styles.caret}>▾</span>
                </button>
                {modelOpen && (
                  <div
                    className={styles.modelPopover}
                    role="dialog"
                    aria-label="Model picker"
                    id={modelListId}
                  >
                    {customModelOpen ? (
                      <div className={styles.customModelBox}>
                        <input
                          ref={customModelInputRef}
                          type="text"
                          className={styles.customModelInput}
                          value={customModelDraft}
                          maxLength={100}
                          placeholder="Model id"
                          aria-label="Custom model id"
                          onChange={(e) => setCustomModelDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              e.stopPropagation();
                              void commitCustomModel();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              e.stopPropagation();
                              cancelCustomModel();
                            }
                          }}
                        />
                      </div>
                    ) : (
                      <>
                        <div className={styles.modelPopoverLeft}>
                          <div className={styles.modelPaneHeader}>MODEL</div>
                          <ul
                            ref={modelListRef}
                            className={styles.modelList}
                            role="listbox"
                            aria-label="Model"
                            tabIndex={0}
                            onKeyDown={onModelListKeyDown}
                          >
                            {modelRows.map((row, index) => {
                              const selected = row.id === model;
                              const highlighted = index === highlightIndex;
                              return (
                                <li
                                  key={row.id ?? "__default__"}
                                  role="option"
                                  aria-selected={selected}
                                >
                                  <button
                                    type="button"
                                    className={styles.modelRow}
                                    data-selected={selected ? "true" : undefined}
                                    data-highlighted={
                                      highlighted ? "true" : undefined
                                    }
                                    onMouseEnter={() => setHighlightIndex(index)}
                                    onClick={() => void pickModel(row.id)}
                                  >
                                    <span className={styles.modelRowLabel}>
                                      {row.label}
                                    </span>
                                    {row.vendor ? (
                                      <span className={styles.modelRowVendor}>
                                        {row.vendor}
                                      </span>
                                    ) : null}
                                  </button>
                                </li>
                              );
                            })}
                            {allowCustomModel && (
                              <li role="option" aria-selected={false}>
                                <button
                                  type="button"
                                  className={styles.modelRow}
                                  onClick={openCustomModel}
                                >
                                  <span className={styles.modelRowLabel}>
                                    Custom…
                                  </span>
                                </button>
                              </li>
                            )}
                          </ul>
                        </div>
                        <div className={styles.modelPopoverRight}>
                          <div className={styles.detailLabel}>
                            {detailRow.label}
                          </div>
                          {detailRow.vendor ? (
                            <div className={styles.detailVendor}>
                              {detailRow.vendor}
                            </div>
                          ) : null}
                          {detailRow.description ? (
                            <div className={styles.detailDesc}>
                              {detailRow.description}
                            </div>
                          ) : null}
                          {reasoningVisible && (
                            <div className={styles.reasoningBlock}>
                              <div className={styles.reasoningHeader}>
                                <span className={styles.reasoningTitle}>
                                  REASONING
                                </span>
                                <span className={styles.reasoningLevel}>
                                  {effortLabel}
                                </span>
                              </div>
                              <div
                                className={styles.effortSegments}
                                role="group"
                                aria-label="Reasoning effort"
                              >
                                {segments.map((seg) => (
                                  <button
                                    key={seg.level}
                                    type="button"
                                    className={styles.effortSegment}
                                    data-filled={seg.filled ? "true" : undefined}
                                    aria-label={`Reasoning ${effortDisplayLabel(seg.level)}`}
                                    aria-pressed={
                                      reasoningEffort === seg.level
                                        ? "true"
                                        : "false"
                                    }
                                    onClick={() => void pickEffort(seg.level)}
                                  />
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className={styles.modeWrap} ref={modeWrapRef}>
              <button
                type="button"
                className={styles.pill}
                disabled={disabled}
                aria-disabled={disabled ? "true" : undefined}
                aria-haspopup="listbox"
                aria-expanded={modeOpen}
                onClick={() => {
                  if (!disabled) {
                    setModeOpen((v) => !v);
                    setProviderOpen(false);
                    setModelOpen(false);
                    setBuildMenuOpen(false);
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

            <div className={styles.buildSplit} ref={buildWrapRef}>
              <button
                type="button"
                className={`${styles.pill} ${styles.pillAccent} ${styles.buildMain}`}
                onClick={() => submitBuild()}
                disabled={!canBuild}
                aria-disabled={!canBuild ? "true" : undefined}
                title="Build workflow"
              >
                {STATIC.mode}
              </button>
              <button
                type="button"
                className={`${styles.pill} ${styles.pillAccent} ${styles.buildCaret}`}
                aria-label="Choose workflow template"
                aria-haspopup="menu"
                aria-expanded={buildMenuOpen}
                disabled={disabled || sending}
                aria-disabled={disabled || sending ? "true" : undefined}
                onClick={() => {
                  if (disabled || sending) return;
                  setBuildMenuOpen((v) => !v);
                  setModeOpen(false);
                  setProviderOpen(false);
                  setModelOpen(false);
                }}
              >
                <span className={styles.caret}>▾</span>
              </button>
              {buildMenuOpen && (
                <ul
                  className={`${styles.modeMenu} ${styles.buildMenu}`}
                  role="menu"
                  aria-label="Workflow templates"
                >
                  {workflows.map((t) => (
                    <li key={t.id} role="none">
                      <button
                        type="button"
                        className={styles.modeOption}
                        role="menuitemradio"
                        aria-checked={t.id === templateId}
                        data-active={t.id === templateId}
                        onClick={() => selectTemplate(t.id)}
                      >
                        <span className={styles.checkSlot}>
                          {t.id === templateId ? "✓" : ""}
                        </span>
                        {t.name}
                        {t.builtin && (
                          <span className={styles.optionHint}> builtin</span>
                        )}
                      </button>
                    </li>
                  ))}
                  {workflows.length > 0 && (
                    <li role="separator" className={styles.menuDivider} />
                  )}
                  <li role="none">
                    <button
                      type="button"
                      className={styles.modeOption}
                      role="menuitem"
                      onClick={() => {
                        setBuildMenuOpen(false);
                        setManageOpen(true);
                      }}
                    >
                      Manage workflows…
                    </button>
                  </li>
                </ul>
              )}
            </div>
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

      <WorkflowsModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        workflows={workflows}
        providers={providers}
        initialSelectedId={templateId}
        onSave={async (template) => {
          const saved = await onSaveWorkflow(template);
          // Rebind Build only when the save was of the currently selected
          // template (covers builtin-copy: source id matches selection, new id).
          // Editing an unrelated template must not repoint the Build button.
          if (template.id != null && template.id === templateId) {
            setTemplateByThread((prev) => ({
              ...prev,
              [threadId]: saved.id,
            }));
          }
          return saved;
        }}
        onRemove={onRemoveWorkflow}
      />
    </div>
  );
}
