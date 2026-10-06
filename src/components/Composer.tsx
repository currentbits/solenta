import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
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
  permissionModeHonoured,
  permissionPickerModes,
  providerDisplayName,
  providerPermissionModes,
  snapToHonouredPermissionMode,
} from "../format";
import {
  buildPickerRows,
  canFavourite,
  clampHighlightIndex,
  CUSTOM_MODEL_ID,
  buildProfileRows,
  effortDisplayLabel,
  effortHint,
  effortsForModel,
  favouriteKey,
  supportsImagesForModel,
  effortOptions,
  firstSelectableIndex,
  initialHighlightIndex,
  isRowSelected,
  lastSelectableIndex,
  modelTriggerLabel,
  readModelFavourites,
  rowKey,
  showReasoningControl,
  stepHighlightIndex,
  writeModelFavourites,
  type ModelRow,
  type ProfileRow,
} from "../modelPicker";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import { ProviderMark } from "./ProviderMark";
import { hintFor } from "./onboarding/installHints";
import { ArchiveToast } from "./ArchiveToast";
import type { ReplyTarget } from "../replyContext";
import { wrapReplyContext } from "../replyContext";
import {
  composePastePrompt,
  formatOverflow,
  makePasteCard,
  overflowWarn,
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
  getReviewComments,
  keptDrafts,
  recordSent,
  scheduleDraftSave,
  sentHistory,
  setReviewComments,
  subscribeReviewComments,
} from "../composerSession";
import { formatReviewCommentsPrompt } from "../diffView";
import {
  pickerVerb,
  type SlashAction,
  type SlashCommand,
} from "../slashCommands";
import { WorkflowsModal } from "./WorkflowsModal";
import {
  DROP_OVERLAY_MESSAGE,
  DROP_REJECT_MESSAGE,
  type DroppedFolder,
} from "../dropFiles";
import { scrollChildIntoNearestView } from "../scrollNearest";
import { teachPermissionAllowed } from "../teach";
import type { ThreadTeach } from "../shared/ipc";
import { useFileDrop } from "../useFileDrop";
import { isWebMode } from "../shared/wire";
import {
  getComposerBusyAction,
  getLastReasoningEffort,
  getPasteCardsEnabled,
  setComposerBusyAction,
  setLastReasoningEffort,
  useEnterSendsEnabled,
  useTranscriptViewMode,
  type ComposerBusyAction,
} from "../uiPrefs";
import { applyComposerVim } from "../composerVim";
import { AttachmentChip } from "./composer/AttachmentChip";
import { CommandList, MentionList } from "./composer/ComposerPopups";
import { ReplyChip } from "./composer/ReplyChip";
import { ReviewCommentChips } from "./composer/ReviewCommentChips";
import { PasteCardList } from "./composer/PasteCardList";
import { SpeechControls } from "./composer/SpeechControls";
import { useComposerAttachments } from "./composer/useComposerAttachments";
import { useComposerSpeech } from "./composer/useComposerSpeech";
import { useComposerVim } from "./composer/useComposerVim";
import { useMentionMenu } from "./composer/useMentionMenu";
import { useOptionsPopoverPlacement } from "./composer/useOptionsPopoverPlacement";
import { useSlashMenu } from "./composer/useSlashMenu";
import { useEscapeInterrupt } from "./composer/useEscapeInterrupt";
import { useTranscriptViewShortcuts } from "./composer/useTranscriptViewShortcuts";
import { usePasteCards } from "./composer/usePasteCards";

import styles from "./Composer.module.css";

interface ComposerProps {
  /** Selected thread id; used for per-thread last-used template. */
  threadId: string;
  /** Sticky permission mode for this thread. */
  permissionMode: PermissionMode;
  /** Teach-mode autonomy cap on the permission picker (issue #373). */
  teach?: ThreadTeach | null;
  /** Ask mode (issue #392): hide permission, Options, attach. */
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
  workflowListError?: string | null;
  onRetryWorkflows?: () => void | Promise<void>;
  /** Provider session id; a live session locks the provider picker. */
  sessionId: string | null;
  /**
   * Tab under the card: editable workspace + base branch on a draft, a
   * read-only "where this runs" label once the thread has started.
   */
  workspaceStrip?: ReactNode;
  /**
   * Status lip on the composer's top edge (#1429): background agents, stalled,
   * usage limit, run errors. ThreadView decides what goes here; Composer only
   * attaches it to the card.
   */
  statusTab?: ReactNode;
  /** Hard lock (archived thread): nothing can be typed or started. */
  disabled?: boolean;
  /**
   * A run is active. The prompt stays live so the next instruction can be
   * typed and sent — the parent queues it for when the run lands (issue #92).
   * Controls that only make sense between runs stay locked.
   */
  busy?: boolean;
  /** Single session turn (send arrow + ⌘Enter). While busy, `steer: true` injects into the live turn. */
  onSend: (
    prompt: string,
    attachments?: AttachmentInfo[],
    opts?: { steer?: boolean },
  ) => void | Promise<void>;
  /**
   * Text pushed back toward the draft from outside (a cancelled queued
   * follow-up, issue #364). Applied at most once, and only onto an EMPTY
   * draft — never clobbers an in-progress one.
   */
  restoreDraft?: { threadId: string; text: string } | null;
  /** Multi-phase workflow. The Build action inside Options calls this. */
  onBuild: (prompt: string, templateId: string) => void | Promise<void>;
  /**
   * Best of N: run this prompt on each selected provider or profile as a
   * forked thread. Absent hides that section inside Options.
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
  /** Start a signed-out provider's login in a terminal (#1501). */
  onProviderSignIn?: (providerId: string) => Promise<void>;
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
  /** Jump back to the quoted source message in the transcript. */
  onRevealReply?: () => void;
  /** Source message is missing or no longer matches the snapshot. */
  replySourceUnavailable?: boolean;
  /**
   * File/image/folder picker for attachments. Absent hides the attach button
   * (tests / shells that do not wire one). `includeImages: false` on
   * text-only models so the native dialog omits the Images filter. Web still
   * shows the paperclip for files/folders; Composer strips kind=image.
   */
  onPickAttachments?: (opts?: {
    includeImages?: boolean;
  }) => Promise<AttachmentInfo[]>;
  /** Web folder pick via showDirectoryPicker. Absent: paperclip is files-only. */
  onPickFolderAttachments?: () => Promise<AttachmentInfo[]>;
  /** Persist a pasted image; returns its attachment or null when rejected. */
  onSaveAttachmentImage?: (dataUrl: string) => Promise<AttachmentInfo | null>;
  /** Thumbnail data URL for an attached image; null when unavailable. */
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
  /**
   * Classify drag-dropped files into attachments. Absent disables drop.
   * `folders` is the webkitGetAsEntry walk (web); native ignores it.
   */
  onDropAttachmentFiles?: (
    files: File[],
    folders?: DroppedFolder[],
  ) => Promise<AttachmentInfo[]>;
  /**
   * Attachments arriving from outside the composer (Browser pane screenshot,
   * issue #155). Consumed into the pending chips, then onIncomingAttachmentsConsumed.
   * `incomingAttachmentThreadId` is the originating thread of that handoff
   * (#1206): a mismatch is consumed without pinning so a stale screenshot
   * cannot land on another draft or wait for a later switch back.
   */
  incomingAttachments?: AttachmentInfo[];
  incomingAttachmentThreadId?: string | null;
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

export const Composer = memo(function Composer({
  threadId,
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
  workflowListError = null,
  onRetryWorkflows,
  sessionId,
  workspaceStrip,
  statusTab,
  disabled = false,
  busy = false,
  onSend,
  restoreDraft = null,
  onBuild,
  onBestOfN,
  ask = false,
  onDelegate,
  onModelPickerOpen,
  onProviderSignIn,
  placeholder = "Ask anything, @ files, $ skills, / commands",
  error = null,
  onDismissError,
  onListFiles,
  onPickMentionFolder,
  replyTo = null,
  onClearReply,
  onRevealReply,
  replySourceUnavailable = false,
  onPickAttachments,
  onPickFolderAttachments,
  onSaveAttachmentImage,
  onLoadAttachmentImage,
  onDropAttachmentFiles,
  incomingAttachments,
  incomingAttachmentThreadId,
  onIncomingAttachmentsConsumed,
  onSlashAction,
  cliCommands,
  onStopRun,
  dropHostRef,
  onFileDragChange,
}: ComposerProps) {
  const currentProviderInfo = providers.find((p) => p.id === provider);
  const canAttachImages = supportsImagesForModel(currentProviderInfo, model);
  const transcriptView = useTranscriptViewMode();
  const enterSends = useEnterSendsEnabled();
  const { vimEnabled, vimMode, setVimMode, vimStateRef } =
    useComposerVim(threadId);
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
   *
   * The object is the module map, so a later mount of this thread sees it.
   */
  const draftsRef = useRef(keptDrafts);
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
      scheduleDraftSave();
      syncHasPrompt(text);
      syncOverflow(text);
    },
    [threadId, syncHasPrompt, syncOverflow],
  );
  const writeDraft = useCallback(
    (text: string, caret?: number) => {
      draftsRef.current[threadId] = text;
      scheduleDraftSave();
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
  const [busyAction, setBusyAction] = useState<ComposerBusyAction>(
    getComposerBusyAction,
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const {
    hasSpeech,
    speech,
    speechConfirm,
    setSpeechConfirm,
    dictating,
    snapshotRef,
    cancelDictationRef,
    onMicClick,
    confirmSpeechDownload,
  } = useComposerSpeech({
    threadId,
    disabled,
    sending,
    draftsRef,
    textareaRef,
    liveThreadIdRef,
    readDraft,
    syncHasPrompt,
    syncOverflow,
    setLocalError,
  });
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
  const { attachments, addAttachments, removeAttachment, clearAttachments } =
    useComposerAttachments({
      threadId,
      canAttachImages,
      incomingAttachments,
      incomingAttachmentThreadId,
      onIncomingAttachmentsConsumed,
    });
  const {
    pasteCards,
    expandedCardIds,
    setExpandedCardIds,
    addPasteCard,
    removePasteCard,
    clearPasteCards,
  } = usePasteCards({ threadId, pasteCardsRef, syncOverflow, readDraft });
  /** Diff comments from the Git pane, sent as one block with the next prompt. */
  const readReviewComments = () => getReviewComments(threadId);
  const reviewComments = useSyncExternalStore(
    subscribeReviewComments,
    readReviewComments,
    readReviewComments,
  );
  const clearReviewComments = useCallback(
    () => setReviewComments(threadId, () => []),
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
  const [customDraft, setCustomDraft] = useState("");
  /** Index of the row under keyboard/hover focus in the model list. */
  const [highlightIndex, setHighlightIndex] = useState(0);
  /** Type-in filter across every installed provider's models (#1429). */
  const [modelQuery, setModelQuery] = useState("");
  /** Starred `${provider}:${model}` keys, persisted in localStorage. */
  const [favourites, setFavourites] = useState<string[]>(readModelFavourites);
  /** The rail's ★: show only starred models. */
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  /** Missing provider whose install hint is expanded in the list. */
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  /** `/bestof` lands on the Best of N section, not Workflow. */
  const bestOfFocusRef = useRef(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [bestIds, setBestIds] = useState<string[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  // Close a stale Options or workflow editor when the thread, lock, or Ask
  // mode changes. Adjusting during render drops it before paint, so the
  // focus restore cannot run after the textarea takes the new thread.
  const [menuGuardSeen, setMenuGuardSeen] = useState(
    () => `${threadId}|${disabled || busy ? 1 : 0}|${ask ? 1 : 0}`,
  );
  const menuGuard = `${threadId}|${disabled || busy ? 1 : 0}|${ask ? 1 : 0}`;
  if (menuGuardSeen !== menuGuard) {
    setMenuGuardSeen(menuGuard);
    setOptionsOpen(false);
    const prevThread = menuGuardSeen.split("|")[0];
    if (prevThread !== threadId || ask) setManageOpen(false);
  }
  /** Per-thread last-used workflow template id. */
  const [templateByThread, setTemplateByThread] = useState<
    Record<string, string>
  >({});
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const attachWrapRef = useRef<HTMLDivElement>(null);
  const modelWrapRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const effortWrapRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLUListElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const optionsWrapRef = useRef<HTMLDivElement>(null);
  const optionsPopoverRef = useRef<HTMLDivElement>(null);
  /** Set when Manage workflows opens, so close can return to Options. */
  const returnFocusToOptions = useRef(false);
  const modelListId = useId();

  const {
    mentionFiles,
    mentionIndex,
    setMentionIndex,
    mentionOpen,
    closeMention,
    refreshMention,
    acceptMention,
    browseMentionFolder,
  } = useMentionMenu({
    textareaRef,
    onListFiles,
    onPickMentionFolder,
    disabled,
    writeDraft,
    setLocalError,
  });

  const {
    commandIndex,
    setCommandIndex,
    commandDismissed,
    commandMatches,
    commandOpen,
    closeCommand,
    refreshCommand,
    acceptCommand,
  } = useSlashMenu({
    textareaRef,
    cliCommands,
    disabled,
    busy,
    writeDraft,
    setModelOpen,
    setModeOpen,
    setEffortOpen,
    setOptionsOpen,
    onModelPickerOpen,
    onSlashAction,
  });
  /** Last idle Esc; a second press within DOUBLE_ESC_MS rewinds (#478). */
  const lastEscAt = useRef(0);
  /** Index into sentHistory while ↑/↓ is browsing; null when not. */
  const recallIndexRef = useRef<number | null>(null);

  useEffect(() => {
    commandDismissed.current = false;
    lastEscAt.current = 0;
    recallIndexRef.current = null;
    syncHasPrompt(draftsRef.current[threadId] ?? "");
    return () => {
      void cancelDictationRef.current();
    };
  }, [threadId, syncHasPrompt]);

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
  const selectedWorkflowName =
    workflows.find((w) => w.id === templateId)?.name ?? null;

  const canSend =
    !disabled &&
    !sending &&
    (hasPrompt || pasteCards.length > 0 || reviewComments.length > 0);
  /**
   * Everything that cannot be queued (workflow start, model, permission mode)
   * waits for the run to land; only the prompt and Send stay live while busy.
   */
  const locked = disabled || busy;
  /** Build is enabled for any provider; backend validates phase providers. */
  const canBuild = !locked && !sending && hasPrompt;
  const workflowRunTitle = hasPrompt
    ? "Build workflow"
    : "Add a prompt to run this workflow";
  const shownError = error ?? localError;
  const sessionLocked = Boolean(sessionId);
  const providerName = providerDisplayName(provider, providers);
  const canSteer = Boolean(busy && currentProviderInfo?.supportsSteer);
  const profileRows = buildProfileRows(agentProfiles, providers);
  const favouriteSet = new Set(favourites);
  const pickerRowsFor = (query: string, favOnly: boolean) =>
    buildPickerRows({
      providers,
      currentProviderId: provider,
      sessionLocked,
      currentProviderName: providerName,
      profiles: profileRows,
      query,
      favourites: favOnly ? favouriteSet : null,
    });
  const modelRows = pickerRowsFor(modelQuery, favouritesOnly);
  const triggerLabel = modelTriggerLabel(model, currentProviderInfo);
  const hi = clampHighlightIndex(modelRows, highlightIndex);
  // The rail's diamond follows the highlighted row's provider.
  const railActive = favouritesOnly
    ? "favourites"
    : modelRows[hi] && !modelRows[hi]!.profile
      ? modelRows[hi]!.providerId
      : null;
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
    if (
      !modeOpen &&
      !modelOpen &&
      !effortOpen &&
      !optionsOpen &&
      !attachOpen
    )
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
      if (optionsOpen && !optionsWrapRef.current?.contains(t)) {
        setOptionsOpen(false);
      }
      if (attachOpen && !attachWrapRef.current?.contains(t)) {
        setAttachOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modeOpen, modelOpen, effortOpen, optionsOpen, attachOpen]);

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
    setModelQuery("");
    setFavouritesOnly(false);
    setSetupFor(null);
    const rows = pickerRowsFor("", false);
    setHighlightIndex(initialHighlightIndex(rows, provider, model));
    // Search takes focus so typing filters at once; arrows work from there.
    const t = window.setTimeout(() => modelSearchRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
    // modelRows is rebuilt each render; the reset only needs the open edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOpen]);

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
    const list = modelListRef.current;
    const hl = list?.querySelector<HTMLElement>('[data-highlighted="true"]');
    // The row sits under a heading inside its <li>, so offsetTop is relative
    // to the wrong box: measure against the list's scrolled content instead.
    setGlider(
      list && hl
        ? {
            top:
              hl.getBoundingClientRect().top -
              list.getBoundingClientRect().top +
              list.scrollTop,
            height: hl.offsetHeight,
          }
        : null,
    );
  }, [modelOpen, hi, modelRows.length, setupFor]);


  /**
   * Rail click: show every provider again and land on this one's first row
   * (its setup row when the CLI is missing, with the hint expanded).
   */
  /**
   * A new filter is a new list: land on the selected model if it still
   * matches, otherwise the first selectable hit. Seeded here, not in an
   * effect, so a rail jump that clears the filter keeps its own highlight.
   */
  const refilter = (query: string, favOnly: boolean) => {
    setModelQuery(query);
    setFavouritesOnly(favOnly);
    setHighlightIndex(
      initialHighlightIndex(pickerRowsFor(query, favOnly), provider, model),
    );
  };

  const jumpToProvider = (id: string) => {
    setFavouritesOnly(false);
    setModelQuery("");
    const rows = pickerRowsFor("", false);
    const at = rows.findIndex((r) => r.providerId === id && !r.profile);
    if (at >= 0) setHighlightIndex(at);
    if (rows[at]?.setup) setSetupFor(id);
    modelSearchRef.current?.focus();
  };

  const toggleFavourite = (row: ModelRow) => {
    const key = favouriteKey(row);
    setFavourites((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key];
      writeModelFavourites(next);
      return next;
    });
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
    optionsOpen ||
    attachOpen ||
    viewOpen;
  const closeAllMenus = useCallback(() => {
    setModeOpen(false);
    setEffortOpen(false);
    if (modelOpen) {
      closeModelPicker(true);
    } else {
      setModelOpen(false);
    }
    setOptionsOpen(false);
    setAttachOpen(false);
    setViewOpen(false);
  }, [modelOpen, closeModelPicker]);
  useEscapeClose(anyMenuOpen, closeAllMenus);
  // Popovers, not aria-modal. Listbox timeout already focuses the
  // provider/model list on open and drill; takeFocus would steal that,
  // and restore would fight closeModelPicker / Escape-back.
  useModalFocus(modelOpen, modelPopoverRef, false);
  useModalFocus(optionsOpen, optionsPopoverRef);
  useOptionsPopoverPlacement(optionsOpen, optionsPopoverRef, optionsWrapRef);
  useEffect(() => {
    if (!optionsOpen || !bestOfFocusRef.current) return;
    bestOfFocusRef.current = false;
    const first = optionsPopoverRef.current?.querySelector<HTMLInputElement>(
      "input[data-best-of-n-profile]:not(:disabled), input[data-best-of-n-provider]",
    );
    first?.scrollIntoView?.({ block: "nearest" });
    first?.focus();
  }, [optionsOpen]);

  // The editor opens after Options unmounts, so the focused Manage control is
  // gone and the dialog restores to body. Run after that restore and land on
  // the Options button, which is still mounted.
  useLayoutEffect(() => {
    if (manageOpen) return;
    if (!returnFocusToOptions.current) return;
    returnFocusToOptions.current = false;
    textareaRef.current?.focus();
  }, [manageOpen]);

  const popupOpen = anyMenuOpen || mentionOpen || commandOpen || manageOpen;
  useEscapeInterrupt({
    disabled,
    busy,
    popupOpen,
    onStopRun,
    onSlashAction,
    textareaRef,
    snapshotRef,
    cancelDictationRef,
    lastEscAt,
  });

  useTranscriptViewShortcuts();

  const composeOutgoing = useCallback(
    (draft: string) => {
      let body = [
        formatReviewCommentsPrompt(reviewComments),
        composePastePrompt(draft.trim(), pasteCards),
      ]
        .filter(Boolean)
        .join("\n\n");
      if (replyTo) {
        body = wrapReplyContext(replyTo.text, body, replyTo.messageId, {
          truncated: replyTo.truncated,
        });
      }
      return body;
    },
    [pasteCards, replyTo, reviewComments],
  );

  const runAction = async (
    action: (prompt: string) => void | Promise<void>,
    failLabel: string,
  ) => {
    const typed = readDraft();
    const prompt = composeOutgoing(typed);
    if (!prompt.trim() || disabled || sending) return;
    setSending(true);
    setLocalError(null);
    try {
      await action(prompt);
      recordSent(threadId, typed);
      recallIndexRef.current = null;
      writeDraft("");
      clearAttachments();
      clearPasteCards();
      clearReviewComments();
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
    // `/workflow …` and `/bestof …` open the picker instead of sending.
    const verb = ask ? null : pickerVerb(readDraft());
    if (verb && (verb.picker === "workflow" || onBestOfN)) {
      writeDraft(verb.tail, verb.tail.length);
      closeCommand();
      if (locked || sending) {
        setLocalError("Wait for this run to finish");
        return;
      }
      setLocalError(null);
      bestOfFocusRef.current = verb.picker === "bestof";
      setOptionsOpen(true);
      setModeOpen(false);
      setModelOpen(false);
      setEffortOpen(false);
      setAttachOpen(false);
      setViewOpen(false);
      return;
    }
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
      await onSend(
        prompt,
        attachments.length ? attachments : undefined,
        canSteer && busyAction === "steer" ? { steer: true } : undefined,
      );
    }, "Failed to start run");
  };

  const submitSteer = () => {
    if (!canSend) return;
    void runAction(async (prompt) => {
      await onSend(
        prompt,
        attachments.length ? attachments : undefined,
        { steer: true },
      );
    }, "Failed to steer");
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
    setOptionsOpen(false);
    void runAction(
      (prompt) => onBuild(prompt, templateId),
      "Failed to start workflow",
    );
  };

  const installedProviders = providers.filter((p) => p.available);
  const canBestOfN = Boolean(onBestOfN) && !busy && canSend;
  const bestRunTitle = !canSend
    ? "Add a prompt to run this on multiple providers"
    : busy || disabled
      ? "Wait for this run to finish"
      : bestIds.length < 2
        ? "Pick at least two"
        : "Run this prompt on multiple providers at once";
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
      setOptionsOpen(false);
    }, "Failed to start Best of N");
  };

  const selectTemplate = (id: string) => {
    setTemplateByThread((prev) => ({ ...prev, [threadId]: id }));
    setOptionsOpen(false);
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
    clearReviewComments();
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

  /**
   * ↑ in an empty composer recalls the last prompt sent on this thread; ↑/↓
   * keep walking while the recalled text is untouched. Edits, or a caret not
   * on the first (↑) / last (↓) line, leave the arrows to the textarea.
   */
  const recallSent = (el: HTMLTextAreaElement, up: boolean): boolean => {
    const history = sentHistory[threadId] ?? [];
    const at = recallIndexRef.current;
    const browsing = at != null && el.value === history[at];
    if (!browsing) recallIndexRef.current = null;
    let next: number | null;
    if (up) {
      if (browsing) {
        const caret = el.selectionStart;
        if (at === 0 || (caret > 0 && el.value.lastIndexOf("\n", caret - 1) !== -1))
          return false;
        next = at - 1;
      } else {
        if (el.value !== "" || !history.length) return false;
        next = history.length - 1;
      }
    } else {
      if (!browsing || el.value.indexOf("\n", el.selectionEnd) !== -1)
        return false;
      next = at + 1 < history.length ? at + 1 : null;
    }
    recallIndexRef.current = next;
    const text = next == null ? "" : history[next]!;
    writeDraft(text, text.length);
    return true;
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
    if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      recallSent(e.currentTarget, e.key === "ArrowUp")
    ) {
      e.preventDefault();
      return;
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
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
      e.preventDefault();
      if (canSteer) submitSteer();
      else submitSend();
      return;
    }
    // Default: ⌘/Ctrl/⇧+Enter send, bare Enter is a newline. With the
    // Enter-sends preference, bare Enter sends and ⇧Enter is the newline.
    if (
      e.key === "Enter" &&
      !e.nativeEvent.isComposing &&
      (e.metaKey || e.ctrlKey || (enterSends ? !e.shiftKey : e.shiftKey))
    ) {
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

  const runAttachmentPick = (
    picker:
      | ((opts?: { includeImages?: boolean }) => Promise<AttachmentInfo[]>)
      | undefined,
  ) => {
    if (!picker || disabled || sending) return;
    picker({ includeImages: canAttachImages })
      .then(addAttachments)
      .catch((err) => {
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "Failed to attach";
        setLocalError(msg);
      });
  };

  const canPickWebFolderNow = () =>
    Boolean(onPickFolderAttachments) &&
    isWebMode() &&
    typeof (window as Window & { showDirectoryPicker?: unknown })
      .showDirectoryPicker === "function";

  const pickAttachments = () => {
    if (!onPickAttachments || disabled || sending) return;
    if (canPickWebFolderNow()) {
      setAttachOpen((v) => !v);
      setModeOpen(false);
      setModelOpen(false);
      setEffortOpen(false);
      setOptionsOpen(false);
      return;
    }
    runAttachmentPick(onPickAttachments);
  };

  /** Clipboard images become saved attachments; large text pastes become cards. */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || sending) return;
    const items = Array.from(e.clipboardData?.items ?? []).filter(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (items.length > 0 && onSaveAttachmentImage) {
      // Refuse the image but do not preventDefault: a mixed clipboard
      // still pastes its text. preventDefault would swallow that too.
      if (!canAttachImages) return;
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
    async (files: File[], folders?: DroppedFolder[]) => {
      if (!onDropAttachmentFiles || disabled || sending) return;
      try {
        const items = await onDropAttachmentFiles(files, folders);
        const accepted = canAttachImages
          ? items
          : items.filter((a) => a.kind !== "image");
        if (accepted.length) {
          addAttachments(accepted);
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
    [onDropAttachmentFiles, disabled, sending, addAttachments, canAttachImages],
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
    if (row.setup) {
      setSetupFor((cur) => (cur === row.providerId ? null : row.providerId));
      return;
    }
    if (row.profile) {
      void pickProfile(row.profile);
      return;
    }
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

  const onModelListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (handleModelNavKey(e, false)) return;
    // A printable key while the list is focused is a search, not a dead key.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      refilter(modelQuery + e.key, favouritesOnly);
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
      // Stop this reaching the document's Escape handler, so clearing the
      // query does not also close the picker.
      e.stopPropagation();
      if (fromSearch && modelQuery.trim()) {
        refilter("", favouritesOnly);
        return true;
      }
      closeModelPicker(true);
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
      {statusTab ? (
        <div className={styles.statusTab} data-composer-status="">
          {statusTab}
        </div>
      ) : null}
      <div className={styles.card}>
        {mentionOpen && (
          <MentionList
            mentionFiles={mentionFiles}
            mentionIndex={mentionIndex}
            setMentionIndex={setMentionIndex}
            acceptMention={acceptMention}
            onPickMentionFolder={onPickMentionFolder}
            browseMentionFolder={browseMentionFolder}
          />
        )}
        {commandOpen && (
          <CommandList
            commandMatches={commandMatches}
            commandIndex={commandIndex}
            setCommandIndex={setCommandIndex}
            acceptCommand={acceptCommand}
          />
        )}
        {replyTo && (
          <ReplyChip
            replyTo={replyTo}
            replySourceUnavailable={replySourceUnavailable}
            onRevealReply={onRevealReply}
            onClearReply={onClearReply}
          />
        )}
        {pasteCards.length > 0 && (
          <PasteCardList
            pasteCards={pasteCards}
            expandedCardIds={expandedCardIds}
            setExpandedCardIds={setExpandedCardIds}
            removePasteCard={removePasteCard}
          />
        )}
        {reviewComments.length > 0 && (
          <ReviewCommentChips
            comments={reviewComments}
            onEdit={(id, text) =>
              setReviewComments(threadId, (prev) =>
                prev.map((c) => (c.id === id ? { ...c, text } : c)),
              )
            }
            onRemove={(id) =>
              setReviewComments(threadId, (prev) =>
                prev.filter((c) => c.id !== id),
              )
            }
          />
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
          readOnly={dictating}
          data-vim-mode={vimEnabled ? vimMode : undefined}
        />
        <div
          ref={overflowRef}
          className={styles.overflow}
          data-paste-overflow=""
          hidden
        />
        {/* View mode lives in the thread title menu and ⌃O (#1411); the
            current mode is mirrored here for keyboard-only callers. */}
        <div className={styles.controls} data-transcript-view-mode={transcriptView}>
          <div className={styles.pills}>
            {hasSpeech && speech && (
              <SpeechControls
                speech={speech}
                dictating={dictating}
                disabled={disabled}
                sending={sending}
                speechConfirm={speechConfirm}
                setSpeechConfirm={setSpeechConfirm}
                onMicClick={onMicClick}
                confirmSpeechDownload={confirmSpeechDownload}
              />
            )}
            {/* Model, effort and access are ghost pills split by hairlines
                (#1429); each keeps its own picker. */}
            <div
              className={styles.modelGroup}
              data-model-group=""
              data-with-effort={reasoningVisible ? "" : undefined}
            >
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
                    setOptionsOpen(false);
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
                  <ProviderMark
                    providerId={provider}
                    providers={providers}
                    size={14}
                    decorative
                  />
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
                  ref={modelPopoverRef}
                  className={styles.modelPopover}
                  role="dialog"
                  aria-label="Model picker"
                  id={modelListId}
                  tabIndex={-1}
                >
                  <div
                    className={styles.pickerRail}
                    role="group"
                    aria-label="Providers"
                  >
                    <button
                      type="button"
                      className={styles.railButton}
                      aria-label="Favourites"
                      title="Favourites"
                      aria-pressed={favouritesOnly}
                      data-active={railActive === "favourites" ? "true" : undefined}
                      onClick={() => {
                        refilter("", !favouritesOnly);
                        modelSearchRef.current?.focus();
                      }}
                    >
                      <span aria-hidden="true">★</span>
                    </button>
                    {providers.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={styles.railButton}
                        aria-label={`Provider ${p.name}`}
                        title={
                          p.available === false
                            ? `${p.name}: not installed`
                            : p.auth === "signedOut"
                              ? `${p.name}: signed out`
                              : p.name
                        }
                        data-active={railActive === p.id ? "true" : undefined}
                        data-unavailable={
                          p.available === false ? "true" : undefined
                        }
                        onClick={() => jumpToProvider(p.id)}
                      >
                        <ProviderMark
                          providerId={p.id}
                          providers={providers}
                          size={16}
                          decorative
                        />
                      </button>
                    ))}
                  </div>
                  <div className={styles.pickerMain}>
                    <div className={styles.modelSearchRow}>
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        aria-hidden="true"
                      >
                        <circle cx="7" cy="7" r="4.5" />
                        <path d="m10.5 10.5 3 3" />
                      </svg>
                      <input
                        ref={modelSearchRef}
                        className={styles.modelSearch}
                        type="search"
                        value={modelQuery}
                        placeholder={
                          favouritesOnly ? "Search favourites…" : "Search models…"
                        }
                        aria-label="Search models"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) =>
                          refilter(e.target.value, favouritesOnly)
                        }
                        onKeyDown={onModelSearchKeyDown}
                      />
                    </div>
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
                      {modelRows.length === 0 ? (
                        <li className={styles.pickerEmpty} role="status">
                          {favouritesOnly && !modelQuery.trim()
                            ? "No favourites yet. Star a model with ☆."
                            : "No matching models"}
                        </li>
                      ) : null}
                      {modelRows.map((row, index) => {
                        const selected = isRowSelected(row, provider, model);
                        const highlighted = index === hi;
                        const starrable = canFavourite(row);
                        const starred =
                          starrable && favouriteSet.has(favouriteKey(row));
                        const groupInfo = row.groupHeading
                          ? providers.find((p) => p.id === row.providerId)
                          : undefined;
                        const note = groupInfo?.catalogNote ?? null;
                        const signedOut = groupInfo?.auth === "signedOut";
                        const hint =
                          row.setup && setupFor === row.providerId
                            ? hintFor(row.providerId)
                            : null;
                        const sub = row.profile
                          ? row.vendor
                          : row.setup
                            ? "not installed · set up"
                            : row.id === CUSTOM_MODEL_ID
                              ? "type a model id"
                              : row.id == null
                                ? "provider default"
                                : row.id === row.label
                                  ? null
                                  : row.id;
                        return (
                          <li
                            key={row.profile ? row.id : rowKey(row)}
                            role="option"
                            aria-selected={selected}
                            aria-disabled={row.disabled ? true : undefined}
                            className={styles.rowEnter}
                            style={rowEnterStyle(index)}
                          >
                            {row.groupHeading ? (
                              <div
                                className={styles.modelGroupHeading}
                                aria-hidden="true"
                              >
                                {row.groupHeading}
                              </div>
                            ) : null}
                            {note ? (
                              <div
                                className={styles.catalogNote}
                                data-catalog-note=""
                              >
                                {note}
                              </div>
                            ) : null}
                            {signedOut ? (
                              <div
                                className={styles.signedOut}
                                data-signed-out={row.providerId}
                              >
                                <span>Signed out</span>
                                {onProviderSignIn ? (
                                  <button
                                    type="button"
                                    className={styles.customModelBtn}
                                    onClick={() => {
                                      closeModelPicker(false);
                                      void onProviderSignIn(row.providerId).catch(
                                        () => {},
                                      );
                                    }}
                                  >
                                    Sign in
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                            <div className={styles.modelRowLine}>
                              <button
                                type="button"
                                className={styles.modelRow}
                                tabIndex={-1}
                                // Scroll the list only: scrollIntoView walks up
                                // to .chatSlot and lifts the composer (#762).
                                ref={(el) => {
                                  if (highlighted && el) {
                                    scrollChildIntoNearestView(
                                      modelListRef.current,
                                      el,
                                    );
                                  }
                                }}
                                aria-label={
                                  row.profile
                                    ? `Profile ${row.label}`
                                    : row.setup
                                      ? `Set up ${row.label}`
                                      : undefined
                                }
                                data-selected={selected ? "true" : undefined}
                                data-highlighted={
                                  highlighted ? "true" : undefined
                                }
                                data-disabled={
                                  row.disabled ? "true" : undefined
                                }
                                data-setup={row.setup ? "true" : undefined}
                                data-profile={
                                  row.profile ? row.profile.id : undefined
                                }
                                disabled={row.disabled}
                                title={
                                  row.disabledReason ??
                                  (row.description || undefined)
                                }
                                onMouseEnter={() => setHighlightIndex(index)}
                                onClick={() => void pickRow(row)}
                              >
                                {row.profile ? (
                                  <ProviderMark
                                    providerId={row.profile.provider}
                                    providers={providers}
                                    size={14}
                                    decorative
                                    className={styles.providerRowMark}
                                  />
                                ) : null}
                                <span className={styles.providerRowText}>
                                  <span className={styles.modelRowLabel}>
                                    {row.label}
                                  </span>
                                  {sub ? (
                                    <span className={styles.modelRowId}>
                                      {sub}
                                    </span>
                                  ) : null}
                                </span>
                              </button>
                              {starrable ? (
                                <button
                                  type="button"
                                  className={styles.star}
                                  aria-label={`Favourite ${row.providerName} ${row.label}`}
                                  aria-pressed={starred}
                                  data-favourite={favouriteKey(row)}
                                  onClick={() => toggleFavourite(row)}
                                >
                                  {starred ? "★" : "☆"}
                                </button>
                              ) : null}
                            </div>
                            {hint ? (
                              <div
                                className={styles.setupPanel}
                                data-provider-setup={row.providerId}
                                ref={(el) =>
                                  scrollChildIntoNearestView(
                                    modelListRef.current,
                                    el,
                                  )
                                }
                              >
                                <code className={styles.setupCommand}>
                                  {hint.command}
                                </code>
                                <div className={styles.customModelActions}>
                                  <button
                                    type="button"
                                    className={styles.customModelBtn}
                                    onClick={() =>
                                      void navigator.clipboard
                                        ?.writeText(hint.command)
                                        .catch(() => {})
                                    }
                                  >
                                    Copy
                                  </button>
                                  {hint.url ? (
                                    <a
                                      className={styles.customModelBtn}
                                      href={hint.url}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Docs
                                    </a>
                                  ) : null}
                                  <button
                                    type="button"
                                    className={styles.customModelBtn}
                                    title="Look for the CLI again"
                                    onClick={() => onModelPickerOpen?.()}
                                  >
                                    Check again
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                    {reasoningVisible ? (
                      <div
                        className={styles.pickerEffort}
                        role="group"
                        aria-label="Effort"
                        data-picker-effort=""
                      >
                        <span className={styles.pickerEffortLabel}>Effort</span>
                        {effortOptions(efforts).map((level) => (
                          <button
                            key={level ?? "auto"}
                            type="button"
                            className={styles.effortChip}
                            aria-pressed={level === reasoningEffort}
                            data-effort-chip={level ?? "auto"}
                            disabled={effortUnavailable}
                            title={effortHint(level) ?? undefined}
                            onClick={() => void pickEffort(level)}
                          >
                            {effortDisplayLabel(level)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            </div>

            {reasoningVisible && <span className={styles.sep} aria-hidden="true" />}
            {reasoningVisible && (
              <div className={styles.modeWrap} ref={effortWrapRef}>
                <button
                  type="button"
                  className={`${styles.pill} ${styles.effortSegment}`}
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
                    setOptionsOpen(false);
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
            </div>

            {currentProviderInfo?.supportsSearch && onSetWebSearch && (
              <span className={styles.sep} aria-hidden="true" />
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
                  setOptionsOpen(false);
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

            {!ask && <span className={styles.sep} aria-hidden="true" />}
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
                    setOptionsOpen(false);
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
            <div
              className={styles.modeWrap}
              ref={optionsWrapRef}
              data-composer-options-anchor=""
            >
              {optionsOpen && (
                <div
                  ref={optionsPopoverRef}
                  className={styles.optionsPopover}
                  role="dialog"
                  aria-label="Options"
                  data-composer-options-popover=""
                  data-best-of-n-popover={onBestOfN ? "" : undefined}
                  tabIndex={-1}
                >
                  <div className={styles.optionsSection}>
                    <p className={styles.bestOfNHint}>Workflow</p>
                    {selectedWorkflowName && (
                      <p
                        className={styles.optionsCurrent}
                        data-selected-workflow={templateId}
                      >
                        {selectedWorkflowName}
                      </p>
                    )}
                    {workflows.length > 0 && (
                      <ul
                        className={styles.optionsList}
                        aria-label="Workflow templates"
                      >
                        {workflows.map((t) => (
                          <li key={t.id}>
                            <button
                              type="button"
                              className={styles.modeOption}
                              aria-pressed={t.id === templateId}
                              data-active={t.id === templateId}
                              data-workflow-template={t.id}
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
                      </ul>
                    )}
                    <button
                      type="button"
                      className={styles.modeOption}
                      onClick={() => {
                        returnFocusToOptions.current = true;
                        setOptionsOpen(false);
                        setManageOpen(true);
                      }}
                    >
                      Manage workflows…
                    </button>
                    <button
                      type="button"
                      className={styles.bestOfNRun}
                      onClick={() => submitBuild()}
                      disabled={!canBuild}
                      aria-disabled={!canBuild ? "true" : undefined}
                      title={workflowRunTitle}
                      data-workflow-run=""
                    >
                      {STATIC.mode}
                    </button>
                  </div>
                  {onBestOfN && (
                    <div className={styles.optionsBest}>
                    <p className={styles.bestOfNHint}>Best of N</p>
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
                      disabled={!canBestOfN || bestIds.length < 2 || sending}
                      aria-disabled={
                        !canBestOfN || bestIds.length < 2 || sending
                          ? "true"
                          : undefined
                      }
                      title={bestRunTitle}
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
            )}
          </div>
          <div className={styles.sendCluster}>
          {canSteer && (
            <div
              className={styles.steerToggle}
              role="group"
              aria-label="Follow-up while this run is live"
              data-steer-toggle=""
            >
              <button
                type="button"
                aria-pressed={busyAction === "queue"}
                data-steer-action="queue"
                title="Queue for when this run lands (⌘Enter)"
                onClick={() => {
                  setBusyAction("queue");
                  setComposerBusyAction("queue");
                }}
              >
                Queue
              </button>
              <button
                type="button"
                aria-pressed={busyAction === "steer"}
                data-steer-action="steer"
                title="Steer the live turn (⌘Enter). ⌘⇧Enter always steers."
                onClick={() => {
                  setBusyAction("steer");
                  setComposerBusyAction("steer");
                }}
              >
                Steer
              </button>
            </div>
          )}
          {onPickAttachments && !ask && (
            <div className={styles.modeWrap} ref={attachWrapRef}>
              <button
                type="button"
                className={styles.pill}
                disabled={disabled || sending}
                aria-disabled={disabled || sending ? "true" : undefined}
                aria-label="Attach files or folders"
                title="Attach files or folders"
                aria-haspopup={
                  canPickWebFolderNow() ? "menu" : undefined
                }
                aria-expanded={
                  canPickWebFolderNow() ? attachOpen : undefined
                }
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
              {attachOpen && (
                <ul
                  className={styles.modeMenu}
                  role="menu"
                  aria-label="Attach"
                >
                  <li>
                    <button
                      type="button"
                      className={styles.modeOption}
                      role="menuitem"
                      onClick={() => {
                        setAttachOpen(false);
                        runAttachmentPick(onPickAttachments);
                      }}
                    >
                      Files
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      className={styles.modeOption}
                      role="menuitem"
                      onClick={() => {
                        setAttachOpen(false);
                        runAttachmentPick(onPickFolderAttachments);
                      }}
                    >
                      Folder
                    </button>
                  </li>
                </ul>
              )}
            </div>
          )}
          <button
            type="button"
            className={styles.send}
            aria-label="Send"
            disabled={!canSend}
            data-queues={busy && !(canSteer && busyAction === "steer") ? "" : undefined}
            title={
              canSteer && busyAction === "steer"
                ? "Steer the live turn (⌘Enter). ⌘⇧Enter also steers."
                : busy
                  ? canSteer
                    ? "Queue for when this run lands (⌘Enter). ⌘⇧Enter steers. Esc stops the run."
                    : "Queue for when this run lands (⌘Enter). ⌥Enter asks a side question. Esc stops the run."
                  : "Send (⌘Enter). ⌥Enter asks a side question. ⌘S stashes the draft."
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
      </div>
      {workspaceStrip ? (
        <div className={styles.meta} data-composer-workspace="">
          {workspaceStrip}
        </div>
      ) : null}

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
        listError={workflowListError}
        onRetryList={onRetryWorkflows}
      />
    </div>
  );
});
