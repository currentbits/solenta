import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage,
  DiffResult,
  FileChange,
  PermissionMode,
  ProjectInfo,
  ProviderInfo,
  ReasoningEffort,
  RunStatInfo,
  ThreadDetail,
  ThreadInfo,
  WorkLogItem,
  WorkflowTemplateInfo,
} from "../shared/ipc";
import type { WorkflowSaveInput } from "../useCoder";
import { diffLineKind, isEmptyDiff } from "../diffView";
import { contextRing, contextWindowFor, type ContextRingView } from "../contextRing";
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
  formatReviewBarText,
  mapReviewBars,
  type ReviewBar,
} from "../reviewBar";
import { buildBestOfNPlan } from "../bestOfN";
import { useEscapeClose } from "../useEscapeClose";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import styles from "./ThreadView.module.css";

const PUSH_FLASH_MS = 3000;

/** Byte-equal to electron/worktrees.js restoreCheckpoint run-active guard. */
const RESTORE_ACTIVE_TITLE =
  "Cannot restore a checkpoint while a run is active";

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

const STICK_BOTTOM_PX = 80;

const RING_R = 8;
const RING_C = 2 * Math.PI * RING_R;

/** Small context-fill ring + percent for the thread header. */
function ContextRingBadge({ ring }: { ring: ContextRingView }) {
  return (
    <span
      className={styles.contextRing}
      title={`Context: ${ring.percentLabel} of ${ring.windowLabel} (last turn)`}
      aria-label={`Context ${ring.percentLabel} of ${ring.windowLabel}`}
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
    </span>
  );
}

interface ThreadViewProps {
  detail: ThreadDetail | null;
  project: ProjectInfo | null;
  providers: ProviderInfo[];
  workflows: WorkflowTemplateInfo[];
  hasProjects: boolean;
  onAddProject: () => void;
  onStartRun: (prompt: string, threadId?: string) => void | Promise<void>;
  /** Multi-phase Build workflow (Build pill) with selected template id. */
  onStartWorkflow: (
    prompt: string,
    templateId: string,
  ) => void | Promise<void>;
  onSaveWorkflow: (template: WorkflowSaveInput) => Promise<WorkflowTemplateInfo>;
  onRemoveWorkflow: (id: string) => Promise<void>;
  onStopRun: () => void | Promise<void>;
  onSetPermissionMode: (mode: PermissionMode) => void | Promise<void>;
  onSetProvider: (input: {
    provider?: string;
    model?: string | null;
  }) => void | Promise<void>;
  onSetReasoningEffort: (effort: ReasoningEffort | null) => void | Promise<void>;
  /** Archive or unarchive the open thread. */
  onSetArchived: (archived: boolean) => void | Promise<void>;
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
  /** Commit all changes shown in the Changes panel. */
  onCommitChanges: (message: string) => Promise<{ subject: string }>;
  /** Discard one changed file (untracked deletes the file). */
  onRevertFile: (path: string, status: string) => Promise<{ path: string }>;
  /** Draft a commit message with the thread's provider. */
  onSuggestCommitMessage: () => Promise<{ message: string }>;
  /** File lookup for the composer @-mention popup. */
  onListFiles?: (query: string) => Promise<string[]>;
  /** Push the thread's current branch to origin. */
  onPush: () => Promise<{ remote: string; branch: string }>;
  runError?: string | null;
  onDismissRunError?: () => void;
  /**
   * Fork / hand off the open thread (round 49). Plain call = same harness;
   * pass provider for hand-off.
   */
  onFork?: (
    opts?: { provider?: string },
  ) => void | Promise<void | ThreadInfo | null>;
  /** Full thread list for handoffFrom provenance lookup. */
  threads?: ThreadInfo[];
  /** Select another thread (provenance chip → source). */
  onSelectThread?: (id: string) => void;
  /** Fired when the composer model picker opens (provider list refresh). */
  onModelPickerOpen?: () => void;
}

function ToolCallCard({
  message,
  autoExpand,
}: {
  message: ChatMessage;
  autoExpand: boolean;
}) {
  const tool = message.tool;
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? autoExpand;

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
      <button
        type="button"
        className={styles.toolHeader}
        onClick={() => setManual(!open)}
        aria-expanded={open}
      >
        <span
          className={styles.toolDot}
          data-status={status}
          aria-label={status}
        />
        <span className={styles.toolName}>{tool.name}</span>
        <span className={styles.toolSummary}>{message.text}</span>
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
      </button>
      {open && (
        <div className={styles.toolBody}>
          <pre className={styles.toolPre}>{tool.input}</pre>
          {tool.output != null && tool.output !== "" && (
            <>
              <div className={styles.toolDivider} />
              <pre className={styles.toolPre}>{tool.output}</pre>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function MessageBlock({
  message,
  autoExpandTool,
  showRetry,
  retryTitle,
  onRetry,
  meta,
}: {
  message: ChatMessage;
  autoExpandTool: boolean;
  showRetry?: boolean;
  retryTitle?: string;
  onRetry?: () => void;
  /** Assistant footer segments; null/empty fields are omitted inside. */
  meta?: { model: string | null; effort: string | null; duration: string | null };
}) {
  if (message.role === "tool") {
    return <ToolCallCard message={message} autoExpand={autoExpandTool} />;
  }

  if (message.role === "user") {
    return (
      <article className={`${styles.message} ${styles.messageUser}`}>
        <div className={styles.userBubble}>{message.text}</div>
      </article>
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
    model: meta?.model ?? null,
    effort: meta?.effort ?? null,
    duration: meta?.duration ?? null,
  });
  return (
    <article className={styles.message}>
      <Markdown text={message.text} />
      <footer className={styles.msgMeta}>{metaLine}</footer>
    </article>
  );
}

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

function DiffLine({ line }: { line: string }) {
  const kind = diffLineKind(line);
  return (
    <div className={styles.diffLine} data-kind={kind}>
      {line || " "}
    </div>
  );
}

function ChangesPanel({
  open,
  threadId,
  openNonce,
  onClose,
  onFetchDiff,
  onCommit,
  onRevert,
  onSuggest,
}: {
  open: boolean;
  threadId: string | null;
  openNonce: number;
  onClose: () => void;
  onFetchDiff: () => Promise<DiffResult>;
  onCommit: (message: string) => Promise<{ subject: string }>;
  onRevert: (path: string, status: string) => Promise<{ path: string }>;
  onSuggest: () => Promise<{ message: string }>;
}) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
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
      const result = await onFetchDiff();
      if (threadIdRef.current !== forThread) return;
      setDiff(result);
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
  }, [threadId]);

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load when panel opens / thread / openNonce
  }, [open, threadId, openNonce]);

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

      {diff && !empty && (
        <>
          {diff.files.length > 0 && (
            <ul className={styles.fileList}>
              {diff.files.map((f) => (
                <li key={f.path} className={styles.fileRow}>
                  <span className={styles.fileStatus}>{f.status}</span>
                  <span className={styles.filePath}>{f.path}</span>
                  <span className={styles.fileStats}>
                    <span className={styles.adds}>+{f.additions}</span>
                    <span className={styles.dels}>−{f.deletions}</span>
                  </span>
                  <button
                    type="button"
                    className={styles.fileRevert}
                    title={
                      f.status === "??" || f.status === "A"
                        ? confirmRevert === f.path
                          ? "Click again to delete this file"
                          : "Discard (deletes the file)"
                        : "Discard changes"
                    }
                    aria-label={`Discard changes to ${f.path}`}
                    disabled={reverting != null}
                    onClick={() => void revert(f)}
                  >
                    {reverting === f.path
                      ? "…"
                      : confirmRevert === f.path
                        ? "Sure?"
                        : "↩"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {diff.patch.trim() !== "" && (
            <div className={styles.patchScroll}>
              {diff.patch.split("\n").map((line, i) => (
                <DiffLine key={i} line={line} />
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

export function ThreadView({
  detail,
  project,
  providers,
  workflows,
  hasProjects,
  onAddProject,
  onStartRun,
  onStartWorkflow,
  onSaveWorkflow,
  onRemoveWorkflow,
  onStopRun,
  onSetPermissionMode,
  onSetProvider,
  onSetReasoningEffort,
  onSetArchived,
  onDeleteThread,
  changesOpen,
  changesNonce,
  onCloseChanges,
  onViewChanges,
  runStats,
  restoreCheckpoint,
  onFetchDiff,
  onCommitChanges,
  onRevertFile,
  onSuggestCommitMessage,
  onListFiles,
  onPush,
  runError = null,
  onDismissRunError,
  onFork,
  threads = [],
  onSelectThread,
  onModelPickerOpen,
}: ThreadViewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevThreadId = useRef<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const handoffMenuRef = useRef<HTMLDivElement>(null);
  const pushFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [pushPending, setPushPending] = useState(false);
  /** Shown briefly after a successful push; null when idle. */
  const [pushFlashBranch, setPushFlashBranch] = useState<string | null>(null);
  /** Header hand-off submenu open. */
  const [handoffMenuOpen, setHandoffMenuOpen] = useState(false);
  /**
   * Provenance chip dismissed for this open (not persisted). Reset when the
   * open thread changes.
   */
  const [handoffBannerDismissed, setHandoffBannerDismissed] = useState(false);
  const [runStatList, setRunStatList] = useState<RunStatInfo[]>([]);
  const [restoreConfirm, setRestoreConfirm] = useState<ReviewBar | null>(null);
  const [restorePending, setRestorePending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

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
  const isArchived = Boolean(detail?.thread.archived);
  const emptyMessages = detail != null && detail.messages.length === 0;

  /** Header context ring; null hides it (unknown window or no measured turn). */
  const ring = useMemo(() => {
    if (!detail) return null;
    const modelId = detail.usage?.model ?? detail.thread.model;
    return contextRing({
      used: detail.usage?.contextTokens ?? null,
      window: contextWindowFor(providers, detail.thread.provider, modelId),
    });
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
    void onStartRun(retryUser.text);
  }, [retryUser, isWorking, onStartRun]);

  /**
   * Fork one thread per selected provider, then start the same prompt on each
   * new fork. Sequential: a run cannot start until its fork exists. Failures
   * throw so Composer and the run-error banner both surface them.
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
      const plan = buildBestOfNPlan(
        availableIds,
        selectedIds,
        current.provider,
      );
      if (typeof plan === "string") throw new Error(plan);
      const created: string[] = [];
      for (const providerId of plan) {
        const forked = await onFork({ provider: providerId });
        if (!forked || typeof forked !== "object" || !forked.id) {
          throw new Error("Failed to fork thread");
        }
        created.push(forked.id);
        await onStartRun(prompt, forked.id);
      }
      if (created[0]) onSelectThread?.(created[0]);
    },
    [detail, onFork, onSelectThread, onStartRun, providers],
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
      setPushPending(false);
      setPushFlashBranch(null);
      setHandoffMenuOpen(false);
      setHandoffBannerDismissed(false);
      setRestoreConfirm(null);
      setRestorePending(false);
      setRestoreError(null);
      setRunStatList([]);
      if (pushFlashTimer.current != null) {
        clearTimeout(pushFlashTimer.current);
        pushFlashTimer.current = null;
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
      if (pushFlashTimer.current != null) {
        clearTimeout(pushFlashTimer.current);
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

  useEffect(() => {
    if (!handoffMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!handoffMenuRef.current?.contains(e.target as Node)) {
        setHandoffMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
    };
  }, [handoffMenuOpen]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setDeleteConfirm(false);
  }, []);
  useEscapeClose(menuOpen, closeMenu);
  useEscapeClose(handoffMenuOpen, () => setHandoffMenuOpen(false));
  useEscapeClose(restoreConfirm != null && !restorePending, () => {
    setRestoreConfirm(null);
  });

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [timeline, isWorking, detail?.messages, detail?.workLog]);

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

  const handoffSourceId = thread.handoffFrom;
  const handoffSource =
    handoffSourceId != null
      ? threads.find((t) => t.id === handoffSourceId) ?? null
      : null;
  const showHandoffBanner =
    handoffSourceId != null && !handoffBannerDismissed;
  const otherProviders = providers.filter((p) => p.id !== thread.provider);

  const handlePush = async () => {
    if (isWorking || pushPending) return;
    setPushPending(true);
    setPushFlashBranch(null);
    if (pushFlashTimer.current != null) {
      clearTimeout(pushFlashTimer.current);
      pushFlashTimer.current = null;
    }
    try {
      const result = await onPush();
      setPushFlashBranch(result.branch);
      pushFlashTimer.current = setTimeout(() => {
        setPushFlashBranch(null);
        pushFlashTimer.current = null;
      }, PUSH_FLASH_MS);
    } catch {
      // Parent surfaces rejections via the runError banner.
    } finally {
      setPushPending(false);
    }
  };

  const pushDisabled = isWorking || pushPending;
  const pushLabel = pushPending
    ? "Pushing…"
    : pushFlashBranch
      ? `Pushed ${pushFlashBranch}`
      : "Push";

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.breadcrumb}>
          <span className={styles.project}>
            {project?.slug ?? "project"}
          </span>
          <span className={styles.sep}>/</span>
          <span className={styles.threadTitle}>{thread.title}</span>
        </div>
        <div className={styles.actions}>
          {ring && <ContextRingBadge ring={ring} />}
          {onFork && (
            <>
              <button
                type="button"
                className={styles.btn}
                data-thread-fork=""
                disabled={isWorking}
                aria-disabled={isWorking ? "true" : undefined}
                title="Fork thread (same harness)"
                onClick={() => {
                  if (isWorking) return;
                  void onFork();
                }}
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
                  <circle cx="4.5" cy="3.5" r="1.5" />
                  <circle cx="4.5" cy="12.5" r="1.5" />
                  <circle cx="11.5" cy="5.5" r="1.5" />
                  <path d="M4.5 5v6M11.5 7c0 2.2-2.8 2.3-4.6 3.4" />
                </svg>
                Fork
              </button>
              <div className={styles.menuWrap} ref={handoffMenuRef}>
                <button
                  type="button"
                  className={styles.btn}
                  data-thread-handoff=""
                  disabled={isWorking || otherProviders.length === 0}
                  aria-disabled={
                    isWorking || otherProviders.length === 0
                      ? "true"
                      : undefined
                  }
                  aria-haspopup="menu"
                  aria-expanded={handoffMenuOpen}
                  title="Hand off to another provider"
                  onClick={() => {
                    if (isWorking || otherProviders.length === 0) return;
                    setHandoffMenuOpen((v) => !v);
                    setMenuOpen(false);
                  }}
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
                    <path d="M9.5 2.5H13a.5.5 0 0 1 .5.5v3.5M13.2 2.8 8.5 7.5M6 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5v-2" />
                  </svg>
                  Hand off to…
                </button>
                {handoffMenuOpen && (
                  <div
                    className={styles.menu}
                    role="menu"
                    data-thread-handoff-menu=""
                  >
                    {otherProviders.map((p) => {
                      const disabled = !p.available;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={styles.menuItem}
                          role="menuitem"
                          data-handoff-provider={p.id}
                          disabled={disabled}
                          aria-disabled={disabled ? "true" : undefined}
                          title={
                            disabled
                              ? `${p.name} is not installed`
                              : `Hand off to ${p.name}`
                          }
                          onClick={() => {
                            if (disabled) return;
                            setHandoffMenuOpen(false);
                            void onFork({ provider: p.id });
                          }}
                        >
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary} ${styles.pushBtn}`}
            disabled={pushDisabled}
            aria-disabled={pushDisabled ? "true" : undefined}
            aria-busy={pushPending || undefined}
            onClick={() => void handlePush()}
          >
            {pushPending && (
              <span className={styles.pushSpinner} aria-hidden />
            )}
            {pushLabel}
          </button>
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

      <ChangesPanel
        open={changesOpen}
        threadId={detail?.thread.id ?? null}
        openNonce={changesNonce}
        onClose={onCloseChanges}
        onFetchDiff={onFetchDiff}
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
            return (
              <Fragment key={entry.message.id}>
                <MessageBlock
                  message={entry.message}
                  autoExpandTool={entry.message.id === latestRunningToolId}
                  showRetry={isRetrySurface}
                  retryTitle={isRetrySurface ? retryTitle : undefined}
                  onRetry={isRetrySurface ? handleRetry : undefined}
                  meta={{
                    model:
                      detail?.usage?.model ?? detail?.thread.model ?? null,
                    effort: detail?.thread.reasoningEffort ?? null,
                    duration: entry.message.runId
                      ? (durationByRunId.get(entry.message.runId) ?? null)
                      : null,
                  }}
                />
                {bar && (
                  <ReviewBarStrip
                    bar={bar}
                    isWorking={isWorking}
                    onReview={() => onViewChanges?.()}
                    onUndo={() => {
                      if (!bar.undoSha || isWorking || restorePending) return;
                      setRestoreError(null);
                      setRestoreConfirm(bar);
                    }}
                  />
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

        {isWorking && (
          <div className={styles.statusStrip}>
            <div className={styles.statusLeft}>
              <span className={styles.statusDot} aria-hidden />
              <span>
                {detail.workflow
                  ? `${runningAgents} agent${runningAgents === 1 ? "" : "s"} working in the background`
                  : "Agent working…"}
              </span>
            </div>
            <button
              type="button"
              className={styles.stopBtn}
              onClick={() => void onStopRun()}
            >
              Stop
            </button>
          </div>
        )}
      </div>

      <Composer
        threadId={thread.id}
        branch={thread.branch}
        permissionMode={thread.permissionMode}
        onPermissionModeChange={onSetPermissionMode}
        provider={thread.provider}
        model={thread.model}
        reasoningEffort={thread.reasoningEffort}
        providers={providers}
        workflows={workflows}
        onSetProvider={onSetProvider}
        onSetReasoningEffort={onSetReasoningEffort}
        onSaveWorkflow={onSaveWorkflow}
        onRemoveWorkflow={onRemoveWorkflow}
        sessionId={thread.sessionId}
        hasWorktree={hasWorktree}
        disabled={isWorking || isArchived}
        placeholder={
          isArchived
            ? "Unarchive to continue this thread"
            : undefined
        }
        onSend={onStartRun}
        onBuild={onStartWorkflow}
        onBestOfN={onFork ? runBestOfN : undefined}
        onDelegate={onFork ? runDelegate : undefined}
        onModelPickerOpen={onModelPickerOpen}
        error={runError}
        onDismissError={onDismissRunError}
        onListFiles={onListFiles}
      />

      {restoreError && (
        <p className={styles.reviewError} role="alert" data-review-undo-error="">
          {restoreError}
        </p>
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
  );
}
