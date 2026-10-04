import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type {
  AgentStatus,
  CheckpointInfo,
  DiffResult,
  GitSyncInfo,
  GitRepoInfo,
  GitPullResult,
  DevServerState,
  Hypothesis,
  LocalServerInfo,
  MergeLaneClaim,
  MergeLaneInfo,
  MergeLanePreview,
  MergeLaneRecycle,
  MergeLaneRestore,
  MemoryEntryInfo,
  MemoryMaintenanceReport,
  MemoryReviewResolution,
  PhaseView,
  ProjectInfo,
  ProviderInfo,
  SessionUsage,
  SkillInfo,
  ThreadInfo,
  ThreadSummariesInput,
  ThreadSummaryInfo,
  CrewTaskView,
  CrewIntegration as CrewIntegrationView,
  VerifyResult,
  WorkflowView,
} from "../shared/ipc";
import {
  formatCostUsd,
  formatRelativeAge,
  formatTokenSum,
  providerDisplayName,
  shortSessionId,
} from "../format";
import { buildWaitStates, waitLabel, type WaitState } from "../waiting";
import {
  isDirectCrewChild,
  isOrchWorker,
  sameCrewProject,
} from "../crewIntegration";
import { CrewIntegration } from "./CrewIntegration";
import { MemoryTab } from "./MemoryTab";
import { SkillsTab } from "./SkillsTab";
import { InspectorSection } from "./InspectorSection";
import inspector from "./Inspector.module.css";
import type { SettingsPane } from "./SettingsModal";
import {
  formatPostMergeLine,
  formatVerifySummary,
  verifyLogStartsCollapsed,
  verifyNowDisabled,
} from "../verifyCard";
import {
  formatHypothesisAge,
  formatHypothesisSummary,
  groupHypotheses,
} from "../hypothesisLedger";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import styles from "./AgentsPanel.module.css";

export type PanelTab = "agents" | "git" | "memory" | "skills";

const INSPECTOR_TABS: readonly { id: PanelTab; label: string }[] = [
  { id: "git", label: "Environment" },
  { id: "agents", label: "Agents" },
  { id: "memory", label: "Memory" },
  { id: "skills", label: "Skills" },
];

/** Session key for a manual inspector choice. Thread keys include the project so two projects never share a selection. Other destinations key the route the same way. */
export function inspectorContextKey(input: {
  view: string;
  projectId?: string | null;
  threadId?: string | null;
}): string {
  const projectId = input.projectId ?? "";
  if (input.view === "thread" && input.threadId) {
    return `thread:${projectId}:${input.threadId}`;
  }
  if (input.view !== "thread") return `route:${projectId}:${input.view}`;
  return `project:${projectId}`;
}

type InspectorThreadSignal = {
  id: string;
  orchWorker?: boolean;
  handoffFrom?: string | null;
  projectId?: string;
};

/**
 * Default tab when this context has no manual choice.
 * Crew/workflow → Agents. Ordinary threads, manual forks, and Review → Environment.
 * Operational destinations (Usage, Automations…) → Environment; their one
 * home is the sidebar's Insights menu (#1411). A null summary (detail still loading, or no thread) stays Environment and does not look at any other thread.
 */
export function defaultInspectorTab(input: {
  view: string;
  summary: InspectorThreadSignal | null;
  threads: readonly InspectorThreadSignal[];
  workflow: unknown | null;
}): PanelTab {
  if (input.view !== "thread") return "git";
  if (input.workflow) return "agents";
  const summary = input.summary;
  if (!summary) return "git";
  if (input.threads.some((row) => isDirectCrewChild(row, summary))) {
    return "agents";
  }
  if (
    isOrchWorker(summary) &&
    summary.handoffFrom &&
    input.threads.some(
      (row) => row.id === summary.handoffFrom && sameCrewProject(row, summary),
    )
  ) {
    return "agents";
  }
  return "git";
}

interface AgentsPanelProps {
  workflow: WorkflowView | null;
  thread: ThreadInfo | null;
  usage: SessionUsage | null;
  providers: ProviderInfo[];
  project: ProjectInfo | null;
  /**
   * "id:status,…" over the threads in the selected project (see App).
   * Changing it refetches summaries for the Agents tab team view, which are
   * fetched scoped to that project (#1398); a string rather than the array
   * because the array's identity churns on every stream tick (issue #91).
   */
  rosterKey?: string;
  /** threads:summaries passthrough powering the team view. */
  listThreadSummaries?: (input?: ThreadSummariesInput) => Promise<ThreadSummaryInfo[]>;
  /** Shared crew task list (issue #277). Read-only; absent = no fetch. */
  listCrewTasks?: (
    threadId: string,
  ) => Promise<{ rootThreadId: string; tasks: CrewTaskView[] }>;
  /** Lead Integration view (#954 / #982). Absent = hide the section. */
  crewIntegration?: (threadId: string) => Promise<CrewIntegrationView>;
  /** Squash a worker onto the lead worktree. */
  onIntegrateWorker?: (workerThreadId: string) => Promise<void>;
  /** Retarget an idle worker onto the lead's current committed HEAD. */
  onRefreshWorker?: (workerThreadId: string) => Promise<void>;
  /** Combined-result verify on the lead. */
  onVerifyLead?: () => Promise<void>;
  /** Final Open PR / Merge into target. Separate from worker integrate. */
  onLandLead?: () => Promise<void>;
  /** Select a thread (team row click). */
  onSelectThread?: (id: string) => void;
  /** Re-spawn a failed workflow phase agent (#825). */
  onRetryAgent?: (agentId: string) => void;
  /** Opens the Git pane (fresh load). */
  onViewChanges: () => void;
  /** Selected thread's working diff, for the Environment "N changed files ›" link. */
  fetchDiff?: () => Promise<DiffResult>;
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
  setVerifyCommand: (threadId: string, command: string | null) => Promise<void>;
  runVerify: (threadId: string) => Promise<VerifyResult>;
  searchMemory: (input: {
    query: string;
    project?: string;
    type?: MemoryEntryInfo["type"];
  }) => Promise<MemoryEntryInfo[]>;
  recentMemory: (input?: {
    limit?: number;
    offset?: number;
    project?: string;
    type?: MemoryEntryInfo["type"];
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
  maintenanceMemory?: (input?: {
    project?: string;
    summary?: boolean;
  }) => Promise<MemoryMaintenanceReport>;
  resolveMemory?: (input: {
    id: number;
    resolution: MemoryReviewResolution;
  }) => Promise<{ ok: boolean; id: number; resolution: string }>;
  listSkills: (input?: { projectPath?: string }) => Promise<SkillInfo[]>;
  removeSkill: (input: { name: string }) => Promise<void>;
  syncSkills: () => Promise<{ copied: number; skills: string[] }>;
  /** App-owned inspector tab. The panel unmounts when the desktop rail collapses. */
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  /** Merge-queue lanes (#346). Absent hides the Environment Lanes card. */
  claimLane?: (input: { threadId: string }) => Promise<MergeLaneClaim>;
  listLanes?: (input: { projectId: string }) => Promise<MergeLaneInfo[]>;
  previewLane?: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
  restorePreview?: (input: { projectId: string }) => Promise<MergeLaneRestore>;
  recycleWedgedLanes?: (input: {
    projectId: string;
  }) => Promise<MergeLaneRecycle[]>;
  spotlightLane?: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
  /** Wide-window Hide control. Absent on the narrow drawer (issue #645). */
  onCollapse?: () => void;
  /** Opens Settings at a pane (Skills → Manage ›, Memory → Project tools). */
  onOpenSettings?: (pane?: SettingsPane) => void;
  /** Bumped when Settings closes, so the Skills tab reloads behind it. */
  skillsRefreshKey?: number;
}

type PhaseChipStatus = "done" | "active" | "pending" | "failed";
type DotStatus = "active" | "done" | "pending" | "error";

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

/**
 * One session line: provider · status · turns · cost, and a muted token
 * line. Model and Permission live in the composer; context in the header ring.
 */
function SessionLine({
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
  const usageUnreported =
    usage != null &&
    usage.turns > 0 &&
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.costUsd === 0 &&
    !(Number(usage.contextTokens) > 0);
  const costUnmetered =
    usage != null &&
    usage.costUsd === 0 &&
    (usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      Number(usage.contextTokens) > 0);
  const parts = [providerDisplayName(thread.provider, providers), thread.status];
  if (usageUnreported) parts.push("usage not reported");
  else if (usage) {
    parts.push(
      `${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`,
      costUnmetered ? "unmetered" : formatCostUsd(usage.costUsd),
    );
  } else parts.push("No usage yet");
  const shortId = shortSessionId(thread.sessionId);
  const tokenLine =
    usage && !usageUnreported
      ? `${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out tokens`
      : null;
  return (
    <section className={inspector.section} aria-label="Session">
      <p className={inspector.line} data-session-line="">
        {role ? <span className={styles.roleChip}>{role}</span> : null}
        {parts.join(" · ")}
      </p>
      {tokenLine || shortId ? (
        <p
          className={`${inspector.line} ${inspector.muted}`}
          data-session-tokens=""
          title={thread.sessionId ?? undefined}
        >
          {[tokenLine, shortId].filter(Boolean).join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

/** Finder + editor icon links for the selected thread (status header row). */
export function EditorCard({
  onReveal,
  onOpen,
}: {
  onReveal: () => void;
  onOpen: () => void;
}) {
  return (
    <span className={inspector.row} data-editor="">
      <button
        type="button"
        className={inspector.iconBtn}
        data-editor-reveal=""
        aria-label="Open in Finder"
        title="Open in Finder"
        onClick={onReveal}
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
          <path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.5l1.5 1.5h4A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5v-7Z" />
        </svg>
      </button>
      <button
        type="button"
        className={inspector.iconBtn}
        data-editor-open=""
        aria-label="Open in Editor"
        title="Open in Editor"
        onClick={onOpen}
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
          <path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3" />
        </svg>
      </button>
    </span>
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

// Main-side listLocalServers runs a full-system lsof + HTTP probes; the
// main-process cache TTL is 30s, so polling faster than this only hits cache.
const SERVER_POLL_MS = 15_000;
const DEV_SERVER_POLL_MS = 3_000;
/** Team-view lastActivity refresh while any thread is working. */
const SUMMARY_POLL_MS = 5_000;

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
    <div className={inspector.block} data-dev-server="">
      <div className={inspector.subhead}>Dev server</div>
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
    </div>
  );
}

export function VerifyCard({
  thread,
  setVerifyCommand,
  runVerify,
}: {
  thread: ThreadInfo | null;
  setVerifyCommand: (threadId: string, command: string | null) => Promise<void>;
  runVerify: (threadId: string) => Promise<VerifyResult>;
}) {
  const saved = thread?.verifyCommand ?? "";
  const [draft, setDraft] = useState(saved);
  const [verifying, setVerifying] = useState(false);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    setDraft(thread?.verifyCommand ?? "");
    setErrorLine(null);
    setVerifying(false);
    const next = thread?.verify ?? null;
    setLogOpen(next ? !verifyLogStartsCollapsed(next) : false);
  }, [thread?.id]);

  useEffect(() => {
    setDraft(thread?.verifyCommand ?? "");
  }, [thread?.verifyCommand]);

  const evidence = thread?.verify ?? null;
  const evidenceKey = evidence ? `${evidence.at}-${evidence.attempt}` : "";
  const postMerge = thread?.postMergeVerify ?? null;
  const postMergeLine = formatPostMergeLine(postMerge, now);
  useEffect(() => {
    if (!evidence) return;
    setLogOpen(!verifyLogStartsCollapsed(evidence));
  }, [evidenceKey]);

  useEffect(() => {
    if (!evidence && postMerge?.status !== "scheduled") return;
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [evidenceKey, postMerge?.status]);

  const runActive = thread?.status === "working";
  const disabled = verifyNowDisabled({
    command: draft,
    runActive,
    verifying,
  });

  async function save(next: string) {
    if (!thread) return;
    const trimmed = next.trim();
    const current = thread.verifyCommand ?? "";
    if (trimmed === current) return;
    try {
      await setVerifyCommand(thread.id, trimmed || null);
      setErrorLine(null);
    } catch (err) {
      setErrorLine(err instanceof Error ? err.message : String(err));
    }
  }

  async function onVerify() {
    if (!thread || disabled) return;
    setVerifying(true);
    setErrorLine(null);
    try {
      const trimmed = draft.trim();
      if (trimmed !== (thread.verifyCommand ?? "")) {
        await setVerifyCommand(thread.id, trimmed || null);
      }
      await runVerify(thread.id);
    } catch (err) {
      setErrorLine(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className={inspector.block} data-verify-card="">
      <div className={inspector.subhead}>Verification</div>
      {!thread ? (
        <p className={styles.gitHint}>Select a thread to set a verify command.</p>
      ) : (
        <>
          <div className={styles.gitActions}>
            <input
              className={styles.verifyInput}
              type="text"
              value={draft}
              placeholder="npm test"
              spellCheck={false}
              autoComplete="off"
              aria-label="Verify command"
              data-verify-command=""
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void save(draft)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                void save(draft);
                (e.target as HTMLInputElement).blur();
              }}
            />
            <button
              type="button"
              className={`${styles.gitBtn} ${styles.gitBtnPrimary}`}
              data-verify-now=""
              disabled={disabled}
              onClick={() => void onVerify()}
            >
              {verifying ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Verifying…
                </>
              ) : (
                "Verify now"
              )}
            </button>
          </div>
          {!saved && (
            <p className={styles.gitHint} data-verify-unarmed="">
              Runs settle on the agent&apos;s word alone.
            </p>
          )}
          {postMergeLine && (
            <p
              className={styles.verifySummary}
              data-post-merge=""
              data-ok={
                postMerge?.status === "passed"
                  ? "true"
                  : postMerge?.status === "failed"
                    ? "false"
                    : undefined
              }
            >
              {postMergeLine}
            </p>
          )}
          {evidence && (
            <div className={styles.verifyEvidence} data-verify-evidence="">
              <p
                className={styles.verifySummary}
                data-ok={evidence.ok ? "true" : "false"}
              >
                {formatVerifySummary(evidence, now)}
              </p>
              {evidence.log ? (
                <details
                  className={styles.verifyLogWrap}
                  data-verify-log=""
                  open={logOpen}
                  onToggle={(e) =>
                    setLogOpen((e.target as HTMLDetailsElement).open)
                  }
                >
                  <summary>Log</summary>
                  <pre className={styles.verifyLog}>{evidence.log}</pre>
                </details>
              ) : null}
            </div>
          )}
        </>
      )}
      {errorLine && (
        <p className={styles.devServerError} data-verify-error="" role="alert">
          {errorLine}
        </p>
      )}
    </div>
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
      // A hidden window can't show the card; skip the lsof scan in main.
      if (document.hidden) return;
      if (!threadId) {
        if (!cancelled) setServers((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      try {
        const list = await listLocalServers(threadId);
        const next = Array.isArray(list) ? list : [];
        if (!cancelled) {
          // Bail on identical lists: a fresh array identity every poll would
          // re-render the card even when nothing changed.
          setServers((prev) =>
            prev.length === next.length &&
            prev.every(
              (s, i) =>
                s.pid === next[i].pid &&
                s.port === next[i].port &&
                s.url === next[i].url &&
                s.command === next[i].command,
            )
              ? prev
              : next,
          );
        }
      } catch {
        if (!cancelled) setServers((prev) => (prev.length === 0 ? prev : []));
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
    <div className={inspector.block} data-local-servers="">
      <div className={inspector.subhead}>
        Local servers
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
    </div>
  );
}

/**
 * Per-project source-control notice (issue #521): one inline line, only for
 * Jujutsu (unsupported). Plain git is the assumed default and renders nothing.
 */
function ScmNotice({ project }: { project: ProjectInfo | null }) {
  const scm = project?.scm;
  if (!scm || scm.kind !== "jj") return null;
  return (
    <p className={inspector.line} data-scm-card="" title={scm.detail}>
      <span className={styles.scmBadge} data-scm-badge={scm.support}>
        jj · unsupported
      </span>
      {scm.detail ? <span data-scm-detail=""> {scm.detail}</span> : null}
    </p>
  );
}

/**
 * Repository link: the thread root's git origin as owner/repo, linking to
 * the host. Renders nothing without an origin. No other surface shows it.
 */
function RepositoryLink({
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
    <a
      className={styles.repoLink}
      href={info.webUrl}
      target="_blank"
      rel="noreferrer"
      title={info.webUrl}
      data-repo-card=""
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
    <InspectorSection
      title="Checkpoints"
      count={checkpoints.length}
      collapsible
      defaultOpen={false}
      data-checkpoints=""
    >
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
    </InspectorSection>
  );
}

function laneFromClaim(
  threadId: string,
  claimed: MergeLaneClaim,
): MergeLaneInfo {
  return {
    n: claimed.n,
    threadId,
    port: claimed.port,
    path: claimed.path,
    branch: claimed.branch,
    claimedAt: Date.now(),
    lastBeat: Date.now(),
  };
}

export function MergeQueueCard({
  threadId,
  projectId,
  claimLane,
  listLanes,
  previewLane,
  restorePreview,
  recycleWedgedLanes,
  spotlight,
  spotlightLane,
}: {
  threadId: string | null;
  projectId: string | null;
  claimLane: (input: { threadId: string }) => Promise<MergeLaneClaim>;
  listLanes: (input: { projectId: string }) => Promise<MergeLaneInfo[]>;
  previewLane: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
  restorePreview: (input: { projectId: string }) => Promise<MergeLaneRestore>;
  recycleWedgedLanes: (input: {
    projectId: string;
  }) => Promise<MergeLaneRecycle[]>;
  spotlight?: boolean;
  spotlightLane?: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
}) {
  const [lanes, setLanes] = useState<MergeLaneInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setLanes([]);
      return;
    }
    try {
      setLanes(await listLanes({ projectId }));
      setError(null);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to load lanes";
      setError(msg);
    }
  }, [projectId, listLanes]);

  useEffect(() => {
    void refresh();
  }, [refresh, threadId]);

  if (!projectId) return null;

  const mine = threadId
    ? lanes.find((row) => row.threadId === threadId)
    : undefined;

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : "Lane action failed";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <InspectorSection
      title="Lanes"
      count={lanes.length}
      collapsible
      defaultOpen={lanes.length > 0}
      data-lanes=""
    >
      {lanes.length > 0 ? (
        <div className={styles.laneRow} data-lane-list="">
          {lanes.map((row) => (
            <span
              key={`${row.n}:${row.threadId}`}
              className={styles.laneChip}
              data-lane-chip={String(row.n)}
              data-lane-current={
                row.threadId === threadId ? "true" : undefined
              }
            >
              lane {row.n}
              <span className={styles.lanePort}>PORT {row.port}</span>
              {row.path ? (
                <span
                  className={styles.lanePath}
                  data-lane-path=""
                  title={row.path}
                >
                  {row.path}
                </span>
              ) : null}
              {row.branch ? (
                <span
                  className={styles.laneBranch}
                  data-lane-branch=""
                  title={row.branch}
                >
                  {row.branch}
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <p className={styles.gitHint} data-lanes-empty="">
          No claimed lanes
        </p>
      )}
      <div className={styles.gitActions}>
        {threadId && !mine ? (
          <button
            type="button"
            className={styles.gitBtn}
            data-lane-claim=""
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const claimed = await claimLane({ threadId });
                try {
                  const next = await listLanes({ projectId });
                  if (next.some((row) => row.n === claimed.n)) {
                    setLanes(next);
                    return;
                  }
                } catch {
                  // Keep the claim receipt when list is stale or empty.
                }
                setLanes((prev) => {
                  const rest = prev.filter(
                    (row) => row.threadId !== threadId && row.n !== claimed.n,
                  );
                  return [...rest, laneFromClaim(threadId, claimed)].sort(
                    (a, b) => a.n - b.n,
                  );
                });
              })
            }
          >
            Claim lane
          </button>
        ) : null}
        {lanes.map((row) => (
          <button
            key={`preview-${row.n}`}
            type="button"
            className={styles.gitBtn}
            data-lane-preview={String(row.n)}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (spotlight && spotlightLane) {
                  await spotlightLane({ projectId, lane: row.n });
                } else {
                  await previewLane({ projectId, lane: row.n });
                }
              })
            }
          >
            Preview {row.n}
          </button>
        ))}
        <button
          type="button"
          className={styles.gitBtn}
          data-lane-restore=""
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await restorePreview({ projectId });
            })
          }
        >
          Restore
        </button>
        {lanes.length > 0 ? (
          <button
            type="button"
            className={styles.gitBtn}
            data-lane-recycle=""
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await recycleWedgedLanes({ projectId });
                await refresh();
              })
            }
          >
            Recycle wedged
          </button>
        ) : null}
      </div>
      {error ? (
        <div className={styles.cardError} role="alert" data-lane-error="">
          <span className={styles.cardErrorText}>{error}</span>
          <button
            type="button"
            className={styles.cardErrorDismiss}
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            title="Dismiss error"
          >
            ×
          </button>
        </div>
      ) : null}
    </InspectorSection>
  );
}

export function GitTab({
  thread,
  project,
  onViewChanges,
  fetchDiff,
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
  setVerifyCommand,
  runVerify,
  claimLane,
  listLanes,
  previewLane,
  restorePreview,
  recycleWedgedLanes,
  spotlightLane,
}: {
  thread: ThreadInfo | null;
  project: ProjectInfo | null;
  onViewChanges: () => void;
  /** Selected thread's diff; only `files.length` is read ("N changed files ›"). */
  fetchDiff?: () => Promise<DiffResult>;
  listCheckpoints: (threadId: string) => Promise<CheckpointInfo[]>;
  restoreCheckpoint: (threadId: string, sha: string) => Promise<void>;
  listLocalServers: (threadId: string) => Promise<LocalServerInfo[]>;
  revealInFinder?: () => Promise<void>;
  openInEditor?: () => Promise<void>;
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  gitFetch?: (threadId: string) => Promise<void>;
  gitRepoInfo?: (threadId: string) => Promise<GitRepoInfo>;
  gitPull?: (threadId: string) => Promise<GitPullResult>;
  /** threads:summaries passthrough for the one-line recap (#1398 scoped). */
  listThreadSummaries?: (input?: ThreadSummariesInput) => Promise<ThreadSummaryInfo[]>;
  claimLane?: (input: { threadId: string }) => Promise<MergeLaneClaim>;
  listLanes?: (input: { projectId: string }) => Promise<MergeLaneInfo[]>;
  previewLane?: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
  restorePreview?: (input: { projectId: string }) => Promise<MergeLaneRestore>;
  recycleWedgedLanes?: (input: {
    projectId: string;
  }) => Promise<MergeLaneRecycle[]>;
  spotlightLane?: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
  listDevScripts: (threadId: string) => Promise<string[]>;
  startDevServer: (threadId: string, script: string) => Promise<DevServerState>;
  stopDevServer: (threadId: string) => Promise<DevServerState>;
  devServerStatus: (threadId: string) => Promise<DevServerState>;
  setVerifyCommand?: (
    threadId: string,
    command: string | null,
  ) => Promise<void>;
  runVerify?: (threadId: string) => Promise<VerifyResult>;
}) {
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(false);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<CheckpointInfo | null>(
    null,
  );
  const [restorePending, setRestorePending] = useState(false);
  const closeRestoreConfirm = useCallback(() => {
    if (restorePending) return;
    setRestoreConfirm(null);
  }, [restorePending]);
  useEscapeClose(
    restoreConfirm != null && !restorePending,
    closeRestoreConfirm,
  );
  const restoreDialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(restoreConfirm != null, restoreDialogRef);
  const [now, setNow] = useState(() => Date.now());
  const [sync, setSync] = useState<GitSyncInfo | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<GitPullResult | null>(null);
  const [changed, setChanged] = useState<number | null>(null);
  const [activity, setActivity] = useState<{ text: string; at: number } | null>(
    null,
  );

  const threadId = thread?.id ?? null;
  const threadStatus = thread?.status ?? null;
  const isWorking = threadStatus === "working";

  // Clear per-thread state when the selected thread changes so a stale
  // error from row A never shows on row B.
  useEffect(() => {
    setCheckpoints([]);
    setCheckpointError(null);
    setRestoreConfirm(null);
    setRestorePending(false);
    setSync(null);
    setSyncing(false);
    setPulling(false);
    setPullResult(null);
    setChanged(null);
  }, [threadId]);

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

  // Fetch on tab mount / thread change / after a run settles (status).
  // GitTab only mounts while the Environment tab is selected.
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
      // Keep the last badge; fetch errors stay quiet.
    } finally {
      setSyncing(false);
    }
  };

  // One-line recap: this thread's last assistant line, scoped (#1398).
  useEffect(() => {
    let cancelled = false;
    if (!threadId || !listThreadSummaries) {
      setActivity(null);
      return;
    }
    listThreadSummaries({ threadIds: [threadId] })
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

  // "N changed files ›": the same git:diff the Git view and the details card
  // read. Thread switch and status change only, never on a timer.
  useEffect(() => {
    if (!threadId || !fetchDiff) {
      setChanged(null);
      return;
    }
    let live = true;
    fetchDiff()
      .then((diff) => {
        if (live) {
          setChanged(Array.isArray(diff?.files) ? diff.files.length : null);
        }
      })
      .catch(() => {
        if (live) setChanged(null);
      });
    return () => {
      live = false;
    };
  }, [threadId, threadStatus, fetchDiff]);

  // `git pull --ff-only`; failures (dirty tree, no upstream, diverged)
  // arrive in-band.
  const handlePull = async () => {
    if (!threadId || !gitPull || pulling) return;
    setPulling(true);
    setPullResult(null);
    try {
      setPullResult(await gitPull(threadId));
    } catch (err) {
      setPullResult({
        ok: false,
        reason:
          err instanceof Error && err.message ? err.message : "Pull failed",
      });
    } finally {
      setPulling(false);
    }
  };

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

  const remote = Boolean(project?.remoteHost);
  // Lanes are local-only and project-scoped, so they show without a thread too.
  const lanes =
    remote ||
    !project ||
    !claimLane ||
    !listLanes ||
    !previewLane ||
    !restorePreview ||
    !recycleWedgedLanes ? null : (
      <MergeQueueCard
        threadId={threadId}
        projectId={project.id}
        claimLane={claimLane}
        listLanes={listLanes}
        previewLane={previewLane}
        restorePreview={restorePreview}
        recycleWedgedLanes={recycleWedgedLanes}
        spotlight={project.spotlight === true}
        spotlightLane={spotlightLane}
      />
    );

  if (!thread) {
    return (
      <div className={inspector.pane} data-env-tools="">
        <p className={inspector.empty} data-env-empty="">
          Select a thread to see its workspace.
        </p>
        {lanes}
      </div>
    );
  }

  const syncLabelText = sync ? syncLabel(sync) : null;
  const branchLabel = thread.branch ?? project?.slug ?? thread.provider;
  const changesLabel =
    changed == null
      ? "Changes"
      : changed === 0
        ? "No changed files"
        : `${changed} changed ${changed === 1 ? "file" : "files"}`;
  const prLabel =
    thread.prNumber == null
      ? null
      : thread.prState
        ? `#${thread.prNumber} ${thread.prState.toLowerCase()}`
        : `#${thread.prNumber}`;

  return (
    <>
      <div className={inspector.pane} data-env-tools="">
        <section
          className={inspector.section}
          aria-label="Status"
          data-env-status=""
        >
          <div className={inspector.row}>
            <span
              className={styles.gitStatusLine}
              data-env-branch=""
              title={branchLabel}
            >
              {branchLabel}
            </span>
            {syncLabelText ? (
              <span className={styles.syncBadge} data-sync-badge="">
                {syncLabelText}
              </span>
            ) : null}
            <span className={inspector.action}>
              {gitFetch ? (
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
              ) : null}
              {!remote && gitPull ? (
                <button
                  type="button"
                  className={styles.syncBtn}
                  data-pull-btn=""
                  onClick={() => void handlePull()}
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
              ) : null}
            </span>
          </div>
          {pullResult ? (
            <p
              className={pullResult.ok ? styles.pullResult : styles.pullError}
              data-pull-result=""
              role={pullResult.ok ? undefined : "alert"}
            >
              {pullResult.ok ? pullResult.summary : pullResult.reason}
            </p>
          ) : null}
          <div className={inspector.row}>
            <button
              type="button"
              className={inspector.linkBtn}
              data-env-changes=""
              onClick={onViewChanges}
            >
              {changesLabel} ›
            </button>
            {prLabel ? (
              <span data-env-pr="">
                {thread.prUrl ? (
                  // Link out only when a URL was recorded; never invent one.
                  <a
                    className={styles.recapPrLink}
                    data-recap-pr=""
                    href={thread.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={thread.prUrl}
                  >
                    {prLabel} ›
                  </a>
                ) : (
                  prLabel
                )}
              </span>
            ) : null}
          </div>
          <p className={inspector.line} data-recap-activity="">
            {activity?.text ?? "No activity yet"}
          </p>
          {thread.status === "failed" && thread.lastError ? (
            <p
              className={styles.pullError}
              data-env-error=""
              role="alert"
              title={thread.lastError}
            >
              {thread.lastError.replace(/\s+/g, " ").trim()}
            </p>
          ) : null}
          <ScmNotice project={project} />
          {remote ? (
            <p className={inspector.line} data-remote-unavailable="">
              Not available on remote projects: dev server, verification,
              checkpoints and lanes.
            </p>
          ) : null}
          <div className={inspector.row} data-env-links="">
            <RepositoryLink threadId={thread.id} gitRepoInfo={gitRepoInfo} />
            {remote ? null : (
              <EditorCard
                onReveal={() => void revealInFinder?.()}
                onOpen={() => void openInEditor?.()}
              />
            )}
          </div>
        </section>
        {remote ? null : (
          <InspectorSection title="Run" data-env-run="">
            <DevServerCard
              threadId={thread.id}
              listDevScripts={listDevScripts}
              startDevServer={startDevServer}
              stopDevServer={stopDevServer}
              devServerStatus={devServerStatus}
            />
            {setVerifyCommand && runVerify ? (
              <VerifyCard
                thread={thread}
                setVerifyCommand={setVerifyCommand}
                runVerify={runVerify}
              />
            ) : null}
            <LocalServersCard
              threadId={thread.id}
              listLocalServers={listLocalServers}
            />
          </InspectorSection>
        )}
        {remote ? null : (
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
        )}
        {lanes}
      </div>
      {restoreConfirm && (
        <div
          className={styles.confirmOverlay}
          role="presentation"
          onClick={closeRestoreConfirm}
        >
          <div
            ref={restoreDialogRef}
            className={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-checkpoint-title"
            tabIndex={-1}
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
              This resets the worktree and the conversation to this checkpoint.
              Later messages and later checkpoints&apos; work will be lost. The
              main repository is not touched.
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
                onClick={closeRestoreConfirm}
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
        {/* A worker stalled on a permission prompt still reads "working"
            (issue #31) — call it out so a stuck fan-out is obvious here. */}
        <span
          className={styles.teamStatus}
          data-status={
            summary.status === "working" && summary.awaitingInput
              ? "waiting"
              : summary.status === "working" && summary.stalledAt
                ? "stalled"
                : summary.status
          }
        >
          {summary.status === "working" && summary.awaitingInput
            ? "waiting"
            : summary.status === "working" && summary.stalledAt
              ? "stalled"
              : summary.status}
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

/**
 * "Waiting on 2 · 3m · 1 blocked" above a roster (issue #42): the thread
 * handed work off and cannot move until it comes back.
 * ponytail: elapsed refreshes on the summaries poll (2s while anything is
 * working), so no clock of its own.
 */
function WaitLine({ wait }: { wait: WaitState }) {
  return (
    <div
      className={styles.waitLine}
      data-wait-line=""
      data-attention={wait.blocked > 0 ? "true" : undefined}
    >
      {waitLabel(wait, Date.now())}
    </div>
  );
}

/** Ruled-out / worked / inconclusive ledger. Hidden when the thread has none. */
function HypothesisLedgerCard({
  hypotheses,
  now,
}: {
  hypotheses: Hypothesis[] | undefined;
  now: number;
}) {
  if (!hypotheses?.length) return null;
  const groups = groupHypotheses(hypotheses);
  return (
    <InspectorSection
      title="Hypotheses"
      count={hypotheses.length}
      collapsible
      defaultOpen={false}
      data-hypothesis-ledger=""
    >
      <p className={styles.hypothesisSummary}>
        {formatHypothesisSummary(hypotheses)}
      </p>
      {groups.map((g) => (
        <div key={g.status} className={styles.hypothesisGroup}>
          <div className={styles.hypothesisGroupLabel}>{g.label}</div>
          <ul className={styles.hypothesisList}>
            {g.entries.map((h) => (
              <li
                key={h.id}
                className={styles.hypothesisRow}
                data-hypothesis-status={h.status}
              >
                <div className={styles.hypothesisRowHead}>
                  <span className={styles.hypothesisClaim}>{h.claim}</span>
                  <span className={styles.hypothesisAge}>
                    {formatHypothesisAge(h.at, now)}
                  </span>
                </div>
                {h.reason ? (
                  <p className={styles.hypothesisReason}>{h.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </InspectorSection>
  );
}

function crewTaskPill(task: CrewTaskView): string {
  return task.blocked ? "blocked" : task.status;
}

function CrewTaskList({
  tasks,
  ownerTitle,
}: {
  tasks: CrewTaskView[];
  ownerTitle: (threadId: string) => string;
}) {
  if (tasks.length === 0) return null;
  return (
    <InspectorSection title="Tasks" count={tasks.length} data-crew-tasks="">
      <ul className={styles.teamList}>
        {tasks.map((task) => {
          const pill = crewTaskPill(task);
          const owner =
            task.status === "claimed" && task.owner
              ? ownerTitle(task.owner)
              : null;
          return (
            <li
              key={task.id}
              className={styles.teamRow}
              data-crew-task={task.id}
            >
              <span className={styles.taskId}>{task.id}</span>
              <span className={styles.teamTitle}>{task.title}</span>
              <span className={styles.teamStatus} data-status={pill}>
                {pill}
              </span>
              {task.attempts.length > 1 && (
                <span className={styles.taskAttempts}>
                  {task.attempts.length} attempts
                </span>
              )}
              {owner ? (
                <span className={styles.teamActivity}>{owner}</span>
              ) : null}
              {task.status === "done" && task.note ? (
                <span className={styles.teamActivity}>{task.note}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </InspectorSection>
  );
}

export function AgentsContent({
  workflow,
  thread,
  usage,
  providers,
  rosterKey = "",
  listThreadSummaries,
  listCrewTasks,
  crewIntegration,
  onIntegrateWorker,
  onRefreshWorker,
  onVerifyLead,
  onLandLead,
  onSelectThread,
  onRetryAgent,
}: {
  workflow: WorkflowView | null;
  thread: ThreadInfo | null;
  usage: SessionUsage | null;
  providers: ProviderInfo[];
  rosterKey?: string;
  listThreadSummaries?: (input?: ThreadSummariesInput) => Promise<ThreadSummaryInfo[]>;
  listCrewTasks?: (
    threadId: string,
  ) => Promise<{ rootThreadId: string; tasks: CrewTaskView[] }>;
  crewIntegration?: (threadId: string) => Promise<CrewIntegrationView>;
  onIntegrateWorker?: (workerThreadId: string) => Promise<void>;
  onRefreshWorker?: (workerThreadId: string) => Promise<void>;
  onVerifyLead?: () => Promise<void>;
  onLandLead?: () => Promise<void>;
  onSelectThread?: (id: string) => void;
  onRetryAgent?: (agentId: string) => void;
}) {
  /**
   * Manual expand/collapse overrides. Absent key = not toggled by user,
   * so active and failed phases auto-expand and others stay collapsed.
   */
  const [manual, setManual] = useState<Record<string, boolean>>({});

  const [summaries, setSummaries] = useState<ThreadSummaryInfo[] | null>(null);

  useEffect(() => {
    setManual({});
  }, [workflow?.id]);

  // Team view data. The refetch is keyed on ids + statuses (`rosterKey`, built
  // in App) rather than the thread array, whose identity churns on every
  // stream event; lastActivity is kept fresh by a slow poll while something is
  // working. Null when no fetcher.
  // ponytail: poll, not per-event; fetch is scoped to the selected
  // thread's project (#1398), not every thread.
  const summaryProjectId = thread?.projectId ?? null;
  useEffect(() => {
    if (!listThreadSummaries || !summaryProjectId) {
      setSummaries(null);
      return;
    }
    let cancelled = false;
    const fetch = () => {
      // Scoped to the selected thread's project (#1398); a hidden window
      // can't show the team view, so don't pay for it.
      if (document.hidden) return;
      // Same-project rows cover the team, the wait line and lead detection.
      listThreadSummaries({ projectId: summaryProjectId })
        .then((list) => {
          if (!cancelled) setSummaries(list);
        })
        .catch(() => {
          if (!cancelled) setSummaries(null);
        });
    };
    void fetch();
    const working = rosterKey.includes(":working");
    const id = working
      ? window.setInterval(() => void fetch(), SUMMARY_POLL_MS)
      : null;
    return () => {
      cancelled = true;
      if (id !== null) window.clearInterval(id);
    };
  }, [listThreadSummaries, rosterKey, summaryProjectId]);

  const [crewTasks, setCrewTasks] = useState<CrewTaskView[]>([]);
  useEffect(() => {
    if (!thread || !listCrewTasks) {
      setCrewTasks([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      listCrewTasks(thread.id)
        .then((res) => {
          if (!cancelled) setCrewTasks(Array.isArray(res?.tasks) ? res.tasks : []);
        })
        .catch(() => {
          if (!cancelled) setCrewTasks([]);
        });
    };
    void load();
    const api = (
      window as unknown as {
        coder?: { on?: (channel: "threads:changed", cb: () => void) => () => void };
      }
    ).coder;
    const off = api?.on?.("threads:changed", () => {
      void load();
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [thread?.id, listCrewTasks]);

  const [integration, setIntegration] = useState<CrewIntegrationView | null>(
    null,
  );
  const [integrationError, setIntegrationError] = useState<string | null>(
    null,
  );
  // Guards against out-of-order resolution: crewIntegration is async in
  // main, so a late call (e.g. the poll) can resolve after a newer one
  // (e.g. a just-finished action) and clobber its result.
  const integrationSeq = useRef(0);
  const [busyWorkerId, setBusyWorkerId] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<"integrate" | "refresh" | null>(
    null,
  );
  const [verifyingLead, setVerifyingLead] = useState(false);
  const [landingLead, setLandingLead] = useState(false);
  // Lead detection as a boolean so a new summaries array (every 5s poll)
  // does not rerun ~6+3×workers git calls in main.
  const isCrewLead = useMemo(
    () => Boolean(thread && summaries?.some((s) => isDirectCrewChild(s, thread))),
    [thread?.id, thread?.projectId, summaries],
  );
  useEffect(() => {
    if (!thread || !crewIntegration || !isCrewLead) {
      setIntegration(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const load = () => {
      const seq = ++integrationSeq.current;
      crewIntegration(thread.id)
        .then((res) => {
          if (!cancelled && seq === integrationSeq.current) {
            setIntegration(res);
            setIntegrationError(null);
          }
        })
        .catch((err) => {
          if (!cancelled && seq === integrationSeq.current) {
            setIntegration(null);
            setIntegrationError(
              err instanceof Error ? err.message : String(err),
            );
          }
        });
    };
    void load();
    const api = (
      window as unknown as {
        coder?: { on?: (channel: "threads:changed", cb: () => void) => () => void };
      }
    ).coder;
    // threads:changed fires dozens of times a minute in a crew run; one
    // reload per second is plenty for a review surface.
    const off = api?.on?.("threads:changed", () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void load();
      }, 1_000);
    });
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      off?.();
    };
  }, [thread?.id, crewIntegration, isCrewLead, rosterKey]);

  const crewOwnerTitle = useCallback(
    (threadId: string) => {
      if (thread?.id === threadId) return thread.title;
      const row = summaries?.find((s) => s.id === threadId);
      return row?.title ?? threadId;
    },
    [thread, summaries],
  );

  // Roles derive from orchWorker: a true crew child is a Worker; a thread
  // those children point at is an Orchestrator. Ordinary forks and legacy
  // summaries without the flag stay a plain session. Live workers stay as
  // plain rows (failed / idle / working). Done workers fold behind a
  // "N done" toggle while any worker is still live so a long orchestration
  // stays scannable. When none are live — including ones the sidebar has
  // settled — list them immediately (no toggle) so an all-done crew is not
  // an empty Team.
  const [showDoneWorkers, setShowDoneWorkers] = useState(false);
  const team = useMemo(() => {
    if (!thread || !summaries) return null;
    const all = summaries.filter((s) => isDirectCrewChild(s, thread));
    const workers = all.filter((s) => s.status !== "done");
    const doneWorkers = all.filter((s) => s.status === "done");
    if (all.length > 0) {
      return { kind: "orchestrator" as const, workers, doneWorkers };
    }
    if (isOrchWorker(thread) && thread.handoffFrom) {
      const orchestrator = summaries.find((s) => s.id === thread.handoffFrom);
      if (orchestrator && sameCrewProject(orchestrator, thread)) {
        return { kind: "worker" as const, orchestrator };
      }
    }
    return null;
  }, [thread, summaries]);

  // In-session subagents (Agent tool) tracked by the runner on the thread
  // record. Not threads — rows render without navigation. The running →
  // "working" map reuses the existing status badge styling.
  const subagents = thread?.subagents ?? [];

  // What this thread is blocked on right now: live worker forks (from the
  // summaries roster) plus its own running subagents. The thread's own row in
  // summaries is swapped for the ThreadInfo so the subagents come along.
  const wait = useMemo(() => {
    if (!thread || !summaries) return null;
    const crew = summaries.filter(
      (s) =>
        s.id !== thread.id && isOrchWorker(s) && sameCrewProject(s, thread),
    );
    return buildWaitStates([...crew, thread]).get(thread.id) ?? null;
  }, [thread, summaries]);
  const subagentSection =
    subagents.length > 0 ? (
      <InspectorSection title="Subagents" count={subagents.length}>
        {/* Orchestrators show the wait line above their Team roster instead. */}
        {!team && wait && <WaitLine wait={wait} />}
        <ul className={styles.teamList}>
          {subagents.map((s) => (
            <TeamRow
              key={s.id}
              summary={{
                id: s.id,
                title: s.description,
                provider: s.agentType ?? (thread?.provider || "claude"),
                status: s.status === "running" ? "working" : s.status,
                handoffFrom: null,
                runStartedAt: null,
                lastActivity: null,
              }}
              role="Subagent"
              providers={providers}
            />
          ))}
        </ul>
      </InspectorSection>
    ) : null;

  // ponytail: Date.now() at render; 60s ticker if ages look frozen in long-open panes.
  const hypothesisSection = (
    <HypothesisLedgerCard hypotheses={thread?.hypotheses} now={Date.now()} />
  );

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
          name: phase.name,
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
    return status === "active" || status === "failed";
  };

  const toggle = (id: string, currentlyOpen: boolean) => {
    setManual((prev) => ({ ...prev, [id]: !currentlyOpen }));
  };

  const pane = inspector.pane;

  if (!workflow) {
    if (!thread) {
      return (
        <div className={pane}>
          <p className={styles.placeholder}>No active session</p>
        </div>
      );
    }
    if (team?.kind === "orchestrator") {
      return (
        <div className={pane}>
          <SessionLine
            thread={thread}
            usage={usage}
            providers={providers}
            role="Orchestrator"
          />
          <InspectorSection
            title="Team"
            count={team.workers.length + team.doneWorkers.length}
          >
            {wait && <WaitLine wait={wait} />}
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
              {(showDoneWorkers || team.workers.length === 0) &&
                team.doneWorkers.map((w) => (
                  <TeamRow
                    key={w.id}
                    summary={w}
                    role="Worker"
                    providers={providers}
                    onSelect={onSelectThread}
                  />
                ))}
            </ul>
            {team.doneWorkers.length > 0 && team.workers.length > 0 && (
              <button
                type="button"
                className={styles.doneToggle}
                onClick={() => setShowDoneWorkers((v) => !v)}
                aria-expanded={showDoneWorkers}
              >
                {showDoneWorkers
                  ? "Hide done"
                  : `${team.doneWorkers.length} done`}
              </button>
            )}
          {crewIntegration ? (
            <CrewIntegration
              key={thread.id}
              view={integration}
              thread={thread}
              error={integrationError}
              busyWorkerId={busyWorkerId}
              busyKind={busyKind}
              verifying={verifyingLead}
              finalPending={landingLead}
              onIntegrate={async (workerId) => {
                if (!onIntegrateWorker) return;
                setBusyWorkerId(workerId);
                setBusyKind("integrate");
                setIntegrationError(null);
                let seq: number | null = null;
                try {
                  await onIntegrateWorker(workerId);
                  if (crewIntegration) {
                    seq = ++integrationSeq.current;
                    const res = await crewIntegration(thread.id);
                    if (seq === integrationSeq.current) setIntegration(res);
                  }
                } catch (err) {
                  if (seq === null || seq === integrationSeq.current) {
                    setIntegrationError(
                      err instanceof Error ? err.message : String(err),
                    );
                  }
                } finally {
                  setBusyWorkerId(null);
                  setBusyKind(null);
                }
              }}
              onRefreshWorker={
                onRefreshWorker
                  ? async (workerId) => {
                      setBusyWorkerId(workerId);
                      setBusyKind("refresh");
                      setIntegrationError(null);
                      let seq: number | null = null;
                      try {
                        await onRefreshWorker(workerId);
                        if (crewIntegration) {
                          seq = ++integrationSeq.current;
                          const res = await crewIntegration(thread.id);
                          if (seq === integrationSeq.current)
                            setIntegration(res);
                        }
                      } catch (err) {
                        if (seq === null || seq === integrationSeq.current) {
                          setIntegrationError(
                            err instanceof Error ? err.message : String(err),
                          );
                        }
                      } finally {
                        setBusyWorkerId(null);
                        setBusyKind(null);
                      }
                    }
                  : undefined
              }
              onSelectThread={onSelectThread}
              onVerify={
                onVerifyLead
                  ? async () => {
                      setVerifyingLead(true);
                      setIntegrationError(null);
                      let seq: number | null = null;
                      try {
                        await onVerifyLead();
                        if (crewIntegration) {
                          seq = ++integrationSeq.current;
                          const res = await crewIntegration(thread.id);
                          if (seq === integrationSeq.current)
                            setIntegration(res);
                        }
                      } catch (err) {
                        if (seq === null || seq === integrationSeq.current) {
                          setIntegrationError(
                            err instanceof Error ? err.message : String(err),
                          );
                        }
                      } finally {
                        setVerifyingLead(false);
                      }
                    }
                  : undefined
              }
              onFinal={
                onLandLead
                  ? async () => {
                      setLandingLead(true);
                      setIntegrationError(null);
                      let seq: number | null = null;
                      try {
                        await onLandLead();
                        if (crewIntegration) {
                          seq = ++integrationSeq.current;
                          const res = await crewIntegration(thread.id);
                          if (seq === integrationSeq.current)
                            setIntegration(res);
                        }
                      } catch (err) {
                        if (seq === null || seq === integrationSeq.current) {
                          setIntegrationError(
                            err instanceof Error ? err.message : String(err),
                          );
                        }
                      } finally {
                        setLandingLead(false);
                      }
                    }
                  : undefined
              }
            />
          ) : null}
          </InspectorSection>
          <CrewTaskList tasks={crewTasks} ownerTitle={crewOwnerTitle} />
          {subagentSection}
          {hypothesisSection}
        </div>
      );
    }
    if (team?.kind === "worker") {
      return (
        <div className={pane}>
          <SessionLine
            thread={thread}
            usage={usage}
            providers={providers}
            role="Worker"
          />
          <section className={inspector.section} aria-label="Lead">
            <button
              type="button"
              className={inspector.linkBtn}
              data-crew-lead={team.orchestrator.id}
              title={team.orchestrator.title}
              onClick={() => onSelectThread?.(team.orchestrator.id)}
            >
              Lead: {team.orchestrator.title} ›
            </button>
          </section>
          <CrewTaskList tasks={crewTasks} ownerTitle={crewOwnerTitle} />
          {subagentSection}
          {hypothesisSection}
        </div>
      );
    }
    return (
      <div className={pane}>
        <SessionLine thread={thread} usage={usage} providers={providers} />
        <CrewTaskList tasks={crewTasks} ownerTitle={crewOwnerTitle} />
        {subagentSection}
        {hypothesisSection}
      </div>
    );
  }

  const working = workflow.phases.reduce(
    (n, p) => n + p.agents.filter((a) => a.status === "running").length,
    0,
  );

  return (
    <>
      <div className={pane}>
        <InspectorSection
          title={`Workflow · ${workflow.name}`}
          action={
            <span className={styles.settled}>
              {workflow.settled}/{workflow.total} settled
            </span>
          }
          data-workflow=""
        >
          <div className={styles.workflow}>
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
          </div>
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
                          {agent.status === "failed" &&
                          thread?.status !== "working" ? (
                            <button
                              type="button"
                              className={styles.retryBtn}
                              data-retry-agent={agent.id}
                              aria-label={`Retry ${agent.id}`}
                              onClick={() => onRetryAgent?.(agent.id)}
                            >
                              Retry
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
          </div>
        </InspectorSection>
        <CrewTaskList tasks={crewTasks} ownerTitle={crewOwnerTitle} />
        {hypothesisSection}
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

/**
 * memo'd: another thread's 700ms stream tick must not re-render this pane
 * (issue #91). It takes `rosterKey` instead of the thread list for the same
 * reason — the array's identity churns, the key only moves on a real change.
 */
export const AgentsPanel = memo(function AgentsPanel({
  workflow,
  thread,
  usage,
  providers,
  project,
  rosterKey,
  listThreadSummaries,
  listCrewTasks,
  crewIntegration,
  onIntegrateWorker,
  onRefreshWorker,
  onVerifyLead,
  onLandLead,
  onSelectThread,
  onRetryAgent,
  onViewChanges,
  fetchDiff,
  tab,
  onTabChange,
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
  setVerifyCommand,
  runVerify,
  searchMemory,
  recentMemory,
  getMemory,
  updateMemory,
  removeMemory,
  storeMemory,
  maintenanceMemory,
  resolveMemory,
  listSkills,
  removeSkill,
  syncSkills,
  claimLane,
  listLanes,
  previewLane,
  restorePreview,
  recycleWedgedLanes,
  spotlightLane,
  onCollapse,
  onOpenSettings,
  skillsRefreshKey,
}: AgentsPanelProps) {
  const tabListRef = useRef<HTMLDivElement>(null);
  const focusRequest = useRef<PanelTab | null>(null);

  const selectTab = (next: PanelTab, focus = false) => {
    if (focus && next !== tab) focusRequest.current = next;
    onTabChange(next);
  };

  useEffect(() => {
    const list = tabListRef.current;
    if (!list) return;
    const btn = list.querySelector<HTMLButtonElement>(
      `[data-panel-tab="${tab}"]`,
    );
    if (!btn) return;
    if (focusRequest.current === tab) {
      focusRequest.current = null;
      btn.focus({ preventScroll: true });
    }
    const listRect = list.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    if (listRect.width <= 0 || btnRect.width <= 0) return;
    if (btnRect.left < listRect.left) {
      list.scrollLeft -= listRect.left - btnRect.left;
    } else if (btnRect.right > listRect.right) {
      list.scrollLeft += btnRect.right - listRect.right;
    }
  }, [tab]);

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const index = INSPECTOR_TABS.findIndex((item) => item.id === tab);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % INSPECTOR_TABS.length;
    else if (event.key === "ArrowLeft") {
      next = (index - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = INSPECTOR_TABS.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    selectTab(INSPECTOR_TABS[next]!.id, true);
  };

  return (
    <aside className={styles.panel}>
      <header className={styles.tabs}>
        <div
          ref={tabListRef}
          className={styles.tabList}
          role="tablist"
          aria-label="Inspector"
        >
          {INSPECTOR_TABS.map((item) => {
            const selected = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`inspector-tab-${item.id}`}
                className={styles.tab}
                data-panel-tab={item.id}
                data-active={selected}
                aria-selected={selected}
                aria-controls="inspector-tabpanel"
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(item.id)}
                onKeyDown={onTabKeyDown}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        {onCollapse ? (
          <button
            type="button"
            className={styles.collapseBtn}
            data-agents-collapse=""
            aria-expanded="true"
            aria-controls="pane-agents"
            title="Hide agents panel (⌘.)"
            aria-label="Hide agents panel"
            onClick={onCollapse}
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
              <path d="M6.5 3.5 11 8 6.5 12.5" />
            </svg>
          </button>
        ) : null}
      </header>

      <div
        id="inspector-tabpanel"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${tab}`}
        className={styles.tabPanel}
      >
      {tab === "agents" ? (
        <AgentsContent
          workflow={workflow}
          thread={thread}
          usage={usage}
          providers={providers}
          rosterKey={rosterKey}
          listThreadSummaries={listThreadSummaries}
          listCrewTasks={listCrewTasks}
          crewIntegration={crewIntegration}
          onIntegrateWorker={onIntegrateWorker}
          onRefreshWorker={onRefreshWorker}
          onVerifyLead={onVerifyLead}
          onLandLead={onLandLead}
          onSelectThread={onSelectThread}
          onRetryAgent={onRetryAgent}
        />
      ) : tab === "git" ? (
        <GitTab
          thread={thread}
          project={project}
          onViewChanges={onViewChanges}
          fetchDiff={fetchDiff}
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
          setVerifyCommand={setVerifyCommand}
          runVerify={runVerify}
          claimLane={claimLane}
          listLanes={listLanes}
          previewLane={previewLane}
          restorePreview={restorePreview}
          recycleWedgedLanes={recycleWedgedLanes}
          spotlightLane={spotlightLane}
        />
      ) : tab === "memory" ? (
        <MemoryTab
          projectSlug={project?.path ?? project?.slug ?? null}
          consolidation={project ?? null}
          searchMemory={searchMemory}
          recentMemory={recentMemory}
          getMemory={getMemory}
          updateMemory={updateMemory}
          removeMemory={removeMemory}
          storeMemory={storeMemory}
          maintenanceMemory={maintenanceMemory}
          resolveMemory={resolveMemory}
          onOpenProjectTools={
            onOpenSettings ? () => onOpenSettings("memory") : undefined
          }
        />
      ) : tab === "skills" ? (
        <SkillsTab
          projectPath={project?.path ?? null}
          listSkills={listSkills}
          removeSkill={removeSkill}
          syncSkills={syncSkills}
          onManage={onOpenSettings ? () => onOpenSettings("skills") : undefined}
          refreshKey={skillsRefreshKey}
        />
      ) : null}
      </div>
    </aside>
  );
});
