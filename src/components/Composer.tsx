import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type {
  AgentProfile,
  AttachmentInfo,
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
  buildProfileRows,
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
  type ProfileRow,
} from "../modelPicker";
import { useEscapeClose } from "../useEscapeClose";
import { applyMention, getMentionQuery, type MentionQuery } from "../mention";
import { parseDelegate } from "../delegate";
import { asBtwPrompt } from "../btw";
import { buildBestOfNEntries, providerVendor } from "../bestOfN";
import {
  commandQuery,
  matchSlashCommands,
  type SlashAction,
  type SlashCommand,
} from "../slashCommands";
import { WorkflowsModal } from "./WorkflowsModal";
import { DROP_OVERLAY_MESSAGE, DROP_REJECT_MESSAGE } from "../dropFiles";
import { teachPermissionAllowed } from "../teach";
import type { ThreadTeach } from "../shared/ipc";
import { useFileDrop } from "../useFileDrop";
import styles from "./Composer.module.css";

interface ComposerProps {
  /** Selected thread id; used for per-thread last-used template. */
  threadId: string;
  /** Thread branch when known; null omits the branch chip (no invented default). */
  branch: string | null;
  /** Sticky permission mode for this thread. */
  permissionMode: PermissionMode;
  /** Teach-mode autonomy cap on the permission picker (issue #373). */
  teach?: ThreadTeach | null;
  /** Ask mode (issue #392): hide permission, Build, Best of N, attach. */
  ask?: boolean;
  onPermissionModeChange: (mode: PermissionMode) => void | Promise<void>;
  /** Current thread provider id. */
  provider: string;
  /** Thread model override; null means provider default. */
  model: string | null;
  /** Thread reasoning effort; null means provider default. */
  reasoningEffort: ReasoningEffort | null;
  /** Registry from providers.list(). */
  providers: ProviderInfo[];
  /** Saved named profiles from settings. Empty hides the Profiles section. */
  agentProfiles?: AgentProfile[];
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
  /** Hard lock (archived thread): nothing can be typed or started. */
  disabled?: boolean;
  /**
   * A run is active. The prompt stays live so the next instruction can be
   * typed and sent — the parent queues it for when the run lands (issue #92).
   * Controls that only make sense between runs stay locked.
   */
  busy?: boolean;
  /** Single session turn (send arrow + ⌘Enter). */
  onSend: (prompt: string, attachments?: AttachmentInfo[]) => void | Promise<void>;
  /** Multi-phase Build workflow (Build pill main segment). */
  onBuild: (prompt: string, templateId: string) => void | Promise<void>;
  /**
   * Best of N: run this prompt on each selected provider or profile as a
   * forked thread. Absent hides the control (tests and shells without fork).
   */
  onBestOfN?: (selectedIds: string[], prompt: string) => void | Promise<void>;
  /**
   * Delegation command: a prompt whose first token is `@<installed provider>`
   * forks this thread onto that provider and runs the remainder there.
   * Absent disables the feature (tests and shells without fork).
   */
  onDelegate?: (providerId: string, task: string) => void | Promise<void>;
  /** Fired each time the model picker popover opens (provider list refresh). */
  onModelPickerOpen?: () => void;
  placeholder?: string;
  /** Run-scope error from the parent hook (e.g. already active). */
  error?: string | null;
  onDismissError?: () => void;
  /**
   * File lookup for the @-mention popup. Absent disables the feature (tests,
   * mock shells without a repo behind them).
   */
  onListFiles?: (query: string) => Promise<string[]>;
  /**
   * File/image/folder picker for attachments. Absent hides the attach button
   * (tests / shells that do not wire one).
   */
  onPickAttachments?: () => Promise<AttachmentInfo[]>;
  /** Persist a pasted image; returns its attachment or null when rejected. */
  onSaveAttachmentImage?: (dataUrl: string) => Promise<AttachmentInfo | null>;
  /** Thumbnail data URL for an attached image; null when unavailable. */
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
  /**
   * Classify drag-dropped files into attachments. Absent disables drop.
   */
  onDropAttachmentFiles?: (files: File[]) => Promise<AttachmentInfo[]>;
  /**
   * CLI `/` verbs that live outside Composer (issue #472): rewind, usage,
   * fork, new, clear, compact. Model / effort / permissions are handled
   * here. Absent: those verbs still clear the token so they never send.
   */
  onSlashAction?: (action: SlashAction) => void;
  /**
   * Extra `/` rows from the underlying CLI (#606): skills and custom
   * commands. Insert-only; Solenta-owned names in the static palette win.
   */
  cliCommands?: readonly SlashCommand[];
  /**
   * Live-turn interrupt (issue #478). Esc, and Ctrl+C with no selection,
   * call this while `busy`. The draft is left alone.
   */
  onStopRun?: () => void | Promise<void>;
  /**
   * Larger drop target (thread pane). When set, listeners bind there so a
   * drop on the transcript or empty state reaches the same chip list.
   */
  dropHostRef?: RefObject<HTMLElement | null>;
  /** Host overlay: true while a file drag is hovering the drop target. */
  onFileDragChange?: (dragging: boolean) => void;
}

const STATIC = {
  mode: "Build",
};

const DEFAULT_TEMPLATE_ID = "standard";

/** Capped cascade index: row 30 shouldn't wait half a second to appear. */
const rowEnterStyle = (index: number): CSSProperties =>
  ({ "--i": String(Math.min(index, 10)) }) as CSSProperties;

/** Two distinct Esc presses within this window rewind when idle (#478). */
const DOUBLE_ESC_MS = 500;

/**
 * Esc must not steal from a modal, the narrow-window drawer, or another
 * field (notes, rename, edit-resubmit). The composer textarea itself is
 * allowed through — that is the interrupt surface.
 */
function escapeConsumedByChrome(
  target: EventTarget | null,
  composerField: HTMLTextAreaElement | null,
): boolean {
  if (typeof document !== "undefined") {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
      return true;
    }
    if (document.querySelector("[data-drawer-open]")) return true;
  }
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  const typing =
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable;
  return typing && target !== composerField;
}

/** One pending attachment: thumbnail for images, glyph for files/folders. */
function AttachmentChip({
  attachment,
  onRemove,
  onLoadImage,
}: {
  attachment: AttachmentInfo;
  onRemove: () => void;
  onLoadImage?: (path: string) => Promise<string | null>;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (attachment.kind !== "image" || !onLoadImage) return;
    let live = true;
    void onLoadImage(attachment.path)
      .then((url) => {
        if (live) setThumb(url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [attachment.kind, attachment.path, onLoadImage]);
  return (
    <span
      className={styles.attachmentChip}
      data-attachment-kind={attachment.kind}
      title={attachment.path}
    >
      {attachment.kind === "image" && thumb ? (
        <img
          className={styles.attachmentThumb}
          src={thumb}
          alt={attachment.name}
        />
      ) : (
        <svg
          className={styles.attachmentIcon}
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {attachment.kind === "folder" ? (
            <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h2.2a1.5 1.5 0 0 1 1.1.5l.8 1a1.5 1.5 0 0 0 1.1.5H12A1.5 1.5 0 0 1 13.5 6v5A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V4Z" />
          ) : attachment.kind === "file" ? (
            <>
              <path d="M4.5 2.5h5l4 4v7A1.5 1.5 0 0 1 12 15H4.5A1.5 1.5 0 0 1 3 13.5v-10A1.5 1.5 0 0 1 4.5 2.5Z" />
              <path d="M9.5 2.5V7h4" />
            </>
          ) : (
            <>
              <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
              <circle cx="5.8" cy="6" r="1" />
              <path d="m3 12 3.5-3.5 2.5 2.5 2-2L13.5 12" />
            </>
          )}
        </svg>
      )}
      <span className={styles.attachmentName}>{attachment.name}</span>
      <button
        type="button"
        className={styles.attachmentRemove}
        aria-label={`Remove ${attachment.name}`}
        title={`Remove ${attachment.name}`}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  );
}

export const Composer = memo(function Composer({
  threadId,
  branch,
  permissionMode,
  teach = null,
  onPermissionModeChange,
  provider,
  model,
  reasoningEffort,
  providers,
  agentProfiles = [],
  workflows,
  onSetProvider,
  onSetReasoningEffort,
  onSaveWorkflow,
  onRemoveWorkflow,
  sessionId,
  hasWorktree,
  disabled = false,
  busy = false,
  onSend,
  onBuild,
  onBestOfN,
  ask = false,
  onDelegate,
  onModelPickerOpen,
  placeholder = "Ask anything, @tag files/folders, @provider delegates, $use skills, or / for commands",
  error = null,
  onDismissError,
  onListFiles,
  onPickAttachments,
  onSaveAttachmentImage,
  onLoadAttachmentImage,
  onDropAttachmentFiles,
  onSlashAction,
  cliCommands,
  onStopRun,
  dropHostRef,
  onFileDragChange,
}: ComposerProps) {
  /**
   * Unsent drafts keyed by thread: one Composer instance serves every thread
   * (ThreadView swaps threadId), so a single string would carry text across a
   * switch. Mirrors templateByThread below.
   *
   * Held in a ref, not useState: a controlled textarea re-renders this whole
   * picker (model rows, pills, slash/mention refresh) on every letter, which
   * is the lag after a few keystrokes. The field is uncontrolled; React only
   * paints when hasPrompt flips or a popup needs to open.
   */
  const draftsRef = useRef<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [hasPrompt, setHasPrompt] = useState(false);
  const syncHasPrompt = useCallback((text: string) => {
    const next = text.trim().length > 0;
    setHasPrompt((prev) => (prev === next ? prev : next));
  }, []);
  const rememberDraft = useCallback(
    (text: string) => {
      draftsRef.current[threadId] = text;
      syncHasPrompt(text);
    },
    [threadId, syncHasPrompt],
  );
  const writeDraft = useCallback(
    (text: string, caret?: number) => {
      draftsRef.current[threadId] = text;
      const el = textareaRef.current;
      if (el) {
        el.value = text;
        if (caret != null) {
          el.focus();
          el.setSelectionRange(caret, caret);
        }
      }
      syncHasPrompt(text);
    },
    [threadId, syncHasPrompt],
  );
  const readDraft = useCallback(
    () => textareaRef.current?.value ?? draftsRef.current[threadId] ?? "",
    [threadId],
  );
  /**
   * Pending attachments keyed by thread, mirroring draftsRef: chips must
   * not leak across a thread switch. Cleared together with the draft on a
   * successful action.
   */
  const [attachmentsByThread, setAttachmentsByThread] = useState<
    Record<string, AttachmentInfo[]>
  >({});
  const attachments = attachmentsByThread[threadId] ?? [];
  const addAttachments = useCallback(
    (items: AttachmentInfo[]) => {
      if (!items.length) return;
      setAttachmentsByThread((prev) => {
        const existing = prev[threadId] ?? [];
        const seen = new Set(existing.map((a) => a.path));
        const fresh = items.filter((a) => !seen.has(a.path));
        return fresh.length
          ? { ...prev, [threadId]: [...existing, ...fresh] }
          : prev;
      });
    },
    [threadId],
  );
  const removeAttachment = useCallback(
    (path: string) =>
      setAttachmentsByThread((prev) => ({
        ...prev,
        [threadId]: (prev[threadId] ?? []).filter((a) => a.path !== path),
      })),
    [threadId],
  );
  const clearAttachments = useCallback(
    () =>
      setAttachmentsByThread((prev) =>
        (prev[threadId] ?? []).length ? { ...prev, [threadId]: [] } : prev,
      ),
    [threadId],
  );
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
  const [bestOfNOpen, setBestOfNOpen] = useState(false);
  const [bestIds, setBestIds] = useState<string[]>([]);
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
  const bestOfNWrapRef = useRef<HTMLDivElement>(null);
  const modelListId = useId();

  /** @-mention popup state; `mention` null means closed. */
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stale-response guard: only the latest lookup may paint the popup. */
  const mentionSeq = useRef(0);
  const mentionOpen = mention != null && mentionFiles.length > 0;

  /** `/` command popup: `command` null means closed. */
  const [command, setCommand] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  /**
   * Escape must stay closed while the same text is still in the box —
   * without this the onSelect that follows the key would reopen it. Cleared
   * by the next edit and by a thread switch. Accepting needs no such guard:
   * the inserted trailing space ends the token on its own.
   */
  const commandDismissed = useRef(false);
  /** Last idle Esc; a second press within DOUBLE_ESC_MS rewinds (#478). */
  const lastEscAt = useRef(0);
  const commandMatches = command
    ? matchSlashCommands(command, cliCommands)
    : [];
  const commandOpen = commandMatches.length > 0;

  const closeCommand = useCallback(() => {
    setCommand(null);
    setCommandIndex(0);
  }, []);

  /** Recompute the active `/` token from the live textarea. */
  const refreshCommand = useCallback(() => {
    const el = textareaRef.current;
    const q =
      el && !disabled && !commandDismissed.current
        ? commandQuery(el.value)
        : null;
    if (q === null) {
      closeCommand();
      return;
    }
    setCommand(q);
    setCommandIndex(0);
  }, [disabled, closeCommand]);

  const acceptCommand = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.kind === "insert") {
        const inserted = `${cmd.name} `;
        writeDraft(inserted, inserted.length);
        closeCommand();
        return;
      }
      // Run verbs must not remain in the draft: sending `/compact` as a
      // prompt is the bug this palette exists to stop.
      writeDraft("", 0);
      closeCommand();
      const action = cmd.action;
      if (!action) return;
      if (action === "model" || action === "effort") {
        if (disabled || busy) return;
        setModelOpen(true);
        setModeOpen(false);
        setBuildMenuOpen(false);
        setBestOfNOpen(false);
        onModelPickerOpen?.();
        return;
      }
      if (action === "permissions") {
        if (disabled || busy) return;
        setModeOpen(true);
        setModelOpen(false);
        setBuildMenuOpen(false);
        setBestOfNOpen(false);
        return;
      }
      onSlashAction?.(action);
    },
    [writeDraft, closeCommand, disabled, busy, onModelPickerOpen, onSlashAction],
  );

  useEffect(() => {
    commandDismissed.current = false;
    lastEscAt.current = 0;
    syncHasPrompt(draftsRef.current[threadId] ?? "");
  }, [threadId, syncHasPrompt]);

  const closeMention = useCallback(() => {
    if (mentionTimer.current) {
      clearTimeout(mentionTimer.current);
      mentionTimer.current = null;
    }
    setMention((prev) => (prev == null ? prev : null));
    setMentionFiles((prev) => (prev.length === 0 ? prev : []));
    setMentionIndex((prev) => (prev === 0 ? prev : 0));
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
    setMention((prev) =>
      prev && prev.start === q.start && prev.query === q.query ? prev : q,
    );
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
      writeDraft(next.text, next.caret);
      closeMention();
    },
    [mention, closeMention, writeDraft],
  );

  /**
   * Focus the input when a thread is opened (mount, or ThreadView swapping
   * threadId on the same instance) and the composer can accept text, so the
   * user can type without clicking first (issue #73). A working thread is
   * focused too — its prompt takes type-ahead (issue #92); only an archived
   * thread waits for unarchive. An already-focused thread is NOT re-focused
   * when a run finishes, so a background completion never steals focus from
   * wherever the user went.
   */
  const focusedThread = useRef<string | null>(null);
  useEffect(() => {
    if (disabled || sending) return;
    if (focusedThread.current === threadId) return;
    const el = textareaRef.current;
    if (!el) return;
    focusedThread.current = threadId;
    el.focus();
    // Land at the end so a restored draft continues where it left off.
    el.setSelectionRange(el.value.length, el.value.length);
  }, [threadId, disabled, sending]);

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

  const canSend = !disabled && !sending && hasPrompt;
  /**
   * Everything that cannot be queued (workflow start, model, permission mode)
   * waits for the run to land; only the prompt and Send stay live while busy.
   */
  const locked = disabled || busy;
  /** Build is enabled for any provider; backend validates phase providers. */
  const canBuild = !locked && !sending && hasPrompt;
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
  const profileRows = buildProfileRows(agentProfiles, providers);
  const firstLevel = [...profileRows, ...providerRows];
  const drillInfo = drillProvider
    ? providers.find((p) => p.id === drillProvider)
    : undefined;
  // Second level shows exactly one provider's models; the flat list is kept for
  // the case where the drill target vanished (provider list changed under us).
  const modelRows = drillInfo
    ? buildModelRows(drillInfo)
    : buildUnifiedModelRows(providers, provider, sessionLocked, providerName);
  const triggerLabel = modelTriggerLabel(
    model,
    currentProviderInfo,
    reasoningEffort,
  );
  const hi = clampHighlightIndex(modelRows, highlightIndex);
  const detailRow = detailModelRow(modelRows, provider, model, hi);
  // At the provider level the pane must describe the highlighted PROVIDER.
  // It used to index the flat model list with the model-level highlight, so a
  // Grok thread showed "Fable, Anthropic": a confident description of something
  // the user was not pointing at.
  const highlightedProfile =
    !drillProvider && providerIndex < profileRows.length
      ? profileRows[providerIndex]
      : null;
  const providerPane = drillProvider
    ? null
    : highlightedProfile
      ? {
          providerId: highlightedProfile.provider,
          label: highlightedProfile.name,
          vendor: highlightedProfile.disabled ? "not installed" : "profile",
          description: highlightedProfile.summary,
        }
      : providerDetail(
          providerRows,
          Math.max(0, providerIndex - profileRows.length),
          providers,
        );
  const detail = providerPane ?? {
    providerId: detailRow.providerId,
    label: detailRow.label,
    vendor: detailRow.vendor,
    description: detailRow.description,
  };
  // Meter binds to the thread, not the highlighted row. Hovering a profile
  // or another provider must not blank the label or switch the harness.
  const efforts = currentProviderInfo?.efforts ?? [];
  const reasoningVisible = showReasoningControl(efforts);
  const meterUnavailable = currentProviderInfo?.available === false;
  const segments = reasoningVisible
    ? effortSegments(efforts, reasoningEffort)
    : [];
  const effortLabel = effortDisplayLabel(reasoningEffort);

  useEffect(() => {
    if (!modeOpen && !modelOpen && !buildMenuOpen && !bestOfNOpen) return;
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
      if (bestOfNOpen && !bestOfNWrapRef.current?.contains(t)) {
        setBestOfNOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modeOpen, modelOpen, buildMenuOpen, bestOfNOpen]);

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
    setProviderIndex(
      profileRows.length + initialProviderIndex(providerRows, provider),
    );
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
        stepProviderIndex(firstLevel, i, e.key === "ArrowDown" ? 1 : -1),
      );
      return;
    }
    if (e.key === "Enter" || e.key === "ArrowRight") {
      e.preventDefault();
      const profile = profileRows[providerIndex];
      if (profile) {
        if (!profile.disabled) void pickProfile(profile);
        return;
      }
      const row = providerRows[providerIndex - profileRows.length];
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

  const anyMenuOpen = modeOpen || modelOpen || buildMenuOpen || bestOfNOpen;
  const closeAllMenus = useCallback(() => {
    setModeOpen(false);
    if (modelOpen) {
      closeModelPicker(true);
    } else {
      setModelOpen(false);
    }
    setBuildMenuOpen(false);
    setBestOfNOpen(false);
  }, [modelOpen, closeModelPicker]);
  useEscapeClose(anyMenuOpen, closeAllMenus);

  const popupOpen = anyMenuOpen || mentionOpen || commandOpen || manageOpen;
  useEffect(() => {
    if (disabled) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat) return;
      if (e.defaultPrevented) return;
      // Mention / command / pill menus own Esc; do not stop or rewind.
      if (popupOpen) return;
      if (escapeConsumedByChrome(e.target, textareaRef.current)) return;

      if (busy && onStopRun) {
        e.preventDefault();
        lastEscAt.current = 0;
        void onStopRun();
        return;
      }

      if (!busy && onSlashAction) {
        const now = Date.now();
        if (now - lastEscAt.current < DOUBLE_ESC_MS) {
          lastEscAt.current = 0;
          e.preventDefault();
          onSlashAction("rewind");
        } else {
          lastEscAt.current = now;
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [disabled, busy, popupOpen, onStopRun, onSlashAction]);

  const runAction = async (
    action: (prompt: string) => void | Promise<void>,
    failLabel: string,
  ) => {
    const prompt = readDraft().trim();
    if (!prompt || disabled || sending) return;
    setSending(true);
    setLocalError(null);
    try {
      await action(prompt);
      writeDraft("");
      clearAttachments();
      closeMention();
      closeCommand();
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
    void runAction(async (prompt) => {
      // Delegation command: "@provider task" forks onto that provider instead
      // of sending to this thread (parseDelegate returns null for @file
      // mentions and unknown ids, so those keep the normal path).
      const delegation = onDelegate
        ? parseDelegate(
            prompt,
            installedProviders.map((p) => p.id),
          )
        : null;
      if (delegation && onDelegate) {
        await onDelegate(delegation.provider, delegation.task);
        return;
      }
      await onSend(prompt, attachments.length ? attachments : undefined);
    }, "Failed to start run");
  };

  const submitBtw = () => {
    if (!canSend) return;
    void runAction(async (prompt) => {
      const body = asBtwPrompt(prompt);
      if (!body) return;
      await onSend(body);
    }, "Failed to ask");
  };

  const submitBuild = () => {
    if (!canBuild) return;
    setBuildMenuOpen(false);
    void runAction(
      (prompt) => onBuild(prompt, templateId),
      "Failed to start workflow",
    );
  };

  const installedProviders = providers.filter((p) => p.available);
  const canBestOfN = Boolean(onBestOfN) && !busy && canSend;
  const toggleBestId = (id: string) => {
    setBestIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const submitBestOfN = () => {
    if (!canBestOfN || !onBestOfN) return;
    const availableIds = installedProviders.map((p) => p.id);
    const plan = buildBestOfNEntries(availableIds, bestIds, agentProfiles);
    if (typeof plan === "string") {
      setLocalError(plan);
      return;
    }
    void runAction(async (prompt) => {
      await onBestOfN(
        plan.map((e) => e.id),
        prompt,
      );
      setBestOfNOpen(false);
    }, "Failed to start Best of N");
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
    if (commandOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCommandIndex((i) => Math.min(i + 1, commandMatches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCommandIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const cmd = commandMatches[commandIndex];
        if (cmd) acceptCommand(cmd);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Same as mention: only this popup closes, not the pill popovers.
        e.stopPropagation();
        commandDismissed.current = true;
        closeCommand();
        return;
      }
    }
    // Ctrl+C interrupts a live turn when nothing is selected so copy still
    // works on a highlighted draft. Cmd+C is left to the platform copy chord.
    if (
      busy &&
      onStopRun &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      (e.key === "c" || e.key === "C")
    ) {
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd) return;
      e.preventDefault();
      void onStopRun();
      return;
    }
    if (
      e.altKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      e.key === "Enter"
    ) {
      e.preventDefault();
      submitBtw();
      return;
    }
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && e.key === "Enter") {
      e.preventDefault();
      submitSend();
    }
  };

  const dismiss = () => {
    setLocalError(null);
    onDismissError?.();
  };

  const pickAttachments = () => {
    if (!onPickAttachments || disabled || sending) return;
    onPickAttachments()
      .then(addAttachments)
      .catch((err) => {
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "Failed to attach";
        setLocalError(msg);
      });
  };

  /** Clipboard images become saved attachments; text pastes untouched. */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onSaveAttachmentImage || disabled || sending) return;
    const items = Array.from(e.clipboardData?.items ?? []).filter(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (items.length === 0) return;
    e.preventDefault();
    for (const item of items) {
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        if (!dataUrl) return;
        onSaveAttachmentImage(dataUrl)
          .then((attachment) => {
            if (attachment) addAttachments([attachment]);
          })
          .catch(() => {});
      };
      reader.readAsDataURL(blob);
    }
  };

  const acceptDroppedFiles = useCallback(
    async (files: File[]) => {
      if (!onDropAttachmentFiles || disabled || sending) return;
      try {
        const items = await onDropAttachmentFiles(files);
        if (items.length) {
          addAttachments(items);
          setLocalError(null);
        } else {
          setLocalError(DROP_REJECT_MESSAGE);
        }
      } catch (err) {
        const msg =
          err instanceof Error && err.message
            ? err.message
            : DROP_REJECT_MESSAGE;
        setLocalError(msg);
      }
    },
    [onDropAttachmentFiles, disabled, sending, addAttachments],
  );

  const composerRef = useRef<HTMLDivElement>(null);
  const dropTargetRef = dropHostRef ?? composerRef;
  const fileDrag = useFileDrop(dropTargetRef, {
    enabled: Boolean(onDropAttachmentFiles) && !disabled && !sending,
    onFiles: acceptDroppedFiles,
    onDraggingChange: onFileDragChange,
  });

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

  const pickProfile = async (row: ProfileRow) => {
    if (row.disabled) return;
    closeModelPicker(true);
    try {
      // setProvider clears effort on a harness switch; effort then permission.
      await onSetProvider({ provider: row.provider, model: row.model });
      await onSetReasoningEffort(row.reasoningEffort);
      await onPermissionModeChange(row.permissionMode);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to apply profile";
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
    // A bar sets reasoning on the current thread. It must never change the
    // harness: that used to happen whenever the pointer was on another row.
    if (meterUnavailable) return;
    try {
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
    const at =
      profileRows.length +
      initialProviderIndex(providerRows, drillProvider ?? provider);
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
    <div className={styles.composer} ref={composerRef}>
      {fileDrag && !dropHostRef && (
        <div className={styles.dropOverlay} data-drop-overlay="" aria-hidden>
          {DROP_OVERLAY_MESSAGE}
        </div>
      )}
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
                  // Same overflow box as the slash palette (16+ rows in 240px).
                  // Without this the highlight walks off-screen and the list
                  // looks frozen. Matches the model picker.
                  ref={(el) => {
                    if (i === mentionIndex && el) {
                      el.scrollIntoView({ block: "nearest" });
                    }
                  }}
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
        {commandOpen && (
          <ul
            className={styles.mentionList}
            role="listbox"
            aria-label="Commands"
          >
            {commandMatches.map((cmd, i) => (
              <li key={cmd.name} role="option" aria-selected={i === commandIndex}>
                <button
                  type="button"
                  className={styles.mentionRow}
                  // 16 slash rows in a 240px box. Arrow keys only bump
                  // commandIndex; without this the highlight walks off-screen
                  // and the palette looks frozen. Matches the model picker.
                  ref={(el) => {
                    if (i === commandIndex && el) {
                      el.scrollIntoView({ block: "nearest" });
                    }
                  }}
                  data-highlighted={i === commandIndex ? "true" : undefined}
                  onMouseEnter={() => setCommandIndex(i)}
                  onClick={() => acceptCommand(cmd)}
                >
                  <span className={styles.providerRowText}>
                    <span className={styles.modelRowLabel}>{cmd.name}</span>
                    <span className={styles.modelRowVendor}>{cmd.hint}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {attachments.length > 0 && (
          <div className={styles.attachmentRow} aria-label="Attachments">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.path}
                attachment={a}
                onRemove={() => removeAttachment(a.path)}
                onLoadImage={onLoadAttachmentImage}
              />
            ))}
          </div>
        )}
        <textarea
          key={threadId}
          ref={textareaRef}
          className={styles.textarea}
          placeholder={placeholder}
          rows={3}
          defaultValue={draftsRef.current[threadId] ?? ""}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(e) => {
            commandDismissed.current = false;
            rememberDraft(e.target.value);
            refreshMention();
            refreshCommand();
          }}
          onSelect={() => {
            refreshMention();
            refreshCommand();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={disabled || sending}
        />
        <div className={styles.controls}>
          <div className={styles.pills}>
            {onPickAttachments && !ask && (
              <button
                type="button"
                className={styles.pill}
                disabled={disabled || sending}
                aria-disabled={disabled || sending ? "true" : undefined}
                aria-label="Attach files or folders"
                title="Attach files or folders"
                onClick={pickAttachments}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m12.5 7.5-4.95 4.95a3.5 3.5 0 0 1-4.95-4.95l5.3-5.3a2.33 2.33 0 0 1 3.3 3.3l-5.3 5.3a1.17 1.17 0 0 1-1.65-1.65l4.6-4.6" />
                </svg>
              </button>
            )}
            <div className={styles.modeWrap} ref={modelWrapRef}>
              <button
                ref={modelTriggerRef}
                type="button"
                className={styles.pill}
                disabled={locked}
                aria-disabled={locked ? "true" : undefined}
                aria-haspopup="dialog"
                aria-expanded={modelOpen}
                aria-controls={modelOpen ? modelListId : undefined}
                aria-label={`Model: ${triggerLabel}`}
                title={`Model: ${triggerLabel}`}
                onClick={() => {
                  if (locked) return;
                  if (modelOpen) {
                    closeModelPicker(false);
                  } else {
                    setModelOpen(true);
                    setModeOpen(false);
                    setBuildMenuOpen(false);
                    setBestOfNOpen(false);
                    // Providers were fetched once at boot; re-check so a CLI
                    // installed mid-session does not show "not installed".
                    onModelPickerOpen?.();
                  }
                }}
              >
                <span className={styles.modelIcon} aria-hidden="true">
                  {/* Hidden legacy glyph: picker tests locate model rows by a
                      textContent prefix, so this trigger's text must not start
                      with the model label. The visible icon is the SVG. */}
                  <span className={styles.legacyGlyph}>◇</span>
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M8 2 9.6 6.4 14 8 9.6 9.6 8 14 6.4 9.6 2 8l4.4-1.6Z" />
                  </svg>
                </span>
                {/* Keyed so a model swap replays the pop instead of swapping
                    text mid-frame. */}
                <span key={triggerLabel} className={styles.pillLabel}>
                  {triggerLabel}
                </span>
                <span className={styles.caret}>
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 3.5 5 6l2.5-2.5" />
                  </svg>
                </span>
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
                        {profileRows.map((row, index) => (
                          <li
                            key={`profile:${row.id}`}
                            role="option"
                            aria-selected={false}
                          >
                            {index === 0 ? (
                              <div
                                className={styles.modelGroupHeading}
                                aria-hidden="true"
                              >
                                Profiles
                              </div>
                            ) : null}
                            <button
                              type="button"
                              className={styles.providerRow}
                              data-highlighted={
                                index === providerIndex ? "true" : undefined
                              }
                              data-disabled={row.disabled ? "true" : undefined}
                              disabled={row.disabled}
                              title={row.disabledReason ?? undefined}
                              aria-label={`Profile ${row.name}`}
                              onMouseEnter={() => setProviderIndex(index)}
                              onClick={() => void pickProfile(row)}
                            >
                              <span className={styles.providerRowText}>
                                <span className={styles.modelRowLabel}>
                                  {row.name}
                                </span>
                                <span className={styles.modelRowVendor}>
                                  {row.summary}
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                        {providerRows.map((row, index) => (
                          <li key={row.id} role="option" aria-selected={row.current}>
                            <button
                              type="button"
                              className={styles.providerRow}
                              data-selected={row.current ? "true" : undefined}
                              data-highlighted={
                                index + profileRows.length === providerIndex
                                  ? "true"
                                  : undefined
                              }
                              data-disabled={row.disabled ? "true" : undefined}
                              disabled={row.disabled}
                              title={row.disabledReason ?? undefined}
                              aria-label={`Provider ${row.name}`}
                              onMouseEnter={() =>
                                setProviderIndex(index + profileRows.length)
                              }
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
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 10 10"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M3.5 2 6.5 5 3.5 8" />
                                </svg>
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
                        remounts the pane and replays the detailIn fade.
                        The reasoning meter lives outside this key: it
                        belongs to the thread, not the hover. */}
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
                    </div>
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
                                reasoningEffort === seg.level
                                  ? "true"
                                  : "false"
                              }
                              disabled={meterUnavailable}
                              onClick={() => void pickEffort(seg.level)}
                            >
                              <span
                                className={styles.effortBar}
                                aria-hidden="true"
                              />
                              <span
                                className={styles.effortCaption}
                                aria-hidden="true"
                              >
                                {effortDisplayLabel(seg.level)}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {!ask && (
            <div className={styles.modeWrap} ref={modeWrapRef}>
              <button
                type="button"
                className={styles.pill}
                disabled={locked}
                aria-disabled={locked ? "true" : undefined}
                aria-haspopup="listbox"
                aria-expanded={modeOpen}
                onClick={() => {
                  if (!locked) {
                    setModeOpen((v) => !v);
                    setModelOpen(false);
                    setBuildMenuOpen(false);
                    setBestOfNOpen(false);
                  }
                }}
              >
                {PERMISSION_MODE_LABELS[permissionMode]}
                <span className={styles.caret}>
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 3.5 5 6l2.5-2.5" />
                  </svg>
                </span>
              </button>
              {modeOpen && (
                <ul
                  className={styles.modeMenu}
                  role="listbox"
                  aria-label="Permission mode"
                >
                  {PERMISSION_MODES.map((mode) => {
                    const gated = !teachPermissionAllowed(mode, teach);
                    return (
                      <li
                        key={mode}
                        role="option"
                        aria-selected={mode === permissionMode}
                      >
                        <button
                          type="button"
                          className={styles.modeOption}
                          data-active={mode === permissionMode}
                          data-teach-gated={gated ? "true" : undefined}
                          disabled={gated}
                          title={
                            gated
                              ? `Teach mode (${teach?.autonomy ?? "hint"}) does not allow this yet`
                              : undefined
                          }
                          onClick={() => void pickMode(mode)}
                        >
                          {PERMISSION_MODE_LABELS[mode]}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            )}

            {!ask && (
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
                disabled={locked || sending}
                aria-disabled={locked || sending ? "true" : undefined}
                onClick={() => {
                  if (locked || sending) return;
                  setBuildMenuOpen((v) => !v);
                  setModeOpen(false);
                  setModelOpen(false);
                  setBestOfNOpen(false);
                }}
              >
                <span className={styles.caret}>
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 3.5 5 6l2.5-2.5" />
                  </svg>
                </span>
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
            )}

            {onBestOfN && !ask && (
              <div className={styles.bestOfNWrap} ref={bestOfNWrapRef}>
                <button
                  type="button"
                  className={styles.pill}
                  disabled={!canBestOfN}
                  aria-disabled={!canBestOfN ? "true" : undefined}
                  aria-haspopup="dialog"
                  aria-expanded={bestOfNOpen}
                  aria-label="Best of N"
                  title="Run this prompt on multiple providers at once"
                  data-best-of-n=""
                  onClick={() => {
                    if (!canBestOfN) return;
                    setBestOfNOpen((v) => !v);
                    setModeOpen(false);
                    setModelOpen(false);
                    setBuildMenuOpen(false);
                  }}
                >
                  Best of N
                  <span className={styles.caret}>
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M2.5 3.5 5 6l2.5-2.5" />
                    </svg>
                  </span>
                </button>
                {bestOfNOpen && (
                  <div
                    className={styles.bestOfNPopover}
                    role="dialog"
                    aria-label="Best of N"
                    data-best-of-n-popover=""
                  >
                    <p className={styles.bestOfNHint}>
                      Each selection forks a new thread
                    </p>
                    <ul className={styles.bestOfNList}>
                      {profileRows.map((row, index) => {
                        const checked = bestIds.includes(row.id);
                        return (
                          <li key={`profile:${row.id}`}>
                            {index === 0 ? (
                              <div
                                className={styles.modelGroupHeading}
                                aria-hidden="true"
                              >
                                Profiles
                              </div>
                            ) : null}
                            <label
                              className={styles.bestOfNRow}
                              title={row.disabledReason ?? undefined}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={row.disabled}
                                data-best-of-n-profile={row.id}
                                onChange={() => toggleBestId(row.id)}
                              />
                              <span className={styles.bestOfNRowText}>
                                <span className={styles.modelRowLabel}>
                                  {row.name}
                                </span>
                                <span className={styles.modelRowVendor}>
                                  {row.summary}
                                </span>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                      {installedProviders.map((p) => {
                        const vendor = providerVendor(p);
                        const checked = bestIds.includes(p.id);
                        return (
                          <li key={p.id}>
                            <label className={styles.bestOfNRow}>
                              <input
                                type="checkbox"
                                checked={checked}
                                data-best-of-n-provider={p.id}
                                onChange={() => toggleBestId(p.id)}
                              />
                              <span className={styles.bestOfNRowText}>
                                <span className={styles.modelRowLabel}>
                                  {p.name}
                                </span>
                                {vendor ? (
                                  <span className={styles.modelRowVendor}>
                                    {vendor}
                                  </span>
                                ) : null}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    <button
                      type="button"
                      className={styles.bestOfNRun}
                      disabled={bestIds.length < 2 || sending}
                      aria-disabled={
                        bestIds.length < 2 || sending ? "true" : undefined
                      }
                      data-best-of-n-run=""
                      onClick={() => submitBestOfN()}
                    >
                      Run
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className={styles.send}
            aria-label="Send"
            disabled={!canSend}
            data-queues={busy ? "" : undefined}
            title={
              busy
                ? "Queue for when this run lands (⌘Enter). ⌥Enter asks a side question."
                : "Send (⌘Enter). ⌥Enter asks a side question."
            }
            onClick={() => submitSend()}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 13V3M4 7l4-4 4 4" />
            </svg>
          </button>
        </div>
        <div className={styles.meta}>
          {shortSess && (
            <span className={`${styles.chip} ${styles.chipMono}`}>
              {shortSess}
            </span>
          )}
          <span className={styles.chip}>
            <svg
              className={styles.chipIcon}
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {hasWorktree ? (
                <>
                  <circle cx="4.5" cy="3.5" r="1.5" />
                  <circle cx="4.5" cy="12.5" r="1.5" />
                  <circle cx="11.5" cy="5.5" r="1.5" />
                  <path d="M4.5 5v6M11.5 7c0 2.2-2.8 2.3-4.6 3.4" />
                </>
              ) : (
                <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h2.2a1.5 1.5 0 0 1 1.1.5l.8 1a1.5 1.5 0 0 0 1.1.5H12A1.5 1.5 0 0 1 13.5 6v5A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V4Z" />
              )}
            </svg>
            {hasWorktree ? "Worktree" : "Project"}
          </span>
          {branch != null && branch !== "" && (
            <span className={`${styles.chip} ${styles.chipMono}`}>
              <svg
                className={styles.chipIcon}
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="4.5" cy="3.5" r="1.5" />
                <circle cx="4.5" cy="12.5" r="1.5" />
                <circle cx="11.5" cy="5.5" r="1.5" />
                <path d="M4.5 5v6M11.5 7c0 2.2-2.8 2.3-4.6 3.4" />
              </svg>
              {branch}
            </span>
          )}
        </div>
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
});
