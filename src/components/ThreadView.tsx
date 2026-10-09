import {
  Fragment,
  memo,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PanePlaceholder,
  PaneWorkspace,
  ViewsMenu,
} from "./PaneWorkspace";
import type { TerminalApi } from "./TerminalPane";
import type { FilesPaneApi } from "./FilesPane";
import { useWorktreeChrome } from "./WorktreeControl";
import { WorkspaceStrip } from "./WorkspaceStrip";
import { ProjectIcon } from "./ProjectIcon";
import {
  hasPaneType,
  hydratePaneLayout,
  leaves,
  type LayoutNode,
} from "../paneLayout";
import type {
  AttachmentInfo,
  DevServerState,
  LocalServerInfo,
  ChatMessage,
  CoderApi,
  ConflictContext,
  DiffResult,
  GitSyncInfo,
  PrChecksResult,
  MergeMethod,
  PrInfo,
  PrTemplateResult,
  PermissionDecision,
  InputValues,
  PermissionMode,
  CliSlashCommand,
  ProjectInfo,
  SimulatorStatus,
  AgentProfile,
  ProviderInfo,
  ReasoningEffort,
  RunStatInfo,
  SpecArtifact,
  ThreadDetail,
  ThreadInfo,
  ThreadMessagePin,
  WorkSuggestion,
  WorkflowTemplateInfo,
  EditorId,
  EditorOption,
} from "../shared/ipc";
import {
  THREAD_NOTES_MAX,
  THREAD_MESSAGE_PINS_MAX,
  THREAD_MESSAGE_PIN_LABEL_MAX,
} from "../shared/ipc";
import {
  isPinAvailable,
  labelMessagePin,
  pinDisplayText,
  pinMessage,
  pinsOf,
  unpinMessage,
} from "../messagePins";
import type { WorkflowSaveInput } from "../useCoder";
import type { ReturnableView } from "../viewReturn";
import { contextBreakdown } from "../contextBreakdown";
import { contextRing, threadContextWindow } from "../contextRing";
import { buildTimeline, type TimelineEntry } from "../timeline";
import { collapseTimeline, type DisplayEntry } from "../toolGroups";
import { RunArtifacts } from "./RunArtifacts";
import { QuestionPrompt } from "./QuestionPrompt";
import { InputPrompt } from "./InputPrompt";
import { threadProviderRef } from "../format";
import { formatQuestionAnswer } from "../questionAnswer";
import { supportsImagesForModel } from "../modelPicker";
import type { DiffViewMode } from "./TurnDiffPanel";
import {
  FIRST_PAINT_CHAR_BUDGET,
  TRANSCRIPT_WINDOW,
  clampWindowStart,
  ensureVisibleStart,
  tailWindowStart,
} from "../transcriptWindow";
import { lastUserMessage } from "../retryTurn";
import { isParsed, preparseMarkdown } from "./Markdown";
import {
  isEditableUserMessage,
  rewindConfirmText,
  rewindDroppedCount,
} from "../editResubmit";
import { mapReviewBars, type ReviewBar } from "../reviewBar";
import { isRunCollapsed, toggleRunCollapsed } from "../runHeader";
import type { SlashAction } from "../slashCommands";
import { NATIVE_COMPACT_PROVIDERS } from "../slashCommands";
import { ProviderQuotaDialog } from "./ProviderQuota";
import type { ProviderLimitsLoader } from "../providerUsage";
import { buildBestOfNEntries } from "../bestOfN";
import { formatQuotaWaitLabel } from "../quotaWait";
import type { ReviewSymbol } from "../reviewItinerary";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import type { ComparePeer } from "../divergence";
import {
  TRANSCRIPT_VIEW_HINTS,
  TRANSCRIPT_VIEW_LABELS,
  TRANSCRIPT_VIEW_MODES,
} from "../focusView";
import {
  setDiffSplit,
  setTranscriptViewMode,
  useDiffSplit,
  useTranscriptViewMode,
} from "../uiPrefs";
import { DROP_OVERLAY_MESSAGE, type DroppedFolder } from "../dropFiles";
import { Composer } from "./Composer";
import { repoRelativeDir } from "../mention";
import {
  makeReplyTarget,
  replySourceUnavailable,
  type ReplyTarget,
} from "../replyContext";
import { waitWhatPrompt } from "../waitWhat";
import { sessionImagePathsFromMessages } from "../sessionImages";
import { PathLinkProvider, ThreadLinkContext } from "./PathLinks";
import {
  SandboxBadge,
  ContextRingBadge,
  SyncPill,
  ElapsedClock,
  MemoryPill,
  DraftProjectChooser,
  HeaderForkControl,
  ReturnToViewButton,
  returnToHeader,
} from "./thread/headerBits";
import {
  ImageLightbox,
  ToolGroupRow,
  MessageBlock,
  ReviewBarStrip,
  SuggestedWorkStrip,
  FocusTurnRow,
  RunHeaderRow,
} from "./thread/messages";
import { NextGitActionButton } from "./thread/NextGitActionButton";
import {
  PlanPrompt,
  PermissionPrompt,
  ExternalApprovalCard,
  PlanCard,
  SpecCard,
  BtwSideCard,
  AskCard,
  TeachCard,
  FeltEstimateCard,
  DivergenceCard,
} from "./thread/cards";
import { setReviewComments } from "../composerSession";
import { useRetryAnchors } from "./thread/useRetryAnchors";
import { useTranscriptAnnotations } from "./thread/useTranscriptAnnotations";
import { useCliCommands } from "./thread/useCliCommands";
import { useCiteShortcut } from "./thread/useCiteShortcut";
import { useHeaderGitStatus } from "./thread/useHeaderGitStatus";
import { useQueuedEdit } from "./thread/useQueuedEdit";
import { usePaneLayoutActions } from "./thread/usePaneLayoutActions";
import { useAppSnap } from "./thread/useAppSnap";
import { useStickToBottom } from "./thread/useStickToBottom";
import { bindingLabel } from "../keybindings";
import styles from "./ThreadView.module.css";
import { lazyNamed } from "../lazyNamed";

// Panes that are closed by default load on first use, keeping their code out
// of the cold-start chunk (#1501 G4). Each is warmed on idle after the thread
// view mounts, so the first open renders without a blank frame.
const ChangesPanel = lazyNamed(() =>
  import("./thread/ChangesPanel").then((m) => m.ChangesPanel),
);
const TurnDiffPanel = lazyNamed(() =>
  import("./TurnDiffPanel").then((m) => m.TurnDiffPanel),
);
const TerminalPane = lazyNamed(() =>
  import("./TerminalPane").then((m) => m.TerminalPane),
);
const BrowserPane = lazyNamed(() =>
  import("./BrowserPane").then((m) => m.BrowserPane),
);
const SimulatorPane = lazyNamed(() =>
  import("./SimulatorPane").then((m) => m.SimulatorPane),
);
const FilesPane = lazyNamed(() =>
  import("./FilesPane").then((m) => m.FilesPane),
);
const LAZY_PANES = [
  ChangesPanel,
  TurnDiffPanel,
  TerminalPane,
  BrowserPane,
  SimulatorPane,
  FilesPane,
];

function preloadPanesWhenIdle(): () => void {
  const preload = () => {
    for (const pane of LAZY_PANES) void pane.preload().catch(() => {});
  };
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(preload, { timeout: 3000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(preload, 500);
  return () => window.clearTimeout(id);
}

const EMPTY_COMPARE_PEERS: ComparePeer[] = [];

const COPY_FLASH_MS = 1500;

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function swapQueuedItem<T>(items: T[], index: number, delta: number): T[] {
  const dest = index + delta;
  if (dest < 0 || dest >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(index, 1);
  next.splice(dest, 0, item!);
  return next;
}

interface ThreadViewProps {
  detail: ThreadDetail | null;
  /**
   * Expand the transcript window to include this message (jump-to-turn
   * #487, find #486, deep links). No-op when missing or already visible.
   */
  revealMessageId?: string | null;
  /** threads.get failure for the selected thread; shown with a retry. */
  detailError?: string | null;
  /** Re-fetch the selected thread's detail after a load failure. */
  onRetryDetail?: () => void;
  project: ProjectInfo | null;
  providers: ProviderInfo[];
  /** Saved agent profiles from settings; passed through to Composer. */
  agentProfiles?: AgentProfile[];
  workflows: WorkflowTemplateInfo[];
  hasProjects: boolean;
  onAddProject: () => void;
  onStartRun: (
    prompt: string,
    threadId?: string,
    attachments?: AttachmentInfo[],
    opts?: { fromNotice?: boolean; steer?: boolean; fromQueue?: boolean },
  ) => void | Promise<void>;
  /**
   * Edit-and-resubmit (#254): rewind to just before messageId, then start
   * a run with the edited prompt. Same start-run path as Composer.
   */
  onRewindAndResubmit?: (
    messageId: string,
    prompt: string,
    restoreFiles?: boolean,
    attachments?: AttachmentInfo[],
  ) => void | Promise<void>;
  /** Multi-phase Build workflow (Build pill) with selected template id. */
  onStartWorkflow: (
    prompt: string,
    templateId: string,
  ) => void | Promise<void>;
  /** Re-spawn a failed workflow phase agent (#825 / #830). */
  onRetryWorkflowAgent?: (agentId: string) => void | Promise<void>;
  onSaveWorkflow: (template: WorkflowSaveInput) => Promise<WorkflowTemplateInfo>;
  onRemoveWorkflow: (id: string) => Promise<void>;
  workflowListError?: string | null;
  onRetryWorkflows?: () => void | Promise<void>;
  onStopRun: () => void | Promise<void>;
  /** Resume a parked quota-wait now (#462). */
  onResumeQuotaWait?: () => void | Promise<void>;
  /** Per-thread auto-resume override. null inherits the global setting. */
  onSetQuotaWaitAutoResume?: (
    enabled: boolean | null,
  ) => void | Promise<void>;
  /** Follow-up typed during the run, waiting for it to land (issue #92). */
  queuedPrompt?: string | null;
  /** Per-thought list when persisted (#809); else the strip splits prompt once. */
  queuedItems?: string[] | null;
  /** The queue row's files: per item when persisted (#1512). */
  queuedFiles?: {
    itemAttachments?: AttachmentInfo[][];
    attachments?: AttachmentInfo[];
  } | null;
  /** Last delivery failure; the prompt is still queued (issue #314). */
  queuedError?: string | null;
  /** Drop the queued follow-up. */
  onCancelQueued?: () => void;
  /** Re-send a queued prompt after a delivery failure. */
  onRetryQueued?: () => void;
  /** Steer queued item `index` into the live turn (#1501). */
  onSteerQueued?: (index: number) => void;
  /** Replace the queued follow-up's text (edit in the strip, issue #364 / #809). */
  onEditQueued?: (
    prompt: string,
    items?: string[],
    itemAttachments?: AttachmentInfo[][],
  ) => void | Promise<void>;
  /**
   * Text a cancelled queue pushed back toward the composer (issue #364).
   * Passed through to Composer, which applies it only onto an empty draft.
   */
  restoreDraft?: { threadId: string; text: string } | null;
  onSetPermissionMode: (
    mode: PermissionMode,
    threadId?: string,
  ) => void | Promise<void>;
  /** Answer the pending permission prompt (detail.pendingPermission). */
  onRespondPermission: (
    requestId: string,
    decision: PermissionDecision,
    answers?: Record<string, string>,
    updatedCommand?: string,
    inputValues?: InputValues,
    feedback?: string,
  ) => void | Promise<void>;
  /** "Implement in a new thread" from the plan prompt (#1501). */
  onImplementPlan?: (plan: string) => void | Promise<void>;
  /** "Save plan to file" from the plan prompt; resolves the path (#1501). */
  onSavePlan?: (plan: string) => Promise<string>;
  /**
   * Dismiss the persisted question card (thread.pendingQuestion) without
   * answering (issue #647). Answering goes through onStartRun instead.
   */
  onClearQuestion: () => void | Promise<void>;
  onSetProvider: (input: {
    provider?: string;
    model?: string | null;
  }) => void | Promise<void>;
  onSetReasoningEffort: (
    effort: ReasoningEffort | null,
    threadId?: string,
  ) => void | Promise<void>;
  onSetWebSearch?: (webSearch: boolean, threadId?: string) => void | Promise<void>;
  /** Archive or unarchive the open thread. */
  onSetArchived: (archived: boolean) => void | Promise<void>;
  /** Per-thread inbound policy for messages from other threads (issue #551). */
  onSetCrossThreadInbound?: (
    policy: "accept" | "queue-only" | "refuse",
  ) => void | Promise<void>;
  /** Rename the open thread (header overflow). */
  onRenameThread?: (title: string) => void | Promise<void>;
  /**
   * New thread in this project, same default as the sidebar "New thread"
   * button (Settings defaultWorktree / orchestrator; remotes stay plain).
   */
  onCreateThread?: (
    projectId?: string,
    opts?: { worktree?: boolean; orchestrate?: boolean; teach?: boolean; ask?: boolean; issueNumber?: number | null },
  ) => void;
  /** Seed an automation from this thread's first prompt (#285). */
  onRepeatSchedule?: () => void;
  /** Distill this thread into a workflow draft for review (#285). */
  onDistillWorkflow?: () => void;
  /** Save scratch notes for a thread (header notes editor, issues #194 / #935). */
  onSetNotes?: (threadId: string, notes: string) => void | Promise<void>;
  /** Replace the per-thread transcript bookmark list (issue #1217). */
  onSetMessagePins?: (
    threadId: string,
    pins: ThreadMessagePin[],
  ) => void | Promise<void>;
  /** Turn spec mode on for a thread that has no spec yet (issue #269). */
  onStartSpec?: (threadId: string) => void | Promise<void>;
  /** Leave spec mode without approving remaining stages (issue #500). */
  onStopSpec?: (threadId: string) => void | Promise<void>;
  /** Answer the spec stage gate. */
  onReviewSpec?: (
    threadId: string,
    decision: "approve" | "revise",
    feedback?: string,
  ) => void | Promise<void>;
  /** Dispatch the current tasks.md wave as parallel workers (issue #537). */
  onDispatchSpec?: (threadId: string) => void | Promise<void>;
  /** Start a converge run that appends missing tasks.md checkboxes. */
  onConvergeSpec?: (threadId: string) => void | Promise<void>;
  /** Read the current spec artifact off disk. */
  onSpecArtifact?: (
    threadId: string,
    stage: SpecArtifact,
  ) => Promise<{ path: string; text: string | null }>;
  /** Turn Teach mode on (issue #373). */
  onStartTeach?: (threadId: string) => void | Promise<void>;
  /** Turn Teach mode off. */
  onStopTeach?: (threadId: string) => void | Promise<void>;
  /** Ask the agent to review the human's TODO(human) fills. */
  onRequestTeachReview?: (threadId: string) => void | Promise<void>;
  /** Turn Ask mode on (issue #392). */
  onStartAsk?: (threadId: string) => void | Promise<void>;
  /** Turn Ask mode off. worktree: true is Start work. */
  onStopAsk?: (
    threadId: string,
    opts?: { worktree?: boolean },
  ) => void | Promise<void>;
  /** Drop a `/btw` side-question card (issue #471). */
  onDismissBtw?: (threadId: string, id: string) => void | Promise<void>;
  /** Queue a side question as a follow-up and drop the card. */
  onPromoteBtw?: (threadId: string, id: string) => void | Promise<void>;
  /**
   * Record the one-tap felt estimate for a finished thread (issue #401).
   * savedMs null = the user declined.
   */
  onSetFeltEstimate?: (
    threadId: string,
    savedMs: number | null,
  ) => void | Promise<void>;
  /** Settings.defaultWorktree — Start work arms a pending worktree when set. */
  defaultWorktree?: boolean;
  /** Permanently delete the open thread (caller already confirmed in UI). */
  onDeleteThread: () => void | Promise<void>;
  /** Git pane open (lifted so Environment / next-git / /review can open it). */
  changesOpen: boolean;
  /** Bumps on each open request so a re-open reloads the diff. */
  changesNonce: number;
  onCloseChanges: () => void;
  /** Opens the Git pane (same path as the Environment tab). */
  onViewChanges?: () => void;
  /** Shell session for the Terminal pane (#147). */
  terminalApi?: TerminalApi;
  /** Show the Terminal pane on this shell (Sign in, #1501). */
  terminalReveal?: { nonce: number; termId: string; threadId: string } | null;
  /** Tree, preview and open-in for the Files pane (#1506). */
  filesApi?: FilesPaneApi;
  /**
   * Fires whenever the workspace holds more than one pane. App collapses
   * the agents rail so the panes get the width.
   */
  onPanesNeedRoom?: () => void;
  /** Per-checkpoint-pair shortstat for review bars. */
  runStats?: (threadId: string) => Promise<RunStatInfo[]>;
  /** Checkpoint-to-checkpoint patch for a turn's Review panel (#148). */
  onFetchTurnDiff?: (threadId: string, sha: string) => Promise<DiffResult>;
  /** Hard-reset the worktree to a checkpoint (Undo confirm). */
  restoreCheckpoint?: (threadId: string, sha: string) => Promise<void>;
  onFetchDiff: () => Promise<DiffResult>;
  /** Code-index symbols + author annotation + accepted hunks (issue #421). */
  onFetchReviewContext?: () => Promise<{
    annotation: unknown;
    symbols: ReviewSymbol[];
    acceptedHunks: string[];
  }>;
  /** Persist hunk hashes the user marked as reviewed. */
  onSetReviewAccepted?: (hashes: string[]) => Promise<void>;
  /** Commit the staged paths (or all files when `paths` is omitted). */
  onCommitChanges: (
    message: string,
    paths?: string[],
  ) => Promise<{ subject: string }>;
  /** Keep the Git-tab merge in sync with the pane's staged path list. */
  onStagedPathsChange?: (paths: string[] | null) => void;
  /** Discard one changed file (untracked deletes the file). */
  onRevertFile: (path: string, status: string) => Promise<{ path: string }>;
  /** Draft a commit message with the thread's provider. */
  onSuggestCommitMessage: () => Promise<{ message: string }>;
  /** File lookup for the composer @-mention popup. */
  onListFiles?: (query: string) => Promise<string[]>;
  /** Native folder picker; returns an absolute path or null. */
  onPickDirectory?: () => Promise<string | null>;
  /** AppSnap: on-screen windows the user can capture. */
  onListSnapWindows?: () => Promise<Array<{ id: string; name: string }>>;
  /** AppSnap: capture one window into an attachment for this thread. */
  onCaptureSnapWindow?: (
    sourceId: string,
  ) => Promise<AttachmentInfo | null>;
  /** CLI skills and custom commands for the composer `/` palette (#606). */
  onListCliCommands?: (input?: {
    provider?: string;
    projectPath?: string;
  }) => Promise<CliSlashCommand[]>;
  /** Resolve transcript path tokens against the thread worktree. */
  onResolvePaths?: (
    paths: string[],
  ) => Promise<Array<{ path: string; abs: string | null }>>;
  /** Open or reveal a resolved worktree path. */
  onOpenWorkspacePath?: (
    abs: string,
    opts?: { reveal?: boolean; line?: number; col?: number },
  ) => void | Promise<void>;
  /** Loads an image a tool returned (ToolCallInfo.images) as a data URL. */
  onLoadImage?: (name: string) => Promise<string | null>;
  /** Native file/image/folder picker for composer attachments (Electron only). */
  onPickAttachments?: (opts?: {
    includeImages?: boolean;
  }) => Promise<AttachmentInfo[]>;
  /** Web folder pick (showDirectoryPicker → saveFolder). */
  onPickFolderAttachments?: () => Promise<AttachmentInfo[]>;
  /** Persist a pasted image; returns its attachment or null when rejected. */
  onSaveAttachmentImage?: (dataUrl: string) => Promise<AttachmentInfo | null>;
  /** Loads one attached image (absolute path) as a data URL. */
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
  /** Classify drag-dropped files into attachments. */
  onDropAttachmentFiles?: (
    files: File[],
    folders?: DroppedFolder[],
  ) => Promise<AttachmentInfo[]>;
  /** Embedded Browser pane (issue #155). Absent hides screenshot-to-composer. */
  preview?: CoderApi["preview"] | null;
  /** Desktop-only iOS Simulator pane (#248). */
  simulator?: CoderApi["simulator"] | null;
  simulatorStatus?: SimulatorStatus | null;
  devServerStatus?: (threadId: string) => Promise<DevServerState>;
  listLocalServers?: (threadId: string) => Promise<LocalServerInfo[]>;
  /** Push the thread's current branch to origin. */
  onPush: () => Promise<{ remote: string; branch: string }>;
  /**
   * Open (or re-return) a GitHub PR for this thread. When omitted, Create PR
   * falls back to asking the agent via createPrPrompt.
   */
  onCreatePr?: (input: {
    title: string;
    body?: string;
    draft?: boolean;
    /** Override the PR-size cap for this creation (issue #402). */
    allowOversize?: boolean;
  }) => Promise<PrInfo>;
  /** Repo PULL_REQUEST_TEMPLATE for the create-PR composer. */
  onPrTemplate?: (projectPath: string) => Promise<PrTemplateResult>;
  /** CI checks for the current PR. Failures stay in-band. */
  onPrChecks?: () => Promise<PrChecksResult>;
  /** Look up the branch's PR on GitHub and record it on the thread. */
  onPrStatus?: () => Promise<PrInfo | null>;
  /** Squash-merge the current OPEN PR. Pass ciWorkflowApproved after sign-off. */
  onPrMerge?: (opts?: {
    ciWorkflowApproved?: boolean;
    method?: MergeMethod;
    auto?: boolean;
  }) => Promise<PrInfo>;
  /** Upstream state for the header sync pill; absent hides the pill. */
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  /** Fetch remotes before the sync pill re-reads state. */
  gitFetch?: (threadId: string) => Promise<void>;
  /** Isolated worktree setup (header control, #680). */
  onSetupWorktree?: () => Promise<unknown>;
  onMergeWorktree?: (opts?: {
    ciWorkflowApproved?: boolean;
  }) => Promise<unknown>;
  /** Crew worker: open the lead Integration view instead of merging here. */
  onOpenCrewLead?: (leadId: string) => void;
  onRemoveWorktree?: (force?: boolean) => Promise<unknown>;
  /** Local branches for the post-create stacked-base picker (#187). */
  listBaseBranches?: (
    projectId: string,
  ) => Promise<{ defaultBranch: string; branches: string[] }>;
  /** Change the recorded merge/PR base after create (#187). */
  onSetBaseBranch?: (
    threadId: string,
    baseBranch: string | null,
  ) => void | Promise<void>;
  /** Right (agents) panel state + toggle for the header button (⌘.). */
  agentsPanelOpen?: boolean;
  onToggleAgentsPanel?: () => void;
  /** Draft workspace strip: arm or drop the lazy worktree before first send. */
  onSetPendingWorktree?: (
    threadId: string,
    worktree: boolean,
    fromOrigin?: boolean,
  ) => Promise<void>;
  /** New-thread hero: projects for the "What should we build in …?" chooser. */
  heroProjects?: readonly ProjectInfo[];
  /** Move a draft to another project from the hero chooser. */
  onMoveDraftToProject?: (threadId: string, projectId: string) => void;
  /** "or start without a project": move the draft into Scratch (#1411). */
  onStartWithoutProject?: (threadId: string) => void;
  /** Draft strip "Previous worktree" source (latest other worktree thread). */
  previousWorktree?: { branch: string; title: string } | null;
  /** Unmerged worktree files plus capped conflict-marker snippets. */
  conflictContext?: (threadId: string) => Promise<ConflictContext>;
  /** Open the thread worktree in the configured editor. */
  onOpenWorktree?: () => void | Promise<void>;
  /** Thread details "Open in ‹editor› ▾" (#1411). */
  listEditors?: () => Promise<EditorOption[]>;
  onOpenWorktreeIn?: (editor: EditorId) => void | Promise<void>;
  /** orchWorker: jump to the lead Integration section (issue #982). */
  onOpenCrewIntegration?: (leadThreadId: string) => void;
  /**
   * Direct orchWorker children of this thread. 0/absent hides the header
   * Workers control. Count is resolved in App so this pane is not passed
   * the full list (issue #91).
   */
  workerCount?: number;
  /** Open the Agents Team / Integration surface for this orchestrator. */
  onOpenWorkers?: () => void;
  /** Retarget this idle worker onto the lead's current committed HEAD. */
  onRefreshWorkerSnapshot?: (
    threadId: string,
  ) => void | Promise<void>;
  /**
   * Run the project's setup command or a named quick action (issue #153).
   * trustRepoConfig approves the project's solenta.json commands (#1506).
   */
  onRunCommand?: (
    threadId: string,
    actionId?: string,
    trustRepoConfig?: string,
  ) => Promise<unknown>;
  runError?: string | null;
  onDismissRunError?: () => void;
  /**
   * Fork / hand off the open thread (round 49). Plain call = same harness;
   * pass provider for hand-off.
   */
  onFork?: (
    opts?: { provider?: string; model?: string | null },
  ) => void | Promise<void | ThreadInfo | null>;
  /**
   * Start a suggested-work chip as a new thread (issue #550). Caller forks
   * with its own worktree and starts the suggestion prompt there.
   */
  onStartSuggestion?: (s: WorkSuggestion) => void | Promise<void>;
  /**
   * File a suggested-work chip on the planboard (`gh issue create`).
   */
  onFileSuggestion?: (s: WorkSuggestion) => void | Promise<void>;
  /** Dismiss a suggested-work chip for this thread. Permanent. */
  onDismissSuggestion?: (s: WorkSuggestion) => void | Promise<void>;
  /**
   * The thread this one was handed off from (handoffFrom), already resolved.
   * Resolved by App rather than passing the whole list: the list gets a new
   * identity on every stream tick, which would defeat the memo (issue #91).
   */
  handoffSource?: ThreadInfo | null;
  /** Select another thread (provenance chip → source). */
  onSelectThread?: (id: string) => void;
  /** Same-project thread id → title; those ids link in replies (#1531). */
  threadTitles?: Record<string, string>;
  /**
   * Report/board the user left to open this thread (#942). Back restores
   * that view; omitted when the thread was opened from the sidebar.
   */
  returnToView?: ReturnableView | null;
  onReturnToView?: () => void;
  /**
   * Same-task siblings (best-of-N / forks) for the divergence compare
   * (issue #393). Resolved in App so this pane is not passed the full list.
   */
  comparePeers?: ComparePeer[];
  /** Load a sibling transcript without marking it visited. */
  onPeekThread?: (id: string) => Promise<ThreadDetail>;
  /** Fired when the composer model picker opens (provider list refresh). */
  onModelPickerOpen?: () => void;
  /** Sign in a signed-out provider from the picker (#1501). */
  onProviderSignIn?: (providerId: string) => Promise<void>;
  loadProviderLimits?: ProviderLimitsLoader;
  /** Seeded demo quotas for browser preview. */
  quotaDemo?: boolean;
  /** Create a new thread in the current project (`/new`, `/clear`). */
  onNewThread?: () => void;
  /** Settle the open thread (`/clear`). Does not delete. */
  onSettleThread?: () => void | Promise<void>;
}

export { formatQuestionAnswer } from "../questionAnswer";
export { diffLineTotals } from "./thread/NextGitActionButton";

function planTextOf(detail: ThreadDetail | null | undefined): string {
  if (!detail) return "";
  const t = detail.thread;
  const parts: string[] = [];
  if (t.plan) parts.push(t.plan);
  if (t.planSteps && t.planSteps.length > 0) {
    parts.push(t.planSteps.map((s) => s.step).join("\n"));
  }
  const firstUser = detail.messages.find((m) => m.role === "user");
  if (firstUser?.text) parts.push(firstUser.text);
  return parts.join("\n\n");
}

/**
 * memo'd: only the OPEN thread's stream should re-render this pane. Four other
 * threads streaming in the sidebar used to re-render it every 700ms each
 * (issue #91) — hence `handoffSource` rather than the whole thread list.
 */
export const ThreadView = memo(function ThreadView({
  detail,
  revealMessageId = null,
  detailError = null,
  onRetryDetail,
  project,
  providers,
  agentProfiles = [],
  workflows,
  hasProjects,
  onAddProject,
  onStartRun,
  onRewindAndResubmit,
  onStartWorkflow,
  onRetryWorkflowAgent,
  onSaveWorkflow,
  onRemoveWorkflow,
  workflowListError = null,
  onRetryWorkflows,
  onStopRun,
  onResumeQuotaWait,
  onSetQuotaWaitAutoResume,
  queuedPrompt = null,
  queuedItems: queuedItemsProp = null,
  queuedFiles: queuedFilesProp = null,
  queuedError = null,
  onCancelQueued,
  onRetryQueued,
  onSteerQueued,
  onEditQueued,
  restoreDraft = null,
  onSetPermissionMode,
  onRespondPermission,
  onImplementPlan,
  onSavePlan,
  onClearQuestion,
  onSetProvider,
  onSetReasoningEffort,
  onSetWebSearch,
  onSetArchived,
  onSetCrossThreadInbound,
  onRenameThread,
  onCreateThread,
  onRepeatSchedule,
  onDistillWorkflow,
  onSetNotes,
  onSetMessagePins,
  onStartSpec,
  onStopSpec,
  onReviewSpec,
  onDispatchSpec,
  onConvergeSpec,
  onSpecArtifact,
  onStartTeach,
  onStopTeach,
  onRequestTeachReview,
  onStartAsk,
  onStopAsk,
  onDismissBtw,
  onPromoteBtw,
  onSetFeltEstimate,
  defaultWorktree = false,
  onDeleteThread,
  changesOpen,
  changesNonce,
  onCloseChanges,
  onViewChanges,
  terminalApi,
  terminalReveal = null,
  filesApi,
  onPanesNeedRoom,
  runStats,
  onFetchTurnDiff,
  restoreCheckpoint,
  onFetchDiff,
  onFetchReviewContext,
  onSetReviewAccepted,
  onCommitChanges,
  onStagedPathsChange,
  onRevertFile,
  onSuggestCommitMessage,
  onListFiles,
  onPickDirectory,
  onListSnapWindows,
  onCaptureSnapWindow,
  onListCliCommands,
  onResolvePaths,
  onOpenWorkspacePath,
  onLoadImage,
  onPickAttachments,
  onPickFolderAttachments,
  onSaveAttachmentImage,
  onLoadAttachmentImage,
  onDropAttachmentFiles,
  preview,
  simulator,
  simulatorStatus,
  devServerStatus,
  listLocalServers,
  onPush,
  onCreatePr,
  onPrTemplate,
  onPrChecks,
  onPrStatus,
  onPrMerge,
  gitSyncInfo,
  gitFetch,
  onSetupWorktree,
  onMergeWorktree,
  onOpenCrewLead,
  onRemoveWorktree,
  listBaseBranches,
  onSetBaseBranch,
  onSetPendingWorktree,
  previousWorktree,
  heroProjects,
  onMoveDraftToProject,
  onStartWithoutProject,
  agentsPanelOpen,
  onToggleAgentsPanel,
  conflictContext,
  onOpenWorktree,
  listEditors,
  onOpenWorktreeIn,
  onOpenCrewIntegration,
  workerCount = 0,
  onOpenWorkers,
  onRefreshWorkerSnapshot,
  onRunCommand,
  runError = null,
  onDismissRunError,
  onNewThread,
  onSettleThread,
  onFork,
  onStartSuggestion,
  onFileSuggestion,
  onDismissSuggestion,
  handoffSource = null,
  onSelectThread,
  threadTitles,
  returnToView = null,
  onReturnToView,
  comparePeers = EMPTY_COMPARE_PEERS,
  onPeekThread,
  onModelPickerOpen,
  onProviderSignIn,
  loadProviderLimits,
  quotaDemo = false,
}: ThreadViewProps) {
  useEffect(preloadPanesWhenIdle, []);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dropHostRef = useRef<HTMLElement>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const stickToBottom = useRef(true);
  /**
   * Thread switch (#83 loading gap) and a new permission card both remount
   * or grow the transcript, then Chrome fires a delayed scroll that is not
   * a user scroll-up. Keep pinning until a pin actually moves scrollTop
   * onto the bottom; a leftover scroll must not clear stickToBottom (#607).
   */
  const forceStick = useRef(false);
  const prevThreadId = useRef<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const detailsRef = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renamingRef = useRef(false);
  const {
    editingQueued,
    setEditingQueued,
    queuedEditDraft,
    setQueuedEditDraft,
    queuedEditSaving,
    queuedEditError,
    setQueuedEditError,
    queuedWritePending,
    queuedWriteError,
    queuedItems,
    queuedFiles,
    writeQueuedItems,
    closeQueuedEdit,
    saveQueuedEdit,
  } = useQueuedEdit({
    detail,
    queuedPrompt,
    queuedItemsProp,
    queuedFilesProp,
    onEditQueued,
    onCancelQueued,
  });
  // Reorder/remove write index orders so files move with their item (#1512).
  const queuedOrder = queuedItems.map((_, j) => j);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesSaving, setNotesSaving] = useState(false);
  const notesOpenRef = useRef(false);
  const notesDraftRef = useRef("");
  notesDraftRef.current = notesDraft;
  /** Thread ids with an in-flight setNotes write. */
  const notesSavingIdsRef = useRef(new Set<string>());
  /** Thread the open panel belongs to, plus the last confirmed saved value. */
  const notesSourceRef = useRef<{ id: string; saved: string } | null>(null);
  /** Failed (or in-flight outgoing) drafts keyed by thread id (#935). */
  const notesFailedRef = useRef<Record<string, { draft: string; error: string }>>(
    {},
  );
  const [pinDraft, setPinDraft] = useState<ThreadMessagePin[] | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSaving, setPinSaving] = useState(false);
  const [pinLabelId, setPinLabelId] = useState<string | null>(null);
  const [pinLabelDraft, setPinLabelDraft] = useState("");
  // Shared reveal target for pinned messages and reply-source navigation.
  const [jumpMessageId, setJumpMessageId] = useState<string | null>(null);
  const pinDraftRef = useRef<ThreadMessagePin[] | null>(null);
  pinDraftRef.current = pinDraft;
  const pinWriteGenRef = useRef<Record<string, number>>({});
  const pinInFlightRef = useRef<Record<string, number>>({});
  const pinFailedRef = useRef<
    Record<string, { pins: ThreadMessagePin[]; error: string }>
  >({});
  const pinPendingRef = useRef<Record<string, ThreadMessagePin[]>>({});
  const currentThreadIdRef = useRef<string | null>(detail?.thread.id ?? null);
  currentThreadIdRef.current = detail?.thread.id ?? null;
  /**
   * Provenance chip dismissed for this open (not persisted). Reset when the
   * open thread changes.
   */
  const [handoffBannerDismissed, setHandoffBannerDismissed] = useState(false);
  const [runStatList, setRunStatList] = useState<RunStatInfo[]>([]);
  const [openTurnSha, setOpenTurnSha] = useState<string | null>(null);
  // One split/unified choice for the turn panel and the Git pane (#1493).
  const turnDiffMode: DiffViewMode = useDiffSplit() ? "split" : "unified";
  const openThreadId = detail?.thread.id ?? null;
  useEffect(() => {
    setOpenTurnSha(null);
  }, [openThreadId]);
  const [restoreConfirm, setRestoreConfirm] = useState<ReviewBar | null>(null);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const reviewUndoDialogRef = useRef<HTMLDivElement>(null);
  const [rewindConfirm, setRewindConfirm] = useState<{
    messageId: string;
    prompt: string;
  } | null>(null);
  const rewindDialogRef = useRef<HTMLDivElement>(null);
  const [rewindRestoreFiles, setRewindRestoreFiles] = useState(false);
  const [rewindPending, setRewindPending] = useState(false);
  /** Header context breakdown; `/context` pins this open. */
  const [contextOpen, setContextOpen] = useState(false);
  /** Provider account quotas; `/usage` opens this even with no ring. */
  const [quotaOpen, setQuotaOpen] = useState(false);
  /** Runs collapsed by the user; everything else stays open. */
  const [collapsedRuns, setCollapsedRuns] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  /** Settled Focus turns the user opened; live turns stay open without this. */
  const [expandedFocusTurns, setExpandedFocusTurns] = useState<
    ReadonlySet<string>
  >(() => new Set<string>());
  const [focusThreadId, setFocusThreadId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  /** Bumps after a successful push so the sync pill refetches. */
  const [syncRefreshNonce, setSyncRefreshNonce] = useState(0);
  /** Brief inline confirmation after copying the thread id. */
  const [copiedThreadId, setCopiedThreadId] = useState(false);
  /** Header quick action currently in flight (issue #153). */
  const [commandRunningId, setCommandRunningId] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  /** solenta.json command waiting on the approval card (#1506). */
  const [approveCommandId, setApproveCommandId] = useState<string | null>(null);
  /** Image opened in the lightbox; null when closed. */
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const copyFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadId = detail?.thread.id ?? null;
  if (threadId !== focusThreadId) {
    setFocusThreadId(threadId);
    setExpandedFocusTurns(new Set());
  }

  useEffect(() => {
    setCommandRunningId(null);
    setCommandError(null);
    setExpandedGroups(new Set());
    setQuotaOpen(false);
    setContextOpen(false);
  }, [threadId]);

  const cliCommands = useCliCommands({
    onListCliCommands,
    project,
    threadId,
    detail,
  });
  const [incomingHandoff, setIncomingHandoff] = useState<{
    threadId: string;
    items: AttachmentInfo[];
  } | null>(null);
  // #1206: bump during render so A→B→A cannot revive a save that
  // resolves between the new render and the reset effect.
  const screenshotHandoffGen = useRef(0);
  const screenshotHandoffThreadId = useRef(threadId);
  if (screenshotHandoffThreadId.current !== threadId) {
    screenshotHandoffThreadId.current = threadId;
    screenshotHandoffGen.current += 1;
  }
  const [replyByThread, setReplyByThread] = useState<
    Record<string, ReplyTarget>
  >({});
  const replyTo = threadId ? (replyByThread[threadId] ?? null) : null;
  const replySourceGone = replyTo
    ? replySourceUnavailable(
        replyTo,
        detail?.messages.find((m) => m.id === replyTo.messageId),
      )
    : false;
  const [snapOpen, setSnapOpen] = useState(false);
  const snapDialogRef = useRef<HTMLDivElement>(null);
  const [snapWindows, setSnapWindows] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);
  const [layoutThreadId, setLayoutThreadId] = useState<string | null>(threadId);
  const [layout, setLayout] = useState<LayoutNode>(() =>
    hydratePaneLayout(threadId, { openDiff: changesOpen }).layout,
  );
  const [focusedId, setFocusedId] = useState(
    () => hydratePaneLayout(threadId, { openDiff: changesOpen }).focusId,
  );
  if (threadId !== layoutThreadId) {
    const hydrated = hydratePaneLayout(threadId);
    setLayoutThreadId(threadId);
    setLayout(hydrated.layout);
    setFocusedId(hydrated.focusId);
  }
  const browserPaneOpen = hasPaneType(layout, "browser");
  const wasBrowserPaneOpen = useRef(browserPaneOpen);
  if (wasBrowserPaneOpen.current && !browserPaneOpen) {
    screenshotHandoffGen.current += 1;
  }
  wasBrowserPaneOpen.current = browserPaneOpen;

  const sessionImages = useMemo(
    () => sessionImagePathsFromMessages(detail?.messages ?? []),
    [detail?.messages],
  );

  const resolvePathMap = useCallback(
    async (paths: string[]) => {
      const rows = onResolvePaths
        ? await onResolvePaths(paths)
        : paths.map((p) => ({ path: p, abs: null as string | null }));
      const map: Record<string, string | null> = {};
      for (const r of rows) map[r.path] = r.abs;
      for (const p of paths) {
        if (!map[p] && sessionImages[p]) map[p] = sessionImages[p];
      }
      return map;
    },
    [onResolvePaths, sessionImages],
  );

  const threadLinks = useMemo(
    () =>
      threadTitles && onSelectThread
        ? { titles: threadTitles, open: onSelectThread }
        : null,
    [threadTitles, onSelectThread],
  );

  const handleOpenWorkspacePath = useCallback(
    (abs: string, opts?: { reveal?: boolean; line?: number; col?: number }) => {
      void onOpenWorkspacePath?.(abs, opts);
    },
    [onOpenWorkspacePath],
  );

  const runningAgents = useMemo(() => {
    if (!detail?.workflow) return 0;
    return detail.workflow.phases.reduce(
      (n, phase) =>
        n + phase.agents.filter((a) => a.status === "running").length,
      0,
    );
  }, [detail]);

  const timeline = useMemo(() => {
    if (!detail) return [];
    return buildTimeline(
      detail.messages,
      detail.workLog,
      detail.artifacts ?? [],
    );
  }, [detail]);

  /**
   * One integer: index of the first mounted timeline entry. Thread switches
   * reset to the tail window. Appends while stuck to the bottom advance it so
   * the mounted tail stays bounded (#1475); scrolled up, it stays put so the
   * content being read does not move. Show earlier / revealMessageId only
   * move it down.
   */
  const [windowThreadId, setWindowThreadId] = useState(threadId);
  const [windowStart, setWindowStart] = useState(() =>
    tailWindowStart(timeline),
  );
  const revealTargetId = revealMessageId ?? jumpMessageId;
  const revealIndex = useMemo(() => {
    if (!revealTargetId) return -1;
    return timeline.findIndex(
      (entry) =>
        entry.kind === "message" && entry.message.id === revealTargetId,
    );
  }, [timeline, revealTargetId]);

  const windowAt = clampWindowStart(
    ensureVisibleStart(
      threadId !== windowThreadId
        ? tailWindowStart(timeline)
        : stickToBottom.current
          ? Math.max(windowStart, tailWindowStart(timeline))
          : windowStart,
      revealIndex,
    ),
    timeline,
  );
  if (threadId !== windowThreadId) {
    setWindowThreadId(threadId);
    setWindowStart(windowAt);
    setJumpMessageId(null);
  } else if (windowAt !== windowStart) {
    setWindowStart(windowAt);
  }

  /**
   * Tail first (#1475): the first render of a thread mounts only the last
   * FIRST_PAINT_CHAR_BUDGET of message text, so the switch frame parses what
   * is on screen, not long answers far above it. The rest of the window
   * mounts in a transition after paint; useStickToBottom keeps it pinned
   * (#607). `start` is what is mounted, `windowAt` the window itself.
   */
  const fullWindowThread = useRef<string | null>(null);
  const [, setFullWindowTick] = useState(0);
  let start = windowAt;
  if (
    fullWindowThread.current !== threadId &&
    detail?.thread.id === threadId
  ) {
    const tail =
      revealIndex >= 0
        ? windowAt
        : Math.max(
            windowAt,
            tailWindowStart(timeline, TRANSCRIPT_WINDOW, FIRST_PAINT_CHAR_BUDGET),
          );
    if (tail === windowAt) fullWindowThread.current = threadId;
    else start = tail;
  }
  const tailOnly = start !== windowAt;
  const deferred = useRef({ timeline, from: windowAt, to: start });
  deferred.current = { timeline, from: windowAt, to: start };
  // Once per tail-only phase: streaming pushes re-render this view ~5/s, and
  // re-running would force a layout read per push (#1482) and restart the
  // idle chain.
  useLayoutEffect(() => {
    if (!tailOnly) return;
    const showAll = () => {
      fullWindowThread.current = threadId;
      setFullWindowTick((n) => n + 1);
    };
    const el = bodyRef.current;
    // A tail that doesn't fill the pane would grow visibly: mount it all now,
    // before paint.
    if (!el || el.scrollHeight <= el.clientHeight) {
      showAll();
      return;
    }
    // Parse the deferred answers one per idle slot, so a 35 KB answer's
    // ~20 ms parse never shares a frame with the mount, then mount them all
    // from the cache.
    const { timeline: entries, from, to } = deferred.current;
    const texts: string[] = [];
    for (let i = from; i < to; i++) {
      const entry = entries[i];
      if (entry?.kind === "message" && entry.message.role === "assistant") {
        texts.push(entry.message.text);
      }
    }
    // The timeout keeps a busy renderer (a stream elsewhere) from starving it.
    const idle = (cb: () => void) =>
      window.requestIdleCallback
        ? window.requestIdleCallback(cb, { timeout: 100 })
        : setTimeout(cb, 0);
    let live = true;
    const step = () => {
      if (!live) return;
      let text = texts.pop();
      while (text !== undefined && isParsed(text)) text = texts.pop();
      if (text === undefined) {
        startTransition(showAll);
        return;
      }
      preparseMarkdown(text);
      idle(step);
    };
    idle(step);
    return () => {
      live = false;
    };
  }, [tailOnly, threadId]);

  const visibleTimeline = start === 0 ? timeline : timeline.slice(start);
  const hiddenCount = start;
  const transcriptView = useTranscriptViewMode();
  const verboseTools = transcriptView === "verbose";
  const summaryMode = transcriptView === "summary";
  const isWorking = detail?.thread.status === "working";
  /** Queued items can be steered into the live turn only where the CLI takes stdin. */
  const canSteerQueued = Boolean(
    onSteerQueued &&
      isWorking &&
      providers.find((p) => p.id === detail?.thread.provider)?.supportsSteer,
  );
  /** Queued item being dragged to a new slot (#1501). */
  const [queuedDrag, setQueuedDrag] = useState<number | null>(null);
  const displayTimeline = useMemo(() => {
    if (summaryMode) {
      // Focus folds replace tool groups: keep groupable messages as plain
      // message entries so the per-turn fold in the message branch can hide
      // and re-expand them (#461). collapseTimeline would swallow them into
      // ToolGroupRow, which has no focus handling.
      const entries: DisplayEntry[] = [];
      for (const entry of visibleTimeline) {
        if (entry.kind === "worklog") continue;
        entries.push(
          entry.kind === "message"
            ? {
                kind: "message",
                message: entry.message,
                timestamp: entry.timestamp,
              }
            : entry,
        );
      }
      return entries;
    }
    return collapseTimeline(visibleTimeline, {
      working: detail?.thread.status === "working",
    });
  }, [visibleTimeline, detail?.thread.status, summaryMode]);

  /**
   * Stream-in gating: an entry plays its entrance animation only when it is
   * a genuinely new tail append. Thread switches seed the whole visible
   * timeline; prepends (Show earlier / revealMessageId) seed the newly
   * included slice — both before children mount, so neither animates.
   * Run-collapse remounts are covered because keys stay in the set.
   */
  const seenEntryKeys = useRef<Set<string>>(new Set());
  const seenEntryThread = useRef<string | null>(null);
  const prevTimelineStart = useRef(start);
  const timelineKey = (entry: TimelineEntry) => {
    if (entry.kind === "message") return entry.message.id;
    if (entry.kind === "artifacts") return `artifacts:${entry.key}`;
    return `worklog-${entry.runId}`;
  };
  if (threadId !== seenEntryThread.current) {
    seenEntryThread.current = threadId;
    seenEntryKeys.current = new Set([
      ...visibleTimeline.map(timelineKey),
      ...displayTimeline
        .filter((entry) => entry.kind === "group")
        .map((entry) => `group:${entry.group.id}`),
    ]);
  } else if (start < prevTimelineStart.current) {
    for (let i = start; i < prevTimelineStart.current; i++) {
      const entry = timeline[i];
      if (entry) seenEntryKeys.current.add(timelineKey(entry));
    }
    // A tool run cut by the old start re-keys once its head mounts.
    for (const entry of displayTimeline) {
      if (entry.kind === "group") {
        seenEntryKeys.current.add(`group:${entry.group.id}`);
      }
    }
  }
  prevTimelineStart.current = start;
  useLayoutEffect(() => {
    for (const entry of visibleTimeline) {
      seenEntryKeys.current.add(timelineKey(entry));
    }
    for (const entry of displayTimeline) {
      if (entry.kind === "group") {
        seenEntryKeys.current.add(`group:${entry.group.id}`);
      }
    }
  });

  useLayoutEffect(() => {
    if (!revealTargetId) return;
    const root = bodyRef.current;
    if (!root) return;
    const el = Array.from(root.querySelectorAll("[data-msg]")).find(
      (node) => node.getAttribute("data-msg") === revealTargetId,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [revealTargetId, start]);

  const {
    hiddenFocusActivity,
    focusTurnByFirstId,
    durationByRunId,
    headerByMessageId,
    provenanceById,
    latestRunningToolId,
    latestThinkingId,
    streamingMessageId,
    stalledAt,
    workingLabel,
  } = useTranscriptAnnotations({
    detail,
    timeline,
    summaryMode,
    isWorking,
    expandedFocusTurns,
    runningAgents,
  });
  const isArchived = Boolean(detail?.thread.archived);
  const emptyMessages = detail != null && detail.messages.length === 0;

  /** Header context ring; null hides it (unknown window or no measured turn). */
  const ring = useMemo(() => {
    if (!detail) return null;
    const modelId = detail.usage?.model ?? detail.thread.model;
    const used = detail.usage?.contextTokens ?? null;
    const view = contextRing({
      used,
      window: threadContextWindow(
        detail.usage?.contextWindow,
        providers,
        detail.thread.provider,
        modelId,
      ),
    });
    if (!view || used == null) return null;
    return {
      view,
      used,
      segments: contextBreakdown({
        messages: detail.messages,
        measured: used,
      }),
    };
  }, [detail, providers]);
  const handleForkFresh = useCallback(() => {
    if (isWorking || !onFork) return;
    void onFork();
  }, [isWorking, onFork]);
  // Provider-native compaction needs a live session; otherwise /compact
  // falls back to the fresh-context fork.
  const nativeCompact =
    Boolean(detail?.thread.sessionId) &&
    NATIVE_COMPACT_PROVIDERS.includes(detail?.thread.provider ?? "");
  const handleCompact = useCallback(() => {
    if (isWorking) return;
    if (nativeCompact) void onStartRun("/compact");
    else handleForkFresh();
  }, [isWorking, nativeCompact, onStartRun, handleForkFresh]);
  const hasTimeline = timeline.length > 0;
  const hasWorktree = Boolean(detail?.thread.worktreePath);
  const worktree = useWorktreeChrome({
    thread:
      onSetupWorktree && onMergeWorktree && onRemoveWorktree
        ? (detail?.thread ?? null)
        : null,
    project,
    isWorking,
    onSetupWorktree: onSetupWorktree ?? (async () => {}),
    onMergeWorktree: onMergeWorktree ?? (async () => {}),
    onOpenCrewLead,
    onRemoveWorktree: onRemoveWorktree ?? (async () => {}),
    onStartRun,
    conflictContext,
    onOpenWorktree: onOpenWorktree
      ? () => {
          void onOpenWorktree();
        }
      : null,
    listBaseBranches:
      listBaseBranches && project
        ? () => listBaseBranches(project.id)
        : undefined,
    onSetBaseBranch:
      onSetBaseBranch && detail?.thread
        ? (baseBranch) =>
            Promise.resolve(onSetBaseBranch(detail.thread.id, baseBranch))
        : undefined,
    onOpenCrewIntegration,
    listEditors,
    onOpenWorktreeIn: onOpenWorktreeIn
      ? (editor) => {
          void onOpenWorktreeIn(editor);
        }
      : undefined,
    onRefreshWorkerSnapshot:
      onRefreshWorkerSnapshot && detail?.thread
        ? () =>
            Promise.resolve(onRefreshWorkerSnapshot(detail.thread.id))
        : undefined,
  });

  const {
    retrySend,
    retryEventId,
    workflowRetryAgentId,
    overflowEventId,
    upgradeEventId,
    writerLockEventId,
    retryTitle,
  } = useRetryAnchors(detail);
  const handleRetry = useCallback(() => {
    if (isWorking) return;
    if (workflowRetryAgentId) {
      if (onRetryWorkflowAgent) void onRetryWorkflowAgent(workflowRetryAgentId);
      return;
    }
    if (!retrySend) return;
    void onStartRun(
      retrySend.text,
      undefined,
      retrySend.attachments,
      {
        fromQueue: true,
        ...(retrySend.fromNotice ? { fromNotice: true } : {}),
      },
    );
  }, [
    retrySend,
    isWorking,
    onStartRun,
    workflowRetryAgentId,
    onRetryWorkflowAgent,
  ]);

  const handleUpgradeCli = useCallback(() => {
    void navigator.clipboard?.writeText("codex update");
  }, []);

  const handleRequestResubmit = useCallback(
    (messageId: string, prompt: string) => {
      if (!onRewindAndResubmit || isWorking || rewindPending) return;
      setRewindRestoreFiles(false);
      setRewindConfirm({ messageId, prompt });
    },
    [onRewindAndResubmit, isWorking, rewindPending],
  );

  const handleRewindConfirm = useCallback(async () => {
    const pending = rewindConfirm;
    if (!pending || !onRewindAndResubmit || rewindPending || isWorking) return;
    setRewindPending(true);
    try {
      // Carry the original attachments, like Retry turn does: editing the
      // words of a message must not silently drop the images it came with.
      const source = detail?.messages.find((m) => m.id === pending.messageId);
      await onRewindAndResubmit(
        pending.messageId,
        pending.prompt,
        rewindRestoreFiles || undefined,
        source?.attachments,
      );
      setRewindConfirm(null);
    } catch {
      // Parent surfaces rejections via the runError banner. Keep the
      // editor and confirm so a rejected start is not a committed rewind
      // (#1202): retry or cancel from here.
    } finally {
      setRewindPending(false);
    }
  }, [
    rewindConfirm,
    onRewindAndResubmit,
    rewindPending,
    isWorking,
    rewindRestoreFiles,
    detail,
  ]);

  const handleRewindCancel = useCallback(() => {
    if (rewindPending) return;
    setRewindConfirm(null);
    setRewindRestoreFiles(false);
  }, [rewindPending]);

  useEscapeClose(Boolean(rewindConfirm) && !rewindPending, handleRewindCancel);
  useModalFocus(Boolean(rewindConfirm), rewindDialogRef);

  const handleSlashRewind = useCallback(() => {
    if (isWorking || rewindPending) return;
    const bars = detail
      ? mapReviewBars({
          messages: detail.messages,
          stats: runStatList,
          threadStatus: detail.thread.status,
        })
      : [];
    for (let i = bars.length - 1; i >= 0; i--) {
      const bar = bars[i];
      if (bar?.undoSha && restoreCheckpoint) {
        setRestoreError(null);
        setRestoreConfirm(bar);
        return;
      }
    }
    const lastUser = detail ? lastUserMessage(detail.messages) : null;
    if (lastUser && onRewindAndResubmit) {
      handleRequestResubmit(lastUser.id, lastUser.text);
    }
  }, [
    isWorking,
    rewindPending,
    detail,
    runStatList,
    restoreCheckpoint,
    onRewindAndResubmit,
    handleRequestResubmit,
  ]);

  const handleSlashClear = useCallback(async () => {
    if (isWorking) return;
    await onSettleThread?.();
    onNewThread?.();
  }, [isWorking, onSettleThread, onNewThread]);

  const handleSlashAction = useCallback(
    (action: SlashAction) => {
      if (action === "usage") {
        setContextOpen(false);
        setQuotaOpen(true);
        return;
      }
      if (action === "context") {
        setQuotaOpen(false);
        if (ring) setContextOpen(true);
        return;
      }
      if (action === "compact") {
        handleCompact();
        return;
      }
      if (action === "fork") {
        handleForkFresh();
        return;
      }
      if (action === "rewind") {
        handleSlashRewind();
        return;
      }
      if (action === "new") {
        onNewThread?.();
        return;
      }
      if (action === "review") {
        onViewChanges?.();
        return;
      }
      if (action === "clear") {
        void handleSlashClear();
      }
    },
    [
      ring,
      handleCompact,
      handleForkFresh,
      handleSlashRewind,
      onNewThread,
      handleSlashClear,
      onViewChanges,
    ],
  );

  const handleComposerSend = useCallback(
    (
      prompt: string,
      messageAttachments?: AttachmentInfo[],
      opts?: { steer?: boolean },
    ) => onStartRun(prompt, undefined, messageAttachments, opts),
    [onStartRun],
  );

  const storeReply = useCallback((target: ReplyTarget) => {
    const tid = target.threadId;
    if (!tid) return;
    setReplyByThread((prev) => ({ ...prev, [tid]: target }));
  }, []);

  const handleReply = useCallback(
    (message: ChatMessage) => {
      if (!threadId) return;
      const target = makeReplyTarget({
        messageId: message.id,
        threadId,
        text: message.text,
        kind: "message",
        sourceText: message.text,
      });
      if (target) storeReply(target);
    },
    [threadId, storeReply],
  );

  const handleCiteSelection = useCallback(
    (target: ReplyTarget) => {
      storeReply(target);
    },
    [storeReply],
  );

  const handleWaitWhat = useCallback(
    (message: ChatMessage) => {
      void onStartRun(waitWhatPrompt(message.text));
    },
    [onStartRun],
  );

  useCiteShortcut(detail, storeReply);

  const pickMentionFolder = useCallback(async () => {
    if (!onPickDirectory) return null;
    const dir = await onPickDirectory();
    if (!dir) return null;
    return repoRelativeDir(project?.path ?? "", dir);
  }, [onPickDirectory, project?.path]);

  const { attachBrowserScreenshot, captureAppSnap } = useAppSnap({
    onListSnapWindows,
    onCaptureSnapWindow,
    onSaveAttachmentImage,
    isArchived,
    snapOpen,
    setSnapOpen,
    setSnapWindows,
    setSnapError,
    snapBusy,
    setSnapBusy,
    snapDialogRef,
    setIncomingHandoff,
    screenshotHandoffGen,
    screenshotHandoffThreadId,
  });

  /**
   * Fork one thread per selected provider or profile, then start the same
   * prompt on each new fork. Sequential: a run cannot start until its fork
   * exists. Failures throw so Composer and the run-error banner both surface
   * them. Profile forks set effort then permission on the new thread before
   * the run, same order as pickProfile.
   */
  const runBestOfN = useCallback(
    async (selectedIds: string[], prompt: string) => {
      const current = detail?.thread;
      if (!current || !onFork) {
        throw new Error("Failed to start Best of N");
      }
      const availableIds = providers
        .filter((p) => p.available)
        .map((p) => p.id);
      const plan = buildBestOfNEntries(availableIds, selectedIds, agentProfiles);
      if (typeof plan === "string") throw new Error(plan);
      const created: string[] = [];
      for (const entry of plan) {
        const forked =
          entry.kind === "profile"
            ? await onFork({
                provider: entry.provider,
                model: entry.model,
              })
            : await onFork({ provider: entry.provider });
        if (!forked || typeof forked !== "object" || !forked.id) {
          throw new Error("Failed to fork thread");
        }
        created.push(forked.id);
        if (entry.kind === "profile") {
          await onSetReasoningEffort(entry.reasoningEffort, forked.id);
          await onSetPermissionMode(entry.permissionMode, forked.id);
        }
        await onStartRun(prompt, forked.id);
      }
      if (created[0]) onSelectThread?.(created[0]);
    },
    [
      agentProfiles,
      detail,
      onFork,
      onSelectThread,
      onSetPermissionMode,
      onSetReasoningEffort,
      onStartRun,
      providers,
    ],
  );

  /**
   * Delegation command ("@provider task" in the composer): fork the open
   * thread onto the named provider, start the task on the fork, then select
   * it so the user watches it run. Same fork-then-run sequence as Best of N.
   */
  const runDelegate = useCallback(
    async (providerId: string, task: string) => {
      if (!detail?.thread || !onFork) {
        throw new Error("Failed to delegate");
      }
      const forked = await onFork({ provider: providerId });
      if (!forked || typeof forked !== "object" || !forked.id) {
        throw new Error("Failed to fork thread");
      }
      await onStartRun(task, forked.id);
      onSelectThread?.(forked.id);
    },
    [detail, onFork, onSelectThread, onStartRun],
  );

  const rememberFailedNotes = (threadId: string, draft: string, error: string) => {
    notesFailedRef.current = {
      ...notesFailedRef.current,
      [threadId]: { draft, error },
    };
  };

  const forgetFailedNotes = (threadId: string) => {
    if (!(threadId in notesFailedRef.current)) return;
    const next = { ...notesFailedRef.current };
    delete next[threadId];
    notesFailedRef.current = next;
  };

  const persistNotes = async (
    threadId: string,
    notes: string,
    closeOnSuccess: boolean,
  ) => {
    const session = notesSourceRef.current;
    const applySuccess = () => {
      const held = notesFailedRef.current[threadId];
      if (!held || held.draft === notes) forgetFailedNotes(threadId);
      const open = notesSourceRef.current;
      if (open?.id !== threadId || notesDraftRef.current.trim() !== notes) {
        return;
      }
      // Same text is now confirmed; an unchanged close must not rewrite.
      notesSourceRef.current = { id: threadId, saved: notes };
      if (closeOnSuccess && open === session) {
        notesOpenRef.current = false;
        notesSourceRef.current = null;
        setNotesOpen(false);
        setNotesError(null);
      }
    };
    if (!onSetNotes) {
      applySuccess();
      return;
    }
    if (notesSavingIdsRef.current.has(threadId)) return;
    notesSavingIdsRef.current.add(threadId);
    if (notesSourceRef.current?.id === threadId) {
      setNotesSaving(true);
      setNotesError(null);
    }
    try {
      await onSetNotes(threadId, notes);
      applySuccess();
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : String(err);
      const held = notesFailedRef.current[threadId];
      if (!held || held.draft === notes) {
        rememberFailedNotes(threadId, notes, message);
      }
      if (
        notesSourceRef.current?.id === threadId &&
        notesOpenRef.current &&
        notesDraftRef.current.trim() === notes
      ) {
        setNotesError(message);
      }
    } finally {
      notesSavingIdsRef.current.delete(threadId);
      if (notesSourceRef.current?.id === threadId) {
        setNotesSaving(false);
      }
    }
  };

  const rememberFailedPins = (
    threadId: string,
    pins: ThreadMessagePin[],
    error: string,
  ) => {
    pinFailedRef.current = {
      ...pinFailedRef.current,
      [threadId]: { pins, error },
    };
  };

  const forgetFailedPins = (threadId: string) => {
    if (!(threadId in pinFailedRef.current)) return;
    const next = { ...pinFailedRef.current };
    delete next[threadId];
    pinFailedRef.current = next;
  };

  const persistPins = async (threadId: string, pins: ThreadMessagePin[]) => {
    const gen = (pinWriteGenRef.current[threadId] ?? 0) + 1;
    pinWriteGenRef.current[threadId] = gen;
    pinPendingRef.current[threadId] = pins;
    pinInFlightRef.current[threadId] =
      (pinInFlightRef.current[threadId] ?? 0) + 1;
    if (currentThreadIdRef.current === threadId) {
      setPinSaving(true);
      setPinError(null);
    }
    try {
      if (!onSetMessagePins) return;
      await onSetMessagePins(threadId, pins);
      if (pinWriteGenRef.current[threadId] !== gen) return;
      forgetFailedPins(threadId);
      delete pinPendingRef.current[threadId];
      if (currentThreadIdRef.current === threadId) {
        const held = pinDraftRef.current;
        if (!held || JSON.stringify(held) === JSON.stringify(pins)) {
          pinDraftRef.current = null;
          setPinDraft(null);
        }
        setPinError(null);
      }
    } catch (err) {
      if (pinWriteGenRef.current[threadId] !== gen) return;
      const message =
        err instanceof Error && err.message ? err.message : String(err);
      rememberFailedPins(threadId, pins, message);
      if (currentThreadIdRef.current === threadId) {
        setPinError(message);
      }
    } finally {
      pinInFlightRef.current[threadId] = Math.max(
        0,
        (pinInFlightRef.current[threadId] ?? 1) - 1,
      );
      if (
        currentThreadIdRef.current === threadId &&
        (pinInFlightRef.current[threadId] ?? 0) === 0
      ) {
        setPinSaving(false);
      }
    }
  };

  useEffect(() => {
    const id = detail?.thread.id ?? null;
    if (id !== prevThreadId.current) {
      const source = notesSourceRef.current;
      const outgoingDraft = notesDraft.trim();
      const wasOpen = notesOpenRef.current;
      const alreadySaving = source
        ? notesSavingIdsRef.current.has(source.id)
        : false;
      prevThreadId.current = id;
      stickToBottom.current = true;
      setMenuOpen(false);
      setDetailsOpen(false);
      setDeleteConfirm(false);
      setContextOpen(false);
      setRenaming(false);
      renamingRef.current = false;
      // Flush the outgoing thread's dirty draft (⌘J/K and any other
      // programmatic select skip the textarea blur). Write to the thread
      // we were editing, not the newly selected one. Keep a failed draft
      // keyed by that source id so reopen-after-navigate can retry (#935).
      if (wasOpen && source && outgoingDraft !== source.saved) {
        rememberFailedNotes(source.id, outgoingDraft, "");
        if (!alreadySaving) {
          void persistNotes(source.id, outgoingDraft, false);
        }
      }
      notesOpenRef.current = false;
      notesSourceRef.current = null;
      setNotesOpen(false);
      setNotesSaving(false);
      setNotesError(null);
      const incoming = detail?.thread.notes ?? "";
      notesDraftRef.current = incoming;
      setNotesDraft(incoming);
      const incomingId = id ?? "";
      const incomingPins =
        pinPendingRef.current[incomingId] ??
        pinFailedRef.current[incomingId]?.pins ??
        null;
      pinDraftRef.current = incomingPins;
      setPinDraft(incomingPins);
      setPinError(pinFailedRef.current[incomingId]?.error ?? null);
      setPinSaving(
        incomingId ? (pinInFlightRef.current[incomingId] ?? 0) > 0 : false,
      );
      setPinLabelId(null);
      setPinLabelDraft("");
      setJumpMessageId(null);
      setHandoffBannerDismissed(false);
      setRestoreConfirm(null);
      setRestorePending(false);
      setRestoreError(null);
      setRewindConfirm(null);
      setRewindRestoreFiles(false);
      setRewindPending(false);
      setRunStatList([]);
      setCollapsedRuns(new Set<string>());
      setSyncRefreshNonce(0);
      setCopiedThreadId(false);
      setLightbox(null);
      setIncomingHandoff(null);
      setSnapOpen(false);
      setSnapBusy(false);
      setSnapError(null);
      if (copyFlashTimer.current != null) {
        clearTimeout(copyFlashTimer.current);
        copyFlashTimer.current = null;
      }
    }
  }, [detail?.thread.id]);

  const {
    handlePaneChange,
    handleOpenPane,
    terminalLeaf,
    handleToggleTerminal,
    handleResetLayout,
  } = usePaneLayoutActions({
    threadId,
    layoutThreadId,
    layout,
    setLayout,
    focusedId,
    setFocusedId,
    changesOpen,
    changesNonce,
    terminalNonce:
      terminalReveal && terminalReveal.threadId === threadId ? terminalReveal.nonce : 0,
    onPanesNeedRoom,
    onCloseChanges,
    onViewChanges,
  });

  const refreshRunStats = useCallback(async () => {
    const threadId = detail?.thread.id;
    const wt = detail?.thread.worktreePath;
    if (!threadId || !wt || !runStats) {
      setRunStatList([]);
      return;
    }
    try {
      const list = await runStats(threadId);
      setRunStatList(list);
    } catch {
      setRunStatList([]);
    }
  }, [detail?.thread.id, detail?.thread.worktreePath, runStats]);

  useEffect(() => {
    let cancelled = false;
    const threadId = detail?.thread.id;
    const wt = detail?.thread.worktreePath;
    if (!threadId || !wt || !runStats) {
      setRunStatList([]);
      return;
    }
    void runStats(threadId)
      .then((list) => {
        if (!cancelled) setRunStatList(list);
      })
      .catch(() => {
        if (!cancelled) setRunStatList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [
    detail?.thread.id,
    detail?.thread.worktreePath,
    detail?.thread.status,
    detail?.messages.length,
    runStats,
  ]);

  const barByMessageId = useMemo(() => {
    const map = new Map<string, ReviewBar>();
    if (!detail) return map;
    for (const bar of mapReviewBars({
      messages: detail.messages,
      stats: runStatList,
      threadStatus: detail.thread.status,
    })) {
      map.set(bar.messageId, bar);
    }
    return map;
  }, [detail, runStatList]);

  const handleRestoreConfirm = async () => {
    const threadId = detail?.thread.id;
    const bar = restoreConfirm;
    if (
      !threadId ||
      !bar?.undoSha ||
      !restoreCheckpoint ||
      restorePending ||
      isWorking
    ) {
      return;
    }
    setRestorePending(true);
    setRestoreError(null);
    try {
      await restoreCheckpoint(threadId, bar.undoSha);
      setRestoreConfirm(null);
      await refreshRunStats();
      onViewChanges?.();
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : "Restore failed";
      setRestoreError(msg);
      setRestoreConfirm(null);
    } finally {
      setRestorePending(false);
    }
  };

  useEffect(() => {
    return () => {
      if (copyFlashTimer.current != null) {
        clearTimeout(copyFlashTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setDeleteConfirm(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
    };
  }, [menuOpen]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setDeleteConfirm(false);
  }, []);
  useEscapeClose(menuOpen, closeMenu);

  useEffect(() => {
    if (!detailsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!detailsRef.current?.contains(e.target as Node)) setDetailsOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [detailsOpen]);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);
  const [prRequest, setPrRequest] = useState(0);
  const { headerBehind, detailsGit } = useHeaderGitStatus({
    detail,
    detailsOpen,
    gitSyncInfo,
    onFetchDiff,
    syncRefreshNonce,
  });
  const ringWarn = ring?.view.warn === true;
  useEffect(() => {
    if (contextOpen && !ringWarn) setDetailsOpen(true);
  }, [contextOpen, ringWarn]);
  useEscapeClose(detailsOpen, closeDetails);
  useEscapeClose(restoreConfirm != null && !restorePending, () => {
    setRestoreConfirm(null);
  });
  useModalFocus(
    restoreConfirm != null && Boolean(restoreConfirm.undoSha),
    reviewUndoDialogRef,
  );

  const { showEarlier, onBodyScroll } = useStickToBottom({
    bodyRef,
    stickToBottom,
    forceStick,
    detail,
    timeline,
    isWorking,
    start,
    revealTargetId,
    setWindowStart,
  });

  /**
   * Delegated: any image in the timeline (tool output, attachment thumb,
   * markdown) opens the lightbox, so new image sources need no extra wiring.
   */
  const openClickedImage = (target: EventTarget | null) => {
    const img = target as HTMLImageElement | null;
    if (!img || img.tagName !== "IMG") return false;
    setLightbox({ src: img.src, alt: img.alt });
    return true;
  };

  if (!hasProjects) {
    return (
      <main className={styles.main}>
        <div className={styles.empty}>
          <div className={styles.emptyGlyph} aria-hidden="true">
            <svg
              width="22"
              height="22"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h2.2a1.5 1.5 0 0 1 1.1.5l.8 1a1.5 1.5 0 0 0 1.1.5H12A1.5 1.5 0 0 1 13.5 6v5A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V4Z" />
            </svg>
          </div>
          <p className={styles.emptyTitle}>Add a project to get started</p>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={onAddProject}
          >
            Add project
          </button>
        </div>
      </main>
    );
  }

  if (!detail) {
    if (detailError) {
      return (
        <main className={styles.main}>
          {returnToHeader(returnToView, onReturnToView)}
          <div className={styles.empty}>
            <div className={styles.emptyGlyph} aria-hidden="true">
              <svg
                width="22"
                height="22"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M8 4.5v4" />
                <path d="M8 11h.01" />
                <path d="M6.9 2.3 1.6 11.6A1.5 1.5 0 0 0 2.9 13.9h10.2a1.5 1.5 0 0 0 1.3-2.3L9.1 2.3a1.5 1.5 0 0 0-2.2 0Z" />
              </svg>
            </div>
            <p className={styles.emptyTitle}>Couldn’t load this thread</p>
            <p className={styles.emptyHint}>{detailError}</p>
            {onRetryDetail && (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={onRetryDetail}
              >
                Retry
              </button>
            )}
          </div>
        </main>
      );
    }
    return (
      <main className={styles.main}>
        {returnToHeader(returnToView, onReturnToView)}
        <div className={styles.empty}>
          <div className={styles.emptyGlyph} aria-hidden="true">
            <svg
              width="22"
              height="22"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v6A1.5 1.5 0 0 1 13 11.5H8l-3.5 2.8v-2.8H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5Z" />
            </svg>
          </div>
          <p className={styles.emptyTitle}>Select a thread</p>
          <p className={styles.emptyHint}>
            Choose a thread from the sidebar, or create a new one.
          </p>
          <div className={styles.emptyStarters} data-empty-starters="">
            <p className={styles.emptyStartersLabel}>Try asking</p>
            <ul className={styles.emptyStarterList}>
              <li className={styles.emptyStarterChip}>
                Fix the failing test
              </li>
              <li className={styles.emptyStarterChip}>
                Add dark mode to the settings page
              </li>
              <li className={styles.emptyStarterChip}>
                Explain how auth works in this repo
              </li>
            </ul>
          </div>
        </div>
      </main>
    );
  }

  const { thread } = detail;
  const remoteQuestionFiles = Boolean(project?.remoteHost);
  const questionAttach = {
    threadId: thread.id,
    allowAttachments: Boolean(onPickAttachments) && !remoteQuestionFiles,
    remoteUnsupported: remoteQuestionFiles,
    includeImages: supportsImagesForModel(
      providers.find((p) => p.id === thread.provider),
      thread.model,
    ),
    onPickAttachments,
    onSaveAttachmentImage,
    onLoadAttachmentImage,
    onDropAttachmentFiles,
  };
  const savedPins = pinsOf(thread);
  const displayPins = pinDraft ?? pinFailedRef.current[thread.id]?.pins ?? savedPins;
  const pinnedIds = new Set(displayPins.map((p) => p.messageId));
  const messageIds = new Set(detail.messages.map((m) => m.id));
  const applyPins = (next: ThreadMessagePin[]) => {
    pinDraftRef.current = next;
    pinPendingRef.current[thread.id] = next;
    setPinDraft(next);
    setPinError(null);
    void persistPins(thread.id, next);
  };
  const handleTogglePin = (message: ChatMessage) => {
    if (!onSetMessagePins) return;
    if (pinnedIds.has(message.id)) {
      applyPins(unpinMessage(displayPins, message.id));
      return;
    }
    if (displayPins.length >= THREAD_MESSAGE_PINS_MAX) {
      setPinError(`Pin limit reached (${THREAD_MESSAGE_PINS_MAX})`);
      return;
    }
    applyPins(pinMessage(displayPins, { messageId: message.id, text: message.text }));
  };
  const handleJumpPin = (pin: ThreadMessagePin) => {
    if (!isPinAvailable(pin, messageIds)) return;
    stickToBottom.current = false;
    forceStick.current = false;
    setJumpMessageId(pin.messageId);
  };
  const commitPinLabel = (messageId: string, raw: string) => {
    applyPins(labelMessagePin(displayPins, messageId, raw));
    setPinLabelId(null);
    setPinLabelDraft("");
  };
  const projectSlug = project?.slug ?? "project";
  const newThreadLabel = `New thread in ${projectSlug}`;
  // Project settings win over solenta.json field by field (#1506).
  const repoConfig = project?.repoConfig;
  const headerCommands: Array<{
    id: string;
    name: string;
    command: string;
    fromRepo?: boolean;
  }> = [];
  if (onRunCommand) {
    const setup = project?.setupCommand || repoConfig?.setupCommand;
    if (setup) {
      headerCommands.push({
        id: "setup",
        name: "Setup",
        command: setup,
        fromRepo: !project?.setupCommand,
      });
    }
    const ownActions = project?.quickActions ?? [];
    for (const action of ownActions.length
      ? ownActions
      : (repoConfig?.quickActions ?? []).map((a) => ({ ...a, fromRepo: true }))) {
      if (action && action.id && action.name) headerCommands.push(action);
    }
  }
  // The approval covers every command in the file (its hash), so list them
  // all, including any a project setting currently overrides.
  const repoCommandsShown = [
    ...(repoConfig?.setupCommand
      ? [{ id: "setup", name: "Setup", command: repoConfig.setupCommand }]
      : []),
    ...(repoConfig?.quickActions ?? []),
  ];

  const runHeaderCommand = (actionId: string, trust?: string) => {
    if (!onRunCommand || commandRunningId) return;
    const row = headerCommands.find((a) => a.id === actionId);
    if (row?.fromRepo && !repoConfig?.trusted && !trust) {
      setApproveCommandId(actionId);
      return;
    }
    setApproveCommandId(null);
    setCommandRunningId(actionId);
    setCommandError(null);
    void onRunCommand(
      thread.id,
      actionId === "setup" ? "setup" : actionId,
      trust,
    )
      .then(() => {
        setCommandRunningId(null);
      })
      .catch((err: unknown) => {
        setCommandRunningId(null);
        const message =
          err instanceof Error && err.message ? err.message : String(err);
        // solenta.json changed since it was approved: ask again.
        if (message.includes("REPO_CONFIG_UNTRUSTED")) {
          setApproveCommandId(actionId);
          return;
        }
        setCommandError(message);
      });
  };

  const startRename = () => {
    setMenuOpen(false);
    setDeleteConfirm(false);
    setRenameDraft(thread.title);
    renamingRef.current = true;
    setRenaming(true);
  };

  const finishRename = (cancel: boolean) => {
    if (!renamingRef.current) return;
    renamingRef.current = false;
    const next = renameDraft.trim();
    setRenaming(false);
    if (cancel || !next || next === thread.title) return;
    void onRenameThread?.(next);
  };

  // Close/discard only after a confirmed write or Escape (#935). A rejected
  // persist keeps the editor open with the typed draft and a retry.
  const closeNotes = (save: boolean) => {
    if (!notesOpenRef.current) return;
    const sourceId = notesSourceRef.current?.id ?? thread.id;
    if (notesSavingIdsRef.current.has(sourceId)) return;
    if (!save) {
      notesOpenRef.current = false;
      notesSourceRef.current = null;
      setNotesOpen(false);
      setNotesDraft(thread.notes);
      setNotesError(null);
      forgetFailedNotes(sourceId);
      return;
    }
    const next = notesDraft.trim();
    const confirmed = notesSourceRef.current?.saved ?? thread.notes;
    if (next === confirmed) {
      notesOpenRef.current = false;
      notesSourceRef.current = null;
      setNotesOpen(false);
      setNotesError(null);
      forgetFailedNotes(sourceId);
      return;
    }
    void persistNotes(sourceId, next, true);
  };

  const toggleNotes = () => {
    if (notesOpenRef.current) {
      closeNotes(true);
      return;
    }
    const held = notesFailedRef.current[thread.id];
    const nextDraft = held?.draft ?? thread.notes;
    notesDraftRef.current = nextDraft;
    setNotesDraft(nextDraft);
    setNotesError(held?.error ? held.error : null);
    const pending = notesSavingIdsRef.current.has(thread.id);
    setNotesSaving(pending);
    notesOpenRef.current = true;
    notesSourceRef.current = { id: thread.id, saved: thread.notes };
    setNotesOpen(true);
  };

  const handoffSourceId = thread.handoffFrom;
  const isCrewWorker = Boolean(thread.orchWorker);
  const showWorkerNav = isCrewWorker;
  const showHandoffBanner =
    !isCrewWorker && handoffSourceId != null && !handoffBannerDismissed;
  const workerNavLabel = handoffSource?.orchWorker ? "Parent worker" : "Task";
  const workersLabel = `Workers (${workerCount})`;

  const handleCopyThreadId = async () => {
    try {
      await navigator.clipboard.writeText(thread.id);
    } catch {
      return;
    }
    setCopiedThreadId(true);
    if (copyFlashTimer.current != null) {
      clearTimeout(copyFlashTimer.current);
    }
    copyFlashTimer.current = setTimeout(() => {
      setCopiedThreadId(false);
      copyFlashTimer.current = null;
    }, COPY_FLASH_MS);
  };

  const hasVersionControl =
    Boolean(gitSyncInfo && gitFetch) || headerCommands.length > 0;
  // A brand-new draft's header is just terminal + right panel (#1411): no
  // git step or details card until there is a conversation (or notes).
  const isDraftHeader =
    emptyMessages && !hasTimeline && !thread.notes && displayPins.length === 0;
  const hasDetails =
    !isDraftHeader &&
    (Boolean(onSetNotes) ||
    Boolean(worktree.toolbar) ||
    Boolean(thread.sandbox) ||
    Boolean(ring && !ring.view.warn) ||
    hasVersionControl);
  // Worktree lifecycle as one transcript line (t3-style) instead of header
  // churn. Derived from thread state, so no message is stored.
  const worktreeBase =
    thread.orchWorker && thread.leadSnapshotBranch
      ? thread.leadSnapshotBranch
      : thread.baseBranch || "repo default";
  const worktreeLine = thread.worktreePath ? (
    <div className={styles.worktreeLine} data-worktree-line="ready">
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m3.5 8.5 3 3 6-7" />
      </svg>
      <b>Worktree ready</b>
      {thread.branch ? (
        <>
          <span aria-hidden>·</span>
          <span className={styles.worktreeLineBranch}>{thread.branch}</span>
        </>
      ) : null}
      <span>from {worktreeBase}</span>
      {typeof thread.worktreeSetupMs === "number" ? (
        <span data-worktree-setup-ms="">
          · {(thread.worktreeSetupMs / 1000).toFixed(1)}s
        </span>
      ) : null}
    </div>
  ) : thread.pendingWorktree &&
    thread.status !== "failed" &&
    detail.messages.some((m) => m.role === "user") ? (
    <div className={styles.worktreeLine} data-worktree-line="setup" role="status">
      <span className={styles.worktreeLineSpinner} aria-hidden />
      <b>Setting up worktree…</b>
      <span>from {worktreeBase}</span>
    </div>
  ) : null;

  // A warning ring stays in the header (compaction is close); otherwise the
  // ring lives in Thread details.
  const ringBadge = ring ? (
    <ContextRingBadge
      ring={ring.view}
      segments={ring.segments}
      used={ring.used}
      open={contextOpen}
      onOpenChange={setContextOpen}
      onFork={onFork && !isWorking ? handleForkFresh : undefined}
      onCompact={nativeCompact && !isWorking ? handleCompact : undefined}
    />
  ) : null;

  // Run status rides on the composer's top edge (#1429), not the transcript.
  const composerStatus =
    detail.thread.status === "quota-wait" ? (
      <div
        className={`${styles.statusStrip} ${styles.statusStripQuotaWait}`}
        data-quota-wait-strip=""
      >
        <span className={styles.statusDiamond} aria-hidden />
        <span className={styles.statusText}>
          Usage limit reached. Resuming at{" "}
          {detail.thread.quotaWaitUntil != null
            ? formatQuotaWaitLabel(detail.thread.quotaWaitUntil, Date.now())
            : "the reset"}
          .
        </span>
        {onResumeQuotaWait ? (
          <button
            type="button"
            className={styles.statusAction}
            onClick={() => void onResumeQuotaWait()}
            data-resume-quota-wait=""
          >
            Resume now
          </button>
        ) : null}
        {onSetQuotaWaitAutoResume &&
        detail.thread.quotaWaitAutoResume !== false ? (
          <button
            type="button"
            className={styles.stopBtn}
            onClick={() => void onSetQuotaWaitAutoResume(false)}
            data-quota-wait-opt-out=""
          >
            Don&apos;t auto-resume
          </button>
        ) : null}
      </div>
    ) : isWorking ? (
      <div
        className={`${styles.statusStrip}${stalledAt != null ? ` ${styles.statusStripStalled}` : ""}`}
        data-stalled={stalledAt != null ? "" : undefined}
      >
        <span className={styles.statusDiamond} aria-hidden />
        <span className={styles.statusText}>{workingLabel}</span>
        {detail.thread.runStartedAt != null ? (
          <ElapsedClock since={detail.thread.runStartedAt} />
        ) : null}
        <button
          type="button"
          className={styles.stopBtn}
          title="Stop (Esc · Ctrl+C)"
          aria-keyshortcuts="Escape Control+C"
          onClick={() => void onStopRun()}
        >
          Stop
        </button>
      </div>
    ) : null;

  return (
    <PathLinkProvider
      threadId={detail.thread.id}
      resolvePaths={resolvePathMap}
      openPath={handleOpenWorkspacePath}
      loadImage={onLoadAttachmentImage}
      sessionImages={sessionImages}
    >
    <ThreadLinkContext.Provider value={threadLinks}>
    <main
      className={styles.main}
      ref={dropHostRef}
      data-thread-drop=""
    >
      {fileDrag && onDropAttachmentFiles ? (
        <div className={styles.dropOverlay} data-drop-overlay="" aria-hidden>
          {DROP_OVERLAY_MESSAGE}
        </div>
      ) : null}
      <header className={styles.header} data-thread-header="">
        <div className={styles.headerLead}>
          {returnToView && onReturnToView ? (
            <ReturnToViewButton
              view={returnToView}
              onClick={onReturnToView}
            />
          ) : null}
          <div className={styles.breadcrumb}>
          {onCreateThread ? (
            <button
              type="button"
              className={styles.project}
              data-new-thread-in=""
              title={newThreadLabel}
              aria-label={newThreadLabel}
              onClick={() => onCreateThread(thread.projectId)}
            >
              {project ? (
                <ProjectIcon
                  url={project.iconUrl}
                  name={projectSlug}
                  seed={project.id}
                  size={16}
                />
              ) : null}
              <span className={styles.projectName}>{projectSlug}</span>
            </button>
          ) : (
            <span className={styles.project}>
              {project ? (
                <ProjectIcon
                  url={project.iconUrl}
                  name={projectSlug}
                  seed={project.id}
                  size={16}
                />
              ) : null}
              <span className={styles.projectName}>{projectSlug}</span>
            </span>
          )}
          <span className={styles.sep} aria-hidden>
            /
          </span>
          {renaming ? (
            <input
              className={`${styles.threadTitle} ${styles.titleInput}`}
              data-thread-title-input=""
              value={renameDraft}
              maxLength={60}
              aria-label="Thread title"
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={() => finishRename(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  finishRename(true);
                }
              }}
            />
          ) : (
          <div className={styles.menuWrap} ref={menuRef}>
              <button
                type="button"
                className={styles.titleMenuBtn}
                aria-label="Thread actions"
                title={thread.title}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                data-thread-title-menu=""
                onClick={() => {
                  setMenuOpen((v) => !v);
                  setDeleteConfirm(false);
                }}
              >
                <span className={styles.threadTitle}>{thread.title}</span>
                <svg
                  className={styles.titleChevron}
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m4 6 4 4 4-4" />
                </svg>
              </button>
              {menuOpen && (
                <div className={`${styles.menu} ${styles.titleMenu}`} role="menu">
                  {deleteConfirm ? (
                    <div className={styles.menuConfirm}>
                      <p className={styles.menuConfirmText}>
                        Move to Recently deleted? You can restore for 7 days.
                      </p>
                      <div className={styles.menuConfirmActions}>
                        <button
                          type="button"
                          className={`${styles.menuItem} ${styles.menuItemDanger}`}
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            setDeleteConfirm(false);
                            void onDeleteThread();
                          }}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          className={styles.menuItem}
                          role="menuitem"
                          onClick={() => setDeleteConfirm(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {onStartSpec && !thread.spec && !thread.ask && (
                        <button
                          type="button"
                          className={styles.menuItem}
                          role="menuitem"
                          data-spec-mode-btn=""
                          onClick={() => {
                            setMenuOpen(false);
                            void onStartSpec(thread.id);
                          }}
                        >
                          Spec mode
                        </button>
                      )}
                      {onStartTeach && !thread.teach && !thread.ask && (
                        <button
                          type="button"
                          className={styles.menuItem}
                          role="menuitem"
                          data-teach-mode-btn=""
                          onClick={() => {
                            setMenuOpen(false);
                            void onStartTeach(thread.id);
                          }}
                        >
                          Teach mode
                        </button>
                      )}
                      {onStartAsk && !thread.ask && (
                        <button
                          type="button"
                          className={styles.menuItem}
                          role="menuitem"
                          data-ask-mode-btn=""
                          onClick={() => {
                            setMenuOpen(false);
                            void onStartAsk(thread.id);
                          }}
                        >
                          Ask mode
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.menuItem}
                        role="menuitem"
                        data-copy-thread-id=""
                        onClick={() => void handleCopyThreadId()}
                      >
                        {copiedThreadId ? "Copied" : "Copy thread ID"}
                      </button>
                      {onRenameThread && !isWorking && (
                        <button
                          type="button"
                          className={styles.menuItem}
                          role="menuitem"
                          data-rename-thread=""
                          onClick={startRename}
                        >
                          Rename thread
                        </button>
                      )}
                    <div className={styles.menuInbound} data-transcript-view-menu="">
                      <div className={styles.menuInboundLabel}>
                        Transcript view <span className={styles.menuKbd}>⌃O</span>
                      </div>
                      {TRANSCRIPT_VIEW_MODES.map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={styles.menuItem}
                          role="menuitemradio"
                          aria-checked={transcriptView === mode}
                          data-transcript-view-option={mode}
                          data-active={transcriptView === mode ? "true" : undefined}
                          title={TRANSCRIPT_VIEW_HINTS[mode]}
                          onClick={() => {
                            setMenuOpen(false);
                            setTranscriptViewMode(mode);
                          }}
                        >
                          {TRANSCRIPT_VIEW_LABELS[mode]}
                        </button>
                      ))}
                    </div>
                      {onSetCrossThreadInbound && (
                        <div
                          className={styles.menuInbound}
                          data-inbound-policy-menu=""
                        >
                          <div className={styles.menuInboundLabel}>
                            Messages from other threads
                          </div>
                          {(
                            [
                              ["accept", "Accept"],
                              ["queue-only", "Queue only"],
                              ["refuse", "Refuse"],
                            ] as const
                          ).map(([value, label]) => {
                            const current =
                              thread.crossThreadInbound === "queue-only" ||
                              thread.crossThreadInbound === "refuse"
                                ? thread.crossThreadInbound
                                : "accept";
                            return (
                              <button
                                key={value}
                                type="button"
                                className={styles.menuItem}
                                role="menuitemradio"
                                aria-checked={current === value}
                                data-inbound-policy={value}
                                data-active={current === value ? "true" : undefined}
                                onClick={() => {
                                  setMenuOpen(false);
                                  void onSetCrossThreadInbound(value);
                                }}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {!isWorking && onRepeatSchedule && (
                        <button
                          type="button"
                          className={styles.menuItem}
                          role="menuitem"
                          data-repeat-schedule=""
                          onClick={() => {
                            setMenuOpen(false);
                            onRepeatSchedule();
                          }}
                        >
                          Schedule this prompt…
                        </button>
                      )}
                      {!isWorking && onDistillWorkflow && (
                        <button
                          type="button"
                          className={styles.menuItem}
                          role="menuitem"
                          data-distill-workflow=""
                          onClick={() => {
                            setMenuOpen(false);
                            onDistillWorkflow();
                          }}
                        >
                          Distill into workflow…
                        </button>
                      )}
                      {!isWorking && (
                        <button
                          type="button"
                          className={styles.menuItem}
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            void onSetArchived(!isArchived);
                          }}
                        >
                          {isArchived ? "Unarchive thread" : "Archive thread"}
                        </button>
                      )}
                      {!isWorking && (
                        <button
                          type="button"
                          className={`${styles.menuItem} ${styles.menuItemDanger}`}
                          role="menuitem"
                          onClick={() => setDeleteConfirm(true)}
                        >
                          Delete thread
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          </div>
          {workerCount > 0 && onOpenWorkers ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.workersBtn}`}
              data-open-workers=""
              aria-label={workersLabel}
              title={workersLabel}
              onClick={onOpenWorkers}
            >
              {workersLabel}
            </button>
          ) : null}
        </div>
        <div className={styles.headerTrail}>
          <div className={styles.actions}>
          {!thread.ask && !isDraftHeader && (
          <NextGitActionButton
            thread={thread}
            isWorking={isWorking}
            remoteProject={Boolean(project?.remoteHost)}
            changesOpen={changesOpen}
            changesNonce={changesNonce}
            syncRefreshNonce={syncRefreshNonce}
            onFetchDiff={onFetchDiff}
            gitSyncInfo={gitSyncInfo}
            onViewChanges={onViewChanges}
            onPush={onPush}
            onCreatePr={onCreatePr}
            loadPrTemplate={
              project && onPrTemplate
                ? () => onPrTemplate(project.path)
                : undefined
            }
            onPrChecks={onPrChecks}
            onPrStatus={onPrStatus}
            onPrMerge={onPrMerge}
            onStartRun={onStartRun}
            providerName={
              providers.find((p) => p.id === threadProviderRef(thread))?.name ??
              thread.provider
            }
            onPushed={() => setSyncRefreshNonce((n) => n + 1)}
            onMore={hasDetails ? () => setDetailsOpen(true) : undefined}
            prRequest={prRequest}
          />
          )}
          {onStopSpec && thread.spec && !thread.ask && (
            <button
              type="button"
              className={styles.btn}
              data-spec-exit-btn=""
              onClick={() => void onStopSpec(thread.id)}
            >
              Exit spec mode
            </button>
          )}
          {onFork && !isWorking && !isDraftHeader ? (
            <HeaderForkControl
              thread={thread}
              providers={providers}
              onFork={onFork}
            />
          ) : null}
          {ring?.view.warn ? ringBadge : null}
          {hasDetails ? (
          <div className={styles.detailsWrap} ref={detailsRef}>
            <button
              type="button"
              className={styles.iconBtn}
              data-thread-details-btn=""
              data-active={detailsOpen ? "true" : undefined}
              aria-haspopup="dialog"
              aria-expanded={detailsOpen}
              aria-label={
                headerBehind > 0
                  ? `Thread details: ${headerBehind} behind upstream`
                  : "Thread details"
              }
              title={
                headerBehind > 0
                  ? `Thread details · ${headerBehind} behind upstream`
                  : "Thread details"
              }
              data-attention={headerBehind > 0 ? "" : undefined}
              onClick={() => setDetailsOpen((v) => !v)}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="5.75" />
                <path d="M8 7.25v3.5M8 5.25h.01" />
              </svg>
              {headerBehind > 0 ? (
                <span className={styles.attentionDot} data-attention-dot="" aria-hidden />
              ) : thread.notes ? (
                <span className={styles.notesDot} data-notes-dot="" aria-hidden />
              ) : null}
            </button>
            {detailsOpen && (
              <div
                className={styles.detailsCard}
                role="dialog"
                aria-label="Thread details"
                data-thread-details=""
              >
                <section className={styles.detailsSection}>
                  <div className={styles.detailsHeading}>Workspace</div>
                  {worktree.rows ? (
                    <div className={styles.detailsRow}>{worktree.rows.workspace}</div>
                  ) : worktree.toolbar ? (
                    <div className={styles.detailsRow}>{worktree.toolbar}</div>
                  ) : null}
                  {thread.sandbox || (ring && !ring.view.warn) ? (
                    <div className={styles.detailsKv}>
                      <span className={styles.detailsKey}>
                        {thread.sandbox ? "Sandbox" : "Context"}
                      </span>
                      {thread.sandbox && <SandboxBadge sandbox={thread.sandbox} />}
                      <span className={styles.detailsKvEnd}>
                        {ring && !ring.view.warn ? ringBadge : null}
                      </span>
                    </div>
                  ) : null}
                </section>
                <section className={styles.detailsSection}>
                  <div className={styles.detailsHeading}>Version control</div>
                  {worktree.rows ? (
                    <div className={styles.detailsRow}>{worktree.rows.versionControl}</div>
                  ) : null}
                  {gitSyncInfo && gitFetch ? (
                    <div className={styles.detailsKv}>
                      <span className={styles.detailsKey}>Status</span>
                      <span className={styles.detailsStatus} data-details-status="">
                        {detailsGit
                          ? `${detailsGit.changed} changed${
                              detailsGit.sync?.hasUpstream ? " · " : ""
                            }`
                          : ""}
                      </span>
                      <SyncPill
                        threadId={thread.id}
                        gitSyncInfo={gitSyncInfo}
                        gitFetch={gitFetch}
                        refreshNonce={syncRefreshNonce}
                      />
                    </div>
                  ) : null}
                  {!thread.ask && !project?.remoteHost && detailsGit ? (
                    <div className={styles.detailsActions}>
                      {detailsGit.changed > 0 && onViewChanges ? (
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnPrimary}`}
                          data-details-commit=""
                          disabled={isWorking}
                          onClick={() => {
                            setDetailsOpen(false);
                            onViewChanges();
                          }}
                        >
                          Commit {detailsGit.changed}{" "}
                          {detailsGit.changed === 1 ? "file" : "files"}
                        </button>
                      ) : null}
                      {thread.branch &&
                      (!detailsGit.sync?.hasUpstream ||
                        (detailsGit.sync.ahead ?? 0) > 0) ? (
                        <button
                          type="button"
                          className={styles.btn}
                          data-details-push=""
                          disabled={isWorking}
                          onClick={() => {
                            void onPush().then(
                              () => setSyncRefreshNonce((n) => n + 1),
                              () => {},
                            );
                          }}
                        >
                          Push
                        </button>
                      ) : null}
                      {thread.worktreePath && thread.prNumber == null ? (
                        <button
                          type="button"
                          className={styles.btn}
                          data-details-create-pr=""
                          disabled={isWorking}
                          onClick={() => {
                            setDetailsOpen(false);
                            setPrRequest((n) => n + 1);
                          }}
                        >
                          Create PR
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {headerCommands.length > 0 ? (
                    <div className={styles.detailsRow}>
                      <div className={styles.quickActions} data-thread-commands="">
                        {headerCommands.map((action) => {
                          const running = commandRunningId === action.id;
                          return (
                            <button
                              key={action.id}
                              type="button"
                              className={styles.btn}
                              data-thread-command={action.id}
                              title={action.command}
                              disabled={isWorking || Boolean(commandRunningId)}
                              onClick={() => runHeaderCommand(action.id)}
                            >
                              {running ? `${action.name}…` : action.name}
                            </button>
                          );
                        })}
                        {commandError ? (
                          <span
                            className={styles.commandError}
                            data-thread-command-error=""
                            role="alert"
                          >
                            {commandError}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {approveCommandId && repoConfig?.hash ? (
                    <div
                      className={styles.permissionCard}
                      role="alertdialog"
                      aria-label="Approve solenta.json commands"
                      data-repo-config-approve=""
                    >
                      <div className={styles.permissionHead}>
                        Run commands from this repo&apos;s solenta.json?
                      </div>
                      <p className={styles.repoApproveNote}>
                        These come from a checked-in file, so anyone who
                        can push to the repo can change them. You will be
                        asked again if they change.
                      </p>
                      <ul className={styles.repoApproveList}>
                        {repoCommandsShown.map((a) => (
                          <li key={a.id}>
                            <span>{a.name}</span>
                            <code>{a.command}</code>
                          </li>
                        ))}
                      </ul>
                      <div className={styles.permissionActions}>
                        <button
                          type="button"
                          className={styles.permissionAllow}
                          data-repo-config-approve-run=""
                          onClick={() =>
                            runHeaderCommand(approveCommandId, repoConfig.hash)
                          }
                        >
                          Approve and run
                        </button>
                        <button
                          type="button"
                          className={styles.permissionDeny}
                          onClick={() => setApproveCommandId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </section>
                      {onSetNotes && (
                        <button
                          type="button"
                          className={styles.detailsNotesBtn}
                          data-thread-notes-btn=""
                          data-has-notes={thread.notes ? "true" : undefined}
                          data-has-pins={displayPins.length ? String(displayPins.length) : undefined}
                          data-active={notesOpen ? "true" : undefined}
                          aria-expanded={notesOpen}
                          aria-label="Thread notes"
                          title="Thread notes"
                          onMouseDown={(e) => {
                            // Keep the textarea from blurring before this click, so
                            // toggle-close does not immediately re-open.
                            if (notesOpenRef.current) e.preventDefault();
                          }}
                          onClick={toggleNotes}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M4 2.5h8A1.5 1.5 0 0 1 13.5 4v9A1.5 1.5 0 0 1 12 14.5H4A1.5 1.5 0 0 1 2.5 13V4A1.5 1.5 0 0 1 4 2.5Z" />
                            <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" />
                          </svg>
                          <span>Notes</span>
                          <span className={styles.detailsNotesMeta}>
                            {thread.notes
                              ? "1 note"
                              : displayPins.length
                                ? `${displayPins.length} pinned`
                                : "Add a note"}
                          </span>
                        </button>
                      )}
                {worktree.rows ? (
                  <div className={styles.detailsDanger}>{worktree.rows.danger}</div>
                ) : null}
              </div>
            )}
          </div>
          ) : null}
          </div>
          <div className={styles.headerDivider} aria-hidden />
          <button
            type="button"
            className={styles.toggleBtn}
            data-terminal-toggle=""
            data-active={terminalLeaf ? "true" : undefined}
            aria-pressed={Boolean(terminalLeaf)}
            aria-label="Terminal"
            title={terminalLeaf ? "Close terminal" : "Open terminal"}
            onClick={handleToggleTerminal}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
              <path d="M5 6.5 7 8.25 5 10M8.5 10.5H11" />
            </svg>
          </button>
          {onToggleAgentsPanel ? null : (
            <ViewsMenu
              layout={layout}
              onOpen={handleOpenPane}
              onReset={handleResetLayout}
            />
          )}
          {onToggleAgentsPanel ? (
            <div className={styles.panelSplit} data-panel-split="">
            <button
              type="button"
              className={styles.toggleBtn}
              data-agents-panel-toggle=""
              data-active={agentsPanelOpen ? "true" : undefined}
              aria-pressed={Boolean(agentsPanelOpen)}
              aria-label="Right panel"
              title={`${agentsPanelOpen ? "Hide" : "Show"} right panel (${bindingLabel("agents.toggle", true)})`}
              onClick={onToggleAgentsPanel}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
                <path d="M10 2.5v11" />
              </svg>
            </button>
            <ViewsMenu
              compact
              layout={layout}
              onOpen={handleOpenPane}
              onReset={handleResetLayout}
            />
            </div>
          ) : null}
        </div>
      </header>
      {worktree.banner}

      {(displayPins.length > 0 || pinError) && (
        <div className={styles.notesPanel} data-thread-pins="">
          <div className={styles.pinsHeader}>Pins</div>
          {displayPins.length > 0 ? (
            <ul className={styles.pinsList}>
              {displayPins.map((pin) => {
                const available = isPinAvailable(pin, messageIds);
                const labeling = pinLabelId === pin.messageId;
                return (
                  <li
                    key={pin.messageId}
                    className={styles.pinRow}
                    data-thread-pin={pin.messageId}
                    data-pin-stale={available ? undefined : ""}
                  >
                    {labeling ? (
                      <input
                        className={styles.pinLabelInput}
                        data-thread-pin-label-input=""
                        aria-label="Pin label"
                        value={pinLabelDraft}
                        autoFocus
                        maxLength={THREAD_MESSAGE_PIN_LABEL_MAX}
                        onChange={(e) => setPinLabelDraft(e.target.value)}
                        onBlur={() => commitPinLabel(pin.messageId, pinLabelDraft)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitPinLabel(pin.messageId, pinLabelDraft);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setPinLabelId(null);
                            setPinLabelDraft("");
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className={styles.pinJump}
                        data-thread-pin-jump=""
                        disabled={!available}
                        title={
                          available
                            ? "Jump to this message"
                            : "This message is no longer in the transcript"
                        }
                        onClick={() => handleJumpPin(pin)}
                      >
                        {pinDisplayText(pin)}
                        {available ? "" : " (unavailable)"}
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.msgAction}
                      data-thread-pin-label=""
                      aria-label="Label pin"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setPinLabelId(pin.messageId);
                        setPinLabelDraft(pin.label ?? "");
                      }}
                    >
                      Label
                    </button>
                    <button
                      type="button"
                      className={styles.msgAction}
                      data-thread-pin-unpin=""
                      aria-label="Unpin message"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() =>
                        applyPins(unpinMessage(displayPins, pin.messageId))
                      }
                    >
                      Unpin
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {pinError ? (
            <div className={styles.notesSaveError}>
              <span
                className={styles.permissionGuardrail}
                data-thread-pins-error=""
              >
                {pinError}
              </span>
              <button
                type="button"
                className={styles.retryBtn}
                data-thread-pins-retry=""
                disabled={pinSaving}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const retryPins =
                    pinDraft ??
                    pinFailedRef.current[thread.id]?.pins ??
                    displayPins;
                  void persistPins(thread.id, retryPins);
                }}
              >
                Retry
              </button>
            </div>
          ) : null}
        </div>
      )}

      {notesOpen && onSetNotes && (
        <div className={styles.notesPanel} data-thread-notes-panel="">
          <textarea
            className={styles.notesInput}
            data-thread-notes-input=""
            maxLength={THREAD_NOTES_MAX}
            aria-label="Thread notes"
            autoFocus
            placeholder="Scratch notes - why this is snoozed, what to do next…"
            value={notesDraft}
            disabled={notesSaving}
            onChange={(e) => {
              setNotesDraft(e.target.value);
              if (notesError) setNotesError(null);
            }}
            onBlur={() => closeNotes(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeNotes(false);
              }
            }}
          />
          {notesError ? (
            <div className={styles.notesSaveError}>
              <span
                className={styles.permissionGuardrail}
                data-thread-notes-error=""
              >
                {notesError}
              </span>
              <button
                type="button"
                className={styles.retryBtn}
                data-thread-notes-retry=""
                disabled={notesSaving}
                onMouseDown={(e) => {
                  // Keep blur from starting a second persist before this click.
                  e.preventDefault();
                }}
                onClick={() => closeNotes(true)}
              >
                Retry
              </button>
            </div>
          ) : null}
        </div>
      )}

      <PaneWorkspace
        layout={layout}
        focusedId={focusedId}
        onChange={handlePaneChange}
        onFocus={setFocusedId}
        renderPane={(leaf) => {
          if (leaf.type === "browser") {
            return (
              <BrowserPane
                threadId={detail?.thread.id ?? ""}
                preview={preview}
                devServerStatus={devServerStatus}
                listLocalServers={listLocalServers}
                onAttachScreenshot={
                  onSaveAttachmentImage ? attachBrowserScreenshot : undefined
                }
              />
            );
          }
          if (leaf.type === "simulator") {
            if (!simulator) return <PanePlaceholder type="simulator" />;
            return (
              <SimulatorPane
                threadId={detail?.thread.id ?? ""}
                api={simulator}
                status={simulatorStatus}
              />
            );
          }
          if (leaf.type === "diff") {
            return (
              <ChangesPanel
                open
                embedded={leaves(layout).length > 1}
                threadId={detail?.thread.id ?? null}
                threadTitle={detail?.thread.title ?? ""}
                threadBranch={detail?.thread.branch ?? null}
                threadBaseBranch={detail?.thread.baseBranch ?? null}
                planText={planTextOf(detail)}
                openNonce={changesNonce}
                onFetchDiff={onFetchDiff}
                onFetchReviewContext={onFetchReviewContext}
                onSetReviewAccepted={onSetReviewAccepted}
                onCommit={onCommitChanges}
                onStagedPathsChange={onStagedPathsChange}
                onRevert={onRevertFile}
                onSuggest={onSuggestCommitMessage}
                onComment={
                  isArchived || !detail
                    ? undefined
                    : (comment) =>
                        setReviewComments(detail.thread.id, (prev) => [
                          ...prev,
                          comment,
                        ])
                }
              />
            );
          }
          if (leaf.type === "files" && filesApi && detail) {
            return (
              <FilesPane
                key={detail.thread.id}
                threadId={detail.thread.id}
                api={filesApi}
                remote={Boolean(project?.remoteHost)}
                onAddToPrompt={
                  isArchived
                    ? undefined
                    : (comment) =>
                        setReviewComments(detail.thread.id, (prev) => [
                          ...prev,
                          comment,
                        ])
                }
              />
            );
          }
          if (leaf.type === "terminal" && terminalApi) {
            return (
              <TerminalPane
                threadId={detail?.thread.id ?? null}
                api={terminalApi}
                reveal={terminalReveal}
              />
            );
          }
          if (leaf.type !== "chat") {
            return <PanePlaceholder type={leaf.type} />;
          }
          return (
            <div
              className={styles.chatSlot}
              data-pane-chat=""
              data-draft-hero={emptyMessages && !hasTimeline ? "" : undefined}
            >
      {showWorkerNav && (
        <div className={styles.handoffBanner} data-worker-nav="">
          <span className={styles.handoffBannerText}>
            {handoffSource ? (
              <>
                {workerNavLabel}{" "}
                <button
                  type="button"
                  className={styles.handoffLink}
                  data-task-source={handoffSource.id}
                  onClick={() => onSelectThread?.(handoffSource.id)}
                >
                  {handoffSource.title}
                </button>
              </>
            ) : (
              <span data-worker-nav-missing="">
                Task is no longer available
              </span>
            )}
          </span>
        </div>
      )}
      {showHandoffBanner && (
        <div className={styles.handoffBanner} data-handoff-banner="">
          <span className={styles.handoffBannerText}>
            {handoffSource ? (
              <>
                Forked from{" "}
                <button
                  type="button"
                  className={styles.handoffLink}
                  data-handoff-source={handoffSource.id}
                  onClick={() => onSelectThread?.(handoffSource.id)}
                >
                  {handoffSource.title}
                </button>
              </>
            ) : (
              <span data-handoff-missing="">
                Forked from a deleted thread
              </span>
            )}
          </span>
          <button
            type="button"
            className={styles.handoffDismiss}
            aria-label="Dismiss handoff banner"
            title="Dismiss handoff banner"
            onClick={() => setHandoffBannerDismissed(true)}
          >
            ×
          </button>
        </div>
      )}

      {detail && (
        <DivergenceCard
          key={detail.thread.id}
          detail={detail}
          peers={comparePeers}
          providers={providers}
          onPeekThread={onPeekThread}
        />
      )}

      <div
        className={styles.body}
        data-thread-body=""
        ref={bodyRef}
        onScroll={onBodyScroll}
        onClick={(e) => openClickedImage(e.target)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          if (openClickedImage(e.target)) e.preventDefault();
        }}
      >
        {emptyMessages && !hasTimeline && (
          <div className={styles.heroDraft} data-draft-hero-title="">
            {project?.scratch ? (
              <>
                <h1 className={styles.heroTitle}>What should we build?</h1>
                <p className={styles.heroHint} data-hero-scratch="">
                  No project: this thread runs in an empty scratch folder.{" "}
                  <DraftProjectChooser
                    current={null}
                    label="Pick a project"
                    projects={heroProjects ?? []}
                    onPick={
                      onMoveDraftToProject
                        ? (id) => onMoveDraftToProject(thread.id, id)
                        : undefined
                    }
                  />
                </p>
              </>
            ) : (
              <>
                {project ? (
                  <MemoryPill projectPath={project.path} label={projectSlug} />
                ) : null}
                <h1 className={styles.heroTitle}>
                  What should we build in{" "}
                  <DraftProjectChooser
                    current={project}
                    projects={heroProjects ?? []}
                    onPick={
                      onMoveDraftToProject
                        ? (id) => onMoveDraftToProject(thread.id, id)
                        : undefined
                    }
                    onStartWithoutProject={
                      onStartWithoutProject
                        ? () => onStartWithoutProject(thread.id)
                        : undefined
                    }
                  />
                  ?
                </h1>
                <p className={styles.heroHint}>
                  Every agent here starts where the last one stopped.
                </p>
              </>
            )}
          </div>
        )}

        {hiddenCount > 0 && (
          <div className={styles.showEarlier}>
            <button
              type="button"
              className={styles.showEarlierBtn}
              data-show-earlier=""
              data-hidden-count={hiddenCount}
              onClick={() => {
                fullWindowThread.current = threadId;
                showEarlier();
              }}
            >
              {`Show ${hiddenCount} earlier ${hiddenCount === 1 ? "message" : "messages"}`}
            </button>
          </div>
        )}

        {hiddenCount === 0 && worktreeLine}

        {displayTimeline.map((entry) => {
          if (entry.kind === "group") {
            const runId = entry.group.runId;
            const runCollapsed =
              runId != null && isRunCollapsed(collapsedRuns, runId);
            const runHeader = headerByMessageId.get(entry.group.messages[0]!.id);
            if (runCollapsed && !runHeader) return null;
            const groupKey = `group:${entry.group.id}`;
            return (
              <Fragment key={groupKey}>
                {runHeader && (
                  <RunHeaderRow
                    header={runHeader}
                    collapsed={runCollapsed}
                    onToggle={() =>
                      setCollapsedRuns((prev) =>
                        toggleRunCollapsed(prev, runHeader.runId),
                      )
                    }
                  />
                )}
                {!runCollapsed && (
                  <ToolGroupRow
                    group={entry.group}
                    working={isWorking}
                    expanded={expandedGroups.has(entry.group.id)}
                    verbose={verboseTools}
                    animateIn={!seenEntryKeys.current.has(groupKey)}
                    onToggle={() =>
                      setExpandedGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(entry.group.id)) next.delete(entry.group.id);
                        else next.add(entry.group.id);
                        return next;
                      })
                    }
                    onLoadImage={onLoadImage}
                    latestRunningToolId={latestRunningToolId}
                    latestThinkingId={latestThinkingId}
                  />
                )}
              </Fragment>
            );
          }
          if (entry.kind === "message") {
            const isOverflowSurface =
              entry.message.role === "event" &&
              overflowEventId != null &&
              entry.message.id === overflowEventId;
            const isUpgradeSurface =
              !isOverflowSurface &&
              entry.message.role === "event" &&
              upgradeEventId != null &&
              entry.message.id === upgradeEventId;
            const isWriterLockSurface =
              !isOverflowSurface &&
              !isUpgradeSurface &&
              entry.message.role === "event" &&
              writerLockEventId != null &&
              entry.message.id === writerLockEventId;
            const isRetrySurface =
              !isOverflowSurface &&
              !isUpgradeSurface &&
              !isWriterLockSurface &&
              entry.message.role === "event" &&
              retryEventId != null &&
              entry.message.id === retryEventId;
            const bar = barByMessageId.get(entry.message.id);
            const runHeader = headerByMessageId.get(entry.message.id);
            const runId = entry.message.runId;
            const runCollapsed =
              runId != null && isRunCollapsed(collapsedRuns, runId);
            if (runCollapsed && !runHeader) return null;
            const focusTurn = focusTurnByFirstId.get(entry.message.id);
            const focusHidden = hiddenFocusActivity.has(entry.message.id);
            if (focusHidden && !focusTurn) return null;
            return (
              <Fragment key={entry.message.id}>
                {runHeader && (
                  <RunHeaderRow
                    header={runHeader}
                    collapsed={runCollapsed}
                    onToggle={() =>
                      setCollapsedRuns((prev) =>
                        toggleRunCollapsed(prev, runHeader.runId),
                      )
                    }
                  />
                )}
                {focusTurn && !focusTurn.live && (
                  <FocusTurnRow
                    turn={focusTurn}
                    collapsed={focusHidden}
                    onToggle={() =>
                      setExpandedFocusTurns((prev) => {
                        const next = new Set(prev);
                        if (next.has(focusTurn.key)) next.delete(focusTurn.key);
                        else next.add(focusTurn.key);
                        return next;
                      })
                    }
                  />
                )}
                {!runCollapsed && !focusHidden && (
                  <>
                    <div
                      data-message-id={entry.message.id}
                      data-revealed-message={
                        revealTargetId === entry.message.id ? "" : undefined
                      }
                    >
                    <MessageBlock
                      message={entry.message}
                      autoExpandTool={
                        verboseTools ||
                        entry.message.id === latestRunningToolId ||
                        entry.message.id === latestThinkingId
                      }
                      activityOpen={
                        verboseTools || revealTargetId === entry.message.id
                      }
                      animateIn={!seenEntryKeys.current.has(entry.message.id)}
                      streaming={entry.message.id === streamingMessageId}
                      onLoadImage={onLoadImage}
                      onLoadAttachmentImage={onLoadAttachmentImage}
                      onSelectThread={onSelectThread}
                      pinned={pinnedIds.has(entry.message.id)}
                      onTogglePin={
                        onSetMessagePins &&
                        (entry.message.role === "user" ||
                          entry.message.role === "assistant") &&
                        !entry.message.thinking
                          ? () => handleTogglePin(entry.message)
                          : undefined
                      }
                      eventActionLabel={
                        isOverflowSurface
                          ? "Fork to fresh context"
                          : isUpgradeSurface
                            ? "Upgrade Codex"
                            : isRetrySurface
                              ? "Retry turn"
                              : undefined
                      }
                      eventActionTitle={
                        isOverflowSurface
                          ? "Fork this thread with recent history in a fresh context"
                          : isUpgradeSurface
                            ? "Copy `codex update` to the clipboard"
                            : isRetrySurface
                              ? retryTitle
                              : undefined
                      }
                      onEventAction={
                        isOverflowSurface
                          ? handleForkFresh
                          : isUpgradeSurface
                            ? handleUpgradeCli
                            : isRetrySurface
                              ? handleRetry
                              : undefined
                      }
                      canEdit={
                        Boolean(onRewindAndResubmit) &&
                        isEditableUserMessage(
                          entry.message,
                          detail.thread.status,
                        )
                      }
                      confirming={rewindConfirm?.messageId === entry.message.id}
                      onRequestResubmit={
                        onRewindAndResubmit
                          ? handleRequestResubmit
                          : undefined
                      }
                      onCancelConfirm={handleRewindCancel}
                      metaAgent={detail?.thread.provider ?? null}
                      metaModel={
                        detail?.usage?.model ?? detail?.thread.model ?? null
                      }
                      metaEffort={detail?.thread.reasoningEffort ?? null}
                      metaDuration={
                        entry.message.runId
                          ? (durationByRunId.get(entry.message.runId) ?? null)
                          : null
                      }
                      provenance={
                        provenanceById.get(entry.message.id) ?? null
                      }
                      threadId={threadId}
                      onReply={
                        entry.message.role === "assistant"
                          ? handleReply
                          : undefined
                      }
                      onCiteSelection={
                        entry.message.role === "assistant"
                          ? handleCiteSelection
                          : undefined
                      }
                      onWaitWhat={
                        entry.message.role === "assistant"
                          ? handleWaitWhat
                          : undefined
                      }
                    />
                    </div>
                    {bar && (
                      <>
                        <ReviewBarStrip
                          bar={bar}
                          isWorking={isWorking}
                          expanded={openTurnSha === bar.sha}
                          onReview={() => {
                            if (onFetchTurnDiff) {
                              setOpenTurnSha((prev) =>
                                prev === bar.sha ? null : bar.sha,
                              );
                              return;
                            }
                            onViewChanges?.();
                          }}
                          onUndo={() => {
                            if (!bar.undoSha || isWorking || restorePending)
                              return;
                            setRestoreError(null);
                            setRestoreConfirm(bar);
                          }}
                        />
                        {openTurnSha === bar.sha && onFetchTurnDiff ? (
                          <Suspense fallback={null}>
                            <TurnDiffPanel
                              threadId={detail.thread.id}
                              sha={bar.sha}
                              turn={bar.turn}
                              mode={turnDiffMode}
                              onModeChange={(m) => setDiffSplit(m === "split")}
                              onFetch={onFetchTurnDiff}
                            />
                          </Suspense>
                        ) : null}
                      </>
                    )}
                  </>
                )}
              </Fragment>
            );
          }
          if (entry.kind === "artifacts") {
            const key = `artifacts:${entry.key}`;
            return (
              <RunArtifacts
                key={key}
                threadId={detail.thread.id}
                group={entry}
                allArtifacts={detail.artifacts ?? []}
                animateIn={!seenEntryKeys.current.has(key)}
              />
            );
          }
          return null;
        })}

        <SuggestedWorkStrip
          suggestions={thread.suggestions}
          onStart={onStartSuggestion}
          onFile={onFileSuggestion}
          onDismiss={onDismissSuggestion}
        />

        {thread.spec && !thread.ask ? (
          <SpecCard
            thread={thread}
            onReviewSpec={onReviewSpec}
            onDispatchSpec={onDispatchSpec}
            onConvergeSpec={onConvergeSpec}
            onStopSpec={onStopSpec}
            onSpecArtifact={onSpecArtifact}
          />
        ) : null}

        {thread.pendingExternalApproval ? (
          <ExternalApprovalCard thread={thread} />
        ) : null}

        {thread.ask ? (
          <AskCard
            thread={thread}
            onStopAsk={onStopAsk}
            promoteWorktree={
              defaultWorktree === true && !project?.remoteHost
            }
          />
        ) : null}

        {(thread.btw ?? []).map((card) => (
          <BtwSideCard
            key={card.id}
            threadId={thread.id}
            card={card}
            onDismiss={onDismissBtw}
            onPromote={onPromoteBtw}
          />
        ))}

        {thread.teach && !thread.ask ? (
          <TeachCard
            thread={thread}
            onStopTeach={onStopTeach}
            onRequestTeachReview={onRequestTeachReview}
          />
        ) : null}

        {!thread.ask && !thread.teach ? (
          <FeltEstimateCard
            thread={thread}
            onSetFeltEstimate={onSetFeltEstimate}
          />
        ) : null}

        {/* A pending plan prompt already shows the plan — don't show it twice. */}
        {(thread.planSteps?.length || thread.plan) &&
        !detail.pendingPermission?.plan ? (
          <PlanCard thread={thread} />
        ) : null}

        {/*
          Persisted question (issue #647): grok/kimi ended their turn after
          asking, so answering is the next message — not a permission answer.
          A live permission prompt wins: that one is blocking a running CLI.
        */}
        {!detail.pendingPermission && thread.pendingQuestion ? (
          <QuestionPrompt
            key={`${thread.id}:${thread.pendingQuestion.id}`}
            requestId={thread.pendingQuestion.id}
            questions={thread.pendingQuestion.questions}
            onAnswer={async (answers, attachments) => {
              // The Answer button gates on every question being answered, so
              // an empty text means nothing was picked — never start a turn
              // with an empty prompt. Paths in the answer values keep
              // file-only submits valid (issue #1219).
              const text = formatQuestionAnswer(answers);
              if (text) await onStartRun(text, undefined, attachments);
            }}
            onDismiss={() => onClearQuestion()}
            {...questionAttach}
          />
        ) : null}

        {detail.pendingPermission?.inputRequest ? (
          <InputPrompt
            key={`${thread.id}:${detail.pendingPermission.requestId}`}
            pending={detail.pendingPermission}
            onRespond={(decision, inputValues) => onRespondPermission(
              detail.pendingPermission!.requestId, decision, undefined, undefined, inputValues,
            )}
          />
        ) : detail.pendingPermission?.questions?.length ? (
          <QuestionPrompt
            key={`${thread.id}:${detail.pendingPermission.requestId}`}
            requestId={detail.pendingPermission.requestId}
            questions={detail.pendingPermission.questions}
            onAnswer={async (answers) =>
              onRespondPermission(
                detail.pendingPermission!.requestId,
                "allow",
                answers,
              )
            }
            onDismiss={() =>
              onRespondPermission(detail.pendingPermission!.requestId, "deny")
            }
            {...questionAttach}
          />
        ) : detail.pendingPermission?.plan ? (
          <PlanPrompt
            key={detail.pendingPermission.requestId}
            pending={detail.pendingPermission}
            onRespond={onRespondPermission}
            onImplement={onImplementPlan}
            onSave={onSavePlan}
          />
        ) : detail.pendingPermission ? (
          <PermissionPrompt
            key={detail.pendingPermission.requestId}
            pending={detail.pendingPermission}
            onRespond={onRespondPermission}
          />
        ) : null}

        {queuedPrompt != null && (
          <div
            className={`${styles.queuedStrip} ${styles.streamIn}${queuedItems.length > 1 ? ` ${styles.queuedStripMulti}` : ""}`}
            data-queued-prompt=""
          >
            {queuedItems.length > 1 ? (
              <>
                <div className={styles.statusLeft}>
                  <span className={styles.queuedLabel} data-queued-label="">
                    {isWorking ? "Queued" : "Queued, paused"}
                  </span>
                  {queuedError ? (
                    <span
                      className={styles.permissionGuardrail}
                      data-queued-error=""
                    >
                      {queuedError}
                    </span>
                  ) : null}
                  {queuedWriteError ? (
                    <span
                      className={styles.permissionGuardrail}
                      data-queued-write-error=""
                    >
                      {queuedWriteError}
                    </span>
                  ) : null}
                </div>
                <ul className={styles.queuedList}>
                  {queuedItems.map((item, i) => (
                    <li
                      key={i}
                      className={`${styles.queuedItem}${queuedDrag === i ? ` ${styles.queuedItemDragging}` : ""}`}
                      data-queued-item={String(i)}
                      draggable={editingQueued == null && !queuedWritePending}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", String(i));
                        setQueuedDrag(i);
                      }}
                      onDragOver={(e) => {
                        if (queuedDrag == null) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = queuedDrag;
                        setQueuedDrag(null);
                        if (from == null || from === i) return;
                        writeQueuedItems(swapQueuedItem(queuedOrder, from, i - from));
                      }}
                      onDragEnd={() => setQueuedDrag(null)}
                    >
                      {editingQueued === i ? (
                        <>
                          <textarea
                            className={styles.queuedEdit}
                            value={queuedEditDraft}
                            rows={2}
                            autoFocus
                            data-edit-queued-input=""
                            onChange={(e) => {
                              setQueuedEditDraft(e.target.value);
                              if (queuedEditError) setQueuedEditError(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                e.preventDefault();
                                closeQueuedEdit();
                              }
                              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                e.preventDefault();
                                saveQueuedEdit();
                              }
                            }}
                          />
                          {queuedEditError ? (
                            <span
                              className={styles.permissionGuardrail}
                              data-queued-edit-error=""
                            >
                              {queuedEditError}
                            </span>
                          ) : null}
                          <div className={styles.queuedActions}>
                            <button
                              type="button"
                              className={styles.retryBtn}
                              onClick={saveQueuedEdit}
                              disabled={queuedEditSaving}
                              data-save-queued-edit=""
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className={styles.stopBtn}
                              onClick={closeQueuedEdit}
                              disabled={queuedEditSaving}
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className={styles.queuedText}>{item}</span>
                          {queuedFiles[i]?.length ? (
                            <span
                              className={styles.queuedFiles}
                              title={queuedFiles[i]!.map((f) => f.name).join(", ")}
                              data-queued-files={String(queuedFiles[i]!.length)}
                            >
                              {queuedFiles[i]!.length === 1
                                ? "1 file"
                                : `${queuedFiles[i]!.length} files`}
                            </span>
                          ) : null}
                          <div
                            className={styles.queuedActions}
                            data-queued-actions=""
                          >
                            {canSteerQueued ? (
                              <button
                                type="button"
                                className={styles.retryBtn}
                                disabled={queuedWritePending}
                                onClick={() => onSteerQueued?.(i)}
                                data-steer-queued=""
                              >
                                Steer now
                              </button>
                            ) : null}
                            {i > 0 ? (
                              <button
                                type="button"
                                className={styles.retryBtn}
                                aria-label="Move queued follow-up up"
                                disabled={queuedWritePending}
                                onClick={() =>
                                  writeQueuedItems(
                                    swapQueuedItem(queuedOrder, i, -1),
                                  )
                                }
                                data-move-queued-up=""
                              >
                                Up
                              </button>
                            ) : null}
                            {i < queuedItems.length - 1 ? (
                              <button
                                type="button"
                                className={styles.retryBtn}
                                aria-label="Move queued follow-up down"
                                disabled={queuedWritePending}
                                onClick={() =>
                                  writeQueuedItems(
                                    swapQueuedItem(queuedOrder, i, 1),
                                  )
                                }
                                data-move-queued-down=""
                              >
                                Down
                              </button>
                            ) : null}
                            {onEditQueued ? (
                              <button
                                type="button"
                                className={styles.retryBtn}
                                disabled={queuedWritePending}
                                onClick={() => {
                                  setQueuedEditDraft(item);
                                  setEditingQueued(i);
                                }}
                                data-edit-queued=""
                              >
                                Edit
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={styles.stopBtn}
                              disabled={queuedWritePending}
                              onClick={() =>
                                writeQueuedItems(
                                  queuedOrder.filter((j) => j !== i),
                                )
                              }
                              data-remove-queued=""
                            >
                              Remove
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                <div className={styles.statusLeft}>
                  {onRetryQueued ? (
                    <button
                      type="button"
                      className={styles.retryBtn}
                      onClick={onRetryQueued}
                      disabled={isWorking}
                      data-retry-queued=""
                    >
                      {queuedError ? "Retry" : "Send now"}
                    </button>
                  ) : null}
                  {onCancelQueued && (
                    <button
                      type="button"
                      className={styles.stopBtn}
                      onClick={onCancelQueued}
                      data-cancel-queued=""
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </>
            ) : editingQueued != null ? (
              <>
                <span className={styles.queuedLabel} data-queued-label="">
                    {isWorking ? "Queued" : "Queued, paused"}
                  </span>
                <textarea
                  className={styles.queuedEdit}
                  value={queuedEditDraft}
                  rows={2}
                  autoFocus
                  data-edit-queued-input=""
                  onChange={(e) => {
                    setQueuedEditDraft(e.target.value);
                    if (queuedEditError) setQueuedEditError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      closeQueuedEdit();
                    }
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      saveQueuedEdit();
                    }
                  }}
                />
                {queuedEditError ? (
                  <span
                    className={styles.permissionGuardrail}
                    data-queued-edit-error=""
                  >
                    {queuedEditError}
                  </span>
                ) : null}
                <div className={styles.queuedActions}>
                  <button
                    type="button"
                    className={styles.retryBtn}
                    onClick={saveQueuedEdit}
                    disabled={queuedEditSaving}
                    data-save-queued-edit=""
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className={styles.stopBtn}
                    onClick={closeQueuedEdit}
                    disabled={queuedEditSaving}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={styles.queuedBody}>
                  <span className={styles.queuedLabel} data-queued-label="">
                    {isWorking ? "Queued" : "Queued, paused"}
                  </span>
                  <span className={styles.queuedText}>{queuedPrompt}</span>
                  {queuedError ? (
                    <span
                      className={styles.permissionGuardrail}
                      data-queued-error=""
                    >
                      {queuedError}
                    </span>
                  ) : null}
                </div>
                <div
                  className={styles.queuedActions}
                  data-queued-actions=""
                >
                  {canSteerQueued ? (
                    <button
                      type="button"
                      className={styles.retryBtn}
                      onClick={() => onSteerQueued?.(0)}
                      data-steer-queued=""
                    >
                      Steer now
                    </button>
                  ) : null}
                  {onEditQueued ? (
                    <button
                      type="button"
                      className={styles.retryBtn}
                      onClick={() => {
                        setQueuedEditDraft(queuedPrompt);
                        setEditingQueued(0);
                      }}
                      data-edit-queued=""
                    >
                      Edit
                    </button>
                  ) : null}
                  {/* Any prompt still queued on a settled thread is one main
                      did not deliver — send it now, whether or not the failure
                      reason survived a reload. */}
                  {onRetryQueued ? (
                    <button
                      type="button"
                      className={styles.retryBtn}
                      onClick={onRetryQueued}
                      disabled={isWorking}
                      data-retry-queued=""
                    >
                      {queuedError ? "Retry" : "Send now"}
                    </button>
                  ) : null}
                  {onCancelQueued && (
                    <button
                      type="button"
                      className={styles.stopBtn}
                      onClick={onCancelQueued}
                      data-cancel-queued=""
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className={styles.composerColumn}>
      <Composer
        threadId={thread.id}
        permissionMode={thread.permissionMode}
        teach={thread.teach ?? null}
        ask={thread.ask === true}
        onPermissionModeChange={onSetPermissionMode}
        provider={threadProviderRef(thread)}
        model={thread.model}
        reasoningEffort={thread.reasoningEffort}
        webSearch={thread.webSearch === true}
        providers={providers}
        agentProfiles={agentProfiles}
        workflows={workflows}
        onSetProvider={onSetProvider}
        onSetReasoningEffort={onSetReasoningEffort}
        onSetWebSearch={onSetWebSearch}
        onSaveWorkflow={onSaveWorkflow}
        onRemoveWorkflow={onRemoveWorkflow}
        workflowListError={workflowListError}
        onRetryWorkflows={onRetryWorkflows}
        sessionId={thread.sessionId}
        statusTab={composerStatus}
        workspaceStrip={
          !project ||
          project.remoteHost ||
          project.scratch ||
          thread.ask ||
          thread.pendingFork ? undefined : thread.worktreePath ||
            detail.messages.some((m) => m.role === "user") ? (
            <WorkspaceStrip
              started={{ branch: thread.branch }}
              worktree={Boolean(thread.worktreePath)}
              projectPath={project.path}
              baseBranch={thread.baseBranch ?? null}
              listBaseBranches={
                listBaseBranches ? () => listBaseBranches(project.id) : undefined
              }
            />
          ) : onSetPendingWorktree && !thread.orchWorker ? (
            <WorkspaceStrip
              worktree={Boolean(thread.pendingWorktree)}
              projectPath={project.path}
              baseBranch={thread.baseBranch ?? null}
              listBaseBranches={
                listBaseBranches ? () => listBaseBranches(project.id) : undefined
              }
              onSetWorktree={(next) => onSetPendingWorktree(thread.id, next)}
              fromOrigin={thread.worktreeFromOrigin === true}
              onSetFromOrigin={(next) =>
                onSetPendingWorktree(thread.id, true, next)
              }
              onSetBaseBranch={
                onSetBaseBranch
                  ? (base) => Promise.resolve(onSetBaseBranch(thread.id, base))
                  : undefined
              }
              previous={previousWorktree}
            />
          ) : undefined
        }
        disabled={isArchived}
        busy={isWorking}
        placeholder={
          isArchived
            ? "Unarchive to continue this thread"
            : isWorking
              ? providers.find((p) => p.id === thread.provider)?.supportsSteer
                ? "Queue a follow-up, steer the live turn, or /btw a side question…"
                : "Queue a follow-up, or /btw a side question…"
              : thread.ask
                ? "Ask about this repo…"
                : undefined
        }
        onSend={handleComposerSend}
        restoreDraft={restoreDraft}
        onBuild={onStartWorkflow}
        onBestOfN={onFork && !thread.ask ? runBestOfN : undefined}
        onDelegate={onFork && !thread.ask ? runDelegate : undefined}
        onModelPickerOpen={onModelPickerOpen}
        onProviderSignIn={onProviderSignIn}
        error={runError}
        onDismissError={onDismissRunError}
        onListFiles={onListFiles}
        onPickMentionFolder={
          onPickDirectory ? pickMentionFolder : undefined
        }
        replyTo={replyTo}
        onClearReply={() => {
          if (!threadId) return;
          setReplyByThread((prev) => {
            if (!(threadId in prev)) return prev;
            const next = { ...prev };
            delete next[threadId];
            return next;
          });
        }}
        onRevealReply={() => {
          if (!replyTo || replySourceGone) return;
          setJumpMessageId(replyTo.messageId);
        }}
        replySourceUnavailable={replySourceGone}
        onPickAttachments={onPickAttachments}
        onPickFolderAttachments={onPickFolderAttachments}
        onSaveAttachmentImage={onSaveAttachmentImage}
        onLoadAttachmentImage={onLoadAttachmentImage}
        onDropAttachmentFiles={onDropAttachmentFiles}
        incomingAttachments={incomingHandoff?.items}
        incomingAttachmentThreadId={incomingHandoff?.threadId ?? null}
        onIncomingAttachmentsConsumed={() => setIncomingHandoff(null)}
        onSlashAction={handleSlashAction}
        cliCommands={cliCommands}
        onStopRun={onStopRun}
        dropHostRef={dropHostRef}
        onFileDragChange={setFileDrag}
      />
      </div>
            </div>
          );
        }}
      />

      {snapOpen && (
        <div
          ref={snapDialogRef}
          className={styles.confirmOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="appsnap-title"
          tabIndex={-1}
          data-appsnap=""
          onClick={() => {
            if (!snapBusy) setSnapOpen(false);
          }}
        >
          <div
            className={styles.confirmDialog}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="appsnap-title" className={styles.confirmTitle}>
              Capture a window
            </h2>
            <p className={styles.confirmBody}>
              Double-Option again to refresh. Esc cancels.
            </p>
            {snapError && (
              <p className={styles.reviewError} role="alert">
                {snapError}
              </p>
            )}
            <ul className={styles.snapList}>
              {snapWindows.map((win) => (
                <li key={win.id}>
                  <button
                    type="button"
                    className={styles.snapRow}
                    data-appsnap-window={win.id}
                    disabled={snapBusy}
                    onClick={() => void captureAppSnap(win.id)}
                  >
                    {win.name}
                  </button>
                </li>
              ))}
            </ul>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.confirmCancel}
                disabled={snapBusy}
                onClick={() => setSnapOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}

      <ProviderQuotaDialog
        open={quotaOpen}
        onClose={() => setQuotaOpen(false)}
        loadLimits={loadProviderLimits}
        activeProvider={detail?.thread.provider ?? null}
        providers={providers}
        demo={quotaDemo}
      />

      {restoreError && (
        <p className={styles.reviewError} role="alert" data-review-undo-error="">
          {restoreError}
        </p>
      )}

      {rewindConfirm && (
        <div
          className={styles.confirmOverlay}
          role="presentation"
          onClick={() => {
            if (rewindPending) return;
            handleRewindCancel();
          }}
        >
          <div
            ref={rewindDialogRef}
            className={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="rewind-title"
            tabIndex={-1}
            data-rewind-confirm={rewindConfirm.messageId}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="rewind-title" className={styles.confirmTitle}>
              Resubmit from this message?
            </h2>
            <p className={styles.confirmBody}>
              {rewindConfirmText(
                rewindDroppedCount(detail.messages, rewindConfirm.messageId),
              )}
            </p>
            {hasWorktree && (
              <label className={styles.confirmCheck}>
                <input
                  type="checkbox"
                  checked={rewindRestoreFiles}
                  data-rewind-restore-files=""
                  onChange={(e) => setRewindRestoreFiles(e.target.checked)}
                />
                Also restore files to that point
              </label>
            )}
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.confirmDanger}
                data-rewind-confirm-submit=""
                disabled={rewindPending || isWorking}
                aria-busy={rewindPending || undefined}
                onClick={() => void handleRewindConfirm()}
              >
                {rewindPending ? "Resubmitting…" : "Resubmit"}
              </button>
              <button
                type="button"
                className={styles.confirmCancel}
                data-rewind-confirm-cancel=""
                disabled={rewindPending}
                onClick={handleRewindCancel}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {restoreConfirm && restoreConfirm.undoSha && (
        <div
          className={styles.confirmOverlay}
          role="presentation"
          onClick={() => {
            if (restorePending) return;
            setRestoreConfirm(null);
          }}
        >
          <div
            ref={reviewUndoDialogRef}
            className={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-undo-title"
            tabIndex={-1}
            data-review-undo-confirm={restoreConfirm.undoSha}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="review-undo-title" className={styles.confirmTitle}>
              Restore turn {restoreConfirm.undoTurn} (
              {shortSha(restoreConfirm.undoSha)})?
            </h2>
            <p className={styles.confirmBody}>
              This resets the worktree and the conversation to this checkpoint.
              Later messages and later checkpoints&apos; work will be lost. The
              main repository is not touched.
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.confirmDanger}
                data-review-undo-submit=""
                disabled={restorePending || isWorking}
                aria-busy={restorePending || undefined}
                onClick={() => void handleRestoreConfirm()}
              >
                {restorePending ? "Restoring…" : "Restore checkpoint"}
              </button>
              <button
                type="button"
                className={styles.confirmCancel}
                data-review-undo-cancel=""
                disabled={restorePending}
                onClick={() => {
                  if (restorePending) return;
                  setRestoreConfirm(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
    </ThreadLinkContext.Provider>
    </PathLinkProvider>
  );
});
