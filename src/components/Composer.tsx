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
  buildUnifiedModelRows,
  clampHighlightIndex,
  detailModelRow,
  CUSTOM_MODEL_ID,
  effortDisplayLabel,
  effortSegments,
  firstSelectableIndex,
  initialHighlightIndex,
  isRowSelected,
  lastSelectableIndex,
  modelTriggerLabel,
  rowKey,
  showReasoningControl,
  stepHighlightIndex,
  type ModelRow,
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
  const [modelOpen, setModelOpen] = useState(false);
  /** Provider whose Custom... row was picked; null when not entering one. */
  const [customFor, setCustomFor] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  /** Index of the row under keyboard/hover focus in the model list. */
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [buildMenuOpen, setBuildMenuOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  /** Per-thread last-used workflow template id. */
  const [templateByThread, setTemplateByThread] = useState<
    Record<string, string>
  >({});
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const modelWrapRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelListRef = useRef<HTMLUListElement>(null);
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
  const modelRows = buildUnifiedModelRows(
    providers,
    provider,
    sessionLocked,
    providerName,
  );
  const triggerLabel = modelTriggerLabel(model, currentProviderInfo);
  const hi = clampHighlightIndex(modelRows, highlightIndex);
  const detailRow = detailModelRow(modelRows, provider, model, hi);
  const efforts = detailRow.efforts ?? [];
  const reasoningVisible = showReasoningControl(efforts);
  // Effort applies only to the current provider: show the live value when the
  // highlighted row is that provider, otherwise a blank meter (null current).
  const effortForMeter =
    detailRow.providerId === provider ? reasoningEffort : null;
  const segments = reasoningVisible
    ? effortSegments(efforts, effortForMeter)
    : [];
  const effortLabel = effortDisplayLabel(effortForMeter);

  useEffect(() => {
    if (!modeOpen && !modelOpen && !buildMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (modeOpen && !modeWrapRef.current?.contains(t)) {
        setModeOpen(false);
      }
      if (modelOpen && !modelWrapRef.current?.contains(t)) {
        setModelOpen(false);
      }
      if (buildMenuOpen && !buildWrapRef.current?.contains(t)) {
        setBuildMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modeOpen, modelOpen, buildMenuOpen]);

  // When the popover opens, seed highlight on the selected model and focus the list.
  useEffect(() => {
    if (!modelOpen) return;
    // Reset the custom-entry target on every OPEN, not on close. Only the
    // commit and the field's own Cancel/Escape cleared it, so closing any
    // other way (outside click, Escape while focus sat on a button) left it
    // set: reopening then showed a text box with no sign of its target, and a
    // commit went to the provider highlighted minutes earlier.
    setCustomFor(null);
    setHighlightIndex(initialHighlightIndex(modelRows, provider, model));
    // Focus the listbox so arrow keys work immediately.
    const t = window.setTimeout(() => {
      modelListRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
    // modelRows is rebuilt each render; open edge only needs modelOpen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOpen]);

  const closeModelPicker = useCallback((returnFocus: boolean) => {
    setModelOpen(false);
    if (returnFocus) {
      modelTriggerRef.current?.focus();
    }
  }, []);

  const anyMenuOpen = modeOpen || modelOpen || buildMenuOpen;
  const closeAllMenus = useCallback(() => {
    setModeOpen(false);
    if (modelOpen) {
      closeModelPicker(true);
    } else {
      setModelOpen(false);
    }
    setBuildMenuOpen(false);
  }, [modelOpen, closeModelPicker]);
  useEscapeClose(anyMenuOpen, closeAllMenus);

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

  const pickRow = async (row: ModelRow) => {
    if (row.disabled) return;
    if (row.id === CUSTOM_MODEL_ID) {
      // Swap the popover for a free-text field rather than selecting a model.
      setCustomFor(row.providerId);
      setCustomDraft("");
      return;
    }
    closeModelPicker(true);
    const same =
      row.providerId === provider && row.id === model;
    if (same) return;
    try {
      // Always send both so a cross-provider pick switches harness and model
      // in one setProvider call (no contract change).
      await onSetProvider({ provider: row.providerId, model: row.id });
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to set model";
      setLocalError(msg);
    }
  };

  /** Commit a free-text model id for the provider whose Custom row was picked. */
  const commitCustomModel = async () => {
    const id = customDraft.trim();
    if (!id || !customFor) return;
    closeModelPicker(true);
    try {
      await onSetProvider({ provider: customFor, model: id });
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to set model";
      setLocalError(msg);
    } finally {
      setCustomFor(null);
      setCustomDraft("");
    }
  };

  const pickEffort = async (level: ReasoningEffort) => {
    // Clicking the current level clears it back to the provider default.
    // Without this the null branch is implemented at every layer and
    // unreachable from the UI: once you pick a level you can never stop.
    // Only act when the detail row is the current provider (effort is per thread provider).
    if (detailRow.providerId !== provider) return;
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

  const onModelListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => stepHighlightIndex(modelRows, i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => stepHighlightIndex(modelRows, i, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = modelRows[clampHighlightIndex(modelRows, highlightIndex)];
      if (row && !row.disabled) void pickRow(row);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeModelPicker(true);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlightIndex(firstSelectableIndex(modelRows));
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlightIndex(lastSelectableIndex(modelRows));
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
                  <div className={styles.modelPopoverLeft}>
                    <div className={styles.modelPaneHeader}>MODEL</div>
                    {customFor ? (
                      <div className={styles.customModelWrap}>
                        <input
                          className={styles.customModelInput}
                          value={customDraft}
                          autoFocus
                          placeholder="Model id"
                          aria-label="Custom model id"
                          onChange={(e) => setCustomDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void commitCustomModel();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              // Do not let this reach the popover's own Escape
                              // handler, or backing out of the field closes the
                              // whole picker.
                              e.stopPropagation();
                              setCustomFor(null);
                              modelListRef.current?.focus();
                            }
                          }}
                        />
                        <div className={styles.customModelActions}>
                          <button
                            type="button"
                            className={styles.customModelBtn}
                            disabled={customDraft.trim().length === 0}
                            onClick={() => void commitCustomModel()}
                          >
                            Use model
                          </button>
                          <button
                            type="button"
                            className={styles.customModelBtn}
                            onClick={() => {
                              setCustomFor(null);
                              // Focus must go back to the list: the arrow
                              // handler is on the <ul>, so leaving focus on
                              // <body> leaves the open popover unnavigable.
                              modelListRef.current?.focus();
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                    <ul
                      ref={modelListRef}
                      className={styles.modelList}
                      role="listbox"
                      aria-label="Model"
                      tabIndex={0}
                      onKeyDown={onModelListKeyDown}
                    >
                      {modelRows.map((row, index) => {
                        const selected = isRowSelected(row, provider, model);
                        const highlighted = index === hi;
                        return (
                          <li
                            key={rowKey(row)}
                            role="option"
                            aria-selected={selected}
                            aria-disabled={row.disabled ? true : undefined}
                          >
                            {row.groupHeading ? (
                              <div
                                className={styles.modelGroupHeading}
                                aria-hidden="true"
                              >
                                {row.groupHeading}
                              </div>
                            ) : null}
                            <button
                              type="button"
                              className={styles.modelRow}
                              // The list scrolls (26 rows in a 240px box) and
                              // opens focused, so arrow keys are the first
                              // affordance. Without this the highlight walks
                              // off-screen past the sixth row and the list
                              // looks frozen while the detail pane changes.
                              ref={(el) => {
                                if (highlighted && el) {
                                  el.scrollIntoView({ block: "nearest" });
                                }
                              }}
                              data-selected={selected ? "true" : undefined}
                              data-highlighted={
                                highlighted ? "true" : undefined
                              }
                              data-disabled={
                                row.disabled ? "true" : undefined
                              }
                              disabled={row.disabled}
                              title={row.disabledReason ?? undefined}
                              onMouseEnter={() => setHighlightIndex(index)}
                              onClick={() => void pickRow(row)}
                            >
                              <span className={styles.modelRowLabel}>
                                {row.label}
                              </span>
                              <span className={styles.modelRowVendor}>
                                {row.vendor}
                                {row.unavailable ? " · not installed" : ""}
                              </span>
                            </button>
                          </li>
                        );
                      })}
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
                                detailRow.providerId === provider &&
                                reasoningEffort === seg.level
                                  ? "true"
                                  : "false"
                              }
                              disabled={detailRow.providerId !== provider}
                              onClick={() => void pickEffort(seg.level)}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

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
