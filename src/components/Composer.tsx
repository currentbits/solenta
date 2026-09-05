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
  CoderApi,
  PermissionMode,
  ProviderInfo,
  ReasoningEffort,
  SpeechStatus,
  WorkflowTemplateInfo,
} from "../shared/ipc";
import type { WorkflowSaveInput } from "../useCoder";
import {
  PERMISSION_MODE_LABELS,
  permissionModeHonoured,
  permissionPickerModes,
  providerDisplayName,
  providerPermissionModes,
  shortSessionId,
  snapToHonouredPermissionMode,
} from "../format";
import {
  buildModelRows,
  buildUnifiedModelRows,
  clampHighlightIndex,
  detailModelRow,
  filterModelRows,
  CUSTOM_MODEL_ID,
  buildProfileRows,
  buildProviderRows,
  effortDisplayLabel,
  effortHint,
  effortsForModel,
  providerDetail,
  effortOptions,
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
import { ProviderMark } from "./ProviderMark";
import { applyMention, getMentionQuery, type MentionQuery } from "../mention";
import { ArchiveToast } from "./ArchiveToast";
import { ProviderMark } from "./ProviderMark";
import type { ReplyTarget } from "../replyContext";
import { excerptReply, wrapReplyContext } from "../replyContext";
import {
  composePastePrompt,
  formatOverflow,
  makePasteCard,
  overflowWarn,
  pasteCardLabel,
  payloadChars,
  shouldCollapsePaste,
  type PasteCard,
} from "../pasteCards";
import {
  popStash,
  pushStash,
  stashIsEmpty,
  undoStash,
  type StashEntry,
} from "../promptStash";
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
import { scrollChildIntoNearestView } from "../scrollNearest";
import { teachPermissionAllowed } from "../teach";
import type { ThreadTeach } from "../shared/ipc";
import { useFileDrop } from "../useFileDrop";
import {
  cycleTranscriptViewMode,
  TRANSCRIPT_VIEW_HINTS,
  TRANSCRIPT_VIEW_LABELS,
  TRANSCRIPT_VIEW_MODES,
  type TranscriptViewMode,
} from "../focusView";
import {
  getLastReasoningEffort,
  getPasteCardsEnabled,
  getTranscriptViewMode,
  setLastReasoningEffort,
  setTranscriptViewMode,
  useComposerVimEnabled,
  useTranscriptViewMode,
} from "../uiPrefs";
import {
  INITIAL_VIM,
  applyComposerVim,
  type VimState,
} from "../composerVim";
import {
  applySpeechDelta,
  applySpeechTranscript,
  formatSpeechModelSize,
} from "../speechDraft";
import {
  speechCaptureError,
  startSpeechCapture,
  type SpeechCapture,
} from "../speechCapture";
import styles from "./Composer.module.css";

function coderSpeech(): CoderApi["speech"] | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { coder?: CoderApi }).coder?.speech;
}

function coderOn(): CoderApi["on"] | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { coder?: CoderApi }).coder?.on;
}

type SpeechSnapshot = {
  threadId: string;
  draft: string;
  caret: number;
  prefix: string;
  suffix: string;
  accumulated: string;
  sessionId: string;
};

function speechMicLabel(
  status: SpeechStatus | null,
  dictating: boolean,
): string {
  if (dictating) return "Stop dictation";
  if (status?.state === "downloading") {
    const d = status.download;
    if (d && d.bytesTotal > 0) {
      const pct = Math.round((100 * d.bytesReceived) / d.bytesTotal);
      return `Downloading speech model, ${pct}%`;
    }
    return "Downloading speech model";
  }
  if (!status || status.state === "missing") return "Download speech model";
  if (status.state === "error" && !status.modelReady) {
    return "Download speech model";
  }
  return "Start dictation";
}

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
  /** Codex live web search (`--search`). Hidden unless the provider advertises it. */
  webSearch?: boolean;
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
  onSetWebSearch?: (webSearch: boolean) => void | Promise<void>;
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
  /**
   * Text pushed back toward the draft from outside (a cancelled queued
   * follow-up, issue #364). Applied at most once, and only onto an EMPTY
   * draft — never clobbers an in-progress one.
   */
  restoreDraft?: { threadId: string; text: string } | null;
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
   * Native folder picker for the mention popup's "Browse folder" row.
   * Returns a repo-relative token (trailing slash) or null if cancelled.
   */
  onPickMentionFolder?: () => Promise<string | null>;
  /** Quote one agent message as bounded context on the next send. */
  replyTo?: ReplyTarget | null;
  onClearReply?: () => void;
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
   * Attachments arriving from outside the composer (Browser pane screenshot,
   * issue #155). Consumed into the pending chips, then onIncomingAttachmentsConsumed.
   */
  incomingAttachments?: AttachmentInfo[];
  onIncomingAttachmentsConsumed?: () => void;
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
  webSearch = false,
  providers,
  agentProfiles = [],
  workflows,
  onSetProvider,
  onSetReasoningEffort,
  onSetWebSearch,
  onSaveWorkflow,
  onRemoveWorkflow,
  sessionId,
  hasWorktree,
  disabled = false,
  busy = false,
  onSend,
  restoreDraft = null,
  onBuild,
  onBestOfN,
  ask = false,
  onDelegate,
  onModelPickerOpen,
  placeholder = "Ask anything, @tag files/folders, @provider delegates, $use skills, or / for commands",
  error = null,
  onDismissError,
  onListFiles,
  onPickMentionFolder,
  replyTo = null,
  onClearReply,
  onPickAttachments,
  onSaveAttachmentImage,
  onLoadAttachmentImage,
  onDropAttachmentFiles,
  incomingAttachments,
  onIncomingAttachmentsConsumed,
  onSlashAction,
  cliCommands,
  onStopRun,
  dropHostRef,
  onFileDragChange,
}: ComposerProps) {
  const transcriptView = useTranscriptViewMode();
  const vimEnabled = useComposerVimEnabled();
  const [vimMode, setVimMode] = useState(INITIAL_VIM.mode);
  const vimStateRef = useRef<VimState>(INITIAL_VIM);
  useEffect(() => {
    vimStateRef.current = INITIAL_VIM;
    setVimMode(INITIAL_VIM.mode);
  }, [threadId, vimEnabled]);
  const [viewOpen, setViewOpen] = useState(false);
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
  const overflowRef = useRef<HTMLDivElement>(null);
  const pasteCardsRef = useRef<PasteCard[]>([]);
  const syncOverflow = useCallback((draft: string) => {
    const el = overflowRef.current;
    if (!el) return;
    const cards = pasteCardsRef.current;
    const used = payloadChars(draft, cards);
    const show = used >= 8_000 || cards.length > 0;
    el.hidden = !show;
    el.textContent = show ? formatOverflow(used) : "";
    el.classList.toggle(styles.overflowWarn, overflowWarn(used));
  }, []);
  const [hasPrompt, setHasPrompt] = useState(false);
  const syncHasPrompt = useCallback((text: string) => {
    const next = text.trim().length > 0;
    setHasPrompt((prev) => (prev === next ? prev : next));
  }, []);
  const rememberDraft = useCallback(
    (text: string) => {
      draftsRef.current[threadId] = text;
      syncHasPrompt(text);
      syncOverflow(text);
    },
    [threadId, syncHasPrompt, syncOverflow],
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
      syncOverflow(text);
    },
    [threadId, syncHasPrompt, syncOverflow],
  );
  const readDraft = useCallback(
    () => textareaRef.current?.value ?? draftsRef.current[threadId] ?? "",
    [threadId],
  );
  const liveThreadIdRef = useRef(threadId);
  liveThreadIdRef.current = threadId;
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const hasSpeech = Boolean(coderSpeech());
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [speechConfirm, setSpeechConfirm] = useState(false);
  const [dictating, setDictating] = useState(false);
  const snapshotRef = useRef<SpeechSnapshot | null>(null);
  const captureRef = useRef<SpeechCapture | null>(null);
  const dictatingRef = useRef(false);
  const writeDraftFor = useCallback(
    (tid: string, text: string, caret?: number) => {
      draftsRef.current[tid] = text;
      if (liveThreadIdRef.current !== tid) return;
      const el = textareaRef.current;
      if (el) {
        el.value = text;
        if (caret != null) {
          el.focus();
          el.setSelectionRange(caret, caret);
        }
      }
      syncHasPrompt(text);
      syncOverflow(text);
    },
    [syncHasPrompt, syncOverflow],
  );
  const cancelDictation = useCallback(async () => {
    if (!snapshotRef.current && !captureRef.current && !dictatingRef.current) {
      return;
    }
    const snap = snapshotRef.current;
    const capture = captureRef.current;
    snapshotRef.current = null;
    captureRef.current = null;
    dictatingRef.current = false;
    setDictating(false);
    setSpeechConfirm(false);
    capture?.close();
    if (snap) writeDraftFor(snap.threadId, snap.draft, snap.caret);
    const api = coderSpeech();
    if (snap?.sessionId && api) {
      try {
        await api.cancel({ sessionId: snap.sessionId });
      } catch {
        // session already gone
      }
    }
  }, [writeDraftFor]);
  const cancelDictationRef = useRef(cancelDictation);
  cancelDictationRef.current = cancelDictation;
  const applySpeechStatus = useCallback(
    (status: SpeechStatus) => {
      setSpeech(status);
      if (status.state === "downloading" || status.state === "ready") {
        setSpeechConfirm(false);
      }
      const snap = snapshotRef.current;
      if (!snap) return;
      if (status.state === "error") {
        void cancelDictationRef.current();
        if (status.error) setLocalError(status.error);
        return;
      }
      if (status.delta) {
        const next = applySpeechDelta({
          prefix: snap.prefix,
          suffix: snap.suffix,
          accumulated: snap.accumulated,
          delta: status.delta,
        });
        snap.accumulated = next.accumulated;
        writeDraftFor(snap.threadId, next.text, next.caret);
      }
      if (status.transcript !== undefined) {
        const next = applySpeechTranscript({
          prefix: snap.prefix,
          suffix: snap.suffix,
          original: snap.draft,
          originalCaret: snap.caret,
          transcript: status.transcript,
        });
        writeDraftFor(snap.threadId, next.text, next.caret);
        snapshotRef.current = null;
        dictatingRef.current = false;
        setDictating(false);
        captureRef.current?.close();
        captureRef.current = null;
      }
    },
    [writeDraftFor],
  );
  useEffect(() => {
    const api = coderSpeech();
    const on = coderOn();
    if (!api || !on) return;
    let live = true;
    void api
      .status()
      .then((s) => {
        if (live) setSpeech(s);
      })
      .catch(() => {});
    const off = on("speech:changed", (s) => {
      if (live) applySpeechStatus(s);
    });
    return () => {
      live = false;
      off();
    };
  }, [applySpeechStatus]);
  useEffect(() => {
    if (disabled) void cancelDictationRef.current();
  }, [disabled]);
  const startDictation = useCallback(async () => {
    const api = coderSpeech();
    if (!api || dictatingRef.current || disabled) return;
    setSpeechConfirm(false);
    const el = textareaRef.current;
    const draft = readDraft();
    const caret = el?.selectionStart ?? draft.length;
    snapshotRef.current = {
      threadId,
      draft,
      caret,
      prefix: draft.slice(0, caret),
      suffix: draft.slice(caret),
      accumulated: "",
      sessionId: "",
    };
    dictatingRef.current = true;
    setDictating(true);
    try {
      const capture = await startSpeechCapture({
        write: (pcm, seq) => {
          const id = snapshotRef.current?.sessionId;
          if (!id) return;
          return api.write({ sessionId: id, pcm, seq });
        },
      });
      if (!snapshotRef.current) {
        capture.close();
        return;
      }
      captureRef.current = capture;
      const started = await api.start();
      if (!snapshotRef.current) {
        capture.close();
        captureRef.current = null;
        try {
          await api.cancel({ sessionId: started.sessionId });
        } catch {
          // already cancelled
        }
        return;
      }
      snapshotRef.current.sessionId = started.sessionId;
    } catch (err) {
      captureRef.current?.close();
      captureRef.current = null;
      const snap = snapshotRef.current;
      snapshotRef.current = null;
      dictatingRef.current = false;
      setDictating(false);
      if (snap) writeDraftFor(snap.threadId, snap.draft, snap.caret);
      setLocalError(speechCaptureError(err));
    }
  }, [disabled, readDraft, threadId, writeDraftFor]);
  const stopDictation = useCallback(async () => {
    const snap = snapshotRef.current;
    const api = coderSpeech();
    if (!snap || !api) return;
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) await capture.flushAndStop();
    try {
      if (snap.sessionId) await api.stop({ sessionId: snap.sessionId });
    } catch (err) {
      await cancelDictation();
      setLocalError(speechCaptureError(err));
    }
  }, [cancelDictation]);
  const onMicClick = useCallback(() => {
    if (disabled || sending) return;
    if (dictatingRef.current) {
      void stopDictation();
      return;
    }
    const state = speech?.state ?? "missing";
    if (state === "downloading") return;
    if (state === "ready" || state === "recording") {
      void startDictation();
      return;
    }
    if (state === "missing" || (state === "error" && !speech?.modelReady)) {
      setSpeechConfirm(true);
    }
  }, [disabled, sending, speech, startDictation, stopDictation]);
  const confirmSpeechDownload = useCallback(() => {
    const api = coderSpeech();
    if (!api) return;
    setSpeechConfirm(false);
    void api.download().catch((err) => {
      setLocalError(speechCaptureError(err));
    });
  }, []);
  /**
   * A cancelled queued follow-up lands here (issue #364): put its text back
   * into the draft, but only onto an empty one — an in-progress draft always
   * wins. Applied at most once per restore payload.
   */
  const appliedRestoreRef = useRef<ComposerProps["restoreDraft"]>(null);
  useEffect(() => {
    if (!restoreDraft || restoreDraft === appliedRestoreRef.current) return;
    appliedRestoreRef.current = restoreDraft;
    if (restoreDraft.threadId !== threadId) return;
    if (readDraft().trim()) return;
    writeDraft(restoreDraft.text, restoreDraft.text.length);
  }, [restoreDraft, threadId, readDraft, writeDraft]);
  /**
   * Keyboard hints show only while the textarea is focused (issue #364).
   * Toggled by direct DOM mutation, not state: the field is uncontrolled so
   * that typing never re-renders the picker chrome (#654), and a focus
   * setState would add a render to that same hot path.
   */
  const hintsRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    if (!incomingAttachments?.length) return;
    addAttachments(incomingAttachments);
    onIncomingAttachmentsConsumed?.();
  }, [incomingAttachments, addAttachments, onIncomingAttachmentsConsumed]);
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
  const [pasteCardsByThread, setPasteCardsByThread] = useState<
    Record<string, PasteCard[]>
  >({});
  const [expandedCardIds, setExpandedCardIds] = useState<
    Record<string, boolean>
  >({});
  const pasteCards = pasteCardsByThread[threadId] ?? [];
  pasteCardsRef.current = pasteCards;
  useEffect(() => {
    syncOverflow(readDraft());
  }, [pasteCards, threadId, syncOverflow, readDraft]);
  const addPasteCard = useCallback(
    (card: PasteCard) => {
      setPasteCardsByThread((prev) => ({
        ...prev,
        [threadId]: [...(prev[threadId] ?? []), card],
      }));
    },
    [threadId],
  );
  const removePasteCard = useCallback(
    (id: string) =>
      setPasteCardsByThread((prev) => ({
        ...prev,
        [threadId]: (prev[threadId] ?? []).filter((c) => c.id !== id),
      })),
    [threadId],
  );
  const clearPasteCards = useCallback(
    () =>
      setPasteCardsByThread((prev) =>
        (prev[threadId] ?? []).length ? { ...prev, [threadId]: [] } : prev,
      ),
    [threadId],
  );
  const [stashToast, setStashToast] = useState<"stashed" | "restored" | null>(
    null,
  );
  const [modeOpen, setModeOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
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
  /** Type-in filter for the drilled-in model list. Empty on the provider screen. */
  const [modelQuery, setModelQuery] = useState("");
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
  const effortWrapRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLUListElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
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
  const mentionOpen =
    mention != null &&
    (mentionFiles.length > 0 || Boolean(onPickMentionFolder));

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
      if (action === "model") {
        if (disabled || busy) return;
        setModelOpen(true);
        setModeOpen(false);
        setEffortOpen(false);
        setBuildMenuOpen(false);
        setBestOfNOpen(false);
        onModelPickerOpen?.();
        return;
      }
      if (action === "effort") {
        if (disabled || busy) return;
        setEffortOpen(true);
        setModelOpen(false);
        setModeOpen(false);
        setBuildMenuOpen(false);
        setBestOfNOpen(false);
        return;
      }
      if (action === "permissions") {
        if (disabled || busy) return;
        setModeOpen(true);
        setModelOpen(false);
        setEffortOpen(false);
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
    return () => {
      void cancelDictationRef.current();
    };
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

  const browseMentionFolder = useCallback(() => {
    if (!onPickMentionFolder || disabled) return;
    void onPickMentionFolder()
      .then((path) => {
        if (path) acceptMention(path);
      })
      .catch((err) => {
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "Failed to pick folder";
        setLocalError(msg);
      });
  }, [onPickMentionFolder, disabled, acceptMention]);

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

  const canSend =
    !disabled && !sending && (hasPrompt || pasteCards.length > 0);
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
  const catalogRows = drillInfo
    ? buildModelRows(drillInfo)
    : buildUnifiedModelRows(providers, provider, sessionLocked, providerName);
  const modelRows = drillProvider
    ? filterModelRows(catalogRows, modelQuery)
    : catalogRows;
  const triggerLabel = modelTriggerLabel(model, currentProviderInfo);
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
  const catalogNote = providers.find((p) => p.id === detail.providerId)
    ?.catalogNote;
  // The effort pill follows the selected model: a per-model list when the
  // catalog publishes one, otherwise the provider list. It does not follow
  // the highlighted picker row.
  const efforts = effortsForModel(currentProviderInfo, model);
  const reasoningVisible = showReasoningControl(efforts);
  const effortUnavailable = currentProviderInfo?.available === false;
  const effortLabel = effortDisplayLabel(reasoningEffort);
  const honouredModes = providerPermissionModes(currentProviderInfo);
  const currentModeHonoured = permissionModeHonoured(
    permissionMode,
    currentProviderInfo,
  );
  const pickerModes = permissionPickerModes(permissionMode, honouredModes);
  const permissionName = currentProviderInfo?.name ?? "This CLI";
  const modeChoiceLocked =
    honouredModes.length <= 1 && currentModeHonoured;
  const permissionTitle = !currentModeHonoured
    ? `${permissionName} cannot honor ${PERMISSION_MODE_LABELS[permissionMode]} — pick a mode this CLI actually sends`
    : modeChoiceLocked
      ? `${permissionName} always runs tools unprompted`
      : undefined;

  useEffect(() => {
    if (!modeOpen && !modelOpen && !effortOpen && !buildMenuOpen && !bestOfNOpen)
      return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (modeOpen && !modeWrapRef.current?.contains(t)) {
        setModeOpen(false);
      }
      if (modelOpen && !modelWrapRef.current?.contains(t)) {
        setModelOpen(false);
      }
      if (effortOpen && !effortWrapRef.current?.contains(t)) {
        setEffortOpen(false);
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
  }, [modeOpen, modelOpen, effortOpen, buildMenuOpen, bestOfNOpen]);

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
    setModelQuery("");
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
      if (drillProvider) {
        (modelSearchRef.current ?? modelListRef.current)?.focus();
      } else {
        providerListRef.current?.focus();
      }
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

  // A new query is a new list: land on the selected model if it still
  // matches, otherwise the first selectable hit.
  useEffect(() => {
    if (!modelOpen || !drillProvider) return;
    setHighlightIndex(initialHighlightIndex(modelRows, provider, model));
    // modelRows is rebuilt each render; only the query edge needs a reseed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelQuery]);

  /** Enter a provider's models, seeding the highlight on its selected row. */
  const enterProvider = (id: string) => {
    setModelQuery("");
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

  const anyMenuOpen =
    modeOpen ||
    modelOpen ||
    effortOpen ||
    buildMenuOpen ||
    bestOfNOpen ||
    viewOpen;
  const closeAllMenus = useCallback(() => {
    setModeOpen(false);
    setEffortOpen(false);
    if (modelOpen) {
      closeModelPicker(true);
    } else {
      setModelOpen(false);
    }
    setBuildMenuOpen(false);
    setBestOfNOpen(false);
    setViewOpen(false);
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

      if (snapshotRef.current) {
        e.preventDefault();
        lastEscAt.current = 0;
        void cancelDictationRef.current();
        return;
      }

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

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const key = e.key.toLowerCase();
      if (
        e.ctrlKey &&
        e.altKey &&
        !e.metaKey &&
        !e.shiftKey &&
        key === "f"
      ) {
        e.preventDefault();
        setTranscriptViewMode(
          getTranscriptViewMode() === "summary" ? "normal" : "summary",
        );
        return;
      }
      if (
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        key === "o"
      ) {
        e.preventDefault();
        setTranscriptViewMode(cycleTranscriptViewMode(getTranscriptViewMode()));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const composeOutgoing = useCallback(
    (draft: string) => {
      let body = composePastePrompt(draft.trim(), pasteCards);
      if (replyTo) body = wrapReplyContext(replyTo.text, body, replyTo.messageId);
      return body;
    },
    [pasteCards, replyTo],
  );

  const runAction = async (
    action: (prompt: string) => void | Promise<void>,
    failLabel: string,
  ) => {
    const prompt = composeOutgoing(readDraft());
    if (!prompt.trim() || disabled || sending) return;
    setSending(true);
    setLocalError(null);
    try {
      await action(prompt);
      writeDraft("");
      clearAttachments();
      clearPasteCards();
      onClearReply?.();
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

  const applyStashEntry = (entry: StashEntry) => {
    writeDraft(entry.text, entry.text.length);
    clearPasteCards();
    clearAttachments();
    if (entry.attachments.length) addAttachments(entry.attachments);
    if (entry.model !== undefined && entry.model !== model) {
      void onSetProvider({ model: entry.model });
    }
    if (
      entry.reasoningEffort !== undefined &&
      entry.reasoningEffort !== reasoningEffort
    ) {
      void onSetReasoningEffort(entry.reasoningEffort);
    }
  };

  const stashCurrent = () => {
    const text = composeOutgoing(readDraft());
    const entry = {
      text,
      attachments,
      model,
      reasoningEffort,
    };
    if (stashIsEmpty(entry) || disabled || sending) return;
    pushStash(provider, entry);
    writeDraft("");
    clearAttachments();
    clearPasteCards();
    onClearReply?.();
    setStashToast("stashed");
  };

  const restoreStash = () => {
    const entry = popStash(provider);
    if (!entry) return;
    applyStashEntry(entry);
    setStashToast("restored");
  };

  const undoLastStash = () => {
    const entry = undoStash(provider);
    setStashToast(null);
    if (!entry) return;
    applyStashEntry(entry);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      if (e.shiftKey) restoreStash();
      else stashCurrent();
      return;
    }
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
      return;
    }
    if (!vimEnabled) return;
    const el = e.currentTarget;
    const result = applyComposerVim(
      vimStateRef.current,
      { text: el.value, cursor: el.selectionStart ?? 0 },
      {
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      },
    );
    vimStateRef.current = result.state;
    if (result.state.mode !== vimMode) setVimMode(result.state.mode);
    if (!result.handled) return;
    e.preventDefault();
    if (result.buffer.text !== el.value) {
      writeDraft(result.buffer.text, result.buffer.cursor);
      refreshMention();
      refreshCommand();
      return;
    }
    el.setSelectionRange(result.buffer.cursor, result.buffer.cursor);
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

  /** Clipboard images become saved attachments; large text pastes become cards. */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || sending) return;
    const items = Array.from(e.clipboardData?.items ?? []).filter(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (items.length > 0 && onSaveAttachmentImage) {
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
      return;
    }
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text || !getPasteCardsEnabled() || !shouldCollapsePaste(text)) return;
    e.preventDefault();
    addPasteCard(makePasteCard(text));
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
      const next = providers.find((p) => p.id === row.provider);
      await onPermissionModeChange(
        snapToHonouredPermissionMode(
          providerPermissionModes(next),
          row.permissionMode,
        ),
      );
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to apply profile";
      setLocalError(msg);
    }
  };

  /**
   * Re-apply the remembered level after a harness switch that dropped it.
   *
   * setProvider (electron/services.js) clears an effort the new harness does
   * not advertise, so claude/Max → codex → claude used to land on Default. It
   * only fires when the OLD harness could not honour the remembered level: a
   * null effort on a harness that CAN honour it is a deliberate Default and
   * must stay one.
   */
  const restoreEffortFor = async (
    nextProviderId: string,
    nextModel: string | null,
  ) => {
    if (reasoningEffort != null) return;
    const want = getLastReasoningEffort();
    if (want == null) return;
    const currentList = effortsForModel(currentProviderInfo, model);
    if (currentList.includes(want)) return;
    const next = providers.find((p) => p.id === nextProviderId);
    if (!effortsForModel(next, nextModel).includes(want)) return;
    await onSetReasoningEffort(want);
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
      await restoreEffortFor(row.providerId, row.id);
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
      await restoreEffortFor(customFor, id);
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

  const toggleWebSearch = async () => {
    if (!onSetWebSearch) return;
    if (locked || currentProviderInfo?.available === false) return;
    try {
      await onSetWebSearch(!webSearch);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to set web search";
      setLocalError(msg);
    }
  };

  const pickEffort = async (level: ReasoningEffort | null) => {
    if (effortUnavailable) return;
    setEffortOpen(false);
    try {
      // Remember the intent even when a later harness switch cannot honour it,
      // so switching back restores the level instead of the provider default.
      setLastReasoningEffort(level);
      await onSetReasoningEffort(level);
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
    setModelQuery("");
    setProviderIndex(at);
    setCustomFor(null);
    // Deliberately NOT re-seeding highlightIndex: the provider level reads
    // providerDetail, and enterProvider re-seeds on every drill-in, so the
    // stale value is never read. Adding a reset here survived its own mutation,
    // which is the signature of a line that looks load-bearing and is not.
  };

  const onModelListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (handleModelNavKey(e, false)) return;
    // A printable key while the list is focused is a search, not a dead key.
    if (
      drillProvider &&
      e.key.length === 1 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      setModelQuery((q) => q + e.key);
      modelSearchRef.current?.focus();
    }
  };

  const onModelSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    handleModelNavKey(e, true);
  };

  /**
   * Shared by the model list and its search field so arrows, Enter, and
   * Escape stay on whichever of the two actually has focus.
   * Returns true when the key was handled (search can then skip type-ahead).
   */
  function handleModelNavKey(
    e: KeyboardEvent<HTMLInputElement | HTMLUListElement>,
    fromSearch: boolean,
  ): boolean {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => stepHighlightIndex(modelRows, i, 1));
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => stepHighlightIndex(modelRows, i, -1));
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = modelRows[clampHighlightIndex(modelRows, highlightIndex)];
      if (row && !row.disabled) void pickRow(row);
      return true;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setHighlightIndex(firstSelectableIndex(modelRows));
      return true;
    }
    if (e.key === "End") {
      e.preventDefault();
      setHighlightIndex(lastSelectableIndex(modelRows));
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Stop this reaching the popover's own Escape handler, or backing out of
      // a provider closes the whole picker instead of stepping up one level.
      e.stopPropagation();
      if (fromSearch && modelQuery.trim()) {
        setModelQuery("");
        return true;
      }
      if (drillProvider) {
        leaveProvider();
        return true;
      }
      closeModelPicker(true);
      return true;
    }
    if (fromSearch) return false;
    if (drillProvider && e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      leaveProvider();
      return true;
    }
    return false;
  }

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
            aria-label="Mention a file or folder"
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
                      scrollChildIntoNearestView(
                        el.closest<HTMLElement>('[role="listbox"]'),
                        el,
                      );
                    }
                  }}
                  data-highlighted={i === mentionIndex ? "true" : undefined}
                  data-mention-kind={f.endsWith("/") ? "folder" : "file"}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => acceptMention(f)}
                >
                  {f}
                </button>
              </li>
            ))}
            {onPickMentionFolder && (
              <li role="option" aria-selected={false}>
                <button
                  type="button"
                  className={styles.mentionRow}
                  data-mention-browse=""
                  onClick={browseMentionFolder}
                >
                  Browse folder…
                </button>
              </li>
            )}
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
                      scrollChildIntoNearestView(
                        el.closest<HTMLElement>('[role="listbox"]'),
                        el,
                      );
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
        {replyTo && (
          <div className={styles.replyChip} data-reply-chip="">
            <span className={styles.replyChipLabel}>Reply</span>
            <span className={styles.replyChipText}>
              {excerptReply(replyTo.text)}
            </span>
            <button
              type="button"
              className={styles.attachmentRemove}
              aria-label="Cancel reply"
              title="Cancel reply"
              onClick={() => onClearReply?.()}
            >
              ×
            </button>
          </div>
        )}
        {pasteCards.length > 0 && (
          <div className={styles.pasteCardList} aria-label="Pasted context">
            {pasteCards.map((card) => {
              const open = Boolean(expandedCardIds[card.id]);
              return (
                <div
                  key={card.id}
                  className={styles.pasteCard}
                  data-paste-card={card.id}
                  data-compressed={card.compressed ? "" : undefined}
                >
                  <div className={styles.pasteCardHead}>
                    <button
                      type="button"
                      className={styles.pasteCardToggle}
                      aria-expanded={open}
                      onClick={() =>
                        setExpandedCardIds((prev) => ({
                          ...prev,
                          [card.id]: !prev[card.id],
                        }))
                      }
                    >
                      <span>{pasteCardLabel(card)}</span>
                      <span className={styles.pasteCardChars}>
                        {card.chars.toLocaleString("en-US")} chars
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.attachmentRemove}
                      aria-label="Remove paste"
                      title="Remove paste"
                      onClick={() => removePasteCard(card.id)}
                    >
                      ×
                    </button>
                  </div>
                  {open && (
                    <pre className={styles.pasteCardBody}>{card.text}</pre>
                  )}
                </div>
              );
            })}
          </div>
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
          onFocus={() => hintsRef.current?.removeAttribute("hidden")}
          onBlur={() => hintsRef.current?.setAttribute("hidden", "")}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={disabled || sending}
          readOnly={dictating}
          data-vim-mode={vimEnabled ? vimMode : undefined}
        />
        <div
          ref={overflowRef}
          className={styles.overflow}
          data-paste-overflow=""
          hidden
        />
        <div ref={hintsRef} className={styles.hints} data-kbd-hints="" hidden>
          {`⌘Enter ${busy ? "queue" : "send"} · ⌥Enter side question · ⌘S stash${busy ? " · Esc stop" : ""}${vimEnabled ? ` · VIM ${vimMode}` : ""}`}
        </div>
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
            {hasSpeech && speech && (
              <>
                <button
                  type="button"
                  className={`${styles.pill}${dictating ? ` ${styles.pillAccent}` : ""}`}
                  data-speech-mic=""
                  disabled={
                    disabled ||
                    sending ||
                    speech.state === "downloading"
                  }
                  aria-disabled={
                    disabled || sending || speech.state === "downloading"
                      ? "true"
                      : undefined
                  }
                  aria-label={speechMicLabel(speech, dictating)}
                  aria-pressed={dictating ? "true" : "false"}
                  title={speechMicLabel(speech, dictating)}
                  onClick={onMicClick}
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
                    <path d="M8 2.5a2.2 2.2 0 0 0-2.2 2.2v3.1a2.2 2.2 0 1 0 4.4 0V4.7A2.2 2.2 0 0 0 8 2.5Z" />
                    <path d="M4.2 8.2a3.8 3.8 0 0 0 7.6 0" />
                    <path d="M8 12v1.8" />
                  </svg>
                  {speech.state === "downloading" && speech.download?.bytesTotal
                    ? `${Math.round((100 * speech.download.bytesReceived) / speech.download.bytesTotal)}%`
                    : null}
                </button>
                {speechConfirm && (
                  <span
                    className={styles.speechConfirm}
                    data-speech-confirm=""
                    role="group"
                    aria-label="Download speech model"
                  >
                    <span>Download {formatSpeechModelSize()}?</span>
                    <button
                      type="button"
                      className={styles.pill}
                      aria-label="Confirm download"
                      onClick={confirmSpeechDownload}
                    >
                      Download
                    </button>
                    <button
                      type="button"
                      className={styles.pill}
                      aria-label="Cancel download"
                      onClick={() => setSpeechConfirm(false)}
                    >
                      Cancel
                    </button>
                  </span>
                )}
              </>
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
                    setEffortOpen(false);
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
                    {drillProvider && !customFor ? (
                      <input
                        ref={modelSearchRef}
                        className={styles.modelSearch}
                        type="search"
                        value={modelQuery}
                        placeholder="Search models"
                        aria-label="Search models"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => setModelQuery(e.target.value)}
                        onKeyDown={onModelSearchKeyDown}
                      />
                    ) : null}
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
                              <ProviderMark
                                providerId={row.provider}
                                providers={providers}
                                size={16}
                                decorative
                                className={styles.providerRowMark}
                              />
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
                              <ProviderMark
                                providerId={row.id}
                                providers={providers}
                                size={16}
                                decorative
                                className={styles.providerRowMark}
                              />
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
                              // affordance. Scroll the list only: scrollIntoView
                              // walks up to .chatSlot and lifts the composer
                              // (#762).
                              ref={(el) => {
                                if (highlighted && el) {
                                  scrollChildIntoNearestView(
                                    modelListRef.current,
                                    el,
                                  );
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
                      {catalogNote ? (
                        <div className={styles.catalogNote} data-catalog-note="">
                          {catalogNote}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {reasoningVisible && (
              <div className={styles.modeWrap} ref={effortWrapRef}>
                <button
                  type="button"
                  className={styles.pill}
                  disabled={locked || effortUnavailable}
                  aria-disabled={
                    locked || effortUnavailable ? "true" : undefined
                  }
                  aria-haspopup="listbox"
                  aria-expanded={effortOpen}
                  aria-label={`Reasoning: ${effortLabel}`}
                  title={
                    effortUnavailable
                      ? "The provider CLI is not installed"
                      : `Reasoning: ${effortLabel}`
                  }
                  onClick={() => {
                    if (locked || effortUnavailable) return;
                    setEffortOpen((v) => !v);
                    setModelOpen(false);
                    setModeOpen(false);
                    setBuildMenuOpen(false);
                    setBestOfNOpen(false);
                  }}
                >
                  <span className={styles.effortIcon} aria-hidden="true">
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
                      <path d="M3 12V9m5 3V5m5 7V7" />
                    </svg>
                  </span>
                  <span key={effortLabel} className={styles.pillLabel}>
                    {effortLabel}
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
                {effortOpen && (
                  <ul
                    className={styles.modeMenu}
                    role="listbox"
                    aria-label="Reasoning effort"
                  >
                    {effortOptions(efforts).map((level) => {
                      const hint = effortHint(level);
                      return (
                      <li
                        key={level ?? "default"}
                        role="option"
                        aria-selected={level === reasoningEffort}
                      >
                        <button
                          type="button"
                          className={styles.modeOption}
                          data-active={level === reasoningEffort}
                          aria-label={
                            hint
                              ? `Reasoning ${effortDisplayLabel(level)}: ${hint}`
                              : `Reasoning ${effortDisplayLabel(level)}`
                          }
                          onClick={() => void pickEffort(level)}
                        >
                          {effortDisplayLabel(level)}
                          {hint ? (
                            <span className={styles.optionHint}> {hint}</span>
                          ) : null}
                        </button>
                      </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {currentProviderInfo?.supportsSearch && onSetWebSearch && (
              <button
                type="button"
                className={
                  webSearch
                    ? `${styles.pill} ${styles.pillAccent}`
                    : styles.pill
                }
                disabled={locked || currentProviderInfo.available === false}
                aria-disabled={
                  locked || currentProviderInfo.available === false
                    ? "true"
                    : undefined
                }
                aria-pressed={webSearch}
                aria-label={webSearch ? "Web search: on" : "Web search: off"}
                title={
                  currentProviderInfo.available === false
                    ? "The provider CLI is not installed"
                    : webSearch
                      ? "Web search on. Codex can query the live web."
                      : "Web search off. Turn on for live docs and API changes."
                }
                onClick={() => {
                  if (locked || currentProviderInfo.available === false) return;
                  setEffortOpen(false);
                  setModelOpen(false);
                  setModeOpen(false);
                  setBuildMenuOpen(false);
                  setBestOfNOpen(false);
                  void toggleWebSearch();
                }}
              >
                <span className={styles.effortIcon} aria-hidden="true">
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
                    <circle cx="8" cy="8" r="5.5" />
                    <path d="M2.5 8h11" />
                    <path d="M8 2.5c1.7 1.8 2.6 3.6 2.6 5.5S9.7 11.7 8 13.5C6.3 11.7 5.4 9.9 5.4 8S6.3 4.3 8 2.5z" />
                  </svg>
                </span>
                <span className={styles.pillLabel}>Search</span>
              </button>
            )}

            {!ask && (
            <div className={styles.modeWrap} ref={modeWrapRef}>
              <button
                type="button"
                className={styles.pill}
                disabled={locked || modeChoiceLocked}
                aria-disabled={
                  locked || modeChoiceLocked ? "true" : undefined
                }
                aria-haspopup="listbox"
                aria-expanded={modeOpen}
                aria-label={`Permission: ${PERMISSION_MODE_LABELS[permissionMode]}`}
                title={permissionTitle}
                onClick={() => {
                  if (!locked && !modeChoiceLocked) {
                    setModeOpen((v) => !v);
                    setModelOpen(false);
                    setEffortOpen(false);
                    setBuildMenuOpen(false);
                    setBestOfNOpen(false);
                  }
                }}
              >
                {PERMISSION_MODE_LABELS[permissionMode]}
                {!modeChoiceLocked && (
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
                )}
              </button>
              {modeOpen && !modeChoiceLocked && (
                <ul
                  className={styles.modeMenu}
                  role="listbox"
                  aria-label="Permission mode"
                >
                  {pickerModes.map((mode) => {
                    const honoured = honouredModes.includes(mode);
                    const gated = !teachPermissionAllowed(mode, teach);
                    const blocked = gated || !honoured;
                    const title = !honoured
                      ? `${permissionName} cannot honor ${PERMISSION_MODE_LABELS[mode]} — pick a mode this CLI actually sends`
                      : gated
                        ? `Teach mode (${teach?.autonomy ?? "hint"}) does not allow this yet`
                        : undefined;
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
                          data-permission-mode={mode}
                          data-teach-gated={gated ? "true" : undefined}
                          data-unhonoured={honoured ? undefined : "true"}
                          disabled={blocked}
                          title={title}
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

            {vimEnabled && (
              <span
                className={`${styles.pill}${
                  vimMode === "normal" ? ` ${styles.pillAccent}` : ""
                }`}
                data-vim-mode-chip={vimMode}
                aria-label={
                  vimMode === "insert" ? "Vim Insert" : "Vim Normal"
                }
              >
                {vimMode === "insert" ? "Vim Insert" : "Vim Normal"}
              </span>
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
                  setEffortOpen(false);
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
                    setEffortOpen(false);
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
                              <ProviderMark
                                providerId={row.provider}
                                providers={providers}
                                size={16}
                                decorative
                                className={styles.bestOfNRowMark}
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
                              <ProviderMark
                                providerId={p.id}
                                providers={providers}
                                size={16}
                                decorative
                                className={styles.bestOfNRowMark}
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
          <div className={styles.sendCluster}>
          <div className={styles.modeWrap} data-transcript-view="">
            <button
              type="button"
              className={`${styles.pill}${
                transcriptView !== "normal" ? ` ${styles.pillAccent}` : ""
              }`}
              data-transcript-view-trigger=""
              data-transcript-view-mode={transcriptView}
              aria-haspopup="listbox"
              aria-expanded={viewOpen}
              aria-label={`Transcript view: ${TRANSCRIPT_VIEW_LABELS[transcriptView]}`}
              title={`${TRANSCRIPT_VIEW_HINTS[transcriptView]}. Ctrl+O cycles.`}
              onClick={() => {
                setViewOpen((v) => !v);
                setModeOpen(false);
                setModelOpen(false);
                setEffortOpen(false);
                setBuildMenuOpen(false);
                setBestOfNOpen(false);
              }}
            >
              {TRANSCRIPT_VIEW_LABELS[transcriptView]}
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
            {viewOpen && (
              <ul
                className={`${styles.modeMenu} ${styles.viewMenu}`}
                role="listbox"
                aria-label="Transcript view"
              >
                {TRANSCRIPT_VIEW_MODES.map((mode: TranscriptViewMode) => (
                  <li
                    key={mode}
                    role="option"
                    aria-selected={mode === transcriptView}
                  >
                    <button
                      type="button"
                      className={styles.modeOption}
                      data-transcript-view-option={mode}
                      data-active={mode === transcriptView}
                      title={TRANSCRIPT_VIEW_HINTS[mode]}
                      onClick={() => {
                        setTranscriptViewMode(mode);
                        setViewOpen(false);
                      }}
                    >
                      <span className={styles.checkSlot}>
                        {mode === transcriptView ? "✓" : ""}
                      </span>
                      {TRANSCRIPT_VIEW_LABELS[mode]}
                    </button>
                  </li>
                ))}
              </ul>
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
        </div>
        <div className={styles.meta}>
          <div className={styles.metaChips}>
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
      </div>

      {stashToast === "stashed" && (
        <ArchiveToast
          message="Stashed"
          onUndo={undoLastStash}
          onDismiss={() => setStashToast(null)}
        />
      )}

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
