import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentStatus,
  AppSettings,
  CheckpointInfo,
  GitSyncInfo,
  GitRepoInfo,
  GitPullResult,
  DevServerState,
  LocalServerInfo,
  MemoryEntryInfo,
  PhaseView,
  ProjectInfo,
  ProviderInfo,
  SessionUsage,
  SkillInfo,
  SkillWrite,
  ThreadInfo,
  ThreadSummaryInfo,
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
import { contextRing, contextWindowFor } from "../contextRing";
import { MemoryTab } from "./MemoryTab";
import { SkillsTab } from "./SkillsTab";
import styles from "./AgentsPanel.module.css";

type PanelTab = "agents" | "git" | "memory" | "skills";

/** Shared props for the 14px line icons in Environment card labels. */
const LABEL_ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

interface AgentsPanelProps {
  workflow: WorkflowView | null;
  thread: ThreadInfo | null;
  usage: SessionUsage | null;
  providers: ProviderInfo[];
  project: ProjectInfo | null;
  /**
   * Full thread list; changing it refetches summaries for the Agents tab
   * team view. Absent (tests) disables the team view.
   */
  threads?: ThreadInfo[];
  /** threads:summaries passthrough powering the team view. */
  listThreadSummaries?: () => Promise<ThreadSummaryInfo[]>;
  /** Select a thread (team row click). */
  onSelectThread?: (id: string) => void;
  onSetupWorktree: () => Promise<unknown>;
  onMergeWorktree: () => Promise<unknown>;
  onRemoveWorktree: (force?: boolean) => Promise<unknown>;
  /** Opens the center-pane Changes panel (fresh load). */
  onViewChanges: () => void;
  /** Worktree checkpoints (newest-first). */
  listCheckpoints: (threadId: string) => Promise<CheckpointInfo[]>;
  restoreCheckpoint: (threadId: string, sha: string) => Promise<void>;
  listLocalServers: (threadId: string) => Promise<LocalServerInfo[]>;
  revealInFinder: () => Promise<void>;
  openInEditor: () => Promise<void>;
  gitSyncInfo: (threadId: string) => Promise<GitSyncInfo>;
  gitFetch: (threadId: string) => Promise<void>;
  /** Origin owner/repo + web URL for the Repository row. Never rejects. */
  gitRepoInfo: (threadId: string) => Promise<GitRepoInfo>;
  /** `git pull --ff-only` for the Pull card. Never rejects. */
  gitPull: (threadId: string) => Promise<GitPullResult>;
  listDevScripts: (threadId: string) => Promise<string[]>;
  startDevServer: (threadId: string, script: string) => Promise<DevServerState>;
  stopDevServer: (threadId: string) => Promise<DevServerState>;
  devServerStatus: (threadId: string) => Promise<DevServerState>;
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
  /** Skills tab: settings surface for MCP servers + skills CRUD. */
  settings: AppSettings | null;
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  listSkills: (input?: { projectPath?: string }) => Promise<SkillInfo[]>;
  addSkill: (input: SkillWrite) => Promise<{ name: string }>;
  removeSkill: (input: {
    target: "claude" | "agents";
    name: string;
  }) => Promise<void>;
}

type PhaseChipStatus = "done" | "active" | "pending" | "failed";
type DotStatus = "active" | "done" | "pending" | "error";
type GitAction = "setup" | "merge" | "remove" | null;

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
  role,
}: {
  thread: ThreadInfo;
  usage: SessionUsage | null;
  providers: ProviderInfo[];
  /** Team role chip ("Orchestrator" / "Worker"); absent renders no chip. */
  role?: string;
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
          <div className={styles.sessionLabel}>
            Session
            {role && <span className={styles.roleChip}>{role}</span>}
          </div>
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
      <div className={styles.gitCardLabel}>
        <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
          <circle cx="4.5" cy="3.5" r="1.5" />
          <circle cx="4.5" cy="12.5" r="1.5" />
          <circle cx="11.5" cy="5.5" r="1.5" />
          <path d="M4.5 5v6M11.5 7c0 2.2-2.8 2.3-4.6 3.4" />
        </svg>
        Worktree
      </div>

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
      <div className={styles.gitCardLabel}>
        <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
          <path d="M11.3 2.7a1.4 1.4 0 0 1 2 2L5 13H3v-2l8.3-8.3Z" />
          <path d="M10 4l2 2" />
        </svg>
        Changes
      </div>
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

export function EditorCard({
  hasThread,
  onReveal,
  onOpen,
}: {
  hasThread: boolean;
  onReveal: () => void;
  onOpen: () => void;
}) {
  return (
    <section className={styles.gitCard} data-editor="">
      <div className={styles.gitCardLabel}>
        <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
          <path d="M7 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V9" />
          <path d="M11 2.8a1.3 1.3 0 0 1 1.9 1.9L8 9.6 5.7 10.2 6.3 7.9 11 2.8Z" />
        </svg>
        Editor
      </div>
      {!hasThread && (
        <p className={styles.gitHint} data-editor-hint="">
          Select a thread to open its folder.
        </p>
      )}
      <div className={styles.gitActions}>
        <button
          type="button"
          className={styles.gitBtn}
          data-editor-reveal=""
          onClick={onReveal}
          disabled={!hasThread}
        >
          Open in Finder
        </button>
        <button
          type="button"
          className={styles.gitBtn}
          data-editor-open=""
          onClick={onOpen}
          disabled={!hasThread}
        >
          Open in Editor
        </button>
      </div>
    </section>
  );
}

function syncLabel(info: GitSyncInfo): string | null {
  if (!info.hasUpstream) return null;
  const { ahead, behind } = info;
  if (ahead === 0 && behind === 0) return "Synced";
  const parts: string[] = [];
  if (ahead > 0) parts.push(`${ahead} ahead`);
  if (behind > 0) parts.push(`${behind} behind`);
  return parts.join(" · ") || "Synced";
}

const SERVER_POLL_MS = 5_000;
const DEV_SERVER_POLL_MS = 3_000;

function formatDevRuntime(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (sec < 60) return `running ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `running ${min}m`;
  const hours = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `running ${hours}h` : `running ${hours}h ${rem}m`;
}

export function DevServerCard({
  threadId,
  listDevScripts,
  startDevServer,
  stopDevServer,
  devServerStatus,
}: {
  threadId: string | null;
  listDevScripts: (threadId: string) => Promise<string[]>;
  startDevServer: (threadId: string, script: string) => Promise<DevServerState>;
  stopDevServer: (threadId: string) => Promise<DevServerState>;
  devServerStatus: (threadId: string) => Promise<DevServerState>;
}) {
  const [scripts, setScripts] = useState<string[]>([]);
  const [script, setScript] = useState<string>("");
  const [state, setState] = useState<DevServerState>({ running: false });
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!threadId) {
        if (!cancelled) {
          setScripts([]);
          setScript("");
          setState({ running: false });
          setErrorLine(null);
          setStarting(false);
          setStopping(false);
        }
        return;
      }
      try {
        const [list, status] = await Promise.all([
          listDevScripts(threadId),
          devServerStatus(threadId),
        ]);
        if (cancelled) return;
        const nextScripts = Array.isArray(list) ? list : [];
        setScripts(nextScripts);
        setState(status && typeof status === "object" ? status : { running: false });
        setScript((prev) =>
          prev && nextScripts.includes(prev) ? prev : nextScripts[0] ?? "",
        );
        setErrorLine(null);
      } catch (err) {
        if (cancelled) return;
        setScripts([]);
        setState({ running: false });
        setErrorLine(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [threadId, listDevScripts, devServerStatus]);

  const live = starting || state.running;
  useEffect(() => {
    if (!threadId || !live) return;
    let cancelled = false;
    async function tick() {
      try {
        const status = await devServerStatus(threadId!);
        if (cancelled) return;
        setState(status && typeof status === "object" ? status : { running: false });
      } catch {
        // keep last known state; next tick retries
      }
    }
    const id = window.setInterval(() => void tick(), DEV_SERVER_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [threadId, live, devServerStatus]);

  useEffect(() => {
    if (!state.running || !state.startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state.running, state.startedAt]);

  const lastLine =
    state.lastLines && state.lastLines.length > 0
      ? state.lastLines[state.lastLines.length - 1]
      : null;
  const failLine =
    errorLine || (!state.running && !starting && lastLine ? lastLine : null);

  async function onStart() {
    if (!threadId || !script || starting || state.running) return;
    setStarting(true);
    setErrorLine(null);
    try {
      const next = await startDevServer(threadId, script);
      setState(next && typeof next === "object" ? next : { running: false });
      if (next && !next.running) {
        const lines = next.lastLines;
        const tail = lines && lines.length ? lines[lines.length - 1] : null;
        if (tail) setErrorLine(tail);
      }
    } catch (err) {
      setErrorLine(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  async function onStop() {
    if (!threadId || stopping || (!state.running && !starting)) return;
    setStopping(true);
    setErrorLine(null);
    try {
      const next = await stopDevServer(threadId);
      setState(next && typeof next === "object" ? next : { running: false });
    } catch (err) {
      setErrorLine(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }

  const statusText =
    state.running && state.startedAt
      ? formatDevRuntime(state.startedAt, now)
      : starting
        ? "starting"
        : "stopped";

  return (
    <section className={styles.gitCard} data-dev-server="">
      <div className={styles.gitCardLabel}>
        <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
          <rect x="2" y="3" width="12" height="10" rx="2" />
          <path d="m5.5 7 2 2-2 2M9 11h2" />
        </svg>
        Dev server
      </div>
      {!threadId ? (
        <p className={styles.gitHint}>Select a thread to run its dev server.</p>
      ) : scripts.length === 0 ? (
        <p className={styles.gitHint} data-dev-server-empty="">
          No dev, start, or serve script in package.json
        </p>
      ) : (
        <>
          <div className={styles.gitActions}>
            {scripts.length > 1 && (
              <select
                className={styles.devScriptSelect}
                value={script}
                disabled={state.running || starting || stopping}
                aria-label="Dev script"
                data-dev-server-script=""
                onChange={(e) => setScript(e.target.value)}
              >
                {scripts.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            {state.running || starting ? (
              <button
                type="button"
                className={styles.gitBtn}
                data-dev-server-stop=""
                disabled={stopping}
                onClick={() => void onStop()}
              >
                {stopping ? (
                  <>
                    <span className={styles.btnSpinner} aria-hidden />
                    Stopping…
                  </>
                ) : (
                  "Stop"
                )}
              </button>
            ) : (
              <button
                type="button"
                className={`${styles.gitBtn} ${styles.gitBtnPrimary}`}
                data-dev-server-start=""
                disabled={!script || starting}
                onClick={() => void onStart()}
              >
                {starting ? (
                  <>
                    <span className={styles.btnSpinner} aria-hidden />
                    Starting…
                  </>
                ) : (
                  "Start"
                )}
              </button>
            )}
          </div>
          <p className={styles.gitHint} data-dev-server-state="">
            {statusText}
          </p>
          {state.url && (
            <a
              className={styles.devServerUrl}
              href={state.url}
              target="_blank"
              rel="noreferrer"
              data-dev-server-url=""
            >
              {state.url}
            </a>
          )}
        </>
      )}
      {failLine && (
        <p className={styles.devServerError} data-dev-server-error="" role="alert">
          {failLine}
        </p>
      )}
    </section>
  );
}

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
        <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
          <rect x="3" y="3" width="10" height="4" rx="1" />
          <rect x="3" y="9" width="10" height="4" rx="1" />
          <path d="M5.5 5h.01M5.5 11h.01" />
        </svg>
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

/**
 * Repository row: the thread root's git origin as owner/repo with an
 * external link to the host. Hidden when there is no origin (or no thread).
 */
function RepositoryCard({
  threadId,
  gitRepoInfo,
}: {
  threadId: string | null;
  gitRepoInfo?: (threadId: string) => Promise<GitRepoInfo>;
}) {
  const [info, setInfo] = useState<GitRepoInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!threadId || !gitRepoInfo) {
      setInfo(null);
      return;
    }
    gitRepoInfo(threadId)
      .then((res) => {
        if (!cancelled) setInfo(res && typeof res === "object" ? res : null);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, gitRepoInfo]);

  if (!info || !info.ok) return null;

  return (
    <section className={styles.gitCard} data-repo-card="">
      <div className={styles.gitCardLabel}>
        <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
          <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3H13v10H4.5A1.5 1.5 0 0 0 3 14.5v-10Z" />
          <path d="M3 14.5A1.5 1.5 0 0 1 4.5 13H13" />
        </svg>
        Repository
      </div>
      <a
        className={styles.repoLink}
        href={info.webUrl}
        target="_blank"
        rel="noreferrer"
        title={info.webUrl}
        data-repo-link=""
      >
        <span className={styles.repoSlug}>
          {info.owner}/{info.repo}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={styles.repoExternal}
        >
          <path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5" />
          <path d="M9.5 2.5h4v4" />
          <path d="M13.5 2.5 8 8" />
        </svg>
      </a>
    </section>
  );
}

/**
 * Pull action: `git pull --ff-only` in the thread root, result inline.
 * Failures (dirty tree, no upstream, diverged) arrive in-band, never thrown.
 */
function PullCard({
  threadId,
  gitPull,
}: {
  threadId: string | null;
  gitPull?: (threadId: string) => Promise<GitPullResult>;
}) {
  const [pulling, setPulling] = useState(false);
  const [result, setResult] = useState<GitPullResult | null>(null);

  useEffect(() => {
    setPulling(false);
    setResult(null);
  }, [threadId]);

  if (!gitPull) return null;

  const onPull = async () => {
    if (!threadId || pulling) return;
    setPulling(true);
    setResult(null);
    try {
      setResult(await gitPull(threadId));
    } catch (err) {
      setResult({
        ok: false,
        reason:
          err instanceof Error && err.message ? err.message : "Pull failed",
      });
    } finally {
      setPulling(false);
    }
  };

  return (
    <section className={styles.gitCard} data-pull-card="">
      <div className={styles.gitCardLabel}>
        <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
          <path d="M8 2.5V10" />
          <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
          <path d="M3 13.5h10" />
        </svg>
        Pull
      </div>
      {!threadId ? (
        <p className={styles.gitHint}>Select a thread to pull its branch.</p>
      ) : (
        <>
          <div className={styles.gitActions}>
            <button
              type="button"
              className={styles.gitBtn}
              data-pull-btn=""
              onClick={() => void onPull()}
              disabled={pulling}
              title="Pull from upstream (fast-forward only)"
            >
              {pulling ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Pulling…
                </>
              ) : (
                "Pull"
              )}
            </button>
          </div>
          {result && (
            <p
              className={result.ok ? styles.pullResult : styles.pullError}
              data-pull-result=""
              role={result.ok ? undefined : "alert"}
            >
              {result.ok ? result.summary : result.reason}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Recap: where the thread stands at a glance, derived without any LLM call.
 * The activity line is the first line of the last assistant message (from
 * threads:summaries); the facts line is branch, PR, and thread status.
 * Refreshes when the selected thread changes or its status changes.
 */
function RecapCard({
  thread,
  listThreadSummaries,
}: {
  thread: ThreadInfo | null;
  listThreadSummaries?: () => Promise<ThreadSummaryInfo[]>;
}) {
  const threadId = thread?.id ?? null;
  const threadStatus = thread?.status ?? null;
  const [activity, setActivity] = useState<{ text: string; at: number } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    if (!threadId || !listThreadSummaries) {
      setActivity(null);
      return;
    }
    listThreadSummaries()
      .then((list) => {
        if (cancelled) return;
        const entry = Array.isArray(list)
          ? list.find((s) => s && s.id === threadId)
          : undefined;
        setActivity(entry?.lastActivity ?? null);
      })
      .catch(() => {
        if (!cancelled) setActivity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, threadStatus, listThreadSummaries]);

  if (!thread) return null;

  const facts: string[] = [];
  if (thread.branch) facts.push(thread.branch);
  if (thread.prNumber != null) {
    facts.push(
      thread.prState
        ? `#${thread.prNumber} ${thread.prState.toLowerCase()}`
        : `#${thread.prNumber}`,
    );
  }
  facts.push(thread.status);

  return (
    <section className={styles.gitCard} data-recap-card="">
      <div className={styles.gitCardLabel}>
        <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5.5V8l2 1.5" />
        </svg>
        Recap
      </div>
      <p className={styles.recapActivity} data-recap-activity="">
        {activity?.text ?? "No activity yet"}
      </p>
      <div className={styles.recapFacts} data-recap-facts="">
        {facts.join(" · ")}
      </div>
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
      <div className={styles.gitCardLabel}>
        <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
          <path d="M4.5 2.5h7a.5.5 0 0 1 .5.5v10l-4-2.6L4 13V3a.5.5 0 0 1 .5-.5Z" />
        </svg>
        Checkpoints
      </div>
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

export function GitTab({
  thread,
  project,
  onSetupWorktree,
  onMergeWorktree,
  onRemoveWorktree,
  onViewChanges,
  listCheckpoints,
  restoreCheckpoint,
  listLocalServers,
  revealInFinder,
  openInEditor,
  gitSyncInfo,
  gitFetch,
  gitRepoInfo,
  gitPull,
  listThreadSummaries,
  listDevScripts,
  startDevServer,
  stopDevServer,
  devServerStatus,
}: {
  thread: ThreadInfo | null;
  project: ProjectInfo | null;
  onSetupWorktree: () => Promise<unknown>;
  onMergeWorktree: () => Promise<unknown>;
  onRemoveWorktree: (force?: boolean) => Promise<unknown>;
  onViewChanges: () => void;
  listCheckpoints: (threadId: string) => Promise<CheckpointInfo[]>;
  restoreCheckpoint: (threadId: string, sha: string) => Promise<void>;
  listLocalServers: (threadId: string) => Promise<LocalServerInfo[]>;
  revealInFinder?: () => Promise<void>;
  openInEditor?: () => Promise<void>;
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  gitFetch?: (threadId: string) => Promise<void>;
  gitRepoInfo?: (threadId: string) => Promise<GitRepoInfo>;
  gitPull?: (threadId: string) => Promise<GitPullResult>;
  /** threads:summaries passthrough powering the Recap card. */
  listThreadSummaries?: () => Promise<ThreadSummaryInfo[]>;
  listDevScripts: (threadId: string) => Promise<string[]>;
  startDevServer: (threadId: string, script: string) => Promise<DevServerState>;
  stopDevServer: (threadId: string) => Promise<DevServerState>;
  devServerStatus: (threadId: string) => Promise<DevServerState>;
}) {
  const [gitAction, setGitAction] = useState<GitAction>(null);
  const [dirtyMessage, setDirtyMessage] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(false);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<CheckpointInfo | null>(
    null,
  );
  const [restorePending, setRestorePending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [sync, setSync] = useState<GitSyncInfo | null>(null);
  const [syncing, setSyncing] = useState(false);

  const isWorking = thread?.status === "working";
  const busy = isWorking || gitAction != null;

  // Clear per-thread state when the selected thread changes so a stale
  // error from row A never shows on row B.
  useEffect(() => {
    setDirtyMessage(null);
    setCardError(null);
    setGitAction(null);
    setCheckpoints([]);
    setCheckpointError(null);
    setRestoreConfirm(null);
    setRestorePending(false);
    setSync(null);
    setSyncing(false);
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

  const refreshSync = useCallback(async () => {
    if (!thread?.id || !gitSyncInfo) {
      setSync(null);
      return;
    }
    try {
      const info = await gitSyncInfo(thread.id);
      setSync(info);
    } catch {
      setSync({ hasUpstream: false });
    }
  }, [thread?.id, gitSyncInfo]);

  useEffect(() => {
    void refreshSync();
  }, [refreshSync, thread?.status]);

  const handleSync = async () => {
    if (!thread || !gitFetch || syncing) return;
    setSyncing(true);
    try {
      await gitFetch(thread.id);
      await refreshSync();
    } catch {
      // Keep last badge; fetch errors stay quiet in the footer.
    } finally {
      setSyncing(false);
    }
  };

  const runAction = async (
    action: Exclude<GitAction, null>,
    fn: () => Promise<unknown>,
  ) => {
    setGitAction(action);
    setCardError(null);
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

  const syncLabelText = sync ? syncLabel(sync) : null;

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
        <RepositoryCard threadId={thread?.id ?? null} gitRepoInfo={gitRepoInfo} />
        <ChangesCard
          hasThread={Boolean(thread)}
          onViewChanges={onViewChanges}
        />
        {project?.remoteHost ? (
          <section className={styles.gitCard} data-remote-unavailable="">
            <div className={styles.gitCardLabel}>
              <svg {...LABEL_ICON_PROPS} className={styles.labelIcon}>
                <path d="M5 12.5h6a3 3 0 0 0 .6-5.9A4.2 4.2 0 0 0 3.6 8 2.6 2.6 0 0 0 5 12.5Z" />
              </svg>
              Remote
            </div>
            <p className={styles.gitHint}>Not available on remote projects</p>
          </section>
        ) : (
          <>
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
        <PullCard threadId={thread?.id ?? null} gitPull={gitPull} />
        <DevServerCard
          threadId={thread?.id ?? null}
          listDevScripts={listDevScripts}
          startDevServer={startDevServer}
          stopDevServer={stopDevServer}
          devServerStatus={devServerStatus}
        />
        <LocalServersCard
          threadId={thread?.id ?? null}
          listLocalServers={listLocalServers}
        />
        <EditorCard
          hasThread={Boolean(thread)}
          onReveal={() => {
            if (!thread) return;
            void revealInFinder?.();
          }}
          onOpen={() => {
            if (!thread) return;
            void openInEditor?.();
          }}
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
          </>
        )}
        <RecapCard thread={thread} listThreadSummaries={listThreadSummaries} />
      </div>
      <footer className={styles.gitStatus} data-git-status="">
        <span className={styles.gitStatusLine} title={statusLine}>
          {statusLine}
        </span>
        {syncLabelText && (
          <span className={styles.syncBadge} data-sync-badge="">
            {syncLabelText}
          </span>
        )}
        {thread && gitFetch && (
          <button
            type="button"
            className={styles.syncBtn}
            data-sync-btn=""
            onClick={() => void handleSync()}
            disabled={syncing}
            title="Fetch from remote"
          >
            {syncing ? "Syncing…" : "Sync"}
          </button>
        )}
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

/** One team row: role chip, provider, title, status badge, last activity. */
function TeamRow({
  summary,
  role,
  providers,
  onSelect,
}: {
  summary: ThreadSummaryInfo;
  role: string;
  providers: ProviderInfo[];
  onSelect?: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={styles.teamRow}
        onClick={() => onSelect?.(summary.id)}
        title={summary.title}
      >
        <span className={styles.roleChip}>{role}</span>
        <span className={styles.teamProvider}>
          {providerDisplayName(summary.provider, providers)}
        </span>
        <span className={styles.teamTitle}>{summary.title}</span>
        <span className={styles.teamStatus} data-status={summary.status}>
          {summary.status}
        </span>
        {summary.lastActivity && (
          <span className={styles.teamActivity}>
            {summary.lastActivity.text}
          </span>
        )}
      </button>
    </li>
  );
}

export function AgentsContent({
  workflow,
  thread,
  usage,
  providers,
  threads,
  listThreadSummaries,
  onSelectThread,
}: {
  workflow: WorkflowView | null;
  thread: ThreadInfo | null;
  usage: SessionUsage | null;
  providers: ProviderInfo[];
  threads?: ThreadInfo[];
  listThreadSummaries?: () => Promise<ThreadSummaryInfo[]>;
  onSelectThread?: (id: string) => void;
}) {
  /**
   * Manual expand/collapse overrides. Absent key = not toggled by user,
   * so active phases auto-expand and others stay collapsed.
   */
  const [manual, setManual] = useState<Record<string, boolean>>({});

  const [summaries, setSummaries] = useState<ThreadSummaryInfo[] | null>(null);

  useEffect(() => {
    setManual({});
  }, [workflow?.id]);

  // Team view data. Refetches when the thread list changes (a worker's
  // status or lastActivity moves with it); null when no fetcher is wired.
  useEffect(() => {
    if (!listThreadSummaries) {
      setSummaries(null);
      return;
    }
    let cancelled = false;
    listThreadSummaries()
      .then((list) => {
        if (!cancelled) setSummaries(list);
      })
      .catch(() => {
        if (!cancelled) setSummaries(null);
      });
    return () => {
      cancelled = true;
    };
  }, [listThreadSummaries, threads]);

  // Roles derive from handoffFrom: a thread WITH one is a Worker; a thread
  // another summary points to is an Orchestrator. Neither = plain session.
  const team = useMemo(() => {
    if (!thread || !summaries) return null;
    const workers = summaries.filter((s) => s.handoffFrom === thread.id);
    if (workers.length > 0) {
      return { kind: "orchestrator" as const, workers };
    }
    const orchestrator = thread.handoffFrom
      ? summaries.find((s) => s.id === thread.handoffFrom)
      : undefined;
    if (orchestrator) {
      return { kind: "worker" as const, orchestrator };
    }
    return null;
  }, [thread, summaries]);

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
    if (!thread) {
      return (
        <div className={styles.scroll}>
          <p className={styles.placeholder}>No active session</p>
        </div>
      );
    }
    if (team?.kind === "orchestrator") {
      return (
        <div className={styles.scroll}>
          <SessionCard
            thread={thread}
            usage={usage}
            providers={providers}
            role="Orchestrator"
          />
          <section className={styles.teamSection} aria-label="Team">
            <div className={styles.sessionLabel}>Team</div>
            <ul className={styles.teamList}>
              {team.workers.map((w) => (
                <TeamRow
                  key={w.id}
                  summary={w}
                  role="Worker"
                  providers={providers}
                  onSelect={onSelectThread}
                />
              ))}
            </ul>
          </section>
        </div>
      );
    }
    if (team?.kind === "worker") {
      return (
        <div className={styles.scroll}>
          <SessionCard
            thread={thread}
            usage={usage}
            providers={providers}
            role="Worker"
          />
          <section className={styles.teamSection} aria-label="Team">
            <div className={styles.sessionLabel}>Team</div>
            <ul className={styles.teamList}>
              <TeamRow
                summary={team.orchestrator}
                role="Orchestrator"
                providers={providers}
                onSelect={onSelectThread}
              />
            </ul>
          </section>
        </div>
      );
    }
    return (
      <div className={styles.scroll}>
        <SessionCard thread={thread} usage={usage} providers={providers} />
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
  threads,
  listThreadSummaries,
  onSelectThread,
  onSetupWorktree,
  onMergeWorktree,
  onRemoveWorktree,
  onViewChanges,
  listCheckpoints,
  restoreCheckpoint,
  listLocalServers,
  revealInFinder,
  openInEditor,
  gitSyncInfo,
  gitFetch,
  gitRepoInfo,
  gitPull,
  listDevScripts,
  startDevServer,
  stopDevServer,
  devServerStatus,
  searchMemory,
  recentMemory,
  getMemory,
  updateMemory,
  removeMemory,
  storeMemory,
  settings,
  saveSettings,
  listSkills,
  addSkill,
  removeSkill,
}: AgentsPanelProps) {
  const [tab, setTab] = useState<PanelTab>("git");

  return (
    <aside className={styles.panel}>
      <header className={styles.tabs}>
        <button
          type="button"
          className={styles.tab}
          data-active={tab === "git"}
          onClick={() => setTab("git")}
        >
          Environment
        </button>
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
          data-active={tab === "memory"}
          onClick={() => setTab("memory")}
        >
          Memory
        </button>
        <button
          type="button"
          className={styles.tab}
          data-active={tab === "skills"}
          onClick={() => setTab("skills")}
        >
          Skills
        </button>
      </header>

      {tab === "agents" ? (
        <AgentsContent
          workflow={workflow}
          thread={thread}
          usage={usage}
          providers={providers}
          threads={threads}
          listThreadSummaries={listThreadSummaries}
          onSelectThread={onSelectThread}
        />
      ) : tab === "git" ? (
        <GitTab
          thread={thread}
          project={project}
          onSetupWorktree={onSetupWorktree}
          onMergeWorktree={onMergeWorktree}
          onRemoveWorktree={onRemoveWorktree}
          onViewChanges={onViewChanges}
          listCheckpoints={listCheckpoints}
          restoreCheckpoint={restoreCheckpoint}
          listLocalServers={listLocalServers}
          revealInFinder={revealInFinder}
          openInEditor={openInEditor}
          gitSyncInfo={gitSyncInfo}
          gitFetch={gitFetch}
          gitRepoInfo={gitRepoInfo}
          gitPull={gitPull}
          listThreadSummaries={listThreadSummaries}
          listDevScripts={listDevScripts}
          startDevServer={startDevServer}
          stopDevServer={stopDevServer}
          devServerStatus={devServerStatus}
        />
      ) : tab === "memory" ? (
        <MemoryTab
          projectSlug={project?.slug ?? null}
          searchMemory={searchMemory}
          recentMemory={recentMemory}
          getMemory={getMemory}
          updateMemory={updateMemory}
          removeMemory={removeMemory}
          storeMemory={storeMemory}
        />
      ) : (
        <SkillsTab
          projectPath={project?.path ?? null}
          settings={settings}
          saveSettings={saveSettings}
          listSkills={listSkills}
          addSkill={addSkill}
          removeSkill={removeSkill}
        />
      )}
    </aside>
  );
}
