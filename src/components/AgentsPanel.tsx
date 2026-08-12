import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentStatus,
  CheckpointInfo,
  LocalServerInfo,
  MemoryEntryInfo,
  PhaseView,
  PrInfo,
  ProjectInfo,
  ProviderInfo,
  SessionUsage,
  ThreadInfo,
  WorkflowView,
} from "../shared/ipc";
import {
  formatCostUsd,
  formatRelativeAge,
  formatTokenSum,
  permissionModeLabel,
  providerDisplayName,
  shortSessionId,
} from "../format";
import { prCardView } from "../prUi";
import { contextRing, contextWindowFor } from "../contextRing";
import { MemoryTab } from "./MemoryTab";
import styles from "./AgentsPanel.module.css";

type PanelTab = "agents" | "git" | "memory";

interface AgentsPanelProps {
  workflow: WorkflowView | null;
  thread: ThreadInfo | null;
  usage: SessionUsage | null;
  providers: ProviderInfo[];
  project: ProjectInfo | null;
  onSetupWorktree: () => Promise<unknown>;
  onMergeWorktree: () => Promise<unknown>;
  onRemoveWorktree: (force?: boolean) => Promise<unknown>;
  /** Opens the center-pane Changes panel (fresh load). */
  onViewChanges: () => void;
  /** Push the thread branch to origin (Git tab, next to PR). */
  onPush: () => Promise<{ remote: string; branch: string }>;
  createPr: (input: {
    title: string;
    body?: string;
    draft?: boolean;
  }) => Promise<PrInfo>;
  prStatus: () => Promise<PrInfo | null>;
  /** Worktree checkpoints (newest-first). */
  listCheckpoints: (threadId: string) => Promise<CheckpointInfo[]>;
  restoreCheckpoint: (threadId: string, sha: string) => Promise<void>;
  listLocalServers: (threadId: string) => Promise<LocalServerInfo[]>;
  searchMemory: (input: {
    query: string;
    project?: string;
  }) => Promise<MemoryEntryInfo[]>;
  recentMemory: (input?: {
    limit?: number;
    project?: string;
  }) => Promise<MemoryEntryInfo[]>;
  getMemory: (input: { id: string }) => Promise<MemoryEntryInfo>;
  updateMemory: (input: {
    id: string;
    title: string;
    body: string;
  }) => Promise<{ id: string }>;
  removeMemory: (input: { id: string }) => Promise<void>;
  storeMemory: (input: {
    type: MemoryEntryInfo["type"];
    title: string;
    body: string;
    project?: string;
  }) => Promise<{ id: string }>;
}

type PhaseChipStatus = "done" | "active" | "pending" | "failed";
type DotStatus = "active" | "done" | "pending" | "error";
type GitAction = "setup" | "merge" | "remove" | "push" | "pr" | null;

function phaseStatus(phase: PhaseView): PhaseChipStatus {
  if (phase.agents.length === 0) return "pending";
  if (phase.agents.some((a) => a.status === "running")) return "active";
  const allSettled = phase.agents.every((a) => a.status === "settled");
  if (allSettled) return "done";
  const allFinished = phase.agents.every(
    (a) => a.status === "settled" || a.status === "failed",
  );
  if (allFinished && phase.agents.some((a) => a.status === "failed")) {
    return "failed";
  }
  return "pending";
}

function phaseClass(status: PhaseChipStatus): string {
  if (status === "done") return styles.phaseDone;
  if (status === "active") return styles.phaseActive;
  if (status === "failed") return styles.phaseFailed;
  return styles.phasePending;
}

function toDot(status: AgentStatus): DotStatus {
  if (status === "running") return "active";
  if (status === "settled") return "done";
  if (status === "failed") return "error";
  return "pending";
}

function dotClass(status: DotStatus): string {
  if (status === "done") return styles.dotDone;
  if (status === "active") return styles.dotActive;
  if (status === "error") return styles.dotError;
  return styles.dotPending;
}

function groupKey(phaseName: string, index: number): string {
  return `${index}:${phaseName}`;
}

function SessionCard({
  thread,
  usage,
  providers,
}: {
  thread: ThreadInfo;
  usage: SessionUsage | null;
  providers: ProviderInfo[];
}) {
  const sess = shortSessionId(thread.sessionId);
  const providerName = providerDisplayName(thread.provider, providers);
  const modelLabel = thread.model ?? usage?.model ?? "n/a";
  const ring = contextRing({
    used: usage?.contextTokens ?? null,
    window: contextWindowFor(
      providers,
      thread.provider,
      thread.model ?? usage?.model,
    ),
  });
  return (
    <section className={styles.sessionCard}>
      <div className={styles.sessionHead}>
        <div>
          <div className={styles.sessionLabel}>Session</div>
          <div className={styles.sessionProvider}>{providerName}</div>
        </div>
        {sess && (
          <span className={styles.sessionId} title={thread.sessionId ?? undefined}>
            {sess}
          </span>
        )}
      </div>

      <dl className={styles.sessionMeta}>
        <div className={styles.sessionRow}>
          <dt>Model</dt>
          <dd>{modelLabel}</dd>
        </div>
        <div className={styles.sessionRow}>
          <dt>Permission</dt>
          <dd>{permissionModeLabel(thread.permissionMode)}</dd>
        </div>
      </dl>

      <div className={styles.usageBlock}>
        <div className={styles.usageTitle}>Usage</div>
        {usage ? (
          <dl className={styles.usageList}>
            <div className={styles.sessionRow}>
              <dt>Input tokens</dt>
              <dd>{usage.inputTokens.toLocaleString()}</dd>
            </div>
            <div className={styles.sessionRow}>
              <dt>Output tokens</dt>
              <dd>{usage.outputTokens.toLocaleString()}</dd>
            </div>
            <div className={styles.sessionRow}>
              <dt>Turns</dt>
              <dd>{usage.turns}</dd>
            </div>
            <div className={styles.sessionRow}>
              <dt>Cost</dt>
              <dd className={styles.cost}>{formatCostUsd(usage.costUsd)}</dd>
            </div>
            {ring && (
              <div className={styles.sessionRow}>
                <dt>Context</dt>
                <dd>
                  {ring.percentLabel} of {ring.windowLabel} (last turn)
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className={styles.usageEmpty}>No usage yet</p>
        )}
      </div>
    </section>
  );
}

function WorktreeCard({
  thread,
  busy,
  gitAction,
  dirtyMessage,
  cardError,
  onSetup,
  onMerge,
  onDelete,
  onForceDelete,
  onCancelDirty,
  onDismissError,
}: {
  thread: ThreadInfo | null;
  busy: boolean;
  gitAction: GitAction;
  dirtyMessage: string | null;
  cardError: string | null;
  onSetup: () => void;
  onMerge: () => void;
  onDelete: () => void;
  onForceDelete: () => void;
  onCancelDirty: () => void;
  onDismissError: () => void;
}) {
  const hasWorktree = Boolean(thread?.worktreePath);
  const branch = thread?.branch ?? null;
  const path = thread?.worktreePath ?? null;
  const setupPending = gitAction === "setup";

  return (
    <section className={styles.gitCard}>
      <div className={styles.gitCardLabel}>Worktree</div>

      {!thread ? (
        <p className={styles.gitHint}>Select a thread to manage its worktree.</p>
      ) : !hasWorktree ? (
        <>
          <p className={styles.gitHint}>
            Create a git worktree so runs execute on an isolated branch.
          </p>
          <div className={styles.gitActions}>
            <button
              type="button"
              className={`${styles.gitBtn} ${styles.gitBtnPrimary}`}
              onClick={onSetup}
              disabled={busy}
            >
              {setupPending ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Setting up…
                </>
              ) : (
                "Set up worktree"
              )}
            </button>
          </div>
        </>
      ) : (
        <>
          {branch && (
            <div className={styles.worktreeBranch} title={branch}>
              {branch}
            </div>
          )}
          {path && (
            <div className={styles.worktreePath} title={path}>
              {path}
            </div>
          )}
          <div className={styles.gitActions}>
            <button
              type="button"
              className={`${styles.gitBtn} ${styles.gitBtnPrimary}`}
              onClick={onMerge}
              disabled={busy}
            >
              {gitAction === "merge" ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Merging…
                </>
              ) : (
                "Merge to main"
              )}
            </button>
            <button
              type="button"
              className={styles.gitBtn}
              onClick={onDelete}
              disabled={busy}
            >
              {gitAction === "remove" && !dirtyMessage ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Deleting…
                </>
              ) : (
                "Delete"
              )}
            </button>
          </div>
        </>
      )}

      {dirtyMessage && (
        <div className={styles.dirtyBlock} role="alert">
          <pre className={styles.dirtyMessage}>{dirtyMessage}</pre>
          <div className={styles.gitActions}>
            <button
              type="button"
              className={`${styles.gitBtn} ${styles.gitBtnDanger}`}
              onClick={onForceDelete}
              disabled={busy}
            >
              {gitAction === "remove" ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Deleting…
                </>
              ) : (
                "Delete anyway"
              )}
            </button>
            <button
              type="button"
              className={styles.gitBtn}
              onClick={onCancelDirty}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {cardError && (
        <div className={styles.cardError} role="alert">
          <span className={styles.cardErrorText}>{cardError}</span>
          <button
            type="button"
            className={styles.cardErrorDismiss}
            onClick={onDismissError}
            aria-label="Dismiss error"
            title="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
    </section>
  );
}

function ChangesCard({
  hasThread,
  onViewChanges,
}: {
  hasThread: boolean;
  onViewChanges: () => void;
}) {
  return (
    <section className={styles.gitCard}>
      <div className={styles.gitCardLabel}>Changes</div>
      <div className={styles.gitActions}>
        <button
          type="button"
          className={styles.gitBtn}
          onClick={onViewChanges}
          disabled={!hasThread}
        >
          View changes
        </button>
      </div>
    </section>
  );
}

const SERVER_POLL_MS = 5_000;

export function LocalServersCard({
  threadId,
  listLocalServers,
}: {
  threadId: string | null;
  listLocalServers: (threadId: string) => Promise<LocalServerInfo[]>;
}) {
  const [servers, setServers] = useState<LocalServerInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (!threadId) {
        if (!cancelled) setServers([]);
        return;
      }
      try {
        const list = await listLocalServers(threadId);
        if (!cancelled) setServers(Array.isArray(list) ? list : []);
      } catch {
        if (!cancelled) setServers([]);
      }
    }
    void tick();
    const id = window.setInterval(() => void tick(), SERVER_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [threadId, listLocalServers]);

  return (
    <section className={styles.gitCard} data-local-servers="">
      <div className={`${styles.gitCardLabel} ${styles.serverLabel}`}>
        Local Servers
        <span className={styles.serverCount} data-local-servers-count="">
          {servers.length}
        </span>
      </div>
      {servers.length === 0 ? (
        <p className={styles.gitHint} data-local-servers-empty="">
          No dev servers detected
        </p>
      ) : (
        <ul className={styles.serverList} data-local-servers-list="">
          {servers.map((s) => (
            <li key={`${s.pid}-${s.port}`} className={styles.serverRow}>
              <a
                className={styles.serverLink}
                href={s.url}
                target="_blank"
                rel="noreferrer"
              >
                <span className={styles.serverCommand}>{s.command}</span>
                <span className={styles.serverPort}>:{s.port}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Byte-equal to electron/worktrees.js restoreCheckpoint run-active guard. */
const RESTORE_ACTIVE_TITLE =
  "Cannot restore a checkpoint while a run is active";

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/**
 * Round 50: worktree turn checkpoints. Hidden with no worktree; empty copy
 * when a worktree exists but list is empty. Restore is confirm-gated.
 */
function CheckpointsCard({
  thread,
  checkpoints,
  loading,
  restorePending,
  cardError,
  isWorking,
  onRestoreRequest,
  onDismissError,
  now,
}: {
  thread: ThreadInfo | null;
  checkpoints: CheckpointInfo[];
  loading: boolean;
  restorePending: boolean;
  cardError: string | null;
  isWorking: boolean;
  onRestoreRequest: (cp: CheckpointInfo) => void;
  onDismissError: () => void;
  now: number;
}) {
  const hasWorktree = Boolean(thread?.worktreePath);
  if (!thread || !hasWorktree) return null;

  return (
    <section className={styles.gitCard} data-checkpoints="">
      <div className={styles.gitCardLabel}>Checkpoints</div>
      {loading && checkpoints.length === 0 ? (
        <p className={styles.gitHint}>Loading…</p>
      ) : checkpoints.length === 0 ? (
        <p className={styles.gitHint} data-checkpoints-empty="">
          No checkpoints yet
        </p>
      ) : (
        <ul className={styles.checkpointList} data-checkpoints-list="">
          {checkpoints.map((cp) => {
            const short = shortSha(cp.sha);
            const restoreDisabled = isWorking || restorePending;
            return (
              <li
                key={cp.sha}
                className={styles.checkpointRow}
                data-checkpoint={cp.sha}
                data-checkpoint-turn={cp.turn}
              >
                <div className={styles.checkpointMeta}>
                  <span className={styles.checkpointTurn}>Turn {cp.turn}</span>
                  <span className={styles.checkpointSha} title={cp.sha}>
                    {short}
                  </span>
                  <span className={styles.checkpointAge}>
                    {formatRelativeAge(cp.at, now)}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.gitBtn}
                  data-checkpoint-restore={cp.sha}
                  disabled={restoreDisabled}
                  title={isWorking ? RESTORE_ACTIVE_TITLE : `Restore turn ${cp.turn}`}
                  onClick={() => {
                    if (restoreDisabled) return;
                    onRestoreRequest(cp);
                  }}
                >
                  Restore
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {cardError && (
        <div className={styles.cardError} role="alert" data-checkpoint-error="">
          <span className={styles.cardErrorText}>{cardError}</span>
          <button
            type="button"
            className={styles.cardErrorDismiss}
            onClick={onDismissError}
            aria-label="Dismiss error"
            title="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
    </section>
  );
}

function formatPrStats(pr: {
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}): string | null {
  const diff: string[] = [];
  if (pr.additions != null) diff.push(`+${pr.additions}`);
  if (pr.deletions != null) diff.push(`-${pr.deletions}`);
  const files =
    pr.changedFiles != null ? `${pr.changedFiles} files` : null;
  if (diff.length === 0 && files == null) return null;
  if (diff.length > 0 && files) return `${diff.join(" ")} · ${files}`;
  if (diff.length > 0) return diff.join(" ");
  return files;
}

function PrCard({
  thread,
  busy,
  gitAction,
  cardError,
  titleDraft,
  bodyDraft,
  draft,
  live,
  prStatus,
  onTitleChange,
  onBodyChange,
  onDraftChange,
  onPush,
  onCreate,
  onDismissError,
}: {
  thread: ThreadInfo | null;
  busy: boolean;
  gitAction: GitAction;
  cardError: string | null;
  titleDraft: string;
  bodyDraft: string;
  draft: boolean;
  live: PrInfo | null | undefined;
  prStatus: () => Promise<PrInfo | null>;
  onTitleChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onDraftChange: (v: boolean) => void;
  onPush: () => void;
  onCreate: () => void;
  onDismissError: () => void;
}) {
  const [refreshed, setRefreshed] = useState<PrInfo | null | undefined>(
    undefined,
  );
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setRefreshed(undefined);
    setRefreshFailed(false);
    setRefreshing(false);
  }, [thread?.id]);

  const effectiveLive = refreshed !== undefined ? refreshed : live;
  const view = prCardView({
    branch: thread?.branch ?? null,
    threadPrNumber: thread?.prNumber ?? null,
    threadPrUrl: thread?.prUrl ?? null,
    live: effectiveLive,
    titleDraft,
    busy,
  });
  const statsLine = view.existing ? formatPrStats(view.existing) : null;

  const refreshPr = async () => {
    setRefreshing(true);
    try {
      const info = await prStatus();
      setRefreshed(info);
      setRefreshFailed(false);
    } catch {
      setRefreshFailed(true);
    } finally {
      setRefreshing(false);
    }
  };

  if (!thread) {
    return (
      <section className={styles.gitCard}>
        <div className={styles.gitCardLabel}>Pull request</div>
        <p className={styles.gitHint}>Select a thread to open a PR.</p>
      </section>
    );
  }

  return (
    <section className={styles.gitCard}>
      <div className={styles.gitCardLabel}>Pull request</div>

      <div className={styles.gitActions}>
        <button
          type="button"
          className={styles.gitBtn}
          onClick={onPush}
          disabled={busy || !thread.branch}
        >
          {gitAction === "push" ? (
            <>
              <span className={styles.btnSpinner} aria-hidden />
              Pushing…
            </>
          ) : (
            "Push"
          )}
        </button>
      </div>

      {view.existing ? (
        <div className={styles.prExisting}>
          <div className={styles.prRow}>
            <span className={styles.prNumber}>#{view.existing.number}</span>
            {view.existing.state && (
              <span
                className={styles.prState}
                data-state={view.existing.state.toLowerCase()}
              >
                {view.existing.state}
              </span>
            )}
            <button
              type="button"
              className={`${styles.gitBtn} ${styles.prRefresh}`}
              onClick={() => void refreshPr()}
              disabled={busy || refreshing}
              title="Refresh PR data"
            >
              {refreshing ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Refresh
                </>
              ) : (
                "Refresh"
              )}
            </button>
          </div>
          {view.existing.title ? (
            <div className={styles.prTitle} title={view.existing.title}>
              {view.existing.title}
            </div>
          ) : null}
          {statsLine ? <div className={styles.prStats}>{statsLine}</div> : null}
          {view.existing.branch && (
            <div className={styles.prBranch} title={view.existing.branch}>
              {view.existing.branch}
            </div>
          )}
          {view.existing.url ? (
            <a
              className={styles.prUrl}
              href={view.existing.url}
              target="_blank"
              rel="noreferrer"
            >
              {view.existing.url}
            </a>
          ) : (
            <p className={styles.gitHint}>No URL recorded for this PR.</p>
          )}
          {refreshFailed ? (
            <div className={styles.prLoadError} role="alert">
              <span className={styles.prLoadErrorText}>
                Couldn&apos;t load PR data
              </span>
              <button
                type="button"
                className={styles.gitBtn}
                onClick={() => void refreshPr()}
                disabled={busy || refreshing}
                title="Retry loading PR data"
              >
                Retry
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {view.showForm ? (
        <div className={styles.prForm}>
          <label className={styles.prField}>
            <span className={styles.prFieldLabel}>Title</span>
            <input
              className={styles.prInput}
              value={titleDraft}
              onChange={(e) => onTitleChange(e.target.value)}
              disabled={busy}
              placeholder="PR title"
              aria-label="PR title"
            />
          </label>
          <label className={styles.prField}>
            <span className={styles.prFieldLabel}>Body (optional)</span>
            <textarea
              className={styles.prTextarea}
              value={bodyDraft}
              onChange={(e) => onBodyChange(e.target.value)}
              disabled={busy}
              rows={3}
              placeholder="Describe the change"
              aria-label="PR body"
            />
          </label>
          <label className={styles.prCheckLabel}>
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => onDraftChange(e.target.checked)}
              disabled={busy}
            />
            Open as draft
          </label>
          <div className={styles.gitActions}>
            <button
              type="button"
              className={`${styles.gitBtn} ${styles.gitBtnPrimary}`}
              onClick={onCreate}
              disabled={!view.canCreate}
            >
              {gitAction === "pr" ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Creating…
                </>
              ) : (
                "Create PR"
              )}
            </button>
          </div>
          {!thread.branch && (
            <p className={styles.gitHint}>
              Set up a worktree (or check out a branch) before opening a PR.
            </p>
          )}
        </div>
      ) : null}

      {cardError && (
        <div className={styles.cardError} role="alert">
          <span className={styles.cardErrorText}>{cardError}</span>
          <button
            type="button"
            className={styles.cardErrorDismiss}
            onClick={onDismissError}
            aria-label="Dismiss error"
            title="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
    </section>
  );
}

export function GitTab({
  thread,
  project,
  onSetupWorktree,
  onMergeWorktree,
  onRemoveWorktree,
  onViewChanges,
  onPush,
  createPr,
  prStatus,
  listCheckpoints,
  restoreCheckpoint,
  listLocalServers,
}: {
  thread: ThreadInfo | null;
  project: ProjectInfo | null;
  onSetupWorktree: () => Promise<unknown>;
  onMergeWorktree: () => Promise<unknown>;
  onRemoveWorktree: (force?: boolean) => Promise<unknown>;
  onViewChanges: () => void;
  onPush: () => Promise<{ remote: string; branch: string }>;
  createPr: (input: {
    title: string;
    body?: string;
    draft?: boolean;
  }) => Promise<PrInfo>;
  prStatus: () => Promise<PrInfo | null>;
  listCheckpoints: (threadId: string) => Promise<CheckpointInfo[]>;
  restoreCheckpoint: (threadId: string, sha: string) => Promise<void>;
  listLocalServers: (threadId: string) => Promise<LocalServerInfo[]>;
}) {
  const [gitAction, setGitAction] = useState<GitAction>(null);
  const [dirtyMessage, setDirtyMessage] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const [draft, setDraft] = useState(false);
  /** undefined until first fetch; null = none; PrInfo = known. */
  const [livePr, setLivePr] = useState<PrInfo | null | undefined>(undefined);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(false);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<CheckpointInfo | null>(
    null,
  );
  const [restorePending, setRestorePending] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const isWorking = thread?.status === "working";
  const busy = isWorking || gitAction != null;

  // Clear per-thread PR form state when the selected thread changes so a
  // stale error or draft from row A never shows on row B.
  useEffect(() => {
    setDirtyMessage(null);
    setCardError(null);
    setPrError(null);
    setGitAction(null);
    setTitleDraft(thread?.title ?? "");
    setBodyDraft("");
    setDraft(false);
    setLivePr(undefined);
    setCheckpoints([]);
    setCheckpointError(null);
    setRestoreConfirm(null);
    setRestorePending(false);
    // Only thread id: a title rename must not wipe an in-progress form.
  }, [thread?.id]);

  // Relative ages tick (same 60s cadence as the sidebar).
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const refreshCheckpoints = useCallback(async () => {
    if (!thread?.id || !thread.worktreePath) {
      setCheckpoints([]);
      return;
    }
    setCheckpointsLoading(true);
    try {
      const list = await listCheckpoints(thread.id);
      setCheckpoints(list);
      setCheckpointError(null);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to load checkpoints";
      setCheckpointError(msg);
    } finally {
      setCheckpointsLoading(false);
    }
  }, [thread?.id, thread?.worktreePath, listCheckpoints]);

  // Fetch on Git tab mount / thread change / after a run settles (status).
  // GitTab only mounts while the Git tab is selected, so open = mount.
  useEffect(() => {
    void refreshCheckpoints();
  }, [refreshCheckpoints, thread?.status]);

  // Refresh live PR status, but ONLY when this thread already has a PR.
  //
  // Two reasons, both learned from review:
  // 1. gh runs through execFileSync in the main process, so every call freezes
  //    the whole app (agent streaming included) for up to the 30s gh timeout.
  //    Clicking down the sidebar must not pay that per thread.
  // 2. prStatus throws for a repo whose origin is not github.com, which is a
  //    supported setup, not an error. Surfacing it painted a permanent red
  //    banner on the Git tab for every GitLab or remote-less project.
  // The create path does its own lookup, so nothing is lost by skipping here.
  useEffect(() => {
    if (!thread || thread.prNumber == null) {
      setLivePr(thread ? null : undefined);
      return;
    }
    let cancelled = false;
    void prStatus()
      .then((info) => {
        if (!cancelled) setLivePr(info);
      })
      .catch(() => {
        // undefined, NOT null: null means "confirmed no PR" and would hide the
        // card behind a create form for a thread that demonstrably has a PR.
        // undefined falls back to the recorded prNumber/prUrl, which is what a
        // failed refresh should do.
        if (!cancelled) setLivePr(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [thread?.id, thread?.prNumber, thread?.prUrl, prStatus]);

  const runAction = async (
    action: Exclude<GitAction, null>,
    fn: () => Promise<unknown>,
    opts?: { scope?: "worktree" | "pr" },
  ) => {
    setGitAction(action);
    if (opts?.scope === "pr") {
      setPrError(null);
    } else {
      setCardError(null);
    }
    try {
      await fn();
      setDirtyMessage(null);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Git action failed";
      const dirtyMarker = "WORKTREE_DIRTY:";
      const dirtyAt = msg.indexOf(dirtyMarker);
      if (dirtyAt !== -1) {
        // Electron wraps invoke rejections ("Error invoking remote method …");
        // strip everything through the marker so only the listed entries show.
        setDirtyMessage(msg.slice(dirtyAt + dirtyMarker.length).trim());
        setCardError(null);
      } else if (opts?.scope === "pr") {
        setPrError(msg);
      } else {
        setCardError(msg);
      }
    } finally {
      setGitAction(null);
    }
  };

  const statusLine = (() => {
    if (!thread) return "No thread selected";
    const provider = thread.provider;
    if (thread.worktreePath && thread.branch) {
      return `${provider} · ${thread.branch}`;
    }
    if (thread.branch) {
      return `${provider} · ${thread.branch}`;
    }
    if (project) {
      return `${provider} · ${project.slug}`;
    }
    return provider;
  })();

  const handleRestoreConfirm = async () => {
    if (!thread || !restoreConfirm || restorePending || isWorking) return;
    const cp = restoreConfirm;
    setRestorePending(true);
    setCheckpointError(null);
    try {
      await restoreCheckpoint(thread.id, cp.sha);
      setRestoreConfirm(null);
      await refreshCheckpoints();
      // Refresh the center Changes surface (same open path bumps nonce).
      onViewChanges();
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Restore failed";
      setCheckpointError(msg);
      setRestoreConfirm(null);
    } finally {
      setRestorePending(false);
    }
  };

  return (
    <>
      <div className={styles.scroll}>
        <WorktreeCard
          thread={thread}
          busy={busy}
          gitAction={gitAction}
          dirtyMessage={dirtyMessage}
          cardError={cardError}
          onSetup={() => void runAction("setup", () => onSetupWorktree())}
          onMerge={() => void runAction("merge", () => onMergeWorktree())}
          onDelete={() =>
            void runAction("remove", () => onRemoveWorktree(false))
          }
          onForceDelete={() =>
            void runAction("remove", () => onRemoveWorktree(true))
          }
          onCancelDirty={() => setDirtyMessage(null)}
          onDismissError={() => setCardError(null)}
        />
        <ChangesCard
          hasThread={Boolean(thread)}
          onViewChanges={onViewChanges}
        />
        <LocalServersCard
          threadId={thread?.id ?? null}
          listLocalServers={listLocalServers}
        />
        <CheckpointsCard
          thread={thread}
          checkpoints={checkpoints}
          loading={checkpointsLoading}
          restorePending={restorePending}
          cardError={checkpointError}
          isWorking={isWorking}
          onRestoreRequest={(cp) => {
            if (isWorking || restorePending) return;
            setCheckpointError(null);
            setRestoreConfirm(cp);
          }}
          onDismissError={() => setCheckpointError(null)}
          now={now}
        />
        <PrCard
          thread={thread}
          busy={busy}
          gitAction={gitAction}
          cardError={prError}
          titleDraft={titleDraft}
          bodyDraft={bodyDraft}
          draft={draft}
          live={livePr}
          prStatus={prStatus}
          onTitleChange={setTitleDraft}
          onBodyChange={setBodyDraft}
          onDraftChange={setDraft}
          onPush={() => void runAction("push", () => onPush(), { scope: "pr" })}
          onCreate={() =>
            void runAction(
              "pr",
              async () => {
                const info = await createPr({
                  title: titleDraft,
                  body: bodyDraft.trim() ? bodyDraft : undefined,
                  draft: draft || undefined,
                });
                setLivePr(info);
              },
              { scope: "pr" },
            )
          }
          onDismissError={() => setPrError(null)}
        />
      </div>
      <footer className={styles.gitStatus} title={statusLine}>
        {statusLine}
      </footer>
      {restoreConfirm && thread && (
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
            aria-labelledby="restore-checkpoint-title"
            data-restore-confirm={restoreConfirm.sha}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="restore-checkpoint-title"
              className={styles.confirmTitle}
            >
              Restore turn {restoreConfirm.turn} ({shortSha(restoreConfirm.sha)}
              )?
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
                data-restore-confirm-submit=""
                disabled={restorePending || isWorking}
                aria-busy={restorePending || undefined}
                onClick={() => void handleRestoreConfirm()}
              >
                {restorePending ? "Restoring…" : "Restore checkpoint"}
              </button>
              <button
                type="button"
                className={styles.confirmCancel}
                data-restore-confirm-cancel=""
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
    </>
  );
}

function AgentsContent({
  workflow,
  thread,
  usage,
  providers,
}: {
  workflow: WorkflowView | null;
  thread: ThreadInfo | null;
  usage: SessionUsage | null;
  providers: ProviderInfo[];
}) {
  /**
   * Manual expand/collapse overrides. Absent key = not toggled by user,
   * so active phases auto-expand and others stay collapsed.
   */
  const [manual, setManual] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setManual({});
  }, [workflow?.id]);

  const groups = useMemo(() => {
    if (!workflow) return [];
    return workflow.phases
      .map((phase, index) => ({ phase, index }))
      .filter(({ phase }) => phase.agents.length > 0)
      .map(({ phase, index }) => {
        const status = phaseStatus(phase);
        const activeCount = phase.agents.filter(
          (a) => a.status === "running",
        ).length;
        const doneCount = phase.agents.filter(
          (a) => a.status === "settled",
        ).length;
        const id = groupKey(phase.name, index);
        return {
          id,
          name: phase.name.toUpperCase(),
          status,
          activeCount,
          doneCount,
          agents: phase.agents,
        };
      });
  }, [workflow]);

  const isOpen = (id: string, status: PhaseChipStatus): boolean => {
    if (Object.prototype.hasOwnProperty.call(manual, id)) {
      return manual[id]!;
    }
    return status === "active";
  };

  const toggle = (id: string, currentlyOpen: boolean) => {
    setManual((prev) => ({ ...prev, [id]: !currentlyOpen }));
  };

  if (!workflow) {
    return (
      <div className={styles.scroll}>
        {thread ? (
          <SessionCard thread={thread} usage={usage} providers={providers} />
        ) : (
          <p className={styles.placeholder}>No active session</p>
        )}
      </div>
    );
  }

  const working = workflow.phases.reduce(
    (n, p) => n + p.agents.filter((a) => a.status === "running").length,
    0,
  );

  return (
    <>
      <div className={styles.scroll}>
        <section className={styles.workflow}>
          <div className={styles.workflowHead}>
            <div>
              <div className={styles.workflowLabel}>Workflow</div>
              <div className={styles.workflowName}>{workflow.name}</div>
            </div>
            <div className={styles.settled}>
              {workflow.settled}/{workflow.total} settled
            </div>
          </div>

          <div
            className={styles.pipeline}
            role="list"
            aria-label="Workflow phases"
          >
            {workflow.phases.map((phase, index) => {
              const status = phaseStatus(phase);
              return (
                <div
                  key={groupKey(phase.name, index)}
                  className={styles.phaseWrap}
                  role="listitem"
                >
                  {index > 0 && (
                    <span className={styles.connector} aria-hidden />
                  )}
                  <span
                    className={`${styles.phaseChip} ${phaseClass(status)}`}
                  >
                    {status === "active" && (
                      <span className={styles.dots} aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                    {status === "done" && (
                      <span className={styles.phaseCheck} aria-hidden>
                        ✓
                      </span>
                    )}
                    {status === "failed" && (
                      <span className={styles.phaseFailMark} aria-hidden>
                        !
                      </span>
                    )}
                    {phase.name}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <div className={styles.groups}>
          {groups.map((group) => {
            const open = isOpen(group.id, group.status);
            return (
              <section key={group.id} className={styles.group}>
                <button
                  type="button"
                  className={styles.groupHeader}
                  onClick={() => toggle(group.id, open)}
                  aria-expanded={open}
                >
                  <span className={styles.chevron} data-open={open}>
                    ▸
                  </span>
                  <span className={styles.groupName}>{group.name}</span>
                  <span className={styles.groupMeta}>
                    · {group.activeCount} active · {group.doneCount} done
                  </span>
                </button>
                {open && (
                  <ul className={styles.agentList}>
                    {group.agents.map((agent) => {
                      const dot = toDot(agent.status);
                      return (
                        <li key={agent.id} className={styles.agentRow}>
                          <span
                            className={`${styles.dot} ${dotClass(dot)}`}
                            aria-label={agent.status}
                          />
                          <span className={styles.agentLabel}>
                            {agent.id}
                            <span className={styles.agentModel}>
                              {" "}
                              / {agent.model}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>

      <footer className={styles.footer}>
        <span>
          {working} working · {workflow.settled} settled
        </span>
        <span className={styles.tokens}>
          {formatTokenSum(workflow.tokensTotal)}
        </span>
      </footer>
    </>
  );
}

export function AgentsPanel({
  workflow,
  thread,
  usage,
  providers,
  project,
  onSetupWorktree,
  onMergeWorktree,
  onRemoveWorktree,
  onViewChanges,
  onPush,
  createPr,
  prStatus,
  listCheckpoints,
  restoreCheckpoint,
  listLocalServers,
  searchMemory,
  recentMemory,
  getMemory,
  updateMemory,
  removeMemory,
  storeMemory,
}: AgentsPanelProps) {
  const [tab, setTab] = useState<PanelTab>("agents");

  return (
    <aside className={styles.panel}>
      <header className={styles.tabs}>
        <button
          type="button"
          className={styles.tab}
          data-active={tab === "agents"}
          onClick={() => setTab("agents")}
        >
          Agents
        </button>
        <button
          type="button"
          className={styles.tab}
          data-active={tab === "git"}
          onClick={() => setTab("git")}
        >
          Git
        </button>
        <button
          type="button"
          className={styles.tab}
          data-active={tab === "memory"}
          onClick={() => setTab("memory")}
        >
          Memory
        </button>
      </header>

      {tab === "agents" ? (
        <AgentsContent
          workflow={workflow}
          thread={thread}
          usage={usage}
          providers={providers}
        />
      ) : tab === "git" ? (
        <GitTab
          thread={thread}
          project={project}
          onSetupWorktree={onSetupWorktree}
          onMergeWorktree={onMergeWorktree}
          onRemoveWorktree={onRemoveWorktree}
          onViewChanges={onViewChanges}
          onPush={onPush}
          createPr={createPr}
          prStatus={prStatus}
          listCheckpoints={listCheckpoints}
          restoreCheckpoint={restoreCheckpoint}
          listLocalServers={listLocalServers}
        />
      ) : (
        <MemoryTab
          projectSlug={project?.slug ?? null}
          searchMemory={searchMemory}
          recentMemory={recentMemory}
          getMemory={getMemory}
          updateMemory={updateMemory}
          removeMemory={removeMemory}
          storeMemory={storeMemory}
        />
      )}
    </aside>
  );
}
