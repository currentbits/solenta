import {
  Fragment,
  memo,
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
import { TerminalPane, type TerminalApi } from "./TerminalPane";
import { BrowserPane } from "./BrowserPane";
import { SimulatorPane } from "./SimulatorPane";
import { useWorktreeChrome } from "./WorktreeControl";
import {
  defaultPaneLayout,
  findLeaf,
  firstLeafId,
  hasPaneType,
  hydratePaneLayout,
  leaves,
  openPane,
  savePaneLayout,
  type LayoutNode,
  type PaneType,
} from "../paneLayout";
import type {
  AttachmentInfo,
  BlastRadiusInfo,
  DevServerState,
  LocalServerInfo,
  ChatMessage,
  CoderApi,
  ConflictContext,
  DiffResult,
  FileChange,
  GitSyncInfo,
  PrChecksResult,
  PrInfo,
  PendingPermissionInfo,
  PendingQuestion,
  PermissionDecision,
  PermissionMode,
  CliSlashCommand,
  ProjectInfo,
  SimulatorStatus,
  AgentProfile,
  ProviderInfo,
  ReasoningEffort,
  RunStatInfo,
  SourceControlDiscovery,
  SpecArtifact,
  SpecStage,
  ThreadDetail,
  ThreadInfo,
  BtwCard as BtwCardInfo,
  WorkLogItem,
  WorkSuggestion,
  WorkflowTemplateInfo,
} from "../shared/ipc";
import { SPEC_ARTIFACTS, THREAD_NOTES_MAX, FELT_ESTIMATE_BUCKETS_MS } from "../shared/ipc";
import { TEACH_AUTONOMY_LABELS } from "../teach";
import type { TeachAutonomy } from "../shared/ipc";
import type { WorkflowSaveInput } from "../useCoder";
import {
  annotateHunkLines,
  commentGutterLabel,
  commentLineRef,
  diffLineKind,
  formatDiffCommentPrompt,
  isEmptyDiff,
  type DiffCommentAnchor,
  type DiffLineKind,
} from "../diffView";
import {
  contextBreakdown,
  type ContextBreakdownSegment,
} from "../contextBreakdown";
import {
  contextRing,
  threadContextWindow,
  type ContextRingView,
} from "../contextRing";
import { messageMetaLine } from "../messageMeta";
import {
  buildTimeline,
  workLogDurationLabel,
  type TimelineEntry,
  type WorkLogGroup,
} from "../timeline";
import {
  collapseTimeline,
  liveGroupLabel,
  summarizeToolGroup,
  type ToolGroup,
} from "../toolGroups";
import { RunArtifacts } from "./RunArtifacts";
import {
  clampWindowStart,
  ensureVisibleStart,
  extendWindowStart,
  initialWindowStart,
} from "../transcriptWindow";
import {
  lastUserMessage,
  retryAnchorEventId,
  retryButtonTitle,
} from "../retryTurn";
import {
  isEditableUserMessage,
  rewindConfirmText,
  rewindDroppedCount,
} from "../editResubmit";
import {
  formatReviewBarText,
  mapReviewBars,
  type ReviewBar,
} from "../reviewBar";
import {
  isRunCollapsed,
  mapRunHeaders,
  toggleRunCollapsed,
  type RunHeader,
} from "../runHeader";
import type { SlashAction, SlashCommand } from "../slashCommands";
import { buildBestOfNEntries } from "../bestOfN";
import { createPrPrompt, isPrTooLargeMessage, splitPrPrompt } from "../prUi";
import {
  blastRadiusLabel,
  blastRadiusTitle,
  isCiWorkflowBlockMessage,
  isCiWorkflowPath,
} from "../blastRadius";
import { suggestNextGitAction } from "../nextGitAction";
import { forgeReadiness } from "../sourceControl";
import { formatQuotaWaitLabel } from "../quotaWait";
import {
  buildReviewItinerary,
  orderedPatches,
  parseReviewAnnotation,
  type ReviewItinerary,
  type ReviewSymbol,
} from "../reviewItinerary";
import {
  ChunkRationale,
  ReviewItineraryView,
} from "./ReviewItinerary";
import { formatElapsed } from "../format";
import { liveWorkingLabel } from "../workingLabel";
import { useEscapeClose } from "../useEscapeClose";
import {
  comparePeerLabel,
  compareSteps,
  extractSteps,
  formatDivergenceHeadline,
  isThreadDone,
  sameThreadRuns,
  truncateStepValue,
  useDivergenceCardEnabled,
  type ComparePeer,
  type DivergenceField,
} from "../divergence";
import { useRunDurationEnabled, useVerboseToolCards } from "../uiPrefs";
import { DROP_OVERLAY_MESSAGE } from "../dropFiles";
import { Composer } from "./Composer";
import { repoRelativeDir } from "../mention";
import { createDoubleOptionTracker } from "../appsnapHotkey";
import type { ReplyTarget } from "../replyContext";
import { waitWhatPrompt } from "../waitWhat";
import { Markdown } from "./Markdown";
import { sessionImagePathsFromMessages } from "../sessionImages";
import { PathLinkProvider, PathText } from "./PathLinks";
import {
  messageProvenance,
  provenanceVisible,
  type MessageProvenance,
} from "../provenance";
import styles from "./ThreadView.module.css";

const EMPTY_COMPARE_PEERS: ComparePeer[] = [];

const PUSH_FLASH_MS = 3000;
const COPY_FLASH_MS = 1500;

/** Byte-equal to electron/worktrees.js restoreCheckpoint run-active guard. */
const RESTORE_ACTIVE_TITLE =
  "Cannot restore a checkpoint while a run is active";

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

const STICK_BOTTOM_PX = 80;

const RING_R = 8;
const RING_C = 2 * Math.PI * RING_R;

/** Per-thread sandbox yes/no; reason lives on hover (#436). */
function SandboxBadge({
  sandbox,
}: {
  sandbox: { sandboxed: boolean; reason: string };
}) {
  const label = sandbox.sandboxed ? "Sandboxed" : "Not sandboxed";
  return (
    <span
      className={styles.sandboxBadge}
      data-sandbox-badge=""
      data-sandboxed={sandbox.sandboxed ? "yes" : "no"}
      title={sandbox.reason}
      aria-label={`${label}: ${sandbox.reason}`}
    >
      {label}
    </span>
  );
}

/** Small context-fill ring + percent; hover/focus/`/usage` opens the breakdown. */
function ContextRingBadge({
  ring,
  segments,
  used,
  open,
  onOpenChange,
  onFork,
}: {
  ring: ContextRingView;
  segments: ContextBreakdownSegment[];
  used: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFork?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEscapeClose(open, useCallback(() => onOpenChange(false), [onOpenChange]));
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onOpenChange]);
  const label = `Context ${ring.percentLabel} of ${ring.windowLabel}`;
  return (
    <div
      className={styles.menuWrap}
      ref={wrapRef}
      onMouseEnter={() => onOpenChange(true)}
      onMouseLeave={() => onOpenChange(false)}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.contextRing}
        data-context-ring=""
        data-warn={ring.warn ? "true" : undefined}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onFocus={() => onOpenChange(true)}
        onBlur={(e) => {
          if (!wrapRef.current?.contains(e.relatedTarget as Node)) {
            onOpenChange(false);
          }
        }}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
          <circle cx="10" cy="10" r={RING_R} className={styles.ringTrack} />
          <circle
            cx="10"
            cy="10"
            r={RING_R}
            className={styles.ringFill}
            strokeDasharray={`${(ring.fraction * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
        <span className={styles.ringLabel}>{ring.percentLabel}</span>
      </button>
      {open && (
        <div
          className={`${styles.menu} ${styles.contextPopover}`}
          role="region"
          aria-label="Context breakdown"
          data-context-popover=""
        >
          <div className={styles.contextPopoverHead}>
            <span>
              {used.toLocaleString()} / {ring.windowLabel}
            </span>
            <span>{ring.percentLabel}</span>
          </div>
          <ul className={styles.contextSegList}>
            {segments.map((seg) => (
              <li key={seg.key} className={styles.contextSeg}>
                <span>{seg.label}</span>
                <span className={styles.contextSegTokens}>
                  {seg.tokens.toLocaleString()}
                </span>
                <span className={styles.contextSegPct}>
                  {Math.round(seg.fraction * 100)}%
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.contextNote}>Estimated from the thread (chars÷4)</p>
          {ring.warn && (
            <div className={styles.contextWarn}>
              <p className={styles.contextWarnNote}>Compaction is close</p>
              {onFork && (
                <button
                  type="button"
                  className={styles.contextForkBtn}
                  data-context-fork=""
                  onClick={() => {
                    triggerRef.current?.focus();
                    onOpenChange(false);
                    onFork();
                  }}
                >
                  Fork to fresh context
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Full-size viewer for an image clicked anywhere in the thread body. Clicking
 * the image toggles fit-to-window / native resolution (the overlay scrolls);
 * backdrop, close button and Escape all dismiss.
 */
function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  useEscapeClose(true, onClose);
  return (
    <div
      className={styles.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Image"}
      data-image-lightbox=""
      onClick={onClose}
    >
      <img
        className={styles.lightboxImg}
        data-zoom={zoomed ? "1" : undefined}
        src={src}
        alt={alt}
        title={zoomed ? "Fit to window" : "View at full size"}
        onClick={(e) => {
          e.stopPropagation();
          setZoomed((v) => !v);
        }}
      />
      <button
        type="button"
        className={styles.lightboxClose}
        aria-label="Close image"
        title="Close (Esc)"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
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
  onSaveWorkflow: (template: WorkflowSaveInput) => Promise<WorkflowTemplateInfo>;
  onRemoveWorkflow: (id: string) => Promise<void>;
  onStopRun: () => void | Promise<void>;
  /** Resume a parked quota-wait now (#462). */
  onResumeQuotaWait?: () => void | Promise<void>;
  /** Per-thread auto-resume override. null inherits the global setting. */
  onSetQuotaWaitAutoResume?: (
    enabled: boolean | null,
  ) => void | Promise<void>;
  /** Follow-up typed during the run, waiting for it to land (issue #92). */
  queuedPrompt?: string | null;
  /** Last delivery failure; the prompt is still queued (issue #314). */
  queuedError?: string | null;
  /** Drop the queued follow-up. */
  onCancelQueued?: () => void;
  /** Re-send a queued prompt after a delivery failure. */
  onRetryQueued?: () => void;
  /** Replace the queued follow-up's text (edit in the strip, issue #364). */
  onEditQueued?: (prompt: string) => void;
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
  ) => void | Promise<void>;
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
  /** Save scratch notes for a thread (header notes editor, issue #194). */
  onSetNotes?: (threadId: string, notes: string) => void | Promise<void>;
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
  /**
   * Fires whenever the workspace holds more than one pane. App collapses
   * the agents rail so the panes get the width.
   */
  onPanesNeedRoom?: () => void;
  /** Per-checkpoint-pair shortstat for review bars. */
  runStats?: (threadId: string) => Promise<RunStatInfo[]>;
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
    projectPath?: string;
  }) => Promise<CliSlashCommand[]>;
  /** Resolve transcript path tokens against the thread worktree. */
  onResolvePaths?: (
    paths: string[],
  ) => Promise<Array<{ path: string; abs: string | null }>>;
  /** Open or reveal a resolved worktree path. */
  onOpenWorkspacePath?: (
    abs: string,
    opts?: { reveal?: boolean },
  ) => void | Promise<void>;
  /** Loads an image a tool returned (ToolCallInfo.images) as a data URL. */
  onLoadImage?: (name: string) => Promise<string | null>;
  /** Native file/image/folder picker for composer attachments (Electron only). */
  onPickAttachments?: () => Promise<AttachmentInfo[]>;
  /** Persist a pasted image; returns its attachment or null when rejected. */
  onSaveAttachmentImage?: (dataUrl: string) => Promise<AttachmentInfo | null>;
  /** Loads one attached image (absolute path) as a data URL. */
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
  /** Classify drag-dropped files into attachments. */
  onDropAttachmentFiles?: (files: File[]) => Promise<AttachmentInfo[]>;
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
  /** CI checks for the current PR. Failures stay in-band. */
  onPrChecks?: () => Promise<PrChecksResult>;
  /** Squash-merge the current OPEN PR. Pass ciWorkflowApproved after sign-off. */
  onPrMerge?: (opts?: { ciWorkflowApproved?: boolean }) => Promise<PrInfo>;
  /** Upstream state for the header sync pill; absent hides the pill. */
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  /** Fetch remotes before the sync pill re-reads state. */
  gitFetch?: (threadId: string) => Promise<void>;
  /** Isolated worktree setup (header control, #680). */
  onSetupWorktree?: () => Promise<unknown>;
  onMergeWorktree?: (opts?: {
    ciWorkflowApproved?: boolean;
  }) => Promise<unknown>;
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
  /** Unmerged worktree files plus capped conflict-marker snippets. */
  conflictContext?: (threadId: string) => Promise<ConflictContext>;
  /** Open the thread worktree in the configured editor. */
  onOpenWorktree?: () => void | Promise<void>;
  /** Run the project's setup command or a named quick action (issue #153). */
  onRunCommand?: (
    threadId: string,
    actionId?: string,
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
  /**
   * Same-task siblings (best-of-N / forks) for the divergence compare
   * (issue #393). Resolved in App so this pane is not passed the full list.
   */
  comparePeers?: ComparePeer[];
  /** Load a sibling transcript without marking it visited. */
  onPeekThread?: (id: string) => Promise<ThreadDetail>;
  /** Fired when the composer model picker opens (provider list refresh). */
  onModelPickerOpen?: () => void;
  /** Create a new thread in the current project (`/new`, `/clear`). */
  onNewThread?: () => void;
  /** Settle the open thread (`/clear`). Does not delete. */
  onSettleThread?: () => void | Promise<void>;
}

function ToolCallCard({
  message,
  autoExpand,
  animateIn,
  onLoadImage,
  bare,
}: {
  message: ChatMessage;
  autoExpand: boolean;
  /** Freshly appended at the live tail — play the stream-in entrance. */
  animateIn?: boolean;
  onLoadImage?: (name: string) => Promise<string | null>;
  /** Inside an expanded tool group: disclosure only, no tile. */
  bare?: boolean;
}) {
  const tool = message.tool;
  const [manual, setManual] = useState<boolean | null>(null);
  /**
   * Latch the entrance flag at mount: any later re-render passes animateIn=false
   * (the key is already seen), and stripping the class mid-flight would cancel
   * the CSS animation. Remounts (collapse/expand) get a fresh false.
   */
  const [entered] = useState(Boolean(animateIn));
  const open = manual ?? autoExpand;
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  // Bytes live under userData, not in the message: fetch an img src (protocol
  // URL on desktop, data URL on web) the first time the card is open.
  const imageKey = (tool?.images ?? []).join("\n");
  useEffect(() => {
    if (!open || !imageKey || !onLoadImage) return;
    let live = true;
    void Promise.all(imageKey.split("\n").map((name) => onLoadImage(name)))
      .then((urls) => {
        if (live) setImageUrls(urls.filter((u): u is string => Boolean(u)));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, imageKey, onLoadImage]);

  if (!tool) {
    return (
      <article
        className={`${styles.message}${entered ? ` ${styles.streamIn}` : ""}`}
        data-stream-in={entered ? "" : undefined}
      >
        <p>{message.text}</p>
      </article>
    );
  }

  const status: "running" | "done" | "error" = !tool.done
    ? "running"
    : tool.isError
      ? "error"
      : "done";

  return (
    <section
      className={`${bare ? styles.toolBare : `${styles.card} ${styles.toolCard}`}${entered ? ` ${styles.streamIn}` : ""}`}
      data-stream-in={entered ? "" : undefined}
    >
      <div
        className={styles.toolHeader}
        onClick={() => setManual(!open)}
      >
        <button
          type="button"
          className={styles.toolToggle}
          onClick={(e) => {
            e.stopPropagation();
            setManual(!open);
          }}
          aria-expanded={open}
        >
          <span
            className={styles.toolDot}
            data-status={status}
            aria-label={status}
          />
          <span className={styles.toolName}>{tool.name}</span>
        </button>
        <span className={styles.toolSummary}>
          <PathText text={message.text} />
        </span>
        <span className={styles.chevron} data-open={open} aria-hidden="true">
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 2 6.5 5 3.5 8" />
          </svg>
        </span>
      </div>
      {open && (
        <div className={styles.toolBody}>
          <pre className={styles.toolPre}>
            <PathText text={tool.input} />
          </pre>
          {tool.output != null && tool.output !== "" && (
            <>
              <div className={styles.toolDivider} />
              <pre className={styles.toolPre}>
                <PathText text={tool.output} />
              </pre>
            </>
          )}
          {imageUrls.map((url) => (
            <img
              key={url.slice(-32)}
              className={styles.toolImage}
              src={url}
              alt={`Image from ${tool.name}`}
              title="Click to view full size"
              tabIndex={0}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ThinkingCard({
  message,
  autoExpand,
  animateIn,
  bare,
}: {
  message: ChatMessage;
  autoExpand: boolean;
  animateIn?: boolean;
  bare?: boolean;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const [entered] = useState(Boolean(animateIn));
  const open = manual ?? autoExpand;
  const status: "running" | "done" = autoExpand ? "running" : "done";
  const firstLine = message.text.split(/\r?\n/, 1)[0] ?? "";

  return (
    <section
      className={`${bare ? styles.toolBare : `${styles.card} ${styles.toolCard}`}${entered ? ` ${styles.streamIn}` : ""}`}
      data-thinking=""
      data-stream-in={entered ? "" : undefined}
    >
      <div className={styles.toolHeader} onClick={() => setManual(!open)}>
        <button
          type="button"
          className={styles.toolToggle}
          onClick={(e) => {
            e.stopPropagation();
            setManual(!open);
          }}
          aria-expanded={open}
        >
          <span
            className={styles.toolDot}
            data-status={status}
            aria-label={status}
          />
          <span className={styles.toolName}>Thinking</span>
        </button>
        {!open && (
          <span className={styles.toolSummary}>
            <PathText text={firstLine} />
          </span>
        )}
        <span className={styles.chevron} data-open={open} aria-hidden="true">
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 2 6.5 5 3.5 8" />
          </svg>
        </span>
      </div>
      {open && (
        <div className={styles.toolBody}>
          <pre className={styles.toolPre}>
            <PathText text={message.text} />
          </pre>
        </div>
      )}
    </section>
  );
}

function ToolGroupRow({
  group,
  working,
  expanded,
  verbose,
  animateIn,
  onToggle,
  onLoadImage,
  latestRunningToolId,
  latestThinkingId,
}: {
  group: ToolGroup;
  working: boolean;
  expanded: boolean;
  verbose: boolean;
  animateIn?: boolean;
  onToggle: () => void;
  onLoadImage?: (name: string) => Promise<string | null>;
  latestRunningToolId: string | null;
  latestThinkingId: string | null;
}) {
  const [entered] = useState(Boolean(animateIn));
  const open = verbose || expanded;
  const live = working ? liveGroupLabel(group.messages) : null;
  const label = live ?? summarizeToolGroup(group.messages);
  return (
    <section
      className={`${styles.toolGroup}${entered ? ` ${styles.streamIn}` : ""}`}
      data-tool-group={group.id}
      data-status={group.hasError ? "error" : undefined}
      data-thinking={
        !group.messages.some((m) => m.role === "tool") &&
        group.messages.some((m) => m.thinking)
          ? ""
          : undefined
      }
      data-stream-in={entered ? "" : undefined}
    >
      <button
        type="button"
        className={styles.toolGroupToggle}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={styles.chevron} data-open={open} aria-hidden="true">
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 2 6.5 5 3.5 8" />
          </svg>
        </span>
        <span>{label}</span>
      </button>
      {open &&
        group.messages.map((message) =>
          message.thinking ? (
            <ThinkingCard
              key={message.id}
              message={message}
              autoExpand={verbose || message.id === latestThinkingId}
              bare
            />
          ) : (
            <ToolCallCard
              key={message.id}
              message={message}
              autoExpand={verbose || message.id === latestRunningToolId}
              onLoadImage={onLoadImage}
              bare
            />
          ),
        )}
    </section>
  );
}

/**
 * Attachments on a user transcript message: image thumbnails load lazily as
 * img src (solenta-media:// on desktop, data URL on web); files/folders
 * render as icon + name.
 */
function TranscriptAttachments({
  attachments,
  onLoadImage,
}: {
  attachments: AttachmentInfo[];
  onLoadImage?: (path: string) => Promise<string | null>;
}) {
  return (
    <div className={styles.attachmentChips}>
      {attachments.map((a) => (
        <TranscriptAttachmentChip
          key={a.path}
          attachment={a}
          onLoadImage={onLoadImage}
        />
      ))}
    </div>
  );
}

function TranscriptAttachmentChip({
  attachment,
  onLoadImage,
}: {
  attachment: AttachmentInfo;
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
          tabIndex={0}
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
    </span>
  );
}

/**
 * One timeline row. memo'd because a streamed update re-renders the whole
 * timeline while only the message being written actually changed — so the
 * props are flat scalars, keeping the default shallow compare honest.
 */
/**
 * User bubble. Edit state lives here so a streamed timeline tick does not
 * blow away the draft. Confirm (destructive rewind) stays on ThreadView.
 */
const UserMessageBlock = memo(function UserMessageBlock({
  message,
  canEdit,
  confirming,
  animateIn,
  onRequestResubmit,
  onCancelConfirm,
  onLoadAttachmentImage,
  onSelectThread,
}: {
  message: ChatMessage;
  canEdit: boolean;
  confirming: boolean;
  /** Freshly appended at the live tail — play the stream-in entrance. */
  animateIn?: boolean;
  onRequestResubmit?: (messageId: string, prompt: string) => void;
  onCancelConfirm?: () => void;
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
  onSelectThread?: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!canEdit && editing) {
      setEditing(false);
      setDraft(message.text);
    }
  }, [canEdit, editing, message.text]);

  const fromThread = message.fromThread;
  // Latch at mount; see ToolCallCard for why.
  const [entered] = useState(Boolean(animateIn));
  const streamCls = entered ? ` ${styles.streamIn}` : "";
  const streamAttr = entered ? "" : undefined;
  const cancelEdit = () => {
    if (confirming) onCancelConfirm?.();
    setEditing(false);
    setDraft(message.text);
  };

  const submitEdit = () => {
    const prompt = draft.trim();
    if (!prompt || !onRequestResubmit) return;
    onRequestResubmit(message.id, prompt);
  };

  if (editing && canEdit) {
    return (
      <article
        className={`${styles.message} ${styles.messageUser}${streamCls}`}
        data-stream-in={streamAttr}
      >
        <div className={styles.userEdit}>
          <textarea
            ref={taRef}
            className={styles.userEditTextarea}
            aria-label="Edit message"
            data-edit-textarea={message.id}
            value={draft}
            rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (confirming) onCancelConfirm?.();
                else cancelEdit();
                return;
              }
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submitEdit();
              }
            }}
          />
          <div className={styles.userEditActions}>
            <button
              type="button"
              className={styles.retryBtn}
              data-edit-resubmit={message.id}
              disabled={!draft.trim()}
              onClick={submitEdit}
            >
              Resubmit
            </button>
            <button
              type="button"
              className={styles.retryBtn}
              data-edit-cancel={message.id}
              onClick={cancelEdit}
            >
              Cancel
            </button>
          </div>
        </div>
      </article>
    );
  }

  if (fromThread) {
    const label = fromThread.title || fromThread.id;
    return (
      <article
        className={`${styles.message} ${styles.messageInbound}${streamCls}`}
        data-inbound-card=""
        data-inbound-from={fromThread.id}
        data-stream-in={streamAttr}
      >
        <div className={styles.inboundCard}>
          <div className={styles.inboundFrom}>
            From{" "}
            {onSelectThread ? (
              <button
                type="button"
                className={styles.handoffLink}
                data-inbound-source={fromThread.id}
                onClick={() => onSelectThread(fromThread.id)}
              >
                {label}
              </button>
            ) : (
              <span>{label}</span>
            )}
          </div>
          <div className={styles.inboundBody}>{message.text}</div>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`${styles.message} ${styles.messageUser}${streamCls}`}
      data-stream-in={streamAttr}
    >
      <div className={styles.userBubbleWrap}>
        <div className={styles.userBubbleCluster}>
          {canEdit && onRequestResubmit && (
            <button
              type="button"
              className={`${styles.retryBtn} ${styles.userEditBtn}`}
              aria-label="Edit and resubmit"
              title="Edit and resubmit"
              data-edit-message={message.id}
              onClick={() => {
                setDraft(message.text);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
          <div className={styles.userBubble}>
            {message.text}
            {message.attachments && message.attachments.length > 0 && (
              <TranscriptAttachments
                attachments={message.attachments}
                onLoadImage={onLoadAttachmentImage}
              />
            )}
          </div>
        </div>
      </div>
    </article>
  );
});

/** Last two path segments for a chip; full list stays on the tooltip. */
function provShortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

/**
 * Provenance tier strip under an assistant message (issue #404). Grounded
 * messages get one chip per addressable source tier; a substantive message
 * with no addressable source gets the "model prior knowledge" tag — the
 * fluent-summary warning this feature exists for.
 */
function ProvenanceStrip({
  prov,
  text,
}: {
  prov: MessageProvenance;
  text: string;
}) {
  if (!provenanceVisible(prov, text)) return null;
  if (!prov.grounded) {
    return (
      <div className={styles.provStrip} data-provenance="prior">
        <span
          className={styles.provChip}
          data-tier="prior"
          title="No repo file, shared-memory entry, or GitHub issue backs this message — it came from the model's prior knowledge."
        >
          model prior knowledge
        </span>
      </div>
    );
  }
  return (
    <div className={styles.provStrip} data-provenance="grounded">
      {prov.repo.length > 0 && (
        <span
          className={styles.provChip}
          data-tier="repo"
          title={prov.repo.join("\n")}
        >
          repo: {provShortPath(prov.repo[0])}
          {prov.repo.length > 1 ? ` +${prov.repo.length - 1}` : ""}
        </span>
      )}
      {prov.memory.length > 0 && (
        <span
          className={styles.provChip}
          data-tier="memory"
          title={`Shared memory: ${prov.memory.join(", ")}`}
        >
          memory
        </span>
      )}
      {prov.issues.map((ref) => (
        <span
          key={ref}
          className={styles.provChip}
          data-tier="issue"
          title="GitHub issue/PR reference"
        >
          {ref.startsWith("#") ? ref : "issue"}
        </span>
      ))}
    </div>
  );
}

const MessageBlock = memo(function MessageBlock({
  message,
  autoExpandTool,
  animateIn,
  streaming,
  eventActionLabel,
  eventActionTitle,
  onEventAction,
  canEdit,
  confirming,
  onRequestResubmit,
  onCancelConfirm,
  metaModel = null,
  metaEffort = null,
  metaDuration = null,
  provenance = null,
  onLoadImage,
  onLoadAttachmentImage,
  onSelectThread,
  onReply,
  onWaitWhat,
}: {
  message: ChatMessage;
  autoExpandTool: boolean;
  /** Freshly appended at the live tail — play the stream-in entrance. */
  animateIn?: boolean;
  /** Actively growing assistant message — show the streaming caret. */
  streaming?: boolean;
  onLoadImage?: (name: string) => Promise<string | null>;
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
  eventActionLabel?: string;
  eventActionTitle?: string;
  onEventAction?: () => void;
  canEdit?: boolean;
  confirming?: boolean;
  onRequestResubmit?: (messageId: string, prompt: string) => void;
  onCancelConfirm?: () => void;
  /** Assistant footer segments; null fields are omitted inside. */
  metaModel?: string | null;
  metaEffort?: string | null;
  metaDuration?: string | null;
  /** Provenance tiers for assistant messages; null hides the strip. */
  provenance?: MessageProvenance | null;
  onSelectThread?: (id: string) => void;
  onReply?: (message: ChatMessage) => void;
  onWaitWhat?: (message: ChatMessage) => void;
}) {
  // Latch at mount; see ToolCallCard for why.
  const [entered] = useState(Boolean(animateIn));
  if (message.thinking) {
    return (
      <ThinkingCard
        message={message}
        autoExpand={autoExpandTool}
        animateIn={entered}
      />
    );
  }
  if (message.role === "tool") {
    return (
      <ToolCallCard
        message={message}
        autoExpand={autoExpandTool}
        animateIn={entered}
        onLoadImage={onLoadImage}
      />
    );
  }

  if (message.role === "user") {
    return (
      <UserMessageBlock
        message={message}
        canEdit={Boolean(canEdit)}
        confirming={Boolean(confirming)}
        animateIn={entered}
        onRequestResubmit={onRequestResubmit}
        onCancelConfirm={onCancelConfirm}
        onLoadAttachmentImage={onLoadAttachmentImage}
        onSelectThread={onSelectThread}
      />
    );
  }

  if (message.role === "event") {
    return (
      <section
        className={`${styles.eventLine}${entered ? ` ${styles.streamIn}` : ""}`}
        data-stream-in={entered ? "" : undefined}
      >
        <div className={styles.eventRow}>
          <div className={styles.eventTitle}>{message.text}</div>
          {eventActionLabel && onEventAction && (
            <button
              type="button"
              className={styles.retryBtn}
              title={eventActionTitle}
              onClick={onEventAction}
            >
              {eventActionLabel}
            </button>
          )}
        </div>
      </section>
    );
  }

  const metaLine = messageMetaLine({
    createdAt: message.createdAt,
    model: metaModel,
    effort: metaEffort,
    duration: metaDuration,
  });
  return (
    <article
      className={`${styles.message}${entered ? ` ${styles.streamIn}` : ""}`}
      data-stream-in={entered ? "" : undefined}
    >
      <Markdown text={message.text} />
      {streaming && (
        <span
          className={styles.streamCaret}
          data-streaming-caret=""
          aria-hidden
        />
      )}
      {provenance && <ProvenanceStrip prov={provenance} text={message.text} />}
      <footer className={styles.msgMeta}>
        <span>{metaLine}</span>
        {!streaming && message.text.trim() && (onReply || onWaitWhat) && (
          <span className={styles.msgActions}>
            {onReply && (
              <button
                type="button"
                className={styles.msgAction}
                data-msg-reply=""
                title="Quote this message as context for the next send"
                onClick={() => onReply(message)}
              >
                Reply
              </button>
            )}
            {onWaitWhat && (
              <button
                type="button"
                className={styles.msgAction}
                data-msg-wait-what=""
                title="Re-explain this message in plain English"
                onClick={() => onWaitWhat(message)}
              >
                Wait, what?
              </button>
            )}
          </span>
        )}
      </footer>
    </article>
  );
});

function ReviewBarStrip({
  bar,
  isWorking,
  onReview,
  onUndo,
}: {
  bar: ReviewBar;
  isWorking: boolean;
  onReview: () => void;
  onUndo: () => void;
}) {
  const canUndo = Boolean(bar.undoSha) && !isWorking;
  const undoTitle = isWorking
    ? RESTORE_ACTIVE_TITLE
    : bar.undoSha
      ? "Undo this run"
      : "Nothing to undo";
  return (
    <div className={styles.reviewBar} data-review-bar={bar.runId}>
      <span className={styles.reviewStats} data-review-stats="">
        {formatReviewBarText(bar.files, bar.additions, bar.deletions)}
      </span>
      <div className={styles.reviewActions}>
        <button
          type="button"
          className={styles.reviewBtn}
          data-review-undo=""
          disabled={!canUndo}
          title={undoTitle}
          onClick={() => {
            if (!canUndo) return;
            onUndo();
          }}
        >
          Undo
        </button>
        <button
          type="button"
          className={styles.reviewBtn}
          data-review-open=""
          title="Review changes"
          onClick={onReview}
        >
          Review
        </button>
      </div>
    </div>
  );
}

/** Open suggested-work chips under the transcript (issue #550). */
function SuggestedWorkStrip({
  suggestions,
  onStart,
  onFile,
  onDismiss,
}: {
  suggestions: WorkSuggestion[] | undefined;
  onStart?: (s: WorkSuggestion) => void | Promise<void>;
  onFile?: (s: WorkSuggestion) => void | Promise<void>;
  onDismiss?: (s: WorkSuggestion) => void | Promise<void>;
}) {
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const open = (suggestions ?? []).filter((s) => s.status === "open");
  if (open.length === 0) return null;

  const run = (
    s: WorkSuggestion,
    action?: (s: WorkSuggestion) => void | Promise<void>,
  ) => {
    if (!action || inFlight.has(s.id)) return;
    setInFlight((prev) => new Set(prev).add(s.id));
    void Promise.resolve(action(s)).finally(() => {
      setInFlight((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    });
  };

  return (
    <div className={styles.suggestedWork} data-suggested-work="">
      {open.map((s) => {
        const busy = inFlight.has(s.id);
        return (
          <div
            key={s.id}
            className={styles.suggestedRow}
            data-suggestion-id={s.id}
          >
            <span className={styles.suggestedTitle}>{s.title}</span>
            <div className={styles.suggestedActions}>
              <button
                type="button"
                className={styles.reviewBtn}
                data-suggestion-action="start"
                disabled={busy}
                onClick={() => run(s, onStart)}
              >
                Start a thread
              </button>
              <button
                type="button"
                className={styles.reviewBtn}
                data-suggestion-action="file"
                disabled={busy}
                onClick={() => run(s, onFile)}
              >
                File on planboard
              </button>
              <button
                type="button"
                className={styles.reviewBtn}
                data-suggestion-action="dismiss"
                disabled={busy}
                onClick={() => run(s, onDismiss)}
              >
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Collapsible "Worked for 2m 5s" header row above a completed run. */
function RunHeaderRow({
  header,
  collapsed,
  onToggle,
}: {
  header: RunHeader;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.runHeader}
      data-run-header={header.runId}
      aria-expanded={!collapsed}
      title={collapsed ? "Show this run" : "Hide this run"}
      onClick={onToggle}
    >
      <span className={styles.chevron} data-open={!collapsed}>
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 2 6.5 5 3.5 8" />
        </svg>
      </span>
      <span className={styles.runHeaderLabel}>{header.label}</span>
    </button>
  );
}

function syncPillLabel(info: GitSyncInfo | null): string | null {
  if (!info || !info.hasUpstream) return null;
  if (info.ahead === 0 && info.behind === 0) return "Synced";
  const parts: string[] = [];
  if (info.ahead > 0) parts.push(`${info.ahead} ahead`);
  if (info.behind > 0) parts.push(`${info.behind} behind`);
  return parts.join(" · ");
}

/**
 * Small upstream-state pill next to Push. Fetches then reads on mount and
 * whenever refreshNonce bumps (after a push); clicking refetches. Hidden
 * entirely when the thread root has no upstream.
 */
function SyncPill({
  threadId,
  gitSyncInfo,
  gitFetch,
  refreshNonce,
}: {
  threadId: string;
  gitSyncInfo: (threadId: string) => Promise<GitSyncInfo>;
  gitFetch: (threadId: string) => Promise<void>;
  refreshNonce: number;
}) {
  const [info, setInfo] = useState<GitSyncInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const threadRef = useRef(threadId);
  threadRef.current = threadId;

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await gitFetch(threadId);
    } catch {
      // Offline or no remote: fall through to re-reading local state.
    }
    try {
      const next = await gitSyncInfo(threadId);
      if (threadRef.current === threadId) setInfo(next);
    } catch {
      if (threadRef.current === threadId) setInfo(null);
    } finally {
      if (threadRef.current === threadId) setBusy(false);
    }
  }, [threadId, gitFetch, gitSyncInfo]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshNonce]);

  const label = syncPillLabel(info);
  if (!label) return null;
  return (
    <button
      type="button"
      className={styles.syncPill}
      data-sync-pill=""
      title="Fetch from remote"
      aria-busy={busy || undefined}
      onClick={() => void refresh()}
    >
      {label}
    </button>
  );
}

const CHECKS_POLL_MS = 8000;

/**
 * One header control that always names the next git step (issue #382).
 * Replaces the always-visible Push + Create PR pair.
 */
function NextGitActionButton({
  thread,
  isWorking,
  remoteProject,
  changesOpen,
  changesNonce,
  syncRefreshNonce,
  onFetchDiff,
  gitSyncInfo,
  onViewChanges,
  onPush,
  onCreatePr,
  onPrChecks,
  onPrMerge,
  onStartRun,
  providerName,
  onPushed,
}: {
  thread: ThreadInfo;
  isWorking: boolean;
  remoteProject: boolean;
  changesOpen: boolean;
  changesNonce: number;
  syncRefreshNonce: number;
  onFetchDiff: () => Promise<DiffResult>;
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  onViewChanges?: () => void;
  onPush: () => Promise<{ remote: string; branch: string }>;
  onCreatePr?: (input: {
    title: string;
    body?: string;
    draft?: boolean;
    allowOversize?: boolean;
  }) => Promise<PrInfo>;
  onPrChecks?: () => Promise<PrChecksResult>;
  onPrMerge?: (opts?: { ciWorkflowApproved?: boolean }) => Promise<PrInfo>;
  onStartRun: (prompt: string) => void | Promise<void>;
  providerName: string;
  onPushed: () => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const [sync, setSync] = useState<GitSyncInfo | null>(null);
  const [checks, setChecks] = useState<PrChecksResult | null>(null);
  const [pending, setPending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  /** Size-cap refusal message while the split/override choice is showing. */
  const [oversizeMsg, setOversizeMsg] = useState<string | null>(null);
  const [blastRadius, setBlastRadius] = useState<BlastRadiusInfo | null>(
    null,
  );
  /** Confirm bar for CI-workflow merge sign-off (issue #510). */
  const [ciSignOff, setCiSignOff] = useState(false);
  const [github, setGithub] = useState<{
    ready: boolean;
    hint: string | null;
  } | null>(null);
  const threadRef = useRef(thread.id);
  threadRef.current = thread.id;
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadForge = useCallback(async (rescan = false) => {
    try {
      const existing = (window as unknown as { coder?: CoderApi }).coder;
      const discover = existing?.sourceControl?.discover;
      if (typeof discover !== "function") return;
      const next: SourceControlDiscovery = await discover(
        rescan ? { rescan: true } : undefined,
      );
      setGithub(forgeReadiness(next, "github"));
    } catch {
      // Probe failed: leave the button on the click-and-fail path.
    }
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimer.current != null) clearTimeout(flashTimer.current);
    };
  }, []);

  useEffect(() => {
    setDirty(false);
    setFileCount(0);
    setSync(null);
    setChecks(null);
    setPending(false);
    setFlash(null);
    setOversizeMsg(null);
    setBlastRadius(null);
    setCiSignOff(false);
  }, [thread.id]);

  const loadGit = useCallback(async () => {
    const id = thread.id;
    try {
      const diff = await onFetchDiff();
      if (threadRef.current !== id) return;
      setDirty(!isEmptyDiff(diff));
      setFileCount(diff.files.length);
      setBlastRadius(diff.blastRadius ?? null);
    } catch {
      if (threadRef.current !== id) return;
      setDirty(false);
      setFileCount(0);
      setBlastRadius(null);
    }
    if (!gitSyncInfo) {
      if (threadRef.current === id) setSync(null);
      return;
    }
    try {
      const next = await gitSyncInfo(id);
      if (threadRef.current === id) setSync(next);
    } catch {
      if (threadRef.current === id) setSync(null);
    }
  }, [thread.id, onFetchDiff, gitSyncInfo]);

  const loadChecks = useCallback(async () => {
    if (
      !onPrChecks ||
      thread.prNumber == null ||
      thread.prState === "MERGED" ||
      thread.prState === "CLOSED"
    ) {
      setChecks(null);
      return;
    }
    const id = thread.id;
    try {
      const next = await onPrChecks();
      if (threadRef.current === id) setChecks(next);
    } catch {
      if (threadRef.current === id) {
        setChecks({ ok: false, reason: "failed to load checks" });
      }
    }
  }, [thread.id, thread.prNumber, thread.prState, onPrChecks]);

  useEffect(() => {
    // Do not re-poll git on every updatedAt tick: a streaming turn used to
    // re-arm git.diff from the previous spawn's close callback (~65 git/s
    // at idle once anything bumped updatedAt). Status / Changes / sync
    // nonce still refetch. Skip while working — the button is disabled
    // and the run-end status change is the right refresh (#688).
    if (thread.status === "working" || thread.status === "quota-wait") return;
    void loadGit();
    void loadForge(false);
  }, [
    loadGit,
    loadForge,
    changesNonce,
    changesOpen,
    thread.status,
    syncRefreshNonce,
  ]);

  useEffect(() => {
    void loadChecks();
  }, [loadChecks, thread.status]);

  const decided = suggestNextGitAction({
    dirty,
    fileCount,
    sync,
    hasWorktree: Boolean(thread.worktreePath),
    remoteProject,
    prNumber: thread.prNumber,
    prUrl: thread.prUrl,
    prState: thread.prState,
    mergeable: thread.prMergeable,
    checks,
    github,
  });
  const action =
    decided.kind === "merge" && !onPrMerge
      ? { ...decided, actionable: false }
      : decided;

  useEffect(() => {
    if (action.kind !== "watch-checks") return;
    // gh checks poll: skip while the window is hidden — the badge can't be
    // seen, and each tick spawns a gh process per open watching thread.
    const id = window.setInterval(() => {
      if (!document.hidden) void loadChecks();
    }, CHECKS_POLL_MS);
    return () => window.clearInterval(id);
  }, [action.kind, loadChecks]);

  const handleClick = async () => {
    if (!action.actionable || pending || isWorking) return;
    if (action.kind === "commit") {
      onViewChanges?.();
      return;
    }
    if (action.kind === "push") {
      setPending(true);
      setFlash(null);
      if (flashTimer.current != null) {
        clearTimeout(flashTimer.current);
        flashTimer.current = null;
      }
      try {
        const result = await onPush();
        setFlash(`Pushed ${result.branch}`);
        onPushed();
        flashTimer.current = setTimeout(() => {
          setFlash(null);
          flashTimer.current = null;
        }, PUSH_FLASH_MS);
        await loadGit();
      } catch {
        // Parent surfaces rejections via the runError banner.
        void loadForge(true);
      } finally {
        setPending(false);
      }
      return;
    }
    if (action.kind === "create-pr") {
      if (onCreatePr) {
        setPending(true);
        try {
          await onCreatePr({ title: thread.title, body: "" });
          setOversizeMsg(null);
          await loadGit();
          await loadChecks();
        } catch (err) {
          // The size-cap refusal (issue #402) is not a failure: offer the
          // split-into-stack prompt or an explicit override inline. Other
          // rejections surface via the parent's runError banner.
          const msg = err instanceof Error ? err.message : String(err);
          if (isPrTooLargeMessage(msg)) setOversizeMsg(msg);
          else void loadForge(true);
        } finally {
          setPending(false);
        }
        return;
      }
      void onStartRun(createPrPrompt(providerName));
      return;
    }
    if (action.kind === "watch-checks" || action.kind === "checks-failed") {
      void loadChecks();
      return;
    }
    if (action.kind === "merge") {
      if (!onPrMerge) return;
      if (blastRadius) {
        setCiSignOff(true);
        return;
      }
      setPending(true);
      try {
        await onPrMerge();
        await loadGit();
        await loadChecks();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isCiWorkflowBlockMessage(msg)) {
          setCiSignOff(true);
        } else {
          void loadForge(true);
        }
      } finally {
        setPending(false);
      }
    }
  };

  const approveCiAndMerge = async () => {
    if (!onPrMerge || pending || isWorking) return;
    setPending(true);
    try {
      await onPrMerge({ ciWorkflowApproved: true });
      setCiSignOff(false);
      await loadGit();
      await loadChecks();
    } catch {
      void loadForge(true);
    } finally {
      setPending(false);
    }
  };

  if (action.kind === "idle") return null;

  /** Retry PR creation with the explicit size-cap override (issue #402). */
  const createOversizePr = async () => {
    if (!onCreatePr || pending || isWorking) return;
    setPending(true);
    try {
      await onCreatePr({ title: thread.title, body: "", allowOversize: true });
      setOversizeMsg(null);
      await loadGit();
      await loadChecks();
    } catch {
      // Parent surfaces rejections via the runError banner.
    } finally {
      setPending(false);
    }
  };

  const disabled = isWorking || pending || !action.actionable;
  const label = pending
    ? action.kind === "push"
      ? "Pushing…"
      : action.kind === "create-pr"
        ? "Creating PR…"
        : action.kind === "merge"
          ? action.label === "Update from main"
            ? "Updating…"
            : "Merging…"
          : action.label
    : (flash ?? action.label);
  const className = [
    styles.btn,
    action.primary ? styles.btnPrimary : "",
    styles.pushBtn,
  ]
    .filter(Boolean)
    .join(" ");
  const dataCreatePr = action.kind === "create-pr" ? "" : undefined;
  const href = action.href;
  const actionTitle = blastRadius
    ? `${action.title} · ${blastRadiusTitle(blastRadius)}`
    : action.title;

  if (
    href &&
    (action.kind === "watch-checks" || action.kind === "checks-failed")
  ) {
    return (
      <>
      {blastRadius ? (
        <span
          className={styles.blastBadge}
          data-blast-radius="ci-workflow"
          title={blastRadiusTitle(blastRadius)}
        >
          {blastRadiusLabel(blastRadius)}
        </span>
      ) : null}
      <a
        className={className}
        data-next-git-action={action.kind}
        data-forge-blocked={
          github != null && !github.ready && !action.actionable
            ? ""
            : undefined
        }
        href={href}
        target="_blank"
        rel="noreferrer"
        title={actionTitle}
        aria-disabled={disabled ? "true" : undefined}
        onClick={() => {
          void loadChecks();
        }}
      >
        {pending && <span className={styles.pushSpinner} aria-hidden />}
        {label}
      </a>
      </>
    );
  }

  return (
    <>
      {blastRadius ? (
        <span
          className={styles.blastBadge}
          data-blast-radius="ci-workflow"
          title={blastRadiusTitle(blastRadius)}
        >
          {blastRadiusLabel(blastRadius)}
        </span>
      ) : null}
      <button
        type="button"
        className={className}
        data-next-git-action={action.kind}
        data-create-pr={dataCreatePr}
        data-forge-blocked={
          github != null && !github.ready && !action.actionable
            ? ""
            : undefined
        }
        disabled={disabled}
        aria-disabled={disabled ? "true" : undefined}
        aria-busy={pending || undefined}
        title={actionTitle}
        onClick={() => void handleClick()}
      >
        {pending && <span className={styles.pushSpinner} aria-hidden />}
        {label}
      </button>
      {ciSignOff ? (
        <span
          className={styles.oversizeBar}
          data-ci-signoff=""
          role="alertdialog"
        >
          <span className={styles.oversizeText}>
            {blastRadius
              ? blastRadiusTitle(blastRadius)
              : "This PR changes CI workflow files. Privilege-escalation — a human must sign off."}
          </span>
          <button
            type="button"
            className={styles.oversizeBtn}
            data-ci-signoff-approve=""
            disabled={disabled}
            onClick={() => void approveCiAndMerge()}
          >
            Sign off & merge
          </button>
          <button
            type="button"
            className={styles.oversizeDismiss}
            data-ci-signoff-cancel=""
            aria-label="Cancel"
            onClick={() => setCiSignOff(false)}
          >
            ×
          </button>
        </span>
      ) : null}
      {oversizeMsg ? (
        <span
          className={styles.oversizeBar}
          data-pr-oversize=""
          role="alert"
        >
          <span className={styles.oversizeText}>{oversizeMsg}</span>
          <button
            type="button"
            className={styles.oversizeBtn}
            data-pr-split=""
            onClick={() => {
              setOversizeMsg(null);
              void onStartRun(splitPrPrompt(providerName));
            }}
          >
            Split into stacked PRs
          </button>
          <button
            type="button"
            className={styles.oversizeBtn}
            data-pr-create-anyway=""
            disabled={disabled}
            onClick={() => void createOversizePr()}
          >
            Create anyway
          </button>
          <button
            type="button"
            className={styles.oversizeDismiss}
            aria-label="Dismiss"
            onClick={() => setOversizeMsg(null)}
          >
            ×
          </button>
        </span>
      ) : null}
    </>
  );
}

/**
 * Answer text for a persisted question card (issue #647). The agent's turn is
 * already over, so this is an ordinary user message — and it repeats the
 * question, because on a session that could not resume it is the only record
 * of what was being answered.
 */
export function formatQuestionAnswer(answers: Record<string, string>): string {
  const lines = Object.entries(answers)
    .filter(([, picked]) => picked)
    .map(([question, picked]) => `${question}\n→ ${picked}`);
  return lines.length ? `Answering your question:\n\n${lines.join("\n\n")}` : "";
}

/**
 * Option picker for an agent question. Options answer with a click or the 1-9
 * keys; a lone single-select question submits immediately, everything else
 * collects picks and submits together. Free text via "Other".
 *
 * Two sources feed the same card (issue #647): claude's blocking
 * AskUserQuestion permission prompt, where answering resumes the live run, and
 * the persisted thread.pendingQuestion left behind by grok/kimi, where
 * answering is simply the next message. Hence callbacks rather than a
 * pendingPermission — the picker does not care which one it is driving.
 */
function QuestionPrompt({
  questions,
  onAnswer,
  onDismiss,
}: {
  questions: PendingQuestion[];
  onAnswer: (answers: Record<string, string>) => void | Promise<void>;
  onDismiss: () => void | Promise<void>;
}) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);

  const answerFor = useCallback(
    (i: number): string => {
      const parts = [...(picked[i] ?? [])];
      const extra = (other[i] ?? "").trim();
      if (extra) parts.push(extra);
      return parts.join(", ");
    },
    [picked, other],
  );
  const allAnswered = questions.every((_, i) => answerFor(i) !== "");
  // A lone single-select question answers straight from the click/keypress.
  const instant = questions.length === 1 && !questions[0].multiSelect;

  const submit = useCallback(
    (override?: { index: number; label: string }) => {
      if (sent) return;
      const answers: Record<string, string> = {};
      questions.forEach((q, i) => {
        answers[q.question] =
          override && override.index === i ? override.label : answerFor(i);
      });
      setSent(true);
      void onAnswer(answers);
    },
    [sent, questions, answerFor, onAnswer],
  );

  const choose = useCallback(
    (qi: number, label: string) => {
      if (instant) {
        submit({ index: qi, label });
        return;
      }
      setPicked((prev) => {
        const cur = prev[qi] ?? [];
        const next = questions[qi].multiSelect
          ? cur.includes(label)
            ? cur.filter((l) => l !== label)
            : [...cur, label]
          : [label];
        return { ...prev, [qi]: next };
      });
    },
    [instant, questions, submit],
  );

  // 1-9 pick an option of the first unanswered question; Enter submits.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "Enter") {
        if (allAnswered) {
          ev.preventDefault();
          submit();
        }
        return;
      }
      const n = Number(ev.key);
      if (!Number.isInteger(n) || n < 1) return;
      let qi = questions.findIndex((_, i) => answerFor(i) === "");
      if (qi < 0) qi = questions.length - 1;
      const opt = questions[qi]?.options[n - 1];
      if (!opt) return;
      ev.preventDefault();
      choose(qi, opt.label);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [questions, answerFor, allAnswered, choose, submit]);

  return (
    <div
      className={styles.permissionCard}
      role="alertdialog"
      aria-label="Agent question"
    >
      {questions.map((q, qi) => (
        <div key={qi} className={styles.questionBlock}>
          <div className={styles.permissionHead}>
            {q.header && (
              <span className={styles.questionChip}>{q.header}</span>
            )}
            {q.question}
          </div>
          <div className={styles.questionOptions}>
            {q.options.map((opt, oi) => {
              const isPicked = (picked[qi] ?? []).includes(opt.label);
              return (
                <button
                  key={oi}
                  type="button"
                  className={styles.questionOption}
                  data-picked={isPicked || undefined}
                  onClick={() => choose(qi, opt.label)}
                >
                  <span className={styles.questionKey}>{oi + 1}</span>
                  <span className={styles.questionText}>
                    <span className={styles.questionLabel}>{opt.label}</span>
                    {opt.description && (
                      <span className={styles.questionDesc}>
                        {opt.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            <input
              type="text"
              className={styles.questionOther}
              placeholder="Other…"
              value={other[qi] ?? ""}
              onChange={(ev) =>
                setOther((prev) => ({ ...prev, [qi]: ev.target.value }))
              }
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && answerFor(qi) !== "" && allAnswered) {
                  ev.preventDefault();
                  submit();
                }
              }}
            />
          </div>
        </div>
      ))}
      <div className={styles.permissionActions}>
        {(!instant || (other[0] ?? "").trim() !== "") && (
          <button
            type="button"
            className={styles.permissionAllow}
            disabled={!allAnswered || sent}
            onClick={() => submit()}
          >
            Answer
          </button>
        )}
        <button
          type="button"
          className={styles.permissionDeny}
          disabled={sent}
          onClick={() => {
            setSent(true);
            void onDismiss();
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * Plan approval (ExitPlanMode): the plan rendered as markdown in the prompt
 * panel, approve or send the agent back to planning.
 */
function PlanPrompt({
  pending,
  onRespond,
}: {
  pending: PendingPermissionInfo;
  onRespond: (
    requestId: string,
    decision: PermissionDecision,
  ) => void | Promise<void>;
}) {
  const [sent, setSent] = useState(false);
  const answer = (decision: PermissionDecision) => {
    if (sent) return;
    setSent(true);
    void onRespond(pending.requestId, decision);
  };
  return (
    <div
      className={styles.permissionCard}
      role="alertdialog"
      aria-label="Plan approval"
    >
      <div className={styles.permissionHead}>Agent proposed a plan</div>
      <div className={styles.planBody}>
        <Markdown text={pending.plan ?? ""} />
      </div>
      <div className={styles.permissionActions}>
        <button
          type="button"
          className={styles.permissionAllow}
          disabled={sent}
          onClick={() => answer("allow")}
        >
          Approve plan
        </button>
        <button
          type="button"
          className={styles.permissionDeny}
          disabled={sent}
          onClick={() => answer("deny")}
        >
          Keep planning
        </button>
      </div>
    </div>
  );
}

type PermissionRespond = (
  requestId: string,
  decision: PermissionDecision,
  answers?: Record<string, string>,
  updatedCommand?: string,
) => void | Promise<void>;

/**
 * Tool permission (#509): the proposed command is an editable field.
 * Approving sends the edited command, not the original. Non-command tools
 * (Edit/Write/…) keep the JSON preview. Same component the inbox (#291)
 * should reuse — the IPC already accepts updatedCommand.
 */
function PermissionPrompt({
  pending,
  onRespond,
}: {
  pending: PendingPermissionInfo;
  onRespond: PermissionRespond;
}) {
  const original = pending.command ?? null;
  const editable = original !== null;
  const [command, setCommand] = useState(original ?? "");
  const [sent, setSent] = useState(false);
  const edited =
    original !== null && command.trim() !== original.trim();
  const empty = original !== null && command.trim() === "";

  const answer = (decision: PermissionDecision) => {
    if (sent) return;
    if (decision !== "deny" && empty) return;
    setSent(true);
    void onRespond(
      pending.requestId,
      decision,
      undefined,
      editable ? command : undefined,
    );
  };

  return (
    <div
      className={styles.permissionCard}
      role="alertdialog"
      aria-label="Permission request"
      data-permission-card=""
      data-edited={edited || undefined}
    >
      <div className={styles.permissionHead}>
        Agent wants to use <strong>{pending.toolName}</strong>
        {edited ? (
          <span className={styles.permissionEdited} data-permission-edited="">
            edited
          </span>
        ) : null}
      </div>
      {pending.guardrail ? (
        <div className={styles.permissionGuardrail}>
          ⚠ {pending.guardrail.reason} ({pending.guardrail.rule})
        </div>
      ) : null}
      {editable ? (
        <>
          <textarea
            className={`${styles.permissionInput} ${styles.permissionCommand}`}
            data-permission-command=""
            aria-label="Proposed command"
            value={command}
            rows={Math.min(8, Math.max(2, command.split("\n").length))}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            onChange={(ev) => setCommand(ev.target.value)}
          />
          {edited ? (
            <div className={styles.permissionWas} data-permission-was="">
              <span>was: {original}</span>
              <button
                type="button"
                className={styles.permissionReset}
                data-permission-reset=""
                onClick={() => {
                  if (original !== null) setCommand(original);
                }}
              >
                Reset
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <pre className={styles.permissionInput}>{pending.input}</pre>
      )}
      <div className={styles.permissionActions}>
        <button
          type="button"
          className={styles.permissionAllow}
          disabled={sent || empty}
          onClick={() => answer("allow")}
        >
          Accept
        </button>
        <button
          type="button"
          className={styles.permissionAllow}
          disabled={sent || empty}
          onClick={() => answer("allowAlways")}
        >
          Accept all
        </button>
        <button
          type="button"
          className={styles.permissionDeny}
          disabled={sent}
          onClick={() => answer("deny")}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/**
 * The thread's plan overview (issue #75): the agent's live steps, mirrored
 * from its todo list, plus the plan it had approved. Unlike PlanPrompt this
 * outlives the approval — it is what the thread intends to do, at a glance.
 */
function PlanCard({ thread }: { thread: ThreadInfo }) {
  const steps = thread.planSteps ?? [];
  // No steps yet means the prose IS the overview, so it starts expanded.
  const [open, setOpen] = useState(steps.length === 0);
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <div className={styles.planCard} data-plan-card="" data-page-block="">
      <div className={styles.planCardHead}>
        <span className={styles.planCardTitle}>Plan</span>
        {steps.length > 0 && (
          <span className={styles.planProgress}>
            {done}/{steps.length} done
          </span>
        )}
        {thread.plan && (
          <button
            type="button"
            className={styles.planToggle}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide full plan" : "Show full plan"}
          </button>
        )}
      </div>
      {steps.length > 0 && (
        <ol className={styles.planStepList}>
          {steps.map((s, i) => (
            <li
              key={`${i}-${s.step}`}
              className={styles.planStep}
              data-plan-step={s.status}
            >
              {s.step}
            </li>
          ))}
        </ol>
      )}
      {thread.plan && open && (
        <div className={styles.planBody}>
          <Markdown text={thread.plan} />
        </div>
      )}
    </div>
  );
}

const SPEC_STAGES: SpecStage[] = [...SPEC_ARTIFACTS, "build"];

function specStepStatus(
  stage: SpecStage,
  current: SpecStage,
): "done" | "doing" | "todo" {
  const i = SPEC_STAGES.indexOf(stage);
  const j = SPEC_STAGES.indexOf(current);
  if (i < j) return "done";
  if (i === j) return "doing";
  return "todo";
}

/**
 * Spec mode card (issue #269): the gated requirements → design → tasks →
 * build strip, the current artifact, and the approve / request-changes gate.
 */
function SpecCard({
  thread,
  onReviewSpec,
  onDispatchSpec,
  onConvergeSpec,
  onStopSpec,
  onSpecArtifact,
}: {
  thread: ThreadInfo;
  onReviewSpec?: (
    threadId: string,
    decision: "approve" | "revise",
    feedback?: string,
  ) => void | Promise<void>;
  onDispatchSpec?: (threadId: string) => void | Promise<void>;
  onConvergeSpec?: (threadId: string) => void | Promise<void>;
  onStopSpec?: (threadId: string) => void | Promise<void>;
  onSpecArtifact?: (
    threadId: string,
    stage: SpecArtifact,
  ) => Promise<{ path: string; text: string | null }>;
}) {
  const spec = thread.spec;
  const [artifact, setArtifact] = useState<{
    path: string;
    text: string | null;
  } | null>(null);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");

  const stage = spec?.stage;
  const awaitingApproval = spec?.awaitingApproval ?? false;

  useEffect(() => {
    setRevising(false);
    setFeedback("");
    if (!onSpecArtifact || stage == null || stage === "build") {
      setArtifact(null);
      return;
    }
    let live = true;
    setArtifact(null);
    void onSpecArtifact(thread.id, stage)
      .then((result) => {
        if (live) setArtifact(result);
      })
      .catch(() => {
        if (live) setArtifact(null);
      });
    return () => {
      live = false;
    };
  }, [thread.id, stage, awaitingApproval, onSpecArtifact]);

  if (!spec) return null;

  const artifactBody =
    artifact &&
    (artifact.text != null ? (
      <div className={styles.planBody}>
        <Markdown text={artifact.text} />
      </div>
    ) : (
      <p className={styles.specStatus}>
        {artifact.path} not written yet
      </p>
    ));

  return (
    <div className={styles.specCard} data-spec-card="" data-page-block="">
      <div className={styles.specCardHead}>
        <span className={styles.specCardTitle}>Spec</span>
        <span className={styles.specStatus}>{spec.stage}</span>
        {onStopSpec && (
          <button
            type="button"
            className={styles.btn}
            data-spec-exit-btn=""
            onClick={() => void onStopSpec(thread.id)}
          >
            Exit spec mode
          </button>
        )}
      </div>
      <ol className={styles.specStageList}>
        {SPEC_STAGES.map((step) => (
          <li
            key={step}
            className={styles.specStage}
            data-spec-stage={step}
            data-plan-step={specStepStatus(step, spec.stage)}
          >
            {step}
          </li>
        ))}
      </ol>
      {spec.stage === "build" ? (
        <>
          <p className={styles.specStatus}>The spec is approved.</p>
          {(onDispatchSpec || onConvergeSpec) && (
            <div className={styles.permissionActions}>
              {onDispatchSpec && (
                <button
                  type="button"
                  className={styles.permissionAllow}
                  data-spec-dispatch-btn=""
                  onClick={() => void onDispatchSpec(thread.id)}
                >
                  Dispatch
                </button>
              )}
              {onConvergeSpec && (
                <button
                  type="button"
                  className={styles.btn}
                  data-spec-converge-btn=""
                  onClick={() => void onConvergeSpec(thread.id)}
                >
                  Converge
                </button>
              )}
            </div>
          )}
        </>
      ) : spec.awaitingApproval ? (
        <>
          {artifactBody}
          {onReviewSpec && (
            <>
              {revising && (
                <textarea
                  className={styles.notesInput}
                  data-spec-feedback=""
                  aria-label="Revision feedback"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="What should change?"
                />
              )}
              <div className={styles.permissionActions}>
                <button
                  type="button"
                  className={styles.permissionAllow}
                  onClick={() => void onReviewSpec(thread.id, "approve")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className={styles.permissionDeny}
                  onClick={() => {
                    if (!revising) {
                      setRevising(true);
                      return;
                    }
                    const text = feedback.trim();
                    void onReviewSpec(
                      thread.id,
                      "revise",
                      text === "" ? undefined : text,
                    );
                  }}
                >
                  Request changes
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {artifactBody}
          <p className={styles.specStatus}>
            The agent is working on this stage.
          </p>
        </>
      )}
    </div>
  );
}

const TEACH_STAGES: TeachAutonomy[] = ["hint", "review", "pair"];

function teachStepStatus(
  step: TeachAutonomy,
  current: TeachAutonomy,
): "todo" | "doing" | "done" {
  const i = TEACH_STAGES.indexOf(step);
  const j = TEACH_STAGES.indexOf(current);
  if (i < j) return "done";
  if (i === j) return "doing";
  return "todo";
}

/**
 * `/btw` side-question card (issue #471). Lives on the thread, not a new
 * thread and not the live turn. Dismiss drops it; promote queues a follow-up.
 */
function BtwSideCard({
  threadId,
  card,
  onDismiss,
  onPromote,
}: {
  threadId: string;
  card: BtwCardInfo;
  onDismiss?: (threadId: string, id: string) => void | Promise<void>;
  onPromote?: (threadId: string, id: string) => void | Promise<void>;
}) {
  const statusLabel =
    card.status === "running"
      ? "asking"
      : card.status === "error"
        ? "failed"
        : "answered";
  return (
    <div
      className={styles.specCard}
      data-btw-card=""
      data-page-block=""
      data-btw-status={card.status}
    >
      <div className={styles.specCardHead}>
        <span className={styles.specCardTitle}>Side question</span>
        <span className={styles.specStatus}>{statusLabel}</span>
      </div>
      <p className={styles.btwQuestion}>{card.question}</p>
      {card.status === "running" ? (
        <p className={styles.specStatus}>Answering from the repo map…</p>
      ) : null}
      {card.answer ? (
        <div className={styles.btwAnswer}>
          <Markdown text={card.answer} />
        </div>
      ) : null}
      {card.error && !card.answer ? (
        <p className={styles.specStatus}>{card.error}</p>
      ) : null}
      <div className={styles.permissionActions}>
        {onPromote && (
          <button
            type="button"
            className={styles.permissionAllow}
            data-btw-promote-btn=""
            onClick={() => void onPromote(threadId, card.id)}
          >
            Promote to follow-up
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            className={styles.permissionDeny}
            data-btw-dismiss-btn=""
            onClick={() => void onDismiss(threadId, card.id)}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Teach mode card (issue #373): autonomy ladder, review-my-code, turn off.
 */
function AskCard({
  thread,
  onStopAsk,
  promoteWorktree,
}: {
  thread: ThreadInfo;
  onStopAsk?: (
    threadId: string,
    opts?: { worktree?: boolean },
  ) => void | Promise<void>;
  promoteWorktree: boolean;
}) {
  if (!thread.ask) return null;
  return (
    <div className={styles.specCard} data-ask-card="" data-page-block="">
      <div className={styles.specCardHead}>
        <span className={styles.specCardTitle}>Ask</span>
        <span className={styles.specStatus}>read-only</span>
      </div>
      <p className={styles.specStatus}>
        Answers from the repo map and memory. No tools, no worktree, no
        agent credits. Start work when you want a real thread.
      </p>
      <div className={styles.permissionActions}>
        {onStopAsk && (
          <button
            type="button"
            className={styles.permissionAllow}
            data-ask-start-work-btn=""
            onClick={() =>
              void onStopAsk(
                thread.id,
                promoteWorktree ? { worktree: true } : undefined,
              )
            }
          >
            Start work
          </button>
        )}
        {onStopAsk && (
          <button
            type="button"
            className={styles.permissionDeny}
            data-ask-stop-btn=""
            onClick={() => void onStopAsk(thread.id)}
          >
            Turn off
          </button>
        )}
      </div>
    </div>
  );
}

function TeachCard({
  thread,
  onStopTeach,
  onRequestTeachReview,
}: {
  thread: ThreadInfo;
  onStopTeach?: (threadId: string) => void | Promise<void>;
  onRequestTeachReview?: (threadId: string) => void | Promise<void>;
}) {
  const teach = thread.teach;
  if (!teach) return null;
  const n = teach.reviewsPassed;
  const reviewLabel = n === 1 ? "1 review passed" : `${n} reviews passed`;
  return (
    <div className={styles.specCard} data-teach-card="" data-page-block="">
      <div className={styles.specCardHead}>
        <span className={styles.specCardTitle}>Teach</span>
        <span className={styles.specStatus}>{reviewLabel}</span>
      </div>
      <ol className={styles.specStageList}>
        {TEACH_STAGES.map((step) => (
          <li
            key={step}
            className={styles.specStage}
            data-teach-autonomy={step}
            data-plan-step={teachStepStatus(step, teach.autonomy)}
          >
            {TEACH_AUTONOMY_LABELS[step]}
          </li>
        ))}
      </ol>
      <p className={styles.specStatus}>
        Hints, not solutions. The agent leaves TODO(human) markers for you
        to fill, then reviews your code.
      </p>
      <div className={styles.permissionActions}>
        {onRequestTeachReview && (
          <button
            type="button"
            className={styles.permissionAllow}
            data-teach-review-btn=""
            onClick={() => void onRequestTeachReview(thread.id)}
          >
            Review my code
          </button>
        )}
        {onStopTeach && (
          <button
            type="button"
            className={styles.permissionDeny}
            data-teach-stop-btn=""
            onClick={() => void onStopTeach(thread.id)}
          >
            Turn off
          </button>
        )}
      </div>
    </div>
  );
}

const FELT_BUCKET_LABELS = ["15 min", "30 min", "1 h", "2 h", "4 h+"];

/**
 * Felt-estimate card (issue #401): one tap, asked once when a run completes.
 * The estimate feeds the felt-vs-actual section of the fleet view; Skip
 * records a decline so the card never nags twice.
 */
function FeltEstimateCard({
  thread,
  onSetFeltEstimate,
}: {
  thread: ThreadInfo;
  onSetFeltEstimate?: (
    threadId: string,
    savedMs: number | null,
  ) => void | Promise<void>;
}) {
  if (!onSetFeltEstimate) return null;
  if (thread.status !== "done" || thread.feltEstimate != null) return null;
  return (
    <div className={styles.specCard} data-felt-card="" data-page-block="">
      <div className={styles.specCardHead}>
        <span className={styles.specCardTitle}>How much time did this save you?</span>
      </div>
      <p className={styles.specStatus}>
        One tap. We compare your gut with the actual clock in the Fleet view.
      </p>
      <div className={styles.permissionActions}>
        {FELT_ESTIMATE_BUCKETS_MS.map((ms, i) => (
          <button
            key={ms}
            type="button"
            className={styles.permissionAllow}
            data-felt-estimate-btn={ms}
            onClick={() => void onSetFeltEstimate(thread.id, ms)}
          >
            {FELT_BUCKET_LABELS[i]}
          </button>
        ))}
        <button
          type="button"
          className={styles.permissionDeny}
          data-felt-skip-btn=""
          onClick={() => void onSetFeltEstimate(thread.id, null)}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

const DiffLine = memo(function DiffLine({
  line,
  kind: kindOverride,
  oldLine = null,
  newLine = null,
  commentable = false,
  commenting = false,
  onCommentClick,
}: {
  line: string;
  kind?: DiffLineKind;
  oldLine?: number | null;
  newLine?: number | null;
  commentable?: boolean;
  commenting?: boolean;
  onCommentClick?: () => void;
}) {
  const kind = kindOverride ?? diffLineKind(line);
  const ref = commentLineRef({ kind, oldLine, newLine });
  return (
    <div
      className={styles.diffLine}
      data-kind={kind}
      data-commenting={commenting ? "" : undefined}
    >
      {commentable && onCommentClick ? (
        <button
          type="button"
          className={styles.diffLineGutter}
          data-diff-comment-gutter=""
          aria-label={commentGutterLabel({ kind, oldLine, newLine })}
          title={commentGutterLabel({ kind, oldLine, newLine })}
          aria-expanded={commenting}
          onClick={onCommentClick}
        >
          {ref ? ref.n : "+"}
        </button>
      ) : (
        <span className={styles.diffLineGutter} data-static="" aria-hidden>
          {ref ? ref.n : ""}
        </span>
      )}
      <span className={styles.diffLineText}>{line || " "}</span>
    </div>
  );
});

function DiffCommentBox({
  draft,
  busy,
  error,
  submitLabel,
  onChange,
  onSend,
  onCancel,
}: {
  draft: string;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  // Escape with a non-empty draft arms a discard confirm first (same two-step
  // pattern as the revert "Sure?" button); a second Escape discards. Typing
  // disarms. Empty drafts still cancel immediately.
  const [discardArmed, setDiscardArmed] = useState(false);
  return (
    <div className={styles.diffComment} data-diff-comment-box="">
      <textarea
        className={styles.diffCommentInput}
        aria-label="Diff comment"
        placeholder="Tell the agent what to change"
        rows={3}
        autoFocus
        value={draft}
        disabled={busy}
        onChange={(e) => {
          setDiscardArmed(false);
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (draft.trim() !== "" && !discardArmed) {
              setDiscardArmed(true);
              return;
            }
            onCancel();
            return;
          }
          if ((e.metaKey || e.ctrlKey || e.shiftKey) && e.key === "Enter") {
            e.preventDefault();
            onSend();
          }
        }}
      />
      {error ? (
        <div className={styles.inlineError} role="alert">
          {error}
        </div>
      ) : null}
      {discardArmed ? (
        <div
          className={styles.diffCommentHint}
          role="status"
          data-diff-comment-discard-hint=""
        >
          Press Escape again to discard the comment
        </div>
      ) : null}
      <div className={styles.diffCommentActions}>
        <button
          type="button"
          className={styles.btn}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={busy || draft.trim() === ""}
          onClick={onSend}
        >
          {busy ? "Sending…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

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

function FileRow({
  file,
  selected,
  staged,
  confirmRevert,
  reverting,
  onSelect,
  onToggleStage,
  onRevert,
}: {
  file: FileChange;
  selected: boolean;
  staged: boolean;
  confirmRevert: string | null;
  reverting: string | null;
  onSelect: (path: string) => void;
  onToggleStage: (path: string, next: boolean) => void;
  onRevert: (f: FileChange) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={styles.fileStage}
        data-stage-file={file.path}
        role="checkbox"
        aria-checked={staged}
        aria-label={`Stage ${file.path}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleStage(file.path, !staged);
        }}
      >
        {staged ? "✓" : ""}
      </button>
      <button
        type="button"
        className={styles.fileRow}
        data-file-row=""
        data-selected={selected ? "true" : undefined}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(file.path)}
      >
        <span className={styles.fileStatus}>{file.status}</span>
        <span className={styles.filePath}>{file.path}</span>
        {isCiWorkflowPath(file.path) ? (
          <span
            className={styles.fileBlast}
            data-blast-radius-file=""
            title="CI workflow — privilege-escalation, human sign-off required"
          >
            CI
          </span>
        ) : null}
        <span className={styles.fileStats}>
          <span className={styles.adds}>+{file.additions}</span>
          <span className={styles.dels}>−{file.deletions}</span>
        </span>
      </button>
      <button
        type="button"
        className={styles.fileRevert}
        title={
          file.status === "??" || file.status === "A"
            ? confirmRevert === file.path
              ? "Click again to delete this file"
              : "Discard (deletes the file)"
            : "Discard changes"
        }
        aria-label={`Discard changes to ${file.path}`}
        disabled={reverting != null}
        onClick={() => onRevert(file)}
      >
        {reverting === file.path
          ? "…"
          : confirmRevert === file.path
            ? "Sure?"
            : "↩"}
      </button>
    </li>
  );
}

function ChangesPanel({
  open,
  embedded = false,
  threadId,
  threadTitle,
  threadBranch,
  threadBaseBranch,
  planText,
  openNonce,
  isWorking = false,
  onFetchDiff,
  onFetchReviewContext,
  onSetReviewAccepted,
  onCommit,
  onStagedPathsChange,
  onRevert,
  onSuggest,
  onComment,
}: {
  open: boolean;
  /** Hide the "Git" title when the pane chrome already names it. */
  embedded?: boolean;
  threadId: string | null;
  threadTitle: string;
  threadBranch: string | null;
  /** Recorded merge/PR base (#187). Null/absent = repo default. */
  threadBaseBranch?: string | null;
  planText: string;
  openNonce: number;
  isWorking?: boolean;
  onFetchDiff: () => Promise<DiffResult>;
  onFetchReviewContext?: () => Promise<{
    annotation: unknown;
    symbols: ReviewSymbol[];
    acceptedHunks: string[];
  }>;
  onSetReviewAccepted?: (hashes: string[]) => Promise<void>;
  onCommit: (message: string, paths?: string[]) => Promise<{ subject: string }>;
  onStagedPathsChange?: (paths: string[] | null) => void;
  onRevert: (path: string, status: string) => Promise<{ path: string }>;
  onSuggest: () => Promise<{ message: string }>;
  /** Send a line comment as a follow-up prompt (issue #162). */
  onComment?: (prompt: string) => void | Promise<void>;
}) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<ReviewSymbol[]>([]);
  const [annotation, setAnnotation] = useState<
    ReturnType<typeof parseReviewAnnotation>
  >(null);
  const [acceptedHunks, setAcceptedHunks] = useState<string[]>([]);
  const [testsFirst, setTestsFirst] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  /** Which footer action is running; null = idle. */
  const [busy, setBusy] = useState<"commit" | "generate" | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);
  /** Untracked-path revert arms a confirm first (it deletes the file). */
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null);
  const [commentTarget, setCommentTarget] = useState<{
    key: string;
    anchor: DiffCommentAnchor;
  } | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [stagedPaths, setStagedPaths] = useState<Set<string>>(() => new Set());
  const knownFilesRef = useRef<Set<string>>(new Set());
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const load = async () => {
    const forThread = threadId;
    setLoading(true);
    setError(null);
    setDiff(null);
    try {
      const [result, context] = await Promise.all([
        onFetchDiff(),
        onFetchReviewContext
          ? onFetchReviewContext().catch(() => null)
          : Promise.resolve(null),
      ]);
      if (threadIdRef.current !== forThread) return;
      setDiff(result);
      if (context) {
        setSymbols(Array.isArray(context.symbols) ? context.symbols : []);
        setAnnotation(parseReviewAnnotation(context.annotation));
        setAcceptedHunks(
          Array.isArray(context.acceptedHunks) ? context.acceptedHunks : [],
        );
      }
    } catch (err) {
      if (threadIdRef.current !== forThread) return;
      setError(
        err instanceof Error && err.message ? err.message : "Failed to load diff",
      );
    } finally {
      if (threadIdRef.current === forThread) setLoading(false);
    }
  };

  // Never show one thread's diff under another thread.
  useEffect(() => {
    setDiff(null);
    setError(null);
    setMessage("");
    setConfirmRevert(null);
    setSymbols([]);
    setAnnotation(null);
    setAcceptedHunks([]);
    setSelectedPath(null);
    setCommentTarget(null);
    setCommentDraft("");
    setCommentBusy(false);
    setCommentError(null);
    setStagedPaths(new Set());
    knownFilesRef.current = new Set();
    onStagedPathsChange?.(null);
    // onStagedPathsChange is a stable setter from useCoder; threadId is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    if (!diff) return;
    setStagedPaths((prev) => {
      const next = new Set<string>();
      const known = knownFilesRef.current;
      const first = known.size === 0;
      for (const f of diff.files) {
        if (first || !known.has(f.path) || prev.has(f.path)) next.add(f.path);
      }
      knownFilesRef.current = new Set(diff.files.map((f) => f.path));
      return next;
    });
  }, [diff]);

  useEffect(() => {
    if (!diff || isEmptyDiff(diff)) return;
    onStagedPathsChange?.([...stagedPaths]);
  }, [diff, stagedPaths, onStagedPathsChange]);

  useEffect(() => {
    if (!diff || diff.files.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (selectedPath && diff.files.some((f) => f.path === selectedPath)) return;
    setSelectedPath(diff.files[0]!.path);
  }, [diff, selectedPath]);

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load when panel opens / thread / openNonce
  }, [open, threadId, openNonce]);

  const itinerary: ReviewItinerary | null = useMemo(() => {
    if (!diff || isEmptyDiff(diff)) return null;
    return buildReviewItinerary({
      files: diff.files,
      patch: diff.patch,
      planText,
      threadTitle,
      symbols,
      annotation,
      acceptedHunks,
      testsFirst,
    });
  }, [diff, planText, threadTitle, symbols, annotation, acceptedHunks, testsFirst]);

  if (!open) return null;

  const empty = !loading && !error && diff != null && isEmptyDiff(diff);

  const failMessage = (err: unknown, fallback: string) =>
    err instanceof Error && err.message ? err.message : fallback;

  const revert = async (f: FileChange) => {
    // Untracked and staged-new reverts delete the file; arm a confirm first.
    const destructive = f.status === "??" || f.status === "A";
    if (destructive && confirmRevert !== f.path) {
      setConfirmRevert(f.path);
      return;
    }
    setConfirmRevert(null);
    setReverting(f.path);
    setError(null);
    try {
      await onRevert(f.path, f.status);
      await load();
    } catch (err) {
      setError(failMessage(err, "Failed to discard changes"));
    } finally {
      setReverting(null);
    }
  };

  const toggleHunk = (id: string, next: boolean) => {
    const hashes = next
      ? acceptedHunks.includes(id)
        ? acceptedHunks
        : [...acceptedHunks, id]
      : acceptedHunks.filter((h) => h !== id);
    setAcceptedHunks(hashes);
    void onSetReviewAccepted?.(hashes);
  };

  const suggest = async () => {
    if (busy) return;
    setBusy("generate");
    setError(null);
    try {
      const result = await onSuggest();
      setMessage(result.message);
    } catch (err) {
      setError(failMessage(err, "Failed to generate a message"));
    } finally {
      setBusy(null);
    }
  };

  const toggleStage = (path: string, next: boolean) => {
    setStagedPaths((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(path);
      else copy.delete(path);
      return copy;
    });
  };

  const doCommit = async () => {
    const msg = message.trim();
    if (!msg || busy || !diff) return;
    const paths = diff.files.map((f) => f.path).filter((p) => stagedPaths.has(p));
    if (paths.length === 0) return;
    setBusy("commit");
    setError(null);
    try {
      await onCommit(msg, paths);
      setMessage("");
      await load();
    } catch (err) {
      setError(failMessage(err, "Failed to commit"));
    } finally {
      setBusy(null);
    }
  };

  const patches = itinerary ? orderedPatches(itinerary) : [];
  const visiblePatches = selectedPath
    ? patches.filter((p) => p.path === selectedPath)
    : patches;

  const toggleComment = (key: string, anchor: DiffCommentAnchor) => {
    if (commentBusy) return;
    if (commentTarget?.key === key) {
      setCommentTarget(null);
      setCommentDraft("");
      setCommentError(null);
      return;
    }
    setCommentTarget({ key, anchor });
    setCommentDraft("");
    setCommentError(null);
  };

  const sendComment = async () => {
    if (!commentTarget || !onComment || commentBusy) return;
    const prompt = formatDiffCommentPrompt(commentTarget.anchor, commentDraft);
    if (!prompt) return;
    setCommentBusy(true);
    setCommentError(null);
    try {
      await onComment(prompt);
      setCommentTarget(null);
      setCommentDraft("");
    } catch (err) {
      setCommentError(
        err instanceof Error && err.message ? err.message : "Failed to send comment",
      );
    } finally {
      setCommentBusy(false);
    }
  };

  const commentBox =
    commentTarget && onComment ? (
      <DiffCommentBox
        draft={commentDraft}
        busy={commentBusy}
        error={commentError}
        submitLabel={isWorking ? "Queue" : "Send"}
        onChange={setCommentDraft}
        onSend={() => void sendComment()}
        onCancel={() => {
          if (commentBusy) return;
          setCommentTarget(null);
          setCommentDraft("");
          setCommentError(null);
        }}
      />
    ) : null;

  return (
    <section
      className={styles.changesPane}
      data-git-pane=""
      aria-label="Git"
    >
      <header className={styles.changesHead}>
        <div className={styles.changesTitleGroup}>
          {embedded ? null : <span className={styles.changesTitle}>Git</span>}
          {threadBranch ? (
            <span className={styles.changesBranch} title={threadBranch}>
              {threadBranch}
            </span>
          ) : null}
          {threadBranch ? (
            <span
              className={styles.changesBase}
              data-stacked-base=""
              title={
                threadBaseBranch
                  ? `Merge and PR land on ${threadBaseBranch}`
                  : "Merge and PR land on the repo default"
              }
            >
              → {threadBaseBranch || "repo default"}
            </span>
          ) : null}
        </div>
        <div className={styles.changesActions}>
          <button
            type="button"
            className={styles.btn}
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && (
        <div className={styles.inlineError} role="alert">
          {error}
        </div>
      )}

      {loading && !diff && (
        <p className={styles.changesEmpty}>Loading diff…</p>
      )}

      {empty && (
        <>
          {diff?.blastRadius ? (
            <div
              className={styles.committedBlast}
              role="alert"
              data-blast-radius="ci-workflow"
            >
              <strong>Blast radius — CI workflow</strong>
              <span>{blastRadiusTitle(diff.blastRadius)}</span>
            </div>
          ) : null}
          <p className={styles.changesEmpty}>Working tree is clean</p>
        </>
      )}

      {diff && !empty && itinerary && (
        <>
          <div className={styles.changesSplit}>
            <div className={styles.changesFiles}>
              <div className={styles.stageBar}>
                <button
                  type="button"
                  className={styles.fileStage}
                  data-stage-all=""
                  role="checkbox"
                  aria-label="Stage all files"
                  aria-checked={
                    diff.files.length > 0 &&
                    stagedPaths.size === diff.files.length
                      ? true
                      : stagedPaths.size === 0
                        ? false
                        : "mixed"
                  }
                  onClick={() => {
                    if (stagedPaths.size === diff.files.length) {
                      setStagedPaths(new Set());
                    } else {
                      setStagedPaths(new Set(diff.files.map((f) => f.path)));
                    }
                  }}
                >
                  {stagedPaths.size === diff.files.length ? "✓" : ""}
                </button>
                {stagedPaths.size}/{diff.files.length} staged
              </div>
              <ReviewItineraryView
                itinerary={itinerary}
                testsFirst={testsFirst}
                onToggleTestsFirst={() => setTestsFirst((v) => !v)}
              />
              {itinerary.chunks.map((chunk) => (
                <div key={chunk.area}>
                  <ChunkRationale itinerary={itinerary} area={chunk.area} />
                  <ul className={styles.fileList}>
                    {chunk.files.map((f) => (
                      <FileRow
                        key={f.path}
                        file={f}
                        selected={selectedPath === f.path}
                        staged={stagedPaths.has(f.path)}
                        confirmRevert={confirmRevert}
                        reverting={reverting}
                        onSelect={setSelectedPath}
                        onToggleStage={toggleStage}
                        onRevert={(file) => void revert(file)}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className={styles.changesDiff}>
              {visiblePatches.length === 0 ? (
                <p className={styles.changesEmpty}>No textual diff for this file</p>
              ) : (
                <div className={styles.patchScroll}>
                  {visiblePatches.map((p) => (
                    <Fragment key={p.path}>
                      {p.hunks.length === 0 &&
                        p.text.split("\n").map((line, i) => {
                          const kind = diffLineKind(line);
                          const key = `${p.path}:${i}`;
                          const commentable =
                            Boolean(onComment) &&
                            (kind === "add" || kind === "del") &&
                            !line.startsWith("\\");
                          return (
                            <Fragment key={key}>
                              <DiffLine
                                line={line}
                                kind={kind}
                                commentable={commentable}
                                commenting={commentTarget?.key === key}
                                onCommentClick={
                                  commentable
                                    ? () =>
                                        toggleComment(key, {
                                          path: p.path,
                                          kind,
                                          text: line,
                                          oldLine: null,
                                          newLine: null,
                                        })
                                    : undefined
                                }
                              />
                              {commentTarget?.key === key ? commentBox : null}
                            </Fragment>
                          );
                        })}
                      {p.hunks.map((hunk) => (
                        <div
                          key={hunk.id}
                          className={styles.hunkBlock}
                          data-review-hunk={hunk.id}
                          data-review-hunk-accepted={
                            hunk.accepted ? "" : undefined
                          }
                        >
                          <div className={styles.hunkBar}>
                            <span className={styles.hunkPath}>{p.path}</span>
                            <button
                              type="button"
                              className={styles.hunkSeen}
                              aria-pressed={hunk.accepted}
                              title={
                                hunk.accepted
                                  ? "Mark this hunk as new again"
                                  : "Mark this hunk reviewed"
                              }
                              onClick={() =>
                                toggleHunk(hunk.id, !hunk.accepted)
                              }
                            >
                              {hunk.accepted ? "Reviewed" : "Mark reviewed"}
                            </button>
                          </div>
                          <DiffLine line={hunk.header} />
                          {annotateHunkLines(hunk.header, hunk.body).map(
                            (row, i) => {
                              const key = `${hunk.id}:${i}`;
                              const commentable =
                                Boolean(onComment) && row.commentable;
                              return (
                                <Fragment key={key}>
                                  <DiffLine
                                    line={row.text}
                                    kind={row.kind}
                                    oldLine={row.oldLine}
                                    newLine={row.newLine}
                                    commentable={commentable}
                                    commenting={commentTarget?.key === key}
                                    onCommentClick={
                                      commentable
                                        ? () =>
                                            toggleComment(key, {
                                              path: p.path,
                                              kind: row.kind,
                                              text: row.text,
                                              oldLine: row.oldLine,
                                              newLine: row.newLine,
                                            })
                                        : undefined
                                    }
                                  />
                                  {commentTarget?.key === key
                                    ? commentBox
                                    : null}
                                </Fragment>
                              );
                            },
                          )}
                        </div>
                      ))}
                    </Fragment>
                  ))}
                </div>
              )}
              {diff.truncated && (
                <p className={styles.truncatedNote}>Diff truncated</p>
              )}
            </div>
          </div>
          <div className={styles.commitBox}>
            <textarea
              className={styles.commitInput}
              rows={2}
              placeholder="Commit message"
              aria-label="Commit message"
              value={message}
              disabled={busy != null}
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className={styles.commitActions}>
              <button
                type="button"
                className={styles.btn}
                disabled={busy != null}
                onClick={() => void suggest()}
              >
                {busy === "generate" ? "Generating…" : "Generate"}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                data-commit-changes=""
                disabled={
                  message.trim() === "" ||
                  busy != null ||
                  stagedPaths.size === 0
                }
                onClick={() => void doCommit()}
              >
                {busy === "commit"
                  ? "Committing…"
                  : stagedPaths.size === 0 ||
                      stagedPaths.size === (diff?.files.length ?? 0)
                    ? "Commit"
                    : stagedPaths.size === 1
                      ? "Commit 1 file"
                      : `Commit ${stagedPaths.size} files`}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function fieldValue(
  step: { type: string; name: string; input: string; output: string; decision: string } | null,
  field: DivergenceField,
): string {
  if (!step) return "—";
  if (field === "type") return step.type;
  if (field === "name") return step.name;
  if (field === "input") return truncateStepValue(step.input);
  if (field === "output") return truncateStepValue(step.output);
  return step.decision;
}

/**
 * First-divergence report for two runs of the same task (issue #393).
 * Hidden until there is a sibling fork or a second completed run.
 */
function DivergenceCard({
  detail,
  peers,
  providers,
  onPeekThread,
}: {
  detail: ThreadDetail;
  peers: ComparePeer[];
  providers: ProviderInfo[];
  onPeekThread?: (id: string) => Promise<ThreadDetail>;
}) {
  const runs = useMemo(
    () => sameThreadRuns(detail.messages, detail.thread.status),
    [detail.messages, detail.thread.status],
  );
  const earlierRuns = runs.length >= 2 ? runs.slice(0, -1) : [];
  const latestRun = runs.length >= 2 ? runs[runs.length - 1]! : null;
  const targets = useMemo(() => {
    const list: { key: string; label: string }[] = [];
    if (onPeekThread) {
      for (const p of peers) list.push({ key: `peer:${p.id}`, label: p.label });
    }
    for (const r of earlierRuns) {
      list.push({ key: `run:${r.runId}`, label: r.label });
    }
    return list;
  }, [onPeekThread, peers, earlierRuns]);

  const [selected, setSelected] = useState("");
  const [peeked, setPeeked] = useState<ThreadDetail | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [peeking, setPeeking] = useState(false);
  const [open, setOpen] = useState(true);
  const enabled = useDivergenceCardEnabled();

  useEffect(() => {
    if (targets.length === 0) {
      setSelected("");
      return;
    }
    if (!targets.some((t) => t.key === selected)) {
      setSelected(targets[0]!.key);
    }
  }, [targets, selected]);

  const peerId = selected.startsWith("peer:") ? selected.slice(5) : null;
  const runId = selected.startsWith("run:") ? selected.slice(4) : null;

  useEffect(() => {
    if (!enabled || !peerId || !onPeekThread) {
      setPeeked(null);
      setPeekError(null);
      setPeeking(false);
      return;
    }
    let live = true;
    setPeeking(true);
    setPeekError(null);
    void onPeekThread(peerId)
      .then((d) => {
        if (!live) return;
        setPeeked(d);
        setPeeking(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPeeked(null);
        setPeeking(false);
        setPeekError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [enabled, peerId, onPeekThread]);

  if (!enabled || targets.length === 0) return null;

  const leftLabel = peerId
    ? comparePeerLabel(detail.thread, peers, providers)
    : (latestRun?.label ?? "This run");
  const rightMeta = targets.find((t) => t.key === selected);
  const rightLabel = rightMeta?.label ?? "other run";

  let report = null;
  if (peerId) {
    if (peeked) {
      report = compareSteps(
        extractSteps(detail.messages),
        extractSteps(peeked.messages),
        {
          leftDone: isThreadDone(detail.thread.status),
          rightDone: isThreadDone(peeked.thread.status),
        },
      );
    }
  } else if (runId && latestRun) {
    report = compareSteps(
      extractSteps(detail.messages, latestRun.runId),
      extractSteps(detail.messages, runId),
    );
  }

  const headline = peekError
    ? peekError
    : peeking
      ? "Comparing…"
      : report
        ? formatDivergenceHeadline(report, leftLabel, rightLabel)
        : "Comparing…";
  const hit = report?.first ?? null;
  const showFields = open && hit != null;

  return (
    <section className={styles.divergenceCard} data-divergence-card="">
      <div className={styles.divergenceHead}>
        <span className={styles.divergenceTitle}>Divergence</span>
        <label className={styles.divergencePick}>
          <span className={styles.divergencePickLabel}>Compare with</span>
          <select
            className={styles.divergenceSelect}
            data-divergence-peer=""
            aria-label="Compare with"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {targets.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p
        className={styles.divergenceHeadline}
        data-divergence-headline=""
        data-divergence-pending={report?.pending ? "1" : undefined}
        role={peekError ? "alert" : undefined}
      >
        {headline}
      </p>
      {hit && (
        <button
          type="button"
          className={styles.divergenceToggle}
          data-divergence-toggle=""
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide fields" : "Show fields"}
        </button>
      )}
      {showFields && (
        <div className={styles.divergenceFields} data-divergence-fields="">
          <span className={styles.divergenceColHead} />
          <span className={styles.divergenceColHead}>{leftLabel}</span>
          <span className={styles.divergenceColHead}>{rightLabel}</span>
          {(
            [
              "type",
              "name",
              "input",
              "output",
              "decision",
            ] as DivergenceField[]
          ).map((field) => {
            const differs = hit.fields.includes(field);
            return (
              <Fragment key={field}>
                <span
                  className={styles.divergenceFieldName}
                  data-divergence-field={field}
                  data-differs={differs ? "1" : undefined}
                >
                  {field}
                </span>
                <span
                  className={styles.divergenceValue}
                  data-divergence-left={field}
                >
                  {fieldValue(hit.left, field)}
                </span>
                <span
                  className={styles.divergenceValue}
                  data-divergence-right={field}
                >
                  {fieldValue(hit.right, field)}
                </span>
              </Fragment>
            );
          })}
        </div>
      )}
    </section>
  );
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
  onSaveWorkflow,
  onRemoveWorkflow,
  onStopRun,
  onResumeQuotaWait,
  onSetQuotaWaitAutoResume,
  queuedPrompt = null,
  queuedError = null,
  onCancelQueued,
  onRetryQueued,
  onEditQueued,
  restoreDraft = null,
  onSetPermissionMode,
  onRespondPermission,
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
  onPanesNeedRoom,
  runStats,
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
  onPrChecks,
  onPrMerge,
  gitSyncInfo,
  gitFetch,
  onSetupWorktree,
  onMergeWorktree,
  onRemoveWorktree,
  listBaseBranches,
  onSetBaseBranch,
  conflictContext,
  onOpenWorktree,
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
  comparePeers = EMPTY_COMPARE_PEERS,
  onPeekThread,
  onModelPickerOpen,
}: ThreadViewProps) {
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
  const pinning = useRef(false);
  const prevLayoutThreadId = useRef<string | null>(null);
  const seenThread = useRef(false);
  const prevPermReq = useRef<string | null>(null);
  const prevThreadId = useRef<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renamingRef = useRef(false);
  /** Inline edit of the queued follow-up strip (issue #364). */
  const [editingQueued, setEditingQueued] = useState(false);
  const [queuedEditDraft, setQueuedEditDraft] = useState("");
  // The edit is bound to the blob it was seeded from: a thread switch or a
  // drained/cancelled queue ends it.
  useEffect(() => {
    setEditingQueued(false);
  }, [detail?.thread.id, queuedPrompt == null]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const notesOpenRef = useRef(false);
  /** Thread the open panel belongs to, plus the value it was seeded with. */
  const notesSourceRef = useRef<{ id: string; saved: string } | null>(null);
  /**
   * Provenance chip dismissed for this open (not persisted). Reset when the
   * open thread changes.
   */
  const [handoffBannerDismissed, setHandoffBannerDismissed] = useState(false);
  const [runStatList, setRunStatList] = useState<RunStatInfo[]>([]);
  const [restoreConfirm, setRestoreConfirm] = useState<ReviewBar | null>(null);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [rewindConfirm, setRewindConfirm] = useState<{
    messageId: string;
    prompt: string;
  } | null>(null);
  const [rewindRestoreFiles, setRewindRestoreFiles] = useState(false);
  const [rewindPending, setRewindPending] = useState(false);
  /** Header context breakdown; `/usage` pins this open. */
  const [contextOpen, setContextOpen] = useState(false);
  /** Runs collapsed by the user; everything else stays open. */
  const [collapsedRuns, setCollapsedRuns] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
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
  /** Image opened in the lightbox; null when closed. */
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const [cliCommands, setCliCommands] = useState<SlashCommand[]>([]);
  const copyFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadId = detail?.thread.id ?? null;

  useEffect(() => {
    setCommandRunningId(null);
    setCommandError(null);
    setExpandedGroups(new Set());
  }, [threadId]);

  useEffect(() => {
    if (!onListCliCommands) {
      setCliCommands([]);
      return;
    }
    let cancelled = false;
    onListCliCommands({ projectPath: project?.path })
      .then((rows) => {
        if (cancelled) return;
        setCliCommands(
          rows.map((r) => ({
            name: r.name,
            hint: r.hint,
            kind: "insert" as const,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setCliCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [onListCliCommands, project?.path, threadId]);
  const [incomingAttachments, setIncomingAttachments] = useState<
    AttachmentInfo[]
  >([]);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const [snapOpen, setSnapOpen] = useState(false);
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

  const handleOpenWorkspacePath = useCallback(
    (abs: string, opts?: { reveal?: boolean }) => {
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
   * reset to the tail window; streaming appends leave it alone so the top
   * does not creep; Show earlier / revealMessageId only move it down.
   */
  const [windowThreadId, setWindowThreadId] = useState(threadId);
  const [windowStart, setWindowStart] = useState(() =>
    initialWindowStart(timeline.length),
  );
  const pendingPrepend = useRef<number | null>(null);

  const revealIndex = useMemo(() => {
    if (!revealMessageId) return -1;
    return timeline.findIndex(
      (entry) =>
        entry.kind === "message" && entry.message.id === revealMessageId,
    );
  }, [timeline, revealMessageId]);

  const start = clampWindowStart(
    ensureVisibleStart(
      threadId !== windowThreadId
        ? initialWindowStart(timeline.length)
        : windowStart,
      revealIndex,
    ),
    timeline.length,
  );
  if (threadId !== windowThreadId) {
    setWindowThreadId(threadId);
    setWindowStart(start);
  } else if (start < windowStart) {
    setWindowStart(start);
  }

  const visibleTimeline = start === 0 ? timeline : timeline.slice(start);
  const hiddenCount = start;
  const displayTimeline = useMemo(
    () =>
      collapseTimeline(visibleTimeline, {
        working: detail?.thread.status === "working",
      }),
    [visibleTimeline, detail?.thread.status],
  );

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

  /** Run duration per runId, for assistant-message meta footers. Opt-in. */
  const showRunDuration = useRunDurationEnabled();
  const verboseTools = useVerboseToolCards();
  const durationByRunId = useMemo(() => {
    const map = new Map<string, string>();
    if (!detail || !showRunDuration) return map;
    const byRun = new Map<string, WorkLogItem[]>();
    for (const item of detail.workLog) {
      const list = byRun.get(item.runId);
      if (list) list.push(item);
      else byRun.set(item.runId, [item]);
    }
    for (const [runId, items] of byRun) {
      const label = workLogDurationLabel(items);
      if (label) map.set(runId, label);
    }
    return map;
  }, [detail, showRunDuration]);

  /** "Worked for" header per completed run, keyed by its first message. */
  const headerByMessageId = useMemo(() => {
    const map = new Map<string, RunHeader>();
    if (!detail) return map;
    for (const header of mapRunHeaders(detail.messages, detail.thread.status)) {
      map.set(header.firstMessageId, header);
    }
    return map;
  }, [detail]);

  /**
   * Provenance tiers per assistant message (issue #404), computed over the
   * raw message list so turn boundaries (previous user message) are intact.
   */
  const provenanceById = useMemo(() => {
    const map = new Map<string, MessageProvenance>();
    if (!detail) return map;
    for (let i = 0; i < detail.messages.length; i++) {
      if (detail.messages[i].role !== "assistant") continue;
      const prov = messageProvenance(detail.messages, i);
      if (prov) map.set(detail.messages[i].id, prov);
    }
    return map;
  }, [detail]);

  const latestWorkLogRunId = useMemo(() => {
    let latest: WorkLogGroup | null = null;
    for (const entry of timeline) {
      if (entry.kind === "worklog") {
        if (!latest || entry.timestamp >= latest.timestamp) latest = entry;
      }
    }
    return latest?.runId ?? null;
  }, [timeline]);

  /**
   * Latest tool message of the most recent run; that card auto-expands and
   * stays open through completion (tool output and done arrive in the same
   * update, so keying off !done would collapse it before output ever shows).
   */
  const latestRunningToolId = useMemo(() => {
    if (!detail || !latestWorkLogRunId) return null;
    let latest: ChatMessage | null = null;
    for (const m of detail.messages) {
      if (m.role === "tool" && m.tool && m.runId === latestWorkLogRunId) {
        if (!latest || m.createdAt >= latest.createdAt) latest = m;
      }
    }
    return latest?.id ?? null;
  }, [detail, latestWorkLogRunId]);

  const isWorking = detail?.thread.status === "working";
  const latestThinkingId = useMemo(() => {
    if (!isWorking || !detail || !latestWorkLogRunId) return null;
    let latest: ChatMessage | null = null;
    for (const m of detail.messages) {
      if (m.thinking && m.runId === latestWorkLogRunId) {
        if (!latest || m.createdAt >= latest.createdAt) latest = m;
      }
    }
    if (!latest) return null;
    for (const m of detail.messages) {
      if (m.runId !== latestWorkLogRunId) continue;
      if (m.createdAt > latest.createdAt && !m.thinking) return null;
    }
    return latest.id;
  }, [detail, isWorking, latestWorkLogRunId]);
  const runningToolSummary = useMemo(() => {
    if (!isWorking || !detail || !latestWorkLogRunId) return null;
    let latest: ChatMessage | null = null;
    for (const m of detail.messages) {
      if (
        m.role === "tool" &&
        m.tool &&
        !m.tool.done &&
        m.runId === latestWorkLogRunId
      ) {
        if (!latest || m.createdAt >= latest.createdAt) latest = m;
      }
    }
    return latest?.text ?? null;
  }, [detail, isWorking, latestWorkLogRunId]);
  const thinkingLive = Boolean(latestThinkingId);
  /**
   * The assistant message currently being written. While a tool runs the
   * last message is the tool call itself, so the caret correctly disappears.
   */
  const streamingMessageId = (() => {
    if (!isWorking || !detail || detail.messages.length === 0) return null;
    const last = detail.messages[detail.messages.length - 1];
    return last.role === "assistant" ? last.id : null;
  })();
  const stalledAt =
    isWorking && detail?.thread.stalledAt != null
      ? detail.thread.stalledAt
      : null;
  const workingLabel = liveWorkingLabel({
    stalledElapsed: stalledAt != null ? formatElapsed(stalledAt) : null,
    workflowRunning: detail?.workflow ? runningAgents : null,
    toolSummary: runningToolSummary,
    thinking: thinkingLive,
  });
  const isArchived = Boolean(detail?.thread.archived);
  const emptyMessages = detail != null && detail.messages.length === 0;

  // Empty save means cancel: editing must never blank the queue (#364).
  const saveQueuedEdit = () => {
    const text = queuedEditDraft.trim();
    setEditingQueued(false);
    if (text && text !== queuedPrompt) onEditQueued?.(text);
  };

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
  });

  /** Last user text + event card id that carries the Retry turn control. */
  const retryUser = useMemo(
    () => (detail ? lastUserMessage(detail.messages) : null),
    [detail],
  );
  const retryEventId = useMemo(
    () =>
      detail
        ? retryAnchorEventId(detail.thread.status, detail.messages)
        : null,
    [detail],
  );
  const overflowEventId = useMemo(() => {
    if (
      !detail ||
      detail.thread.status !== "failed" ||
      detail.thread.lastErrorKind !== "context-overflow"
    ) {
      return null;
    }
    const last = detail.messages[detail.messages.length - 1];
    return last?.role === "event" && !last.thinking ? last.id : null;
  }, [detail]);
  const retryTitle = useMemo(
    () => (retryUser ? retryButtonTitle(retryUser.text) : ""),
    [retryUser],
  );
  const handleRetry = useCallback(() => {
    if (!retryUser || isWorking) return;
    void onStartRun(retryUser.text, undefined, retryUser.attachments);
  }, [retryUser, isWorking, onStartRun]);

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
      // Parent surfaces rejections via the runError banner.
      setRewindConfirm(null);
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
        if (ring) setContextOpen(true);
        return;
      }
      if (action === "compact" || action === "fork") {
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
      handleForkFresh,
      handleSlashRewind,
      onNewThread,
      handleSlashClear,
      onViewChanges,
    ],
  );

  const handleComposerSend = useCallback(
    (prompt: string, messageAttachments?: AttachmentInfo[]) =>
      onStartRun(prompt, undefined, messageAttachments),
    [onStartRun],
  );

  const handleReply = useCallback((message: ChatMessage) => {
    setReplyTo({ messageId: message.id, text: message.text });
  }, []);

  const handleWaitWhat = useCallback(
    (message: ChatMessage) => {
      void onStartRun(waitWhatPrompt(message.text));
    },
    [onStartRun],
  );

  const pickMentionFolder = useCallback(async () => {
    if (!onPickDirectory) return null;
    const dir = await onPickDirectory();
    if (!dir) return null;
    return repoRelativeDir(project?.path ?? "", dir);
  }, [onPickDirectory, project?.path]);

  const openAppSnap = useCallback(async () => {
    if (!onListSnapWindows) return;
    setSnapError(null);
    setSnapOpen(true);
    try {
      const windows = await onListSnapWindows();
      setSnapWindows(windows);
      if (windows.length === 0) {
        setSnapError("No windows to capture. Grant screen recording if asked.");
      }
    } catch (err) {
      setSnapWindows([]);
      setSnapError(
        err instanceof Error && err.message
          ? err.message
          : "Failed to list windows",
      );
    }
  }, [onListSnapWindows]);

  const captureAppSnap = useCallback(
    async (sourceId: string) => {
      if (!onCaptureSnapWindow) return;
      setSnapBusy(true);
      setSnapError(null);
      try {
        const att = await onCaptureSnapWindow(sourceId);
        if (att) {
          setIncomingAttachments([att]);
          setSnapOpen(false);
        } else {
          setSnapError("Could not capture that window");
        }
      } catch (err) {
        setSnapError(
          err instanceof Error && err.message
            ? err.message
            : "Failed to capture the window",
        );
      } finally {
        setSnapBusy(false);
      }
    },
    [onCaptureSnapWindow],
  );

  useEffect(() => {
    if (!onListSnapWindows || isArchived) return;
    const tracker = createDoubleOptionTracker();
    const onKey = (e: KeyboardEvent) => {
      if (
        tracker.note(e.key, e.type as "keydown" | "keyup", {
          meta: e.metaKey,
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
        })
      ) {
        e.preventDefault();
        void openAppSnap();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [onListSnapWindows, isArchived, openAppSnap]);

  useEscapeClose(snapOpen && !snapBusy, () => setSnapOpen(false));

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

  useEffect(() => {
    const id = detail?.thread.id ?? null;
    if (id !== prevThreadId.current) {
      prevThreadId.current = id;
      stickToBottom.current = true;
      setMenuOpen(false);
      setDeleteConfirm(false);
      setContextOpen(false);
      setRenaming(false);
      renamingRef.current = false;
      // Flush the outgoing thread's dirty draft (⌘J/K and any other
      // programmatic select skip the textarea blur). Write to the thread
      // we were editing, not the newly selected one.
      const source = notesSourceRef.current;
      if (notesOpenRef.current && source) {
        const trimmed = notesDraft.trim();
        if (trimmed !== source.saved) {
          void onSetNotes?.(source.id, trimmed);
        }
      }
      notesOpenRef.current = false;
      notesSourceRef.current = null;
      setNotesOpen(false);
      setNotesDraft(detail?.thread.notes ?? "");
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
      setIncomingAttachments([]);
      if (copyFlashTimer.current != null) {
        clearTimeout(copyFlashTimer.current);
        copyFlashTimer.current = null;
      }
    }
  }, [detail?.thread.id]);

  useEffect(() => {
    if (threadId && threadId === layoutThreadId) {
      savePaneLayout(threadId, layout);
    }
  }, [threadId, layoutThreadId, layout]);

  useEffect(() => {
    if (!changesOpen) return;
    // A newly opened pane needs the width the agents rail is holding.
    if (!hasPaneType(layout, "diff")) onPanesNeedRoom?.();
    setLayout((prev) => {
      if (hasPaneType(prev, "diff")) return prev;
      const next = openPane(prev, "diff", focusedId);
      setFocusedId(next.focusId);
      return next.layout;
    });
  }, [changesOpen, changesNonce]);

  const applyLayout = useCallback(
    (next: LayoutNode, focusId: string) => {
      setLayout(next);
      setFocusedId(findLeaf(next, focusId) ? focusId : firstLeafId(next));
      if (!hasPaneType(next, "diff")) onCloseChanges();
    },
    [onCloseChanges],
  );

  const handlePaneChange = useCallback(
    (next: LayoutNode) => {
      applyLayout(next, focusedId);
    },
    [applyLayout, focusedId],
  );

  const handleOpenPane = useCallback(
    (type: PaneType) => {
      const fresh = !hasPaneType(layout, type);
      const next = openPane(layout, type, focusedId);
      applyLayout(next.layout, next.focusId);
      // Git, Terminal, Browser, … all want the width the agents rail holds.
      if (fresh) onPanesNeedRoom?.();
      if (type === "diff") onViewChanges?.();
    },
    [layout, focusedId, applyLayout, onViewChanges, onPanesNeedRoom],
  );

  const handleResetLayout = useCallback(() => {
    const next = defaultPaneLayout();
    applyLayout(next, firstLeafId(next));
  }, [applyLayout]);

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
  useEscapeClose(restoreConfirm != null && !restorePending, () => {
    setRestoreConfirm(null);
  });

  const pinIfStuck = () => {
    const el = bodyRef.current;
    if (!el || !stickToBottom.current) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= 0) return;
    pinning.current = true;
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    const landed =
      el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_PX;
    if (el.scrollTop !== before && landed) {
      forceStick.current = false;
    }
    requestAnimationFrame(() => {
      pinning.current = false;
    });
  };
  const pinIfStuckRef = useRef(pinIfStuck);
  pinIfStuckRef.current = pinIfStuck;

  const showEarlier = () => {
    stickToBottom.current = false;
    forceStick.current = false;
    const el = bodyRef.current;
    pendingPrepend.current = el ? el.scrollHeight : 0;
    setWindowStart((s) => extendWindowStart(s));
  };

  useLayoutEffect(() => {
    const prev = pendingPrepend.current;
    if (prev == null) return;
    pendingPrepend.current = null;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop += el.scrollHeight - prev;
  }, [start]);

  /**
   * Pin before paint so a remounted body (thread switch) and a newly
   * inserted permission card never flash at the wrong scrollTop. #408's
   * ResizeObserver still covers post-paint growth.
   */
  useLayoutEffect(() => {
    const id = detail?.thread.id ?? null;
    if (id !== prevLayoutThreadId.current) {
      const switching =
        prevLayoutThreadId.current !== null &&
        id !== null &&
        prevLayoutThreadId.current !== id;
      const recovering =
        prevLayoutThreadId.current === null &&
        id !== null &&
        seenThread.current;
      prevLayoutThreadId.current = id;
      if (id) seenThread.current = true;
      if (switching || recovering) {
        stickToBottom.current = true;
        forceStick.current = true;
      } else if (id) {
        stickToBottom.current = true;
      }
    }
    const req = detail?.pendingPermission?.requestId ?? null;
    if (req && req !== prevPermReq.current) {
      stickToBottom.current = true;
      forceStick.current = true;
    }
    prevPermReq.current = req;
    pinIfStuck();
  }, [
    timeline,
    isWorking,
    detail?.messages,
    detail?.workLog,
    detail?.pendingPermission,
    detail?.thread.id,
  ]);

  /**
   * Content can grow after paint with no React state change (images, syntax
   * highlight, webfonts). Observe the scroll body and its children so a
   * pinned view stays pinned. Re-attach when the timeline replaces children.
   */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const onResize = () => pinIfStuckRef.current();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    for (const child of el.children) {
      ro.observe(child);
    }
    return () => ro.disconnect();
  }, [timeline, start, detail?.pendingPermission, isWorking]);

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

  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el || pinning.current) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (forceStick.current) {
      if (distance <= STICK_BOTTOM_PX) {
        forceStick.current = false;
        stickToBottom.current = true;
        return;
      }
      pinIfStuck();
      return;
    }
    stickToBottom.current = distance <= STICK_BOTTOM_PX;
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
  const projectSlug = project?.slug ?? "project";
  const newThreadLabel = `New thread in ${projectSlug}`;
  const headerCommands: Array<{ id: string; name: string; command: string }> =
    [];
  if (onRunCommand) {
    if (project?.setupCommand) {
      headerCommands.push({
        id: "setup",
        name: "Setup",
        command: project.setupCommand,
      });
    }
    for (const action of project?.quickActions ?? []) {
      if (action && action.id && action.name) headerCommands.push(action);
    }
  }

  const runHeaderCommand = (actionId: string) => {
    if (!onRunCommand || commandRunningId) return;
    setCommandRunningId(actionId);
    setCommandError(null);
    void onRunCommand(thread.id, actionId === "setup" ? "setup" : actionId)
      .then(() => {
        setCommandRunningId(null);
      })
      .catch((err: unknown) => {
        setCommandRunningId(null);
        setCommandError(
          err instanceof Error && err.message ? err.message : String(err),
        );
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

  const closeNotes = (save: boolean) => {
    if (!notesOpenRef.current) return;
    notesOpenRef.current = false;
    notesSourceRef.current = null;
    const next = notesDraft.trim();
    setNotesOpen(false);
    if (!save) {
      setNotesDraft(thread.notes);
      return;
    }
    if (next === thread.notes) return;
    void onSetNotes?.(thread.id, next);
  };

  const toggleNotes = () => {
    if (notesOpenRef.current) {
      closeNotes(true);
      return;
    }
    setNotesDraft(thread.notes);
    notesOpenRef.current = true;
    notesSourceRef.current = { id: thread.id, saved: thread.notes };
    setNotesOpen(true);
  };

  const handoffSourceId = thread.handoffFrom;
  const showHandoffBanner =
    handoffSourceId != null && !handoffBannerDismissed;

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

  return (
    <PathLinkProvider
      threadId={detail.thread.id}
      resolvePaths={resolvePathMap}
      openPath={handleOpenWorkspacePath}
      loadImage={onLoadAttachmentImage}
      sessionImages={sessionImages}
    >
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
              {projectSlug}
            </button>
          ) : (
            <span className={styles.project}>{projectSlug}</span>
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
            <span className={styles.threadTitle}>{thread.title}</span>
          )}
          </div>
        </div>
        <div className={styles.headerTrail}>
          {worktree.toolbar}
          <div className={styles.actions}>
          {thread.sandbox && <SandboxBadge sandbox={thread.sandbox} />}
          {ring && (
            <ContextRingBadge
              ring={ring.view}
              segments={ring.segments}
              used={ring.used}
              open={contextOpen}
              onOpenChange={setContextOpen}
              onFork={onFork && !isWorking ? handleForkFresh : undefined}
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
          {onSetNotes && (
            <button
              type="button"
              className={styles.iconBtn}
              data-thread-notes-btn=""
              data-has-notes={thread.notes ? "true" : undefined}
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
              {thread.notes ? (
                <span className={styles.notesDot} data-notes-dot="" aria-hidden />
              ) : null}
            </button>
          )}
          {!thread.ask && (
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
            onPrChecks={onPrChecks}
            onPrMerge={onPrMerge}
            onStartRun={onStartRun}
            providerName={
              providers.find((p) => p.id === thread.provider)?.name ??
              thread.provider
            }
            onPushed={() => setSyncRefreshNonce((n) => n + 1)}
          />
          )}
          {gitSyncInfo && gitFetch && (
            <SyncPill
              threadId={thread.id}
              gitSyncInfo={gitSyncInfo}
              gitFetch={gitFetch}
              refreshNonce={syncRefreshNonce}
            />
          )}
          {headerCommands.length > 0 ? (
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
          ) : null}
          <div className={styles.menuWrap} ref={menuRef}>
            <button
              type="button"
              className={styles.menuBtn}
              aria-label="Thread actions"
              title="Thread actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                setMenuOpen((v) => !v);
                setDeleteConfirm(false);
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="3.5" cy="8" r="1.3" />
                <circle cx="8" cy="8" r="1.3" />
                <circle cx="12.5" cy="8" r="1.3" />
              </svg>
            </button>
            {menuOpen && (
              <div className={styles.menu} role="menu">
                {deleteConfirm ? (
                  <div className={styles.menuConfirm}>
                    <p className={styles.menuConfirmText}>
                      Delete permanently? This removes all messages.
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
          </div>
          <div className={styles.headerDivider} aria-hidden />
          <ViewsMenu
            layout={layout}
            onOpen={handleOpenPane}
            onReset={handleResetLayout}
          />
        </div>
      </header>
      {worktree.banner}

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
            onChange={(e) => setNotesDraft(e.target.value)}
            onBlur={() => closeNotes(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeNotes(false);
              }
            }}
          />
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
                  onSaveAttachmentImage
                    ? async (dataUrl) => {
                        const att = await onSaveAttachmentImage(dataUrl);
                        if (att) setIncomingAttachments([att]);
                      }
                    : undefined
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
                isWorking={isWorking}
                onFetchDiff={onFetchDiff}
                onFetchReviewContext={onFetchReviewContext}
                onSetReviewAccepted={onSetReviewAccepted}
                onCommit={onCommitChanges}
                onStagedPathsChange={onStagedPathsChange}
                onRevert={onRevertFile}
                onSuggest={onSuggestCommitMessage}
                onComment={
                  isArchived
                    ? undefined
                    : (prompt) => onStartRun(prompt)
                }
              />
            );
          }
          if (leaf.type === "terminal" && terminalApi) {
            return (
              <TerminalPane
                threadId={detail?.thread.id ?? null}
                api={terminalApi}
              />
            );
          }
          if (leaf.type !== "chat") {
            return <PanePlaceholder type={leaf.type} />;
          }
          return (
            <div className={styles.chatSlot} data-pane-chat="">
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
          <div className={styles.emptyInline}>
            <div
              className={`${styles.emptyGlyph} ${styles.emptyGlyphSm}`}
              aria-hidden="true"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M8 2 9.6 6.4 14 8 9.6 9.6 8 14 6.4 9.6 2 8l4.4-1.6Z" />
              </svg>
            </div>
            <p className={styles.emptyTitle}>
              Start by describing what to build
            </p>
            <p className={styles.emptyHint}>
              Type a prompt below, then send it with ⌘Enter.
            </p>
          </div>
        )}

        {hiddenCount > 0 && (
          <div className={styles.showEarlier}>
            <button
              type="button"
              className={styles.showEarlierBtn}
              data-show-earlier=""
              data-hidden-count={hiddenCount}
              onClick={showEarlier}
            >
              {`Show earlier — ${hiddenCount} ${hiddenCount === 1 ? "message" : "messages"}`}
            </button>
          </div>
        )}

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
            const isRetrySurface =
              !isOverflowSurface &&
              entry.message.role === "event" &&
              retryEventId != null &&
              entry.message.id === retryEventId;
            const bar = barByMessageId.get(entry.message.id);
            const runHeader = headerByMessageId.get(entry.message.id);
            const runId = entry.message.runId;
            const runCollapsed =
              runId != null && isRunCollapsed(collapsedRuns, runId);
            if (runCollapsed && !runHeader) return null;
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
                {!runCollapsed && (
                  <>
                    <MessageBlock
                      message={entry.message}
                      autoExpandTool={
                        verboseTools ||
                        entry.message.id === latestRunningToolId ||
                        entry.message.id === latestThinkingId
                      }
                      animateIn={!seenEntryKeys.current.has(entry.message.id)}
                      streaming={entry.message.id === streamingMessageId}
                      onLoadImage={onLoadImage}
                      onLoadAttachmentImage={onLoadAttachmentImage}
                      onSelectThread={onSelectThread}
                      eventActionLabel={
                        isOverflowSurface
                          ? "Fork to fresh context"
                          : isRetrySurface
                            ? "Retry turn"
                            : undefined
                      }
                      eventActionTitle={
                        isOverflowSurface
                          ? "Fork this thread with recent history in a fresh context"
                          : isRetrySurface
                            ? retryTitle
                            : undefined
                      }
                      onEventAction={
                        isOverflowSurface
                          ? handleForkFresh
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
                      onReply={
                        entry.message.role === "assistant"
                          ? handleReply
                          : undefined
                      }
                      onWaitWhat={
                        entry.message.role === "assistant"
                          ? handleWaitWhat
                          : undefined
                      }
                    />
                    {bar && (
                      <ReviewBarStrip
                        bar={bar}
                        isWorking={isWorking}
                        onReview={() => onViewChanges?.()}
                        onUndo={() => {
                          if (!bar.undoSha || isWorking || restorePending)
                            return;
                          setRestoreError(null);
                          setRestoreConfirm(bar);
                        }}
                      />
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
            key={thread.pendingQuestion.id}
            questions={thread.pendingQuestion.questions}
            onAnswer={(answers) => {
              // The Answer button gates on every question being answered, so
              // an empty text means nothing was picked — never start a turn
              // with an empty prompt.
              const text = formatQuestionAnswer(answers);
              if (text) void onStartRun(text);
            }}
            onDismiss={() => onClearQuestion()}
          />
        ) : null}

        {detail.pendingPermission?.questions?.length ? (
          <QuestionPrompt
            key={detail.pendingPermission.requestId}
            questions={detail.pendingPermission.questions}
            onAnswer={(answers) =>
              onRespondPermission(
                detail.pendingPermission!.requestId,
                "allow",
                answers,
              )
            }
            onDismiss={() =>
              onRespondPermission(detail.pendingPermission!.requestId, "deny")
            }
          />
        ) : detail.pendingPermission?.plan ? (
          <PlanPrompt
            key={detail.pendingPermission.requestId}
            pending={detail.pendingPermission}
            onRespond={onRespondPermission}
          />
        ) : detail.pendingPermission ? (
          <PermissionPrompt
            key={detail.pendingPermission.requestId}
            pending={detail.pendingPermission}
            onRespond={onRespondPermission}
          />
        ) : null}

        {detail && detail.thread.status === "quota-wait" && (
          <div
            className={`${styles.statusStrip} ${styles.statusStripQuotaWait}`}
            data-quota-wait-strip=""
          >
            <div className={styles.statusLeft}>
              <span className={styles.statusDot} aria-hidden />
              <span>
                Usage limit reached. Resuming at{" "}
                {detail.thread.quotaWaitUntil != null
                  ? formatQuotaWaitLabel(
                      detail.thread.quotaWaitUntil,
                      Date.now(),
                    )
                  : "the reset"}
                .
              </span>
            </div>
            <div className={styles.statusLeft}>
              {onResumeQuotaWait ? (
                <button
                  type="button"
                  className={styles.retryBtn}
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
          </div>
        )}

        {isWorking && (
          <div
            className={`${styles.statusStrip} ${styles.streamIn}${stalledAt != null ? ` ${styles.statusStripStalled}` : ""}`}
            data-stalled={stalledAt != null ? "" : undefined}
          >
            <div className={styles.statusLeft}>
              <span className={styles.statusDot} aria-hidden />
              <span>{workingLabel}</span>
            </div>
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
        )}

        {queuedPrompt != null && (
          <div
            className={`${styles.queuedStrip} ${styles.streamIn}`}
            data-queued-prompt=""
          >
            {editingQueued ? (
              <>
                <span className={styles.queuedLabel}>Queued</span>
                <textarea
                  className={styles.queuedEdit}
                  value={queuedEditDraft}
                  rows={2}
                  autoFocus
                  data-edit-queued-input=""
                  onChange={(e) => setQueuedEditDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingQueued(false);
                    }
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      saveQueuedEdit();
                    }
                  }}
                />
                <div className={styles.statusLeft}>
                  <button
                    type="button"
                    className={styles.retryBtn}
                    onClick={saveQueuedEdit}
                    data-save-queued-edit=""
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className={styles.stopBtn}
                    onClick={() => setEditingQueued(false)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={styles.statusLeft}>
                  <span className={styles.queuedLabel}>Queued</span>
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
                <div className={styles.statusLeft}>
                  {onEditQueued ? (
                    <button
                      type="button"
                      className={styles.retryBtn}
                      onClick={() => {
                        setQueuedEditDraft(queuedPrompt);
                        setEditingQueued(true);
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

      <Composer
        threadId={thread.id}
        branch={thread.branch}
        permissionMode={thread.permissionMode}
        teach={thread.teach ?? null}
        ask={thread.ask === true}
        onPermissionModeChange={onSetPermissionMode}
        provider={thread.provider}
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
        sessionId={thread.sessionId}
        hasWorktree={hasWorktree}
        disabled={isArchived}
        busy={isWorking}
        placeholder={
          isArchived
            ? "Unarchive to continue this thread"
            : isWorking
              ? "Queue a follow-up, or /btw a side question…"
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
        error={runError}
        onDismissError={onDismissRunError}
        onListFiles={onListFiles}
        onPickMentionFolder={
          onPickDirectory ? pickMentionFolder : undefined
        }
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        onPickAttachments={onPickAttachments}
        onSaveAttachmentImage={onSaveAttachmentImage}
        onLoadAttachmentImage={onLoadAttachmentImage}
        onDropAttachmentFiles={onDropAttachmentFiles}
        incomingAttachments={incomingAttachments}
        onIncomingAttachmentsConsumed={() => setIncomingAttachments([])}
        onSlashAction={handleSlashAction}
        cliCommands={cliCommands}
        onStopRun={onStopRun}
        dropHostRef={dropHostRef}
        onFileDragChange={setFileDrag}
      />
            </div>
          );
        }}
      />

      {snapOpen && (
        <div
          className={styles.confirmOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="appsnap-title"
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
            className={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="rewind-title"
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
            className={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-undo-title"
            data-review-undo-confirm={restoreConfirm.undoSha}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="review-undo-title" className={styles.confirmTitle}>
              Restore turn {restoreConfirm.undoTurn} (
              {shortSha(restoreConfirm.undoSha)})?
            </h2>
            <p className={styles.confirmBody}>
              This resets the worktree to this checkpoint. Uncommitted changes
              and later checkpoints&apos; work will be lost. The main repository
              is not touched.
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
    </PathLinkProvider>
  );
});
