import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AttachmentInfo,
  ChatMessage,
  DiffResult,
  FileChange,
  GitSyncInfo,
  PrChecksResult,
  PrInfo,
  PendingPermissionInfo,
  PermissionDecision,
  PermissionMode,
  ProjectInfo,
  AgentProfile,
  ProviderInfo,
  ReasoningEffort,
  RunStatInfo,
  SpecArtifact,
  SpecStage,
  ThreadDetail,
  ThreadInfo,
  WorkLogItem,
  WorkflowTemplateInfo,
} from "../shared/ipc";
import { SPEC_ARTIFACTS, THREAD_NOTES_MAX } from "../shared/ipc";
import { TEACH_AUTONOMY_LABELS } from "../teach";
import type { TeachAutonomy } from "../shared/ipc";
import type { WorkflowSaveInput } from "../useCoder";
import { diffLineKind, isEmptyDiff } from "../diffView";
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
  type WorkLogGroup,
} from "../timeline";
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
import type { SlashAction } from "../slashCommands";
import { buildBestOfNEntries } from "../bestOfN";
import { createPrPrompt } from "../prUi";
import { suggestNextGitAction } from "../nextGitAction";
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
import { useEscapeClose } from "../useEscapeClose";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { PathLinkProvider, PathText } from "./PathLinks";
import styles from "./ThreadView.module.css";

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
}: {
  ring: ContextRingView;
  segments: ContextBreakdownSegment[];
  used: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
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
            <p className={styles.contextWarnNote}>Compaction is close</p>
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
  /** Follow-up typed during the run, waiting for it to land (issue #92). */
  queuedPrompt?: string | null;
  /** Last delivery failure; the prompt is still queued (issue #314). */
  queuedError?: string | null;
  /** Drop the queued follow-up. */
  onCancelQueued?: () => void;
  /** Re-send a queued prompt after a delivery failure. */
  onRetryQueued?: () => void;
  onSetPermissionMode: (
    mode: PermissionMode,
    threadId?: string,
  ) => void | Promise<void>;
  /** Answer the pending permission prompt (detail.pendingPermission). */
  onRespondPermission: (
    requestId: string,
    decision: PermissionDecision,
    answers?: Record<string, string>,
  ) => void | Promise<void>;
  onSetProvider: (input: {
    provider?: string;
    model?: string | null;
  }) => void | Promise<void>;
  onSetReasoningEffort: (
    effort: ReasoningEffort | null,
    threadId?: string,
  ) => void | Promise<void>;
  /** Archive or unarchive the open thread. */
  onSetArchived: (archived: boolean) => void | Promise<void>;
  /** Rename the open thread (header overflow). */
  onRenameThread?: (title: string) => void | Promise<void>;
  /**
   * New thread in this project, same default as the sidebar "New thread"
   * button (Settings defaultWorktree / orchestrator; remotes stay plain).
   */
  onCreateThread?: (
    projectId?: string,
    opts?: { worktree?: boolean; orchestrate?: boolean; teach?: boolean; issueNumber?: number | null },
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
  /** Permanently delete the open thread (caller already confirmed in UI). */
  onDeleteThread: () => void | Promise<void>;
  /** Center Changes panel open (lifted so the Git tab can open it). */
  changesOpen: boolean;
  /** Bumps on each open request so a re-open reloads the diff. */
  changesNonce: number;
  onCloseChanges: () => void;
  /** Opens the center Changes panel (same path as the Environment tab). */
  onViewChanges?: () => void;
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
  /** Commit all changes shown in the Changes panel. */
  onCommitChanges: (message: string) => Promise<{ subject: string }>;
  /** Discard one changed file (untracked deletes the file). */
  onRevertFile: (path: string, status: string) => Promise<{ path: string }>;
  /** Draft a commit message with the thread's provider. */
  onSuggestCommitMessage: () => Promise<{ message: string }>;
  /** File lookup for the composer @-mention popup. */
  onListFiles?: (query: string) => Promise<string[]>;
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
  /** Native image/folder picker for composer attachments (Electron only). */
  onPickAttachments?: () => Promise<AttachmentInfo[]>;
  /** Persist a pasted image; returns its attachment or null when rejected. */
  onSaveAttachmentImage?: (dataUrl: string) => Promise<AttachmentInfo | null>;
  /** Loads one attached image (absolute path) as a data URL. */
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
  /** Classify drag-dropped files into attachments. */
  onDropAttachmentFiles?: (files: File[]) => Promise<AttachmentInfo[]>;
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
  }) => Promise<PrInfo>;
  /** CI checks for the current PR. Failures stay in-band. */
  onPrChecks?: () => Promise<PrChecksResult>;
  /** Squash-merge the current OPEN PR. */
  onPrMerge?: () => Promise<PrInfo>;
  /** Upstream state for the header sync pill; absent hides the pill. */
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  /** Fetch remotes before the sync pill re-reads state. */
  gitFetch?: (threadId: string) => Promise<void>;
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
   * The thread this one was handed off from (handoffFrom), already resolved.
   * Resolved by App rather than passing the whole list: the list gets a new
   * identity on every stream tick, which would defeat the memo (issue #91).
   */
  handoffSource?: ThreadInfo | null;
  /** Select another thread (provenance chip → source). */
  onSelectThread?: (id: string) => void;
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
  onLoadImage,
}: {
  message: ChatMessage;
  autoExpand: boolean;
  onLoadImage?: (name: string) => Promise<string | null>;
}) {
  const tool = message.tool;
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? autoExpand;
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  // Bytes live under userData, not in the message: fetch them as data URLs the
  // first time the card is open.
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
      <article className={styles.message}>
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
    <section className={`${styles.card} ${styles.toolCard}`}>
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

/**
 * Attachments on a user transcript message: image thumbnails load lazily as
 * data URLs (the CSP allows data:, not file:), folders render as icon + name.
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
  onRequestResubmit,
  onCancelConfirm,
  onLoadAttachmentImage,
}: {
  message: ChatMessage;
  canEdit: boolean;
  confirming: boolean;
  onRequestResubmit?: (messageId: string, prompt: string) => void;
  onCancelConfirm?: () => void;
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
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
      <article className={`${styles.message} ${styles.messageUser}`}>
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

  return (
    <article className={`${styles.message} ${styles.messageUser}`}>
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

const MessageBlock = memo(function MessageBlock({
  message,
  autoExpandTool,
  showRetry,
  retryTitle,
  onRetry,
  canEdit,
  confirming,
  onRequestResubmit,
  onCancelConfirm,
  metaModel = null,
  metaEffort = null,
  metaDuration = null,
  onLoadImage,
  onLoadAttachmentImage,
}: {
  message: ChatMessage;
  autoExpandTool: boolean;
  onLoadImage?: (name: string) => Promise<string | null>;
  onLoadAttachmentImage?: (path: string) => Promise<string | null>;
  showRetry?: boolean;
  retryTitle?: string;
  onRetry?: () => void;
  canEdit?: boolean;
  confirming?: boolean;
  onRequestResubmit?: (messageId: string, prompt: string) => void;
  onCancelConfirm?: () => void;
  /** Assistant footer segments; null fields are omitted inside. */
  metaModel?: string | null;
  metaEffort?: string | null;
  metaDuration?: string | null;
}) {
  if (message.role === "tool") {
    return (
      <ToolCallCard
        message={message}
        autoExpand={autoExpandTool}
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
        onRequestResubmit={onRequestResubmit}
        onCancelConfirm={onCancelConfirm}
        onLoadAttachmentImage={onLoadAttachmentImage}
      />
    );
  }

  if (message.role === "event") {
    return (
      <section className={styles.card}>
        <div className={styles.eventRow}>
          <div className={styles.eventTitle}>{message.text}</div>
          {showRetry && onRetry && (
            <button
              type="button"
              className={styles.retryBtn}
              title={retryTitle}
              onClick={() => onRetry()}
            >
              Retry turn
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
    <article className={styles.message}>
      <Markdown text={message.text} />
      <footer className={styles.msgMeta}>{metaLine}</footer>
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
  }) => Promise<PrInfo>;
  onPrChecks?: () => Promise<PrChecksResult>;
  onPrMerge?: () => Promise<PrInfo>;
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
  const threadRef = useRef(thread.id);
  threadRef.current = thread.id;
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [thread.id]);

  const loadGit = useCallback(async () => {
    const id = thread.id;
    try {
      const diff = await onFetchDiff();
      if (threadRef.current !== id) return;
      setDirty(!isEmptyDiff(diff));
      setFileCount(diff.files.length);
    } catch {
      if (threadRef.current !== id) return;
      setDirty(false);
      setFileCount(0);
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
    void loadGit();
  }, [
    loadGit,
    changesNonce,
    changesOpen,
    thread.status,
    thread.updatedAt,
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
  });
  const action =
    decided.kind === "merge" && !onPrMerge
      ? { ...decided, actionable: false }
      : decided;

  useEffect(() => {
    if (action.kind !== "watch-checks") return;
    const id = window.setInterval(() => void loadChecks(), CHECKS_POLL_MS);
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
          await loadGit();
          await loadChecks();
        } catch {
          // Parent surfaces rejections via the runError banner.
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
      setPending(true);
      try {
        await onPrMerge();
        await loadGit();
        await loadChecks();
      } catch {
        // Parent surfaces rejections via the runError banner.
      } finally {
        setPending(false);
      }
    }
  };

  if (action.kind === "idle") return null;

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

  if (
    href &&
    (action.kind === "watch-checks" || action.kind === "checks-failed")
  ) {
    return (
      <a
        className={className}
        data-next-git-action={action.kind}
        href={href}
        target="_blank"
        rel="noreferrer"
        title={action.title}
        aria-disabled={disabled ? "true" : undefined}
        onClick={() => {
          void loadChecks();
        }}
      >
        {pending && <span className={styles.pushSpinner} aria-hidden />}
        {label}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={className}
      data-next-git-action={action.kind}
      data-create-pr={dataCreatePr}
      disabled={disabled}
      aria-disabled={disabled ? "true" : undefined}
      aria-busy={pending || undefined}
      title={action.title}
      onClick={() => void handleClick()}
    >
      {pending && <span className={styles.pushSpinner} aria-hidden />}
      {label}
    </button>
  );
}

function WorkLogCard({
  group,
  defaultOpen,
}: {
  group: WorkLogGroup;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const duration = workLogDurationLabel(group.items);

  return (
    <section className={styles.card}>
      <button
        type="button"
        className={styles.cardHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.chevron} data-open={open}>
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
        <span className={styles.cardTitle}>Work Log</span>
      </button>
      {open && (
        <>
          <ul className={styles.steps}>
            {group.items.map((step: WorkLogItem) => (
              <li key={step.id} className={styles.step}>
                <span
                  className={styles.checkbox}
                  data-done={step.done}
                  aria-hidden
                >
                  {step.done ? "✓" : ""}
                </span>
                <span className={styles.stepLabel}>{step.label}</span>
              </li>
            ))}
          </ul>
          {duration && (
            <footer className={styles.workLogFooter}>{duration}</footer>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Option picker for an agent question (AskUserQuestion). Options answer with
 * a click or the 1-9 keys; a lone single-select question submits immediately,
 * everything else collects picks and submits together. Free text via "Other".
 */
function QuestionPrompt({
  pending,
  onRespond,
}: {
  pending: PendingPermissionInfo;
  onRespond: (
    requestId: string,
    decision: PermissionDecision,
    answers?: Record<string, string>,
  ) => void | Promise<void>;
}) {
  const questions = pending.questions ?? [];
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
      void onRespond(pending.requestId, "allow", answers);
    },
    [sent, questions, answerFor, onRespond, pending.requestId],
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
            void onRespond(pending.requestId, "deny");
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
    <div className={styles.planCard} data-plan-card="">
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
  onStopSpec,
  onSpecArtifact,
}: {
  thread: ThreadInfo;
  onReviewSpec?: (
    threadId: string,
    decision: "approve" | "revise",
    feedback?: string,
  ) => void | Promise<void>;
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
    <div className={styles.specCard} data-spec-card="">
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
        <p className={styles.specStatus}>The spec is approved.</p>
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
 * Teach mode card (issue #373): autonomy ladder, review-my-code, turn off.
 */
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
    <div className={styles.specCard} data-teach-card="">
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

function DiffLine({ line }: { line: string }) {
  const kind = diffLineKind(line);
  return (
    <div className={styles.diffLine} data-kind={kind}>
      {line || " "}
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
  confirmRevert,
  reverting,
  onRevert,
}: {
  file: FileChange;
  confirmRevert: string | null;
  reverting: string | null;
  onRevert: (f: FileChange) => void;
}) {
  return (
    <li className={styles.fileRow}>
      <span className={styles.fileStatus}>{file.status}</span>
      <span className={styles.filePath}>{file.path}</span>
      <span className={styles.fileStats}>
        <span className={styles.adds}>+{file.additions}</span>
        <span className={styles.dels}>−{file.deletions}</span>
      </span>
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
  threadId,
  threadTitle,
  planText,
  openNonce,
  onClose,
  onFetchDiff,
  onFetchReviewContext,
  onSetReviewAccepted,
  onCommit,
  onRevert,
  onSuggest,
}: {
  open: boolean;
  threadId: string | null;
  threadTitle: string;
  planText: string;
  openNonce: number;
  onClose: () => void;
  onFetchDiff: () => Promise<DiffResult>;
  onFetchReviewContext?: () => Promise<{
    annotation: unknown;
    symbols: ReviewSymbol[];
    acceptedHunks: string[];
  }>;
  onSetReviewAccepted?: (hashes: string[]) => Promise<void>;
  onCommit: (message: string) => Promise<{ subject: string }>;
  onRevert: (path: string, status: string) => Promise<{ path: string }>;
  onSuggest: () => Promise<{ message: string }>;
}) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
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
  }, [threadId]);

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

  const doCommit = async () => {
    const msg = message.trim();
    if (!msg || busy) return;
    setBusy("commit");
    setError(null);
    try {
      await onCommit(msg);
      setMessage("");
      await load();
    } catch (err) {
      setError(failMessage(err, "Failed to commit"));
    } finally {
      setBusy(null);
    }
  };

  const patches = itinerary ? orderedPatches(itinerary) : [];

  return (
    <section className={styles.changesPanel} aria-label="Changes">
      <header className={styles.changesHead}>
        <span className={styles.changesTitle}>Changes</span>
        <div className={styles.changesActions}>
          <button
            type="button"
            className={styles.btn}
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" className={styles.btn} onClick={onClose}>
            Close
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

      {empty && <p className={styles.changesEmpty}>No changes</p>}

      {diff && !empty && itinerary && (
        <>
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
                    confirmRevert={confirmRevert}
                    reverting={reverting}
                    onRevert={(file) => void revert(file)}
                  />
                ))}
              </ul>
            </div>
          ))}
          {patches.length > 0 && (
            <div className={styles.patchScroll}>
              {patches.map((p) => (
                <Fragment key={p.path}>
                  {p.hunks.length === 0 &&
                    p.text.split("\n").map((line, i) => (
                      <DiffLine key={`${p.path}:${i}`} line={line} />
                    ))}
                  {p.hunks.map((hunk) => (
                    <div
                      key={hunk.id}
                      className={styles.hunkBlock}
                      data-review-hunk={hunk.id}
                      data-review-hunk-accepted={hunk.accepted ? "" : undefined}
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
                          onClick={() => toggleHunk(hunk.id, !hunk.accepted)}
                        >
                          {hunk.accepted ? "Reviewed" : "Mark reviewed"}
                        </button>
                      </div>
                      <DiffLine line={hunk.header} />
                      {hunk.body.split("\n").map((line, i) => (
                        <DiffLine key={`${hunk.id}:${i}`} line={line} />
                      ))}
                    </div>
                  ))}
                </Fragment>
              ))}
            </div>
          )}
          {diff.truncated && (
            <p className={styles.truncatedNote}>Diff truncated</p>
          )}
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
                disabled={message.trim() === "" || busy != null}
                onClick={() => void doCommit()}
              >
                {busy === "commit" ? "Committing…" : "Commit"}
              </button>
            </div>
          </div>
        </>
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
  queuedPrompt = null,
  queuedError = null,
  onCancelQueued,
  onRetryQueued,
  onSetPermissionMode,
  onRespondPermission,
  onSetProvider,
  onSetReasoningEffort,
  onSetArchived,
  onRenameThread,
  onCreateThread,
  onRepeatSchedule,
  onDistillWorkflow,
  onSetNotes,
  onStartSpec,
  onStopSpec,
  onReviewSpec,
  onSpecArtifact,
  onStartTeach,
  onStopTeach,
  onRequestTeachReview,
  onDeleteThread,
  changesOpen,
  changesNonce,
  onCloseChanges,
  onViewChanges,
  runStats,
  restoreCheckpoint,
  onFetchDiff,
  onFetchReviewContext,
  onSetReviewAccepted,
  onCommitChanges,
  onRevertFile,
  onSuggestCommitMessage,
  onListFiles,
  onResolvePaths,
  onOpenWorkspacePath,
  onLoadImage,
  onPickAttachments,
  onSaveAttachmentImage,
  onLoadAttachmentImage,
  onDropAttachmentFiles,
  onPush,
  onCreatePr,
  onPrChecks,
  onPrMerge,
  gitSyncInfo,
  gitFetch,
  runError = null,
  onDismissRunError,
  onNewThread,
  onSettleThread,
  onFork,
  handoffSource = null,
  onSelectThread,
  onModelPickerOpen,
}: ThreadViewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const dropHostRef = useRef<HTMLElement>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const stickToBottom = useRef(true);
  const prevThreadId = useRef<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renamingRef = useRef(false);
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
  /** Bumps after a successful push so the sync pill refetches. */
  const [syncRefreshNonce, setSyncRefreshNonce] = useState(0);
  /** Brief inline confirmation after copying the thread id. */
  const [copiedThreadId, setCopiedThreadId] = useState(false);
  /** Image opened in the lightbox; null when closed. */
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const copyFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolvePathMap = useCallback(
    async (paths: string[]) => {
      if (!onResolvePaths) {
        return Object.fromEntries(paths.map((p) => [p, null]));
      }
      const rows = await onResolvePaths(paths);
      return Object.fromEntries(rows.map((r) => [r.path, r.abs]));
    },
    [onResolvePaths],
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
    return buildTimeline(detail.messages, detail.workLog);
  }, [detail]);

  /** Run duration per runId, for assistant-message meta footers. */
  const durationByRunId = useMemo(() => {
    const map = new Map<string, string>();
    if (!detail) return map;
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
  }, [detail]);

  /** "Worked for" header per completed run, keyed by its first message. */
  const headerByMessageId = useMemo(() => {
    const map = new Map<string, RunHeader>();
    if (!detail) return map;
    for (const header of mapRunHeaders(detail.messages, detail.thread.status)) {
      map.set(header.firstMessageId, header);
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
  const stalledAt =
    isWorking && detail?.thread.stalledAt != null
      ? detail.thread.stalledAt
      : null;
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
  const hasTimeline = timeline.length > 0;
  const hasWorktree = Boolean(detail?.thread.worktreePath);

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
      if (action === "usage" || action === "compact") {
        if (ring) setContextOpen(true);
        return;
      }
      if (action === "fork") {
        if (!isWorking) void onFork?.();
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
      isWorking,
      onFork,
      handleSlashRewind,
      onNewThread,
      handleSlashClear,
      onViewChanges,
    ],
  );

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
      if (copyFlashTimer.current != null) {
        clearTimeout(copyFlashTimer.current);
        copyFlashTimer.current = null;
      }
    }
  }, [detail?.thread.id]);

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

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [timeline, isWorking, detail?.messages, detail?.workLog]);

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
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
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
        </div>
      </main>
    );
  }

  const { thread } = detail;
  const projectSlug = project?.slug ?? "project";
  const newThreadLabel = `New thread in ${projectSlug}`;

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
    >
    <main
      className={styles.main}
      ref={dropHostRef}
      data-thread-drop=""
    >
      {fileDrag && onDropAttachmentFiles ? (
        <div className={styles.dropOverlay} data-drop-overlay="" aria-hidden>
          Drop images or folders
        </div>
      ) : null}
      <header className={styles.header}>
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
          <span className={styles.sep}>/</span>
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
        <div className={styles.actions}>
          {thread.sandbox && <SandboxBadge sandbox={thread.sandbox} />}
          {ring && (
            <ContextRingBadge
              ring={ring.view}
              segments={ring.segments}
              used={ring.used}
              open={contextOpen}
              onOpenChange={setContextOpen}
            />
          )}
          {onStartSpec && !thread.spec && (
            <button
              type="button"
              className={styles.btn}
              data-spec-mode-btn=""
              onClick={() => void onStartSpec(thread.id)}
            >
              Spec mode
            </button>
          )}
          {onStopSpec && thread.spec && (
            <button
              type="button"
              className={styles.btn}
              data-spec-exit-btn=""
              onClick={() => void onStopSpec(thread.id)}
            >
              Exit spec mode
            </button>
          )}
          {onStartTeach && !thread.teach && (
            <button
              type="button"
              className={styles.btn}
              data-teach-mode-btn=""
              onClick={() => void onStartTeach(thread.id)}
            >
              Teach mode
            </button>
          )}
          {onSetNotes && (
            <button
              type="button"
              className={styles.btn}
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
              Notes
              {thread.notes ? (
                <span className={styles.notesDot} data-notes-dot="" aria-hidden />
              ) : null}
            </button>
          )}
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
          {gitSyncInfo && gitFetch && (
            <SyncPill
              threadId={thread.id}
              gitSyncInfo={gitSyncInfo}
              gitFetch={gitFetch}
              refreshNonce={syncRefreshNonce}
            />
          )}
          <div className={styles.menuWrap} ref={menuRef}>
            <button
              type="button"
              className={styles.menuBtn}
              aria-label="Thread actions"
              title="Thread actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={isWorking}
              aria-disabled={isWorking ? "true" : undefined}
              onClick={() => {
                if (isWorking) return;
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
                    <button
                      type="button"
                      className={styles.menuItem}
                      role="menuitem"
                      data-copy-thread-id=""
                      onClick={() => void handleCopyThreadId()}
                    >
                      {copiedThreadId ? "Copied" : "Copy thread ID"}
                    </button>
                    {onRenameThread && (
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
                    <button
                      type="button"
                      className={`${styles.menuItem} ${styles.menuItemDanger}`}
                      role="menuitem"
                      onClick={() => setDeleteConfirm(true)}
                    >
                      Delete thread
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

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

      <ChangesPanel
        open={changesOpen}
        threadId={detail?.thread.id ?? null}
        threadTitle={detail?.thread.title ?? ""}
        planText={planTextOf(detail)}
        openNonce={changesNonce}
        onClose={onCloseChanges}
        onFetchDiff={onFetchDiff}
        onFetchReviewContext={onFetchReviewContext}
        onSetReviewAccepted={onSetReviewAccepted}
        onCommit={onCommitChanges}
        onRevert={onRevertFile}
        onSuggest={onSuggestCommitMessage}
      />

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

      <div
        className={styles.body}
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

        {timeline.map((entry) => {
          if (entry.kind === "message") {
            const isRetrySurface =
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
                      autoExpandTool={entry.message.id === latestRunningToolId}
                      onLoadImage={onLoadImage}
                      onLoadAttachmentImage={onLoadAttachmentImage}
                      showRetry={isRetrySurface}
                      retryTitle={isRetrySurface ? retryTitle : undefined}
                      onRetry={isRetrySurface ? handleRetry : undefined}
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
          return (
            <WorkLogCard
              key={`worklog-${entry.runId}`}
              group={entry}
              defaultOpen={entry.runId === latestWorkLogRunId}
            />
          );
        })}

        {thread.spec ? (
          <SpecCard
            thread={thread}
            onReviewSpec={onReviewSpec}
            onStopSpec={onStopSpec}
            onSpecArtifact={onSpecArtifact}
          />
        ) : null}

        {thread.teach ? (
          <TeachCard
            thread={thread}
            onStopTeach={onStopTeach}
            onRequestTeachReview={onRequestTeachReview}
          />
        ) : null}

        {/* A pending plan prompt already shows the plan — don't show it twice. */}
        {(thread.planSteps?.length || thread.plan) &&
        !detail.pendingPermission?.plan ? (
          <PlanCard thread={thread} />
        ) : null}

        {detail.pendingPermission?.questions?.length ? (
          <QuestionPrompt
            key={detail.pendingPermission.requestId}
            pending={detail.pendingPermission}
            onRespond={onRespondPermission}
          />
        ) : detail.pendingPermission?.plan ? (
          <PlanPrompt
            key={detail.pendingPermission.requestId}
            pending={detail.pendingPermission}
            onRespond={onRespondPermission}
          />
        ) : detail.pendingPermission && (
          <div className={styles.permissionCard} role="alertdialog" aria-label="Permission request">
            <div className={styles.permissionHead}>
              Agent wants to use <strong>{detail.pendingPermission.toolName}</strong>
            </div>
            {detail.pendingPermission.guardrail ? (
              <div className={styles.permissionGuardrail}>
                ⚠ {detail.pendingPermission.guardrail.reason} (
                {detail.pendingPermission.guardrail.rule})
              </div>
            ) : null}
            <pre className={styles.permissionInput}>{detail.pendingPermission.input}</pre>
            <div className={styles.permissionActions}>
              <button
                type="button"
                className={styles.permissionAllow}
                onClick={() =>
                  void onRespondPermission(
                    detail.pendingPermission!.requestId,
                    "allow",
                  )
                }
              >
                Accept
              </button>
              <button
                type="button"
                className={styles.permissionAllow}
                onClick={() =>
                  void onRespondPermission(
                    detail.pendingPermission!.requestId,
                    "allowAlways",
                  )
                }
              >
                Accept all
              </button>
              <button
                type="button"
                className={styles.permissionDeny}
                onClick={() =>
                  void onRespondPermission(
                    detail.pendingPermission!.requestId,
                    "deny",
                  )
                }
              >
                Deny
              </button>
            </div>
          </div>
        )}

        {isWorking && (
          <div
            className={`${styles.statusStrip}${stalledAt != null ? ` ${styles.statusStripStalled}` : ""}`}
            data-stalled={stalledAt != null ? "" : undefined}
          >
            <div className={styles.statusLeft}>
              <span className={styles.statusDot} aria-hidden />
              <span>
                {stalledAt != null
                  ? `No output for ${formatElapsed(stalledAt)} — the agent may be hung`
                  : detail.workflow
                    ? `${runningAgents} agent${runningAgents === 1 ? "" : "s"} working in the background`
                    : "Agent working…"}
              </span>
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
          <div className={styles.queuedStrip} data-queued-prompt="">
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
              {/* Any prompt still queued on a settled thread is one main did
                  not deliver — offer the retry whether or not the failure
                  reason survived a reload. */}
              {onRetryQueued ? (
                <button
                  type="button"
                  className={styles.retryBtn}
                  onClick={onRetryQueued}
                  disabled={isWorking}
                  data-retry-queued=""
                >
                  Retry
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
          </div>
        )}
      </div>

      <Composer
        threadId={thread.id}
        branch={thread.branch}
        permissionMode={thread.permissionMode}
        teach={thread.teach ?? null}
        onPermissionModeChange={onSetPermissionMode}
        provider={thread.provider}
        model={thread.model}
        reasoningEffort={thread.reasoningEffort}
        providers={providers}
        agentProfiles={agentProfiles}
        workflows={workflows}
        onSetProvider={onSetProvider}
        onSetReasoningEffort={onSetReasoningEffort}
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
              ? "Queue the next instruction…"
              : undefined
        }
        onSend={(prompt, messageAttachments) =>
          onStartRun(prompt, undefined, messageAttachments)
        }
        onBuild={onStartWorkflow}
        onBestOfN={onFork ? runBestOfN : undefined}
        onDelegate={onFork ? runDelegate : undefined}
        onModelPickerOpen={onModelPickerOpen}
        error={runError}
        onDismissError={onDismissRunError}
        onListFiles={onListFiles}
        onPickAttachments={onPickAttachments}
        onSaveAttachmentImage={onSaveAttachmentImage}
        onLoadAttachmentImage={onLoadAttachmentImage}
        onDropAttachmentFiles={onDropAttachmentFiles}
        onSlashAction={handleSlashAction}
        onStopRun={onStopRun}
        dropHostRef={dropHostRef}
        onFileDragChange={setFileDrag}
      />

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
