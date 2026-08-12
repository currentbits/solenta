import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
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
  buildUnifiedModelRows,
  clampHighlightIndex,
  detailModelRow,
  CUSTOM_MODEL_ID,
  buildProviderRows,
  effortDisplayLabel,
  providerDetail,
  effortSegments,
  firstSelectableIndex,
  initialHighlightIndex,
  initialProviderIndex,
  stepProviderIndex,
  isRowSelected,
  lastSelectableIndex,
  modelTriggerLabel,
  rowKey,
  showReasoningControl,
  stepHighlightIndex,
  type ModelRow,
} from "../modelPicker";
import { useEscapeClose } from "../useEscapeClose";
import { applyMention, getMentionQuery, type MentionQuery } from "../mention";
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
  /**
   * File lookup for the @-mention popup. Absent disables the feature (tests,
   * mock shells without a repo behind them).
   */
  onListFiles?: (query: string) => Promise<string[]>;
}

const STATIC = {
  mode: "Build",
};

const DEFAULT_TEMPLATE_ID = "standard";

/** Capped cascade index: row 30 shouldn't wait half a second to appear. */
const rowEnterStyle = (index: number): CSSProperties =>
  ({ "--i": String(Math.min(index, 10)) }) as CSSProperties;

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
  onListFiles,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  /** Provider whose Custom... row was picked; null when not entering one. */
  const [customFor, setCustomFor] = useState<string | null>(null);
  /**
   * Which provider's models are showing. null means the FIRST level, the
   * provider list. A flat list of every provider's models ran to 26 rows;
   * drilling shows five to start and one harness's models after that.
   */
  const [drillProvider, setDrillProvider] = useState<string | null>(null);
  const [providerIndex, setProviderIndex] = useState(0);
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
  const providerListRef = useRef<HTMLUListElement>(null);
  const buildWrapRef = useRef<HTMLDivElement>(null);
  const modelListId = useId();

  /** @-mention popup state; `mention` null means closed. */
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stale-response guard: only the latest lookup may paint the popup. */
  const mentionSeq = useRef(0);
  /** Caret to restore after a mention insert re-renders the textarea. */
  const pendingCaret = useRef<number | null>(null);
  const mentionOpen = mention != null && mentionFiles.length > 0;

  const closeMention = useCallback(() => {
    setMention(null);
    setMentionFiles([]);
    setMentionIndex(0);
    if (mentionTimer.current) {
      clearTimeout(mentionTimer.current);
      mentionTimer.current = null;
    }
  }, []);

  /** Recompute the active @token from the live textarea and (re)fetch files. */
  const refreshMention = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !onListFiles || disabled) {
      closeMention();
      return;
    }
    const q = getMentionQuery(el.value, el.selectionStart ?? el.value.length);
    if (!q) {
      closeMention();
      return;
    }
    setMention(q);
    if (mentionTimer.current) clearTimeout(mentionTimer.current);
    const seq = ++mentionSeq.current;
    mentionTimer.current = setTimeout(() => {
      onListFiles(q.query)
        .then((files) => {
          if (mentionSeq.current !== seq) return;
          setMentionFiles(files);
          setMentionIndex(0);
        })
        .catch(() => {
          if (mentionSeq.current !== seq) return;
          setMentionFiles([]);
        });
    }, 150);
  }, [onListFiles, disabled, closeMention]);

  const acceptMention = useCallback(
    (path: string) => {
      const el = textareaRef.current;
      if (!el || !mention) return;
      const next = applyMention(
        el.value,
        el.selectionStart ?? el.value.length,
        mention.start,
        path,
      );
      pendingCaret.current = next.caret;
      setValue(next.text);
      closeMention();
    },
    [mention, closeMention],
  );

  // Restore the caret after an accepted mention re-renders the textarea.
  useEffect(() => {
    if (pendingCaret.current != null && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(
        pendingCaret.current,
        pendingCaret.current,
      );
      pendingCaret.current = null;
    }
  }, [value]);

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
  const providerRows = buildProviderRows(
    providers,
    provider,
    sessionLocked,
    providerName,
  );
  const drillInfo = drillProvider
    ? providers.find((p) => p.id === drillProvider)
    : undefined;
  // Second level shows exactly one provider's models; the flat list is kept for
  // the case where the drill target vanished (provider list changed under us).
  const modelRows = drillInfo
    ? buildModelRows(drillInfo)
    : buildUnifiedModelRows(providers, provider, sessionLocked, providerName);
  const triggerLabel = modelTriggerLabel(model, currentProviderInfo);
  const hi = clampHighlightIndex(modelRows, highlightIndex);
  const detailRow = detailModelRow(modelRows, provider, model, hi);
  // At the provider level the pane must describe the highlighted PROVIDER.
  // It used to index the flat model list with the model-level highlight, so a
  // Grok thread showed "Fable, Anthropic": a confident description of something
  // the user was not pointing at.
  const providerPane = drillProvider
    ? null
    : providerDetail(providerRows, providerIndex, providers);
  const detail = providerPane ?? {
    providerId: detailRow.providerId,
    label: detailRow.label,
    vendor: detailRow.vendor,
    description: detailRow.description,
    efforts: detailRow.efforts ?? [],
  };
  const efforts = detail.efforts ?? [];
  const reasoningVisible = showReasoningControl(efforts);
  // A provider whose CLI is not installed can be highlighted but never
  // selected, so its meter must stay inert even though it renders.
  const detailUnavailable =
    providers.find((p) => p.id === detail.providerId)?.available === false;
  // Effort applies only to the current provider: show the live value when the
  // highlighted row is that provider, otherwise a blank meter (null current).
  const effortForMeter =
    detail.providerId === provider ? reasoningEffort : null;
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
    // Same reason as customFor: reset on OPEN so every close path is covered,
    // including ones added later.
    setDrillProvider(null);
    setProviderIndex(initialProviderIndex(providerRows, provider));
    setHighlightIndex(initialHighlightIndex(modelRows, provider, model));
    // Focus the listbox so arrow keys work immediately.
    // modelRows is rebuilt each render; the reset only needs the open edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOpen]);

  // Focus the list that is ACTUALLY showing, on every level change.
  //
  // Focusing only on the open edge left focus on <body> after drilling in or
  // backing out, because the list that had focus unmounts. That is worse than
  // it sounds: the keydown handler lives on the <ul>, so arrows died, and the
  // Escape handler that stops propagation was never reached, so the document
  // listener closed the entire picker instead of stepping back a level.
  useEffect(() => {
    if (!modelOpen) return;
    const t = window.setTimeout(() => {
      (drillProvider ? modelListRef : providerListRef).current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [modelOpen, drillProvider]);

  /**
   * Gliding highlight: one indicator that slides to the highlighted row
   * instead of each row blinking its own background on and off. Measured
   * from the DOM (offsetTop/Height) so variable row heights and scroll
   * position need no math here. The glider mounts fresh with each list, so
   * drilling never animates it across the level change.
   */
  const [glider, setGlider] = useState<{ top: number; height: number } | null>(
    null,
  );
  useEffect(() => {
    if (!modelOpen) return;
    const list = (drillProvider ? modelListRef : providerListRef).current;
    const hl = list?.querySelector<HTMLElement>('[data-highlighted="true"]');
    setGlider(hl ? { top: hl.offsetTop, height: hl.offsetHeight } : null);
  }, [modelOpen, drillProvider, providerIndex, hi, modelRows.length]);

  /** Enter a provider's models, seeding the highlight on its selected row. */
  const enterProvider = (id: string) => {
    setDrillProvider(id);
    // Seed on the selected model, not on row 0. The comment used to claim this
    // while the code sent every drill-in to Default, so the detail pane and the
    // meter described Default while aria-selected sat on the real model.
    const rows = buildModelRows(providers.find((p) => p.id === id));
    setHighlightIndex(initialHighlightIndex(rows, provider, model));
  };

  const onProviderListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setProviderIndex((i) =>
        stepProviderIndex(providerRows, i, e.key === "ArrowDown" ? 1 : -1),
      );
      return;
    }
    if (e.key === "Enter" || e.key === "ArrowRight") {
      e.preventDefault();
      const row = providerRows[providerIndex];
      if (row && !row.disabled) enterProvider(row.id);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Cheap insurance only: closeAllMenus is idempotent, so the document
      // listener firing as well changes nothing. This branch is NOT what closes
      // the picker at this level, and a comment claiming otherwise would send
      // the next reader looking for behaviour that is not here.
      e.stopPropagation();
      closeModelPicker(true);
    }
  };

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
      closeMention();
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
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionFiles.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const f = mentionFiles[mentionIndex];
        if (f) acceptMention(f);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Keep this from the popover-level Escape handlers: only the mention
        // popup closes.
        e.stopPropagation();
        closeMention();
        return;
      }
    }
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
    // The meter follows the HIGHLIGHTED row. Picking a level on another
    // harness selects that harness and the highlighted model, then applies
    // the level: setProvider resets effort to null on a provider switch, so
    // the effort call must come second or it is wiped immediately.
    if (detailUnavailable) return;
    try {
      if (detail.providerId !== provider) {
        const targetModel =
          providerPane || detailRow.id === CUSTOM_MODEL_ID
            ? null
            : detailRow.id;
        await onSetProvider({ provider: detail.providerId, model: targetModel });
        await onSetReasoningEffort(level);
        return;
      }
      // Clicking the current level clears it back to the provider default.
      // Without this the null branch is implemented at every layer and
      // unreachable from the UI: once you pick a level you can never stop.
      const next = level === reasoningEffort ? null : level;
      await onSetReasoningEffort(next);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to set reasoning effort";
      setLocalError(msg);
    }
  };

  /** Leave a provider's models and return to the provider list. */
  const leaveProvider = () => {
    const at = initialProviderIndex(providerRows, drillProvider ?? provider);
    setDrillProvider(null);
    setProviderIndex(at);
    setCustomFor(null);
    // Deliberately NOT re-seeding highlightIndex: the provider level reads
    // providerDetail, and enterProvider re-seeds on every drill-in, so the
    // stale value is never read. Adding a reset here survived its own mutation,
    // which is the signature of a line that looks load-bearing and is not.
  };

  const onModelListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (drillProvider && (e.key === "ArrowLeft" || e.key === "Escape")) {
      e.preventDefault();
      // Stop this reaching the popover's own Escape handler, or backing out of
      // a provider closes the whole picker instead of stepping up one level.
      e.stopPropagation();
      leaveProvider();
      return;
    }
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
            title="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
      <div className={styles.card}>
        {mentionOpen && (
          <ul
            className={styles.mentionList}
            role="listbox"
            aria-label="Mention a file"
          >
            {mentionFiles.map((f, i) => (
              <li key={f} role="option" aria-selected={i === mentionIndex}>
                <button
                  type="button"
                  className={styles.mentionRow}
                  data-highlighted={i === mentionIndex ? "true" : undefined}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => acceptMention(f)}
                >
                  {f}
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder={placeholder}
          rows={3}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            refreshMention();
          }}
          onSelect={refreshMention}
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
                title={`Model: ${triggerLabel}`}
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
                {/* Keyed so a model swap replays the pop instead of swapping
                    text mid-frame. */}
                <span key={triggerLabel} className={styles.pillLabel}>
                  {triggerLabel}
                </span>
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
                    {drillProvider ? (
                      <button
                        type="button"
                        className={styles.modelBackHeader}
                        aria-label="Back to providers"
                        title="Back to providers"
                        onClick={leaveProvider}
                      >
                        <span aria-hidden="true">‹ </span>
                        {(drillInfo?.name ?? drillProvider).toUpperCase()}
                      </button>
                    ) : (
                      <div className={styles.modelPaneHeader}>MODEL</div>
                    )}
                    {!drillProvider ? (
                      <ul
                        className={`${styles.modelList} ${styles.levelEnterLeft}`}
                        role="listbox"
                        aria-label="Provider"
                        tabIndex={0}
                        ref={providerListRef}
                        onKeyDown={onProviderListKeyDown}
                      >
                        {glider && (
                          <div
                            className={styles.highlightGlider}
                            aria-hidden="true"
                            style={{
                              height: glider.height,
                              transform: `translateY(${glider.top}px)`,
                            }}
                          />
                        )}
                        {providerRows.map((row, index) => (
                          <li key={row.id} role="option" aria-selected={row.current}>
                            <button
                              type="button"
                              className={styles.providerRow}
                              data-selected={row.current ? "true" : undefined}
                              data-highlighted={
                                index === providerIndex ? "true" : undefined
                              }
                              data-disabled={row.disabled ? "true" : undefined}
                              disabled={row.disabled}
                              title={row.disabledReason ?? undefined}
                              aria-label={`Provider ${row.name}`}
                              onMouseEnter={() => setProviderIndex(index)}
                              onClick={() => enterProvider(row.id)}
                            >
                              <span className={styles.providerRowText}>
                                <span className={styles.modelRowLabel}>
                                  {row.name}
                                </span>
                                <span className={styles.modelRowVendor}>
                                  {row.badge}
                                </span>
                              </span>
                              <span
                                className={styles.modelRowChevron}
                                aria-hidden="true"
                              >
                                ›
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {drillProvider && customFor ? (
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
                    {drillProvider ? (
                    <ul
                      ref={modelListRef}
                      className={`${styles.modelList} ${styles.levelEnterRight}`}
                      role="listbox"
                      aria-label="Model"
                      tabIndex={0}
                      onKeyDown={onModelListKeyDown}
                    >
                      {glider && (
                        <div
                          className={styles.highlightGlider}
                          aria-hidden="true"
                          style={{
                            height: glider.height,
                            transform: `translateY(${glider.top}px)`,
                          }}
                        />
                      )}
                      {modelRows.map((row, index) => {
                        const selected = isRowSelected(row, provider, model);
                        const highlighted = index === hi;
                        return (
                          <li
                            key={rowKey(row)}
                            role="option"
                            aria-selected={selected}
                            aria-disabled={row.disabled ? true : undefined}
                            className={styles.rowEnter}
                            style={rowEnterStyle(index)}
                          >
                            {row.groupHeading && !drillProvider ? (
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
                    ) : null}
                  </div>
                  <div className={styles.modelPopoverRight}>
                    {/* Keyed on the highlighted row so a highlight move
                        remounts the pane and replays the detailIn fade. */}
                    <div
                      className={styles.detailBody}
                      key={`${detail.providerId}::${detail.label}`}
                    >
                      <div className={styles.detailLabel}>{detail.label}</div>
                      {detail.vendor ? (
                        <div className={styles.detailVendor}>
                          {detail.vendor}
                        </div>
                      ) : null}
                      {detail.description ? (
                        <div className={styles.detailDesc}>
                          {detail.description}
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
                            {segments.map((seg, i) => (
                              <button
                                key={seg.level}
                                type="button"
                                className={styles.effortSegment}
                                style={{ "--i": String(i) } as CSSProperties}
                                data-filled={seg.filled ? "true" : undefined}
                                aria-label={`Reasoning ${effortDisplayLabel(seg.level)}`}
                                title={`Reasoning ${effortDisplayLabel(seg.level)}`}
                                aria-pressed={
                                  detail.providerId === provider &&
                                  reasoningEffort === seg.level
                                    ? "true"
                                    : "false"
                                }
                                disabled={detailUnavailable}
                                onClick={() => void pickEffort(seg.level)}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
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
                title="Choose workflow template"
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
