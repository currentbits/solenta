import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityItem,
  AppSettings,
  AppStatus,
  AttachmentInfo,
  AutomationInfo,
  AutomationWrite,
  CheckpointInfo,
  CoderApi,
  DigestResult,
  CreateProjectInput,
  RunStatInfo,
  ConflictForecast,
  DevServerState,
  DiffResult,
  ReviewContext,
  ReviewSymbol,
  GitSyncInfo,
  GitRepoInfo,
  GitPullResult,
  FetchIssueResult,
  CreateIssueResult,
  LocalServerInfo,
  MemoryCitation,
  MemoryEntryInfo,
  AgentConfigDoctorReport,
  AgentConfigPreview,
  AgentConfigWriteResult,
  PermissionDecision,
  PermissionMode,
  PlanStatus,
  SetPlanStatusResult,
  ListIssuesResult,
  ListPrsResult,
  PrChecksResult,
  PrInfo,
  ProjectInfo,
  ProjectUpdateInput,
  ProviderInfo,
  ReasoningEffort,
  CliSlashCommand,
  SkillInfo,
  SkillTarget,
  SkillWrite,
  SpecArtifact,
  ThreadDetail,
  ThreadInfo,
  ThreadSummaryInfo,
  CrewTaskView,
  UpdateStatus,
  UsageReport,
  VerifyResult,
  WorkflowTemplateInfo,
  WorkSuggestionStatus,
} from "./shared/ipc";
import { resolveCoderApi } from "./coderApi";
import { isWebMode } from "./shared/wire";
import { nextVisibleThreadId } from "./threadSelection";
import { mergeThreadPatch, patchThreadList } from "./threadPatch";
import { parseBtwCommand } from "./btw";

const STATUS_POLL_MS = 60_000;

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function filesToAttachments(
  files: File[],
  save: (dataUrl: string) => Promise<AttachmentInfo | null>,
): Promise<AttachmentInfo[]> {
  const out: AttachmentInfo[] = [];
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    if (!dataUrl) continue;
    const attachment = await save(dataUrl);
    if (attachment) out.push(attachment);
  }
  return out;
}

/** ponytail: web mode can only attach images, not folders. Native picker allows folders; `<input type=file>` cannot. */
function pickWebImageFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*";
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => finish([]));
    input.click();
  });
}

export type WorkflowSaveInput = Omit<WorkflowTemplateInfo, "id" | "builtin"> & {
  id?: string;
};

function resolveApi(): CoderApi {
  return resolveCoderApi();
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error && err.message ? err.message : String(err);
  for (const marker of ["MERGE_CONFLICT:", "WORKTREE_DIRTY:"]) {
    const at = raw.indexOf(marker);
    if (at !== -1) return raw.slice(at + marker.length).trim();
  }
  return raw;
}

/** A follow-up typed during a run, waiting for that run to land. */
export interface QueuedMessage {
  prompt: string;
  attachments?: AttachmentInfo[];
  /** Last delivery failure (issue #314); prompt is still queued. */
  error?: string | null;
}

export type CoderErrorScope = "project" | "run";

export interface CoderError {
  scope: CoderErrorScope;
  message: string;
}

export interface UseCoderResult {
  api: CoderApi;
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  /** Provider registry loaded once at startup. */
  providers: ProviderInfo[];
  /** Workflow templates loaded at startup; refreshed after save/remove. */
  workflows: WorkflowTemplateInfo[];
  /** Scheduled automations; refreshed after add/update/remove/runNow. */
  automations: AutomationInfo[];
  selectedThreadId: string | null;
  selectThread: (id: string | null) => void;
  detail: ThreadDetail | null;
  /** threads.get rejection for the selected thread, shown with a retry. */
  detailError: string | null;
  /** Re-fetch the selected thread's detail after a load failure. */
  retryDetail: () => void;
  loading: boolean;
  /** Project of the selected thread, or first project if none selected. */
  selectedProjectId: string | null;
  error: CoderError | null;
  clearError: () => void;
  /** Native: folder picker. Web: pass a filesystem path (projects.add). Optional remotes skip the local checkout. */
  addProject: (
    path?: string,
    opts?: { remoteHost?: string; remotePath?: string },
  ) => Promise<ProjectInfo | null>;
  /** Create a new folder + git repo (projects.create) and add it. */
  createProject: (input: CreateProjectInput) => Promise<ProjectInfo | null>;
  /** Patch name, SSH remotes, or worktree retention of a project. */
  updateProject: (input: ProjectUpdateInput) => Promise<ProjectInfo | null>;
  /** Create in projectId when given; otherwise the currently selected project. */
  createThread: (
    title?: string,
    projectId?: string,
    opts?: {
      worktree?: boolean;
      orchestrate?: boolean;
      teach?: boolean;
      ask?: boolean;
      issueNumber?: number | null;
    },
  ) => Promise<ThreadInfo | null>;
  /**
   * Fork / hand off a thread (threads.fork). Selects the new thread the same
   * way createThread does. Plain fork: no provider override. Hand-off: pass
   * provider (and optional model). Errors surface via error scope "run".
   */
  forkThread: (
    threadId: string,
    opts?: { provider?: string; model?: string | null; worktree?: boolean },
  ) => Promise<ThreadInfo | null>;
  /**
   * Start a run, or queue the prompt when that thread is already working:
   * the queued text is delivered at the run's terminal (issue #92).
   */
  startRun: (
    prompt: string,
    threadId?: string,
    attachments?: AttachmentInfo[],
  ) => Promise<void>;
  /**
   * Edit-and-resubmit (#254): rewind the transcript to just before
   * messageId, then start a run with the edited prompt. Rewind starts
   * nothing; this is rewind then the ordinary startRun path.
   */
  rewindAndResubmit: (
    messageId: string,
    prompt: string,
    restoreFiles?: boolean,
    attachments?: AttachmentInfo[],
  ) => Promise<void>;
  /** Follow-ups waiting for a run to land, keyed by thread id. */
  queued: Record<string, QueuedMessage>;
  /** Drop a thread's queued follow-up. Defaults to the selected thread. */
  cancelQueued: (threadId?: string) => void;
  /** Re-send a queued prompt after a delivery failure (issue #314). */
  retryQueued: (threadId?: string) => void;
  /** Fetch a GitHub issue for a project checkout (`gh issue view`). */
  fetchIssue: (
    projectPath: string,
    ref: string,
  ) => Promise<FetchIssueResult>;
  /**
   * Multi-phase Build workflow for the selected thread. Passes templateId to
   * runs.startWorkflow (backend validates phase providers).
   */
  startWorkflowRun: (prompt: string, templateId?: string) => Promise<void>;
  /** Persist a workflow template; refreshes the list. Saving a builtin creates a copy. */
  saveWorkflow: (template: WorkflowSaveInput) => Promise<WorkflowTemplateInfo>;
  /** Remove a non-builtin template; refreshes the list. */
  removeWorkflow: (id: string) => Promise<void>;
  /** Reload workflows.list() into state. */
  refreshWorkflows: () => Promise<void>;
  refreshAutomations: () => Promise<void>;
  addAutomation: (input: AutomationWrite) => Promise<AutomationInfo>;
  updateAutomation: (
    input: Partial<AutomationWrite> & { id: string },
  ) => Promise<AutomationInfo>;
  removeAutomation: (id: string) => Promise<void>;
  runAutomationNow: (id: string) => Promise<AutomationInfo>;
  stopRun: () => Promise<void>;
  /** Sticky permission mode. Pass threadId to target a fork, not the open thread. */
  setPermissionMode: (
    mode: PermissionMode,
    threadId?: string,
  ) => Promise<void>;
  /** Answer the selected thread's pending permission prompt. */
  respondPermission: (
    requestId: string,
    decision: PermissionDecision,
    answers?: Record<string, string>,
  ) => Promise<void>;
  /** Set provider and/or model on the selected thread (selectedRef-guarded). */
  setProvider: (input: {
    provider?: string;
    model?: string | null;
  }) => Promise<void>;
  /**
   * Set reasoning effort. Defaults to the selected thread.
   * Pass threadId when applying a profile to a fork that is not selected.
   */
  setReasoningEffort: (
    effort: ReasoningEffort | null,
    threadId?: string,
  ) => Promise<void>;
  /**
   * Archive or unarchive a thread. Defaults to the selected thread.
   * Pass threadId when undoing archive after selection has already moved.
   * Archiving the selected thread moves selection off it.
   */
  /** Resolves false when the archive failed (message lands in error scope "run"). */
  setArchived: (archived: boolean, threadId?: string) => Promise<boolean>;
  /**
   * Set the settle override for a thread (sidebar hover action).
   * Does not require the thread to be selected.
   */
  setSettled: (
    threadId: string,
    override: "settled" | "active" | null,
  ) => Promise<void>;
  /** Pin or unpin a thread (sidebar hover). Does not require selection. */
  setPinned: (threadId: string, pinned: boolean) => Promise<void>;
  /**
   * Snooze until an epoch ms, or clear with null. Does not require selection.
   */
  setSnoozed: (threadId: string, until: number | null) => Promise<void>;
  setMuted: (threadId: string, muted: boolean) => Promise<void>;
  setQuotaWaitAutoResume: (
    threadId: string,
    enabled: boolean | null,
  ) => Promise<void>;
  resumeQuotaWait: (threadId: string) => Promise<void>;
  /** Rename a thread. Does not require selection. */
  renameThread: (threadId: string, title: string) => Promise<void>;
  /** Save scratch notes on a thread (header editor, issue #194). */
  setNotes: (threadId: string, notes: string) => Promise<void>;
  /**
   * Resolve a suggested-work chip (issue #550). Updates the thread from the
   * returned ThreadInfo. status is never "open" — chips do not reopen.
   */
  resolveSuggestion: (
    threadId: string,
    suggestionId: string,
    status: Exclude<WorkSuggestionStatus, "open">,
    extra?: { startedThreadId?: string; issueNumber?: number },
  ) => Promise<void>;
  /**
   * File a GitHub issue (`gh issue create`). Failures stay in-band; no
   * thread-state merge.
   */
  createIssue: (
    projectPath: string,
    title: string,
    body: string,
  ) => Promise<CreateIssueResult>;
  /** Record the one-tap felt estimate (issue #401); savedMs null = declined. */
  setFeltEstimate: (
    threadId: string,
    savedMs: number | null,
  ) => Promise<void>;
  /** Turn spec mode on (issue #269). Updates thread from the returned ThreadInfo. */
  startSpec: (threadId: string) => Promise<void>;
  /** Turn spec mode off (issue #500). Updates thread from the returned ThreadInfo. */
  stopSpec: (threadId: string) => Promise<void>;
  /** Answer the spec stage gate. Updates thread from the returned ThreadInfo. */
  reviewSpec: (
    threadId: string,
    decision: "approve" | "revise",
    feedback?: string,
  ) => Promise<void>;
  /** Read one spec artifact off disk. */
  specArtifact: (
    threadId: string,
    stage: SpecArtifact,
  ) => Promise<{ path: string; text: string | null }>;
  /** Dispatch the current tasks.md wave as parallel workers (issue #537). */
  dispatchSpec: (threadId: string) => Promise<void>;
  /** Start a converge run that appends missing tasks.md checkboxes. */
  convergeSpec: (threadId: string) => Promise<void>;
  /** Turn Teach mode on (issue #373). Updates thread from the returned ThreadInfo. */
  startTeach: (threadId: string) => Promise<void>;
  /** Turn Teach mode off. */
  stopTeach: (threadId: string) => Promise<void>;
  /** Turn Ask mode on (issue #392). */
  startAsk: (threadId: string) => Promise<void>;
  /** Turn Ask mode off. worktree: true is Start work. */
  stopAsk: (threadId: string, opts?: { worktree?: boolean }) => Promise<void>;
  /** Drop a `/btw` side-question card (issue #471). */
  dismissBtw: (threadId: string, id: string) => Promise<void>;
  /** Queue a side question as a follow-up and drop the card. */
  promoteBtw: (threadId: string, id: string) => Promise<void>;
  /** Ask the agent to review the human's TODO(human) fills. Starts a run. */
  requestTeachReview: (threadId: string) => Promise<void>;
  /** Permanently delete the selected thread (after caller confirms). */
  deleteThread: () => Promise<void>;
  /**
   * Remove a project ENTRY and its threads' history (after caller confirms).
   * Repo on disk is never touched. On success refreshes projects + threads;
   * if the open thread belonged to that project, selection hands off exactly
   * like deleteThread (nextVisibleThreadId + clear detail). Rejects on
   * failure so the caller can show an error toast.
   */
  removeProject: (projectId: string) => Promise<void>;
  setupWorktree: () => Promise<ThreadInfo | null>;
  mergeWorktree: () => Promise<ThreadInfo | null>;
  removeWorktree: (force?: boolean) => Promise<ThreadInfo | null>;
  fetchDiff: () => Promise<DiffResult>;
  fetchReviewContext: () => Promise<ReviewContext>;
  setReviewAccepted: (hashes: string[]) => Promise<void>;
  /** Commit all changes in the selected thread's cwd. */
  commitChanges: (message: string) => Promise<{ subject: string }>;
  /** Discard one changed file in the selected thread's cwd. */
  revertFile: (path: string, status: string) => Promise<{ path: string }>;
  /** Draft a commit message with the thread's provider (never commits). */
  suggestCommitMessage: () => Promise<{ message: string }>;
  /** File paths for the composer @-mention popup. */
  listFiles: (query: string) => Promise<string[]>;
  /** Resolve transcript path tokens against the selected thread worktree. */
  resolvePaths: (
    paths: string[],
  ) => Promise<Array<{ path: string; abs: string | null }>>;
  /** Open or reveal a resolved worktree path in the default app / Finder. */
  openWorkspacePath: (
    abs: string,
    opts?: { reveal?: boolean },
  ) => Promise<void>;
  /** Data URL for one image a tool returned; null when it is gone. */
  loadToolImage: (name: string) => Promise<string | null>;
  /** Native image/folder picker, or a web <input type=file> for images. */
  pickAttachments: () => Promise<AttachmentInfo[]>;
  /** Persist a pasted image for the selected thread; null when rejected. */
  saveAttachmentImage: (dataUrl: string) => Promise<AttachmentInfo | null>;
  /** Data URL for one attached image; null when it is gone. */
  loadAttachmentImage: (path: string) => Promise<string | null>;
  /**
   * Classify drag-dropped files as attachments. Native resolves absolute
   * paths via the Electron preload; web reads each File as a data URL.
   */
  dropAttachmentFiles: (files: File[]) => Promise<AttachmentInfo[]>;
  /** Push the selected thread's branch to origin. */
  pushBranch: () => Promise<{ remote: string; branch: string }>;
  /** Open (or re-return) a GitHub PR for the selected thread's branch. */
  createPr: (input: {
    title: string;
    body?: string;
    draft?: boolean;
    /** Override the PR-size cap for this creation (issue #402). */
    allowOversize?: boolean;
  }) => Promise<PrInfo>;
  /** Live PR for the selected thread's branch, or null when none. */
  prStatus: () => Promise<PrInfo | null>;
  /** CI checks for the selected thread's current PR. Failures are in-band. */
  prChecks: () => Promise<PrChecksResult>;
  /** Squash-merge the selected thread's current OPEN PR. */
  prMerge: () => Promise<PrInfo>;
  /** Open PRs for a project checkout (`gh pr list`). Failures are in-band. */
  listPrs: (projectPath: string) => Promise<ListPrsResult>;
  /** Issues for a project checkout (`gh issue list`). Failures are in-band. */
  listIssues: (projectPath: string) => Promise<ListIssuesResult>;
  /** Move an issue's plan:* label (Planboard). Failures are in-band. */
  setIssuePlanStatus: (
    projectPath: string,
    number: number,
    status: PlanStatus,
  ) => Promise<SetPlanStatusResult>;
  /** Cross-thread newest-first activity feed. */
  listActivity: () => Promise<ActivityItem[]>;
  /** Per-day / provider / model usage ledger. */
  listUsageByDay: () => Promise<UsageReport>;
  /** Receipt for the last unattended window (issue #323). */
  listDigest: (input?: { sinceMs?: number }) => Promise<DigestResult>;
  /** Close the digest window so the next one starts now. */
  markDigestSeen: () => Promise<{ seenAt: number }>;
  /** Per-thread summaries for the Agents tab team view. */
  listThreadSummaries: () => Promise<ThreadSummaryInfo[]>;
  /** Shared crew task list for the selected thread (issue #277). Read-only. */
  listCrewTasks: (
    threadId: string,
  ) => Promise<{ rootThreadId: string; tasks: CrewTaskView[] }>;
  /** Worktree checkpoints for a thread (newest-first). */
  listCheckpoints: (threadId: string) => Promise<CheckpointInfo[]>;
  /** Hard-reset the thread worktree to a checkpoint sha. */
  restoreCheckpoint: (threadId: string, sha: string) => Promise<void>;
  /** Per-checkpoint-pair shortstat for a thread. Never rejects. */
  runStats: (threadId: string) => Promise<RunStatInfo[]>;
  /** Predicted merge conflicts between active threads (#249). Never rejects. */
  conflictForecast: (projectId: string) => Promise<ConflictForecast>;
  /** Local TCP listeners whose cwd is the thread worktree or project. */
  listLocalServers: (threadId: string) => Promise<LocalServerInfo[]>;
  /** Reveal the selected thread root in Finder. */
  revealInFinder: () => Promise<void>;
  /** Open the selected thread root in the default editor. */
  openInEditor: () => Promise<void>;
  /** Ahead/behind vs upstream for a thread root. */
  gitSyncInfo: (threadId: string) => Promise<GitSyncInfo>;
  /** Fetch remotes for a thread root. */
  gitFetch: (threadId: string) => Promise<void>;
  /** Origin owner/repo + web URL for a thread root. Never rejects. */
  gitRepoInfo: (threadId: string) => Promise<GitRepoInfo>;
  /** `git pull --ff-only` for a thread root. Never rejects. */
  gitPull: (threadId: string) => Promise<GitPullResult>;
  /** Runnable package.json scripts (dev/start/serve) at the thread root. */
  listDevScripts: (threadId: string) => Promise<string[]>;
  /** Start the thread's npm dev script. */
  startDevServer: (threadId: string, script: string) => Promise<DevServerState>;
  /** Stop the thread's spawned dev server. */
  stopDevServer: (threadId: string) => Promise<DevServerState>;
  /** Live status for the thread's spawned dev server. */
  devServerStatus: (threadId: string) => Promise<DevServerState>;
  /** Arm or clear the thread's verification command (issue #296). */
  setVerifyCommand: (threadId: string, command: string | null) => Promise<void>;
  /** Run the thread's verification command now. Rejects on an active run. */
  runVerify: (threadId: string) => Promise<VerifyResult>;
  /** Live spend + memory server status. */
  appStatus: AppStatus | null;
  /** Persisted app settings (daily budget). */
  settings: AppSettings | null;
  /** Patch settings; updates local state from the returned value. */
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  /** Re-fetch app.status() (e.g. after a run settles). */
  refreshStatus: () => Promise<void>;
  /** Auto-update check result; null until the boot check settles. */
  updateStatus: UpdateStatus | null;
  /** Manual "Check for updates" — re-runs the check and refreshes status. */
  checkUpdate: () => Promise<void>;
  /** User-initiated download+install of the available update. */
  downloadUpdate: () => Promise<void>;
  /** Relaunch into a staged update. */
  applyUpdate: () => Promise<void>;
  /**
   * Re-fetch providers.list() into state. Cheap and silent: fixes the
   * boot-only fetch going stale when a CLI is installed mid-session.
   */
  refreshProviders: () => Promise<void>;
  projectById: Map<string, ProjectInfo>;
  /** Thin memory passthroughs; callers hold list/search state locally. */
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
    citations?: MemoryCitation[];
  }) => Promise<{ id: string }>;
  lintAgentConfig: (input: {
    projectId: string;
  }) => Promise<AgentConfigDoctorReport>;
  previewAgentConfig: (input: {
    projectId: string;
    targets?: string[];
  }) => Promise<AgentConfigPreview>;
  writeAgentConfig: (input: {
    projectId: string;
    targets?: string[];
  }) => Promise<AgentConfigWriteResult>;
  /** Thin skills passthroughs; SkillsTab holds list state locally. */
  listSkills: (input?: { projectPath?: string }) => Promise<SkillInfo[]>;
  addSkill: (
    input: SkillWrite,
  ) => Promise<{ name: string; installedIn: SkillTarget[] }>;
  removeSkill: (input: { name: string }) => Promise<void>;
  syncSkills: () => Promise<{ copied: number; skills: string[] }>;
  listCliCommands: (input?: {
    projectPath?: string;
  }) => Promise<CliSlashCommand[]>;
  /** Full-content thread search (titles + message text); Sidebar owns debounce/state. */
  searchThreads: (input: { query: string }) => Promise<ThreadInfo[]>;
  /** Load another thread's transcript without marking it visited (#393). */
  peekThread: (id: string) => Promise<ThreadDetail>;
}

export function useCoder(): UseCoderResult {
  const api = useMemo(() => resolveApi(), []);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplateInfo[]>([]);
  const [automations, setAutomations] = useState<AutomationInfo[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  /** Last threads.get failure for the selected thread; retry bumps the nonce. */
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRetryNonce, setDetailRetryNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CoderError | null>(null);
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const selectedRef = useRef<string | null>(null);
  /** Bumped on every threads:changed push so a late initial list cannot clobber it. */
  const threadsListGen = useRef(0);
  const threadsRef = useRef<ThreadInfo[]>([]);
  /** Prior status by thread id; used to detect working → settled for spend refresh. */
  const prevStatusRef = useRef<Map<string, ThreadInfo["status"]>>(new Map());
  /** Open detail, for merging streamed tails (thread:updated is a ThreadPatch). */
  const detailRef = useRef<ThreadDetail | null>(null);
  /** Threads with a full-detail refetch in flight, so pushes can't storm it. */
  const refetchRef = useRef<Set<string>>(new Set());
  /** Last thread:updated seq per thread; a gap means pushes were dropped. */
  const patchSeqRef = useRef<Map<string, number>>(new Map());
  /**
   * Follow-ups typed while a thread was working (issue #92/#137). Main
   * drains the persisted queue at the run terminal (issue #314); the
   * renderer only displays it and offers cancel / retry.
   */
  const queued = useMemo(() => {
    const next: Record<string, QueuedMessage> = {};
    for (const t of threads) {
      if (t.queued) next[t.id] = t.queued;
    }
    return next;
  }, [threads]);

  useEffect(() => {
    selectedRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  /** Refetch the whole transcript after a patch could not be merged. */
  const reloadDetail = useCallback(
    (threadId: string) => {
      if (refetchRef.current.has(threadId)) return;
      refetchRef.current.add(threadId);
      void api.threads
        .get(threadId)
        .then((d) => {
          if (selectedRef.current === threadId) setDetail(d);
        })
        .catch(() => {
          // Best effort; the next mergeable push repairs the view.
        })
        .finally(() => {
          refetchRef.current.delete(threadId);
        });
    },
    [api],
  );

  const applyThreads = useCallback((next: ThreadInfo[]) => {
    threadsRef.current = next;
    setThreads(next);
  }, []);

  const cancelQueued = useCallback(
    (threadId?: string) => {
      const id = threadId ?? selectedRef.current;
      if (!id) return;
      const held = threadsRef.current.find((t) => t.id === id);
      if (!held?.queued) return;
      applyThreads(
        threadsRef.current.map((t) =>
          t.id === id ? { ...t, queued: null } : t,
        ),
      );
      void api.threads.setQueued({ threadId: id, prompt: null }).catch((err) => {
        setError({ scope: "run", message: errorMessage(err) });
      });
    },
    [api, applyThreads],
  );

  const retryQueued = useCallback(
    (threadId?: string) => {
      const id = threadId ?? selectedRef.current;
      if (!id) return;
      const held = threadsRef.current.find((t) => t.id === id);
      const pending = held?.queued;
      if (!pending || held?.status === "working") return;
      // Clear first so a second click cannot double-send.
      applyThreads(
        threadsRef.current.map((t) =>
          t.id === id ? { ...t, queued: null } : t,
        ),
      );
      void (async () => {
        try {
          await api.threads.setQueued({ threadId: id, prompt: null });
          await api.runs.start({
            threadId: id,
            prompt: pending.prompt,
            attachments: pending.attachments,
          });
        } catch (err) {
          // A failed retry must not eat the prompt — that is the loss this
          // issue exists to kill. Put it back, with the new error on it.
          setError({ scope: "run", message: errorMessage(err) });
          await api.threads
            .setQueued({
              threadId: id,
              prompt: pending.prompt,
              attachments: pending.attachments,
            })
            .catch(() => null);
          // setQueued clears the stored error (a fresh queue is not a failed
          // one), so the reason lives on the local row until the next attempt.
          applyThreads(
            threadsRef.current.map((t) =>
              t.id === id
                ? { ...t, queued: { ...pending, error: errorMessage(err) } }
                : t,
            ),
          );
        }
      })();
    },
    [api, applyThreads],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await api.app.status();
      setAppStatus(status);
    } catch {
      // Status is best-effort for the spend meter; ignore transient failures.
    }
  }, [api]);

  // A rejected update call used to be an unhandled rejection: the spinner
  // stopped, nothing was said, and a stale "Up to date." stayed on screen.
  // The updater's own failures already come back as state:"error", so reuse
  // that shape for transport/handler failures instead of a second channel.
  const failUpdate = useCallback((err: unknown) => {
    setUpdateStatus((prev) => ({
      channel: prev?.channel ?? null,
      tag: prev?.tag ?? null,
      url: prev?.url ?? null,
      state: "error",
      error: err instanceof Error && err.message ? err.message : String(err),
    }));
  }, []);

  const applyUpdate = useCallback(async () => {
    try {
      await api.app.applyUpdate();
    } catch (err) {
      failUpdate(err);
    }
  }, [api, failUpdate]);

  const checkUpdate = useCallback(async () => {
    try {
      setUpdateStatus(await api.app.checkUpdate());
    } catch (err) {
      failUpdate(err);
    }
  }, [api, failUpdate]);

  const downloadUpdate = useCallback(async () => {
    try {
      setUpdateStatus(await api.app.downloadUpdate());
    } catch (err) {
      failUpdate(err);
    }
  }, [api, failUpdate]);

  // Auto-update: check on boot, then every 6h. The check only asks the release
  // API — downloading and swapping the bundle waits for a user click.
  // Missing handler (old backend) leaves status null.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      try {
        // try/catch: a stale preload/backend without app:checkUpdate must not
        // take the boot effect down with a synchronous TypeError.
        void api.app
          .checkUpdate()
          .then((u) => {
            if (!cancelled) setUpdateStatus(u);
          })
          .catch(() => {});
      } catch {
        // update checks are strictly best-effort
      }
    };
    check();
    const timer = setInterval(check, 6 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api]);

  // Initial load + subscriptions
  useEffect(() => {
    let cancelled = false;
    let unsubChanged: (() => void) | undefined;
    let unsubUpdated: (() => void) | undefined;
    let unsubSelect: (() => void) | undefined;

    unsubChanged = api.on("threads:changed", (next) => {
      threadsListGen.current += 1;
      applyThreads(next);
      // Import (and any other main-process mint) can add projects without
      // going through projects.add. Refresh so the sidebar sees them.
      if (typeof api.projects?.list === "function") {
        void api.projects.list().then((p) => {
          if (!cancelled) setProjects(p);
        }).catch(() => {});
      }
    });

    unsubSelect = api.on("thread:select", (id) => {
      if (typeof id === "string" && id) {
        setSelectedThreadId(id);
      }
    });

    unsubUpdated = api.on("thread:updated", (next) => {
      const prev = prevStatusRef.current.get(next.thread.id);
      const held = threadsRef.current.find((t) => t.id === next.thread.id);
      prevStatusRef.current.set(next.thread.id, next.thread.status);
      // Main owns the queue now (#314): an explicit null means it drained or
      // cleared it, and holding onto our copy would strand the chip forever.
      // Only a push that OMITS the field (fixtures, partial rows) falls back.
      const incoming = next.thread;
      const row =
        incoming.queued === undefined && held?.queued
          ? { ...incoming, queued: held.queued }
          : incoming;
      // List and open detail are separate subscribers of the same push: a tick
      // that only moved the transcript must not hand the list a new array, or
      // every pane holding it re-renders (issue #91).
      const nextList = patchThreadList(threadsRef.current, row);
      if (nextList !== threadsRef.current) applyThreads(nextList);
      const lastSeq = patchSeqRef.current.get(next.thread.id);
      if (next.seq != null) patchSeqRef.current.set(next.thread.id, next.seq);
      // A gap means a push was dropped (web reconnect): the prefix we hold may
      // be stale, so refetch rather than merge onto it.
      const dropped =
        next.seq != null && lastSeq != null && next.seq !== lastSeq + 1;
      if (selectedRef.current === next.thread.id) {
        const open = detailRef.current;
        if (open && open.thread.id === next.thread.id) {
          const merged = dropped ? null : mergeThreadPatch(open, next);
          if (merged) setDetail(merged);
          else reloadDetail(next.thread.id);
        } else if (!next.messagesFrom && !next.workLogFrom) {
          setDetail(next);
        }
        // Nothing open and only a tail: the in-flight threads.get lands it.
      }
      // Refresh spend when a thread leaves "working" (run finished or stopped).
      if (prev === "working" && next.thread.status !== "working") {
        void refreshStatus();
      }
    });

    const loadGen = threadsListGen.current;

    (async () => {
      try {
        // status/settings are best-effort: missing IPC handlers (merge before
        // backend) must not blank the whole boot (no catch on this IIFE).
        const [p, list, prov, wfs, autos, status, sett] = await Promise.all([
          api.projects.list(),
          api.threads.list(),
          api.providers.list(),
          api.workflows.list(),
          api.automations.list().catch(() => [] as AutomationInfo[]),
          api.app.status().catch(() => null),
          api.settings.get().catch(() => null),
        ]);
        if (cancelled) return;
        setProjects(p);
        setProviders(prov);
        setWorkflows(wfs);
        setAutomations(autos);
        if (status != null) setAppStatus(status);
        if (sett != null) setSettings(sett);
        for (const t of list) {
          prevStatusRef.current.set(t.id, t.status);
        }
        if (threadsListGen.current === loadGen) {
          applyThreads(list);
        }
        const source =
          threadsListGen.current === loadGen ? list : threadsRef.current;
        const preferred =
          source.find((t) => !t.archived && t.status === "working")?.id ??
          source.find((t) => !t.archived)?.id ??
          null;
        setSelectedThreadId((prev) => prev ?? preferred);
        if (selectedRef.current == null && preferred) {
          selectedRef.current = preferred;
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    // Shared 60s interval for the spend meter (same pattern as sidebar age tick).
    const statusHandle = window.setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_MS);

    return () => {
      cancelled = true;
      unsubChanged?.();
      unsubUpdated?.();
      unsubSelect?.();
      window.clearInterval(statusHandle);
    };
  }, [api, applyThreads, refreshStatus, reloadDetail]);

  // Load ThreadDetail when selection changes. threads.get stamps lastVisitedAt
  // (select = visit); merge the returned row into the list so the sidebar
  // unread dot clears without waiting for a separate threads:changed push.
  useEffect(() => {
    if (!selectedThreadId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailError(null);
    (async () => {
      try {
        const d = await api.threads.get(selectedThreadId);
        if (cancelled) return;
        setDetail(d);
        setDetailError(null);
        applyThreads(
          threadsRef.current.map((t) =>
            t.id === d.thread.id ? d.thread : t,
          ),
        );
      } catch (err) {
        if (!cancelled) {
          setDetail(null);
          setDetailError(errorMessage(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, selectedThreadId, applyThreads, detailRetryNonce]);

  const projectById = useMemo(() => {
    const m = new Map<string, ProjectInfo>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const selectedProjectId = useMemo(() => {
    if (selectedThreadId) {
      const t = threads.find((x) => x.id === selectedThreadId);
      if (t) return t.projectId;
    }
    return projects[0]?.id ?? null;
  }, [selectedThreadId, threads, projects]);

  const selectThread = useCallback((id: string | null) => {
    setSelectedThreadId(id);
  }, []);

  /** Re-run the detail fetch for the already-selected thread (error retry). */
  const retryDetail = useCallback(() => {
    setDetailError(null);
    setDetailRetryNonce((n) => n + 1);
  }, []);

  const addProject = useCallback(async (
    path?: string,
    opts?: { remoteHost?: string; remotePath?: string },
  ) => {
    try {
      const trimmed = typeof path === "string" ? path.trim() : "";
      const remoteHost = opts?.remoteHost?.trim() || "";
      const remotes = remoteHost
        ? {
            remoteHost,
            remotePath: opts?.remotePath?.trim() || undefined,
          }
        : undefined;
      // Native folder picker cannot run without Electron. Web callers must
      // pass a path (the path-input modal). Never fall through to addViaDialog.
      if (isWebMode() && !trimmed && !remoteHost) return null;
      const p = trimmed || remoteHost
        ? await api.projects.add(trimmed || remotes?.remotePath || "", remotes)
        : await api.projects.addViaDialog();
      if (p) {
        setProjects((prev) => {
          if (prev.some((x) => x.id === p.id)) return prev;
          return [...prev, p];
        });
        setError(null);
      }
      return p;
    } catch (err) {
      setError({ scope: "project", message: errorMessage(err) });
      return null;
    }
  }, [api]);

  const createProject = useCallback(async (input: CreateProjectInput) => {
    try {
      const p = await api.projects.create({
        name: input.name.trim(),
        parentDir: input.parentDir.trim(),
      });
      setProjects((prev) => {
        if (prev.some((x) => x.id === p.id)) return prev;
        return [...prev, p];
      });
      setError(null);
      return p;
    } catch (err) {
      setError({ scope: "project", message: errorMessage(err) });
      return null;
    }
  }, [api]);

  const updateProject = useCallback(async (input: ProjectUpdateInput) => {
    try {
      const updated = await api.projects.update(input);
      setProjects((prev) =>
        prev.map((p) => (p.id === updated.id ? updated : p)),
      );
      setError(null);
      return updated;
    } catch (err) {
      setError({ scope: "project", message: errorMessage(err) });
      return null;
    }
  }, [api]);

  const createThread = useCallback(
    async (
      title = "New Thread",
      projectId?: string,
      opts?: {
        worktree?: boolean;
        orchestrate?: boolean;
        teach?: boolean;
        ask?: boolean;
        issueNumber?: number | null;
      },
    ) => {
      const pid = projectId ?? selectedProjectId;
      if (!pid) return null;
      // Settings can default new threads into a worktree or into an
      // orchestrator; explicit opts win. Both are local-only, so remote
      // projects always get plain threads. An orchestrator never holds a
      // worktree itself — its worker does — so it wins over `worktree`.
      // Ask (issue #392) wins over both: a Q&A thread must never grow a
      // worktree or fork a worker, even when those defaults are on.
      const project = projects.find((p) => p.id === pid);
      const local = !project?.remoteHost;
      const ask = opts?.ask === true;
      const orchestrate =
        !ask &&
        (opts?.orchestrate ?? (settings?.defaultOrchestrate === true && local));
      const worktree =
        !ask &&
        !orchestrate &&
        (opts?.worktree ?? (settings?.defaultWorktree === true && local));
      // Inherit provider+model from the currently selected thread when present.
      const inheritFrom = selectedRef.current
        ? threadsRef.current.find((x) => x.id === selectedRef.current)
        : undefined;
      let t;
      try {
        t = await api.threads.create({
          projectId: pid,
          title,
          ...(worktree ? { worktree: true } : {}),
          ...(orchestrate ? { orchestrate: true } : {}),
          ...(opts?.teach ? { teach: true } : {}),
          ...(ask ? { ask: true } : {}),
          ...(opts?.issueNumber != null ? { issueNumber: opts.issueNumber } : {}),
        });
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        return null;
      }
      if (inheritFrom) {
        const needsProvider = inheritFrom.provider !== t.provider;
        const needsModel = inheritFrom.model !== t.model;
        if (needsProvider || needsModel) {
          t = await api.threads.setProvider({
            threadId: t.id,
            ...(needsProvider ? { provider: inheritFrom.provider } : {}),
            ...(needsModel || needsProvider
              ? { model: inheritFrom.model }
              : {}),
          });
        }
      }
      const next = threadsRef.current.some((x) => x.id === t.id)
        ? threadsRef.current.map((x) => (x.id === t.id ? t : x))
        : [t, ...threadsRef.current];
      applyThreads(next);
      selectedRef.current = t.id;
      setSelectedThreadId(t.id);
      return t;
    },
    [api, selectedProjectId, applyThreads, projects, settings],
  );

  const forkThread = useCallback(
    async (
      threadId: string,
      opts?: { provider?: string; model?: string | null; worktree?: boolean },
    ) => {
      try {
        const input: {
          threadId: string;
          provider?: string;
          model?: string | null;
          worktree?: boolean;
        } = { threadId };
        if (opts && Object.prototype.hasOwnProperty.call(opts, "provider")) {
          input.provider = opts.provider;
        }
        if (opts && Object.prototype.hasOwnProperty.call(opts, "model")) {
          input.model = opts.model;
        }
        if (opts && Object.prototype.hasOwnProperty.call(opts, "worktree")) {
          input.worktree = opts.worktree;
        }
        const t = await api.threads.fork(input);
        // Same selection path as createThread: prepend row, select new id.
        const next = threadsRef.current.some((x) => x.id === t.id)
          ? threadsRef.current.map((x) => (x.id === t.id ? t : x))
          : [t, ...threadsRef.current];
        applyThreads(next);
        setSelectedThreadId(t.id);
        setError(null);
        return t;
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        return null;
      }
    },
    [api, applyThreads],
  );

  const startRun = useCallback(
    async (
      prompt: string,
      targetThreadId?: string,
      attachments?: AttachmentInfo[],
    ) => {
      const threadId = targetThreadId ?? selectedThreadId;
      if (!threadId) return;
      // Side question (issue #471): intercept BEFORE the busy-queue path so
      // `/btw` never becomes the next follow-up and never starts a main turn.
      const btwQuestion = parseBtwCommand(prompt);
      if (btwQuestion) {
        try {
          const updated = await api.threads.btw({
            threadId,
            question: btwQuestion,
          });
          applyThreads(
            threadsRef.current.map((t) =>
              t.id === updated.id ? updated : t,
            ),
          );
          setDetail((prev) =>
            prev && prev.thread.id === updated.id
              ? { ...prev, thread: updated }
              : prev,
          );
          setError(null);
        } catch (err) {
          setError({ scope: "run", message: errorMessage(err) });
          throw err;
        }
        return;
      }
      // Busy thread: hold the prompt instead of bouncing off the backend's
      // "run already active" (issue #92). Append lives in setQueued so two
      // mid-run sends cannot race-replace each other across the IPC hop.
      if (
        threadsRef.current.find((t) => t.id === threadId)?.status === "working"
      ) {
        try {
          const updated = await api.threads.setQueued({
            threadId,
            prompt,
            attachments,
          });
          applyThreads(
            threadsRef.current.map((t) =>
              t.id === updated.id ? updated : t,
            ),
          );
          setDetail((prev) =>
            prev && prev.thread.id === updated.id
              ? { ...prev, thread: updated }
              : prev,
          );
          setError(null);
        } catch (err) {
          setError({ scope: "run", message: errorMessage(err) });
        }
        return;
      }
      try {
        await api.runs.start({ threadId, prompt, attachments });
        const d = await api.threads.get(threadId);
        if (selectedRef.current !== threadId) return;
        setDetail(d);
        applyThreads(
          threadsRef.current.map((t) =>
            t.id === d.thread.id ? d.thread : t,
          ),
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const rewindAndResubmit = useCallback(
    async (
      messageId: string,
      prompt: string,
      restoreFiles?: boolean,
      attachments?: AttachmentInfo[],
    ) => {
      const threadId = selectedThreadId;
      if (!threadId) return;
      try {
        await api.threads.rewind({
          threadId,
          messageId,
          prompt,
          restoreFiles,
        });
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
      // The transcript we hold is now longer than the stored one. A run push
      // would repair it, but only if the run starts — so refetch here, or a
      // failed start leaves dropped messages on screen as if nothing happened.
      reloadDetail(threadId);
      await startRun(prompt, threadId, attachments);
    },
    [api, selectedThreadId, startRun, reloadDetail],
  );

  const refreshWorkflows = useCallback(async () => {
    const list = await api.workflows.list();
    setWorkflows(list);
  }, [api]);

  const refreshAutomations = useCallback(async () => {
    const list = await api.automations.list();
    setAutomations(list);
  }, [api]);

  const addAutomation = useCallback(
    async (input: AutomationWrite) => {
      const created = await api.automations.add(input);
      await refreshAutomations();
      return created;
    },
    [api, refreshAutomations],
  );

  const updateAutomation = useCallback(
    async (input: Partial<AutomationWrite> & { id: string }) => {
      const updated = await api.automations.update(input);
      await refreshAutomations();
      return updated;
    },
    [api, refreshAutomations],
  );

  const removeAutomation = useCallback(
    async (automationId: string) => {
      await api.automations.remove({ id: automationId });
      await refreshAutomations();
    },
    [api, refreshAutomations],
  );

  const runAutomationNow = useCallback(
    async (automationId: string) => {
      try {
        return await api.automations.runNow({ id: automationId });
      } finally {
        // runNow rethrows the agent failure AFTER the main process has already
        // written lastError, so the row only shows it if we resync on the
        // throwing path too (issue #85).
        await refreshAutomations();
      }
    },
    [api, refreshAutomations],
  );

  const startWorkflowRun = useCallback(
    async (prompt: string, templateId?: string) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      try {
        await api.runs.startWorkflow({
          threadId,
          prompt,
          ...(templateId ? { templateId } : {}),
        });
        const d = await api.threads.get(threadId);
        if (selectedRef.current !== threadId) return;
        setDetail(d);
        applyThreads(
          threadsRef.current.map((t) =>
            t.id === d.thread.id ? d.thread : t,
          ),
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const saveWorkflow = useCallback(
    async (template: WorkflowSaveInput) => {
      const saved = await api.workflows.save(template);
      await refreshWorkflows();
      return saved;
    },
    [api, refreshWorkflows],
  );

  const removeWorkflow = useCallback(
    async (workflowId: string) => {
      await api.workflows.remove({ id: workflowId });
      await refreshWorkflows();
    },
    [api, refreshWorkflows],
  );

  const stopRun = useCallback(async () => {
    if (!selectedThreadId) return;
    const threadId = selectedThreadId;
    try {
      await api.runs.stop({ threadId });
      const d = await api.threads.get(threadId);
      if (selectedRef.current !== threadId) return;
      setDetail(d);
      applyThreads(
        threadsRef.current.map((t) =>
          t.id === d.thread.id ? d.thread : t,
        ),
      );
    } catch (err) {
      setError({ scope: "run", message: errorMessage(err) });
    }
  }, [api, selectedThreadId, applyThreads]);

  const setPermissionMode = useCallback(
    async (mode: PermissionMode, threadIdArg?: string) => {
      const threadId = threadIdArg ?? selectedThreadId;
      if (!threadId) return;
      try {
        const thread = await api.threads.setPermissionMode({
          threadId,
          mode,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        if (selectedRef.current === threadId) {
          setDetail((prev) =>
            prev && prev.thread.id === thread.id
              ? { ...prev, thread }
              : prev,
          );
        }
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const respondPermission = useCallback(
    async (
      requestId: string,
      decision: PermissionDecision,
      answers?: Record<string, string>,
    ) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      try {
        // Updated detail (prompt cleared, decision event) arrives via
        // thread:updated pushed by the runner.
        await api.threads.respondPermission({
          threadId,
          requestId,
          decision,
          answers,
        });
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId],
  );

  const setProvider = useCallback(
    async (input: { provider?: string; model?: string | null }) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      try {
        const thread = await api.threads.setProvider({
          threadId,
          ...input,
        });
        if (selectedRef.current !== threadId) return;
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id
            ? { ...prev, thread }
            : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const setReasoningEffort = useCallback(
    async (effort: ReasoningEffort | null, threadIdArg?: string) => {
      const threadId = threadIdArg ?? selectedThreadId;
      if (!threadId) return;
      try {
        const thread = await api.threads.setReasoningEffort({
          threadId,
          effort,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        if (selectedRef.current === threadId) {
          setDetail((prev) =>
            prev && prev.thread.id === thread.id
              ? { ...prev, thread }
              : prev,
          );
        }
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const setArchived = useCallback(
    async (archived: boolean, threadIdArg?: string) => {
      const threadId = threadIdArg ?? selectedThreadId;
      if (!threadId) return false;
      try {
        const thread = await api.threads.setArchived({ threadId, archived });
        const next = threadsRef.current.map((t) =>
          t.id === thread.id ? thread : t,
        );
        applyThreads(next);
        // Only move selection when we archived the thread that was open.
        if (archived && selectedRef.current === threadId) {
          const nextId = nextVisibleThreadId(next, threadId);
          setSelectedThreadId(nextId);
          if (nextId == null) setDetail(null);
        } else if (selectedRef.current === threadId) {
          setDetail((prev) =>
            prev && prev.thread.id === thread.id
              ? { ...prev, thread }
              : prev,
          );
        }
        setError(null);
        return true;
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        return false;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const setSettled = useCallback(
    async (
      threadId: string,
      override: "settled" | "active" | null,
    ) => {
      try {
        const thread = await api.threads.setSettled({ threadId, override });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id
            ? { ...prev, thread }
            : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setPinned = useCallback(
    async (threadId: string, pinned: boolean) => {
      try {
        const thread = await api.threads.setPinned({ threadId, pinned });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id
            ? { ...prev, thread }
            : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setSnoozed = useCallback(
    async (threadId: string, until: number | null) => {
      try {
        const thread = await api.threads.setSnoozed({ threadId, until });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id
            ? { ...prev, thread }
            : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setMuted = useCallback(
    async (threadId: string, muted: boolean) => {
      try {
        const thread = await api.threads.setMuted({ threadId, muted });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setQuotaWaitAutoResume = useCallback(
    async (threadId: string, enabled: boolean | null) => {
      try {
        const thread = await api.threads.setQuotaWaitAutoResume({
          threadId,
          enabled,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const resumeQuotaWait = useCallback(
    async (threadId: string) => {
      try {
        await api.runs.resumeQuotaWait({ threadId });
        const d = await api.threads.get(threadId);
        if (selectedRef.current !== threadId) return;
        setDetail(d);
        applyThreads(
          threadsRef.current.map((t) =>
            t.id === d.thread.id ? d.thread : t,
          ),
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      try {
        const thread = await api.threads.rename({ threadId, title });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setNotes = useCallback(
    async (threadId: string, notes: string) => {
      try {
        const thread = await api.threads.setNotes({ threadId, notes });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const resolveSuggestion = useCallback(
    async (
      threadId: string,
      suggestionId: string,
      status: Exclude<WorkSuggestionStatus, "open">,
      extra?: { startedThreadId?: string; issueNumber?: number },
    ) => {
      try {
        const thread = await api.threads.resolveSuggestion({
          threadId,
          suggestionId,
          status,
          ...extra,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setFeltEstimate = useCallback(
    async (threadId: string, savedMs: number | null) => {
      try {
        const thread = await api.threads.setFeltEstimate({ threadId, savedMs });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const startSpec = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.startSpec({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const stopSpec = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.stopSpec({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const reviewSpec = useCallback(
    async (
      threadId: string,
      decision: "approve" | "revise",
      feedback?: string,
    ) => {
      try {
        const thread = await api.threads.reviewSpec({
          threadId,
          decision,
          feedback,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const specArtifact = useCallback(
    (threadId: string, stage: SpecArtifact) =>
      api.threads.specArtifact({ threadId, stage }),
    [api],
  );

  const dispatchSpec = useCallback(
    async (threadId: string) => {
      try {
        const result = await api.threads.dispatchSpec({ threadId });
        const thread = result.thread;
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const convergeSpec = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.convergeSpec({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const startTeach = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.startTeach({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const stopTeach = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.stopTeach({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const startAsk = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.startAsk({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const stopAsk = useCallback(
    async (threadId: string, opts?: { worktree?: boolean }) => {
      try {
        const thread = await api.threads.stopAsk({
          threadId,
          ...(opts?.worktree ? { worktree: true } : {}),
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const dismissBtw = useCallback(
    async (threadId: string, id: string) => {
      try {
        const thread = await api.threads.dismissBtw({ threadId, id });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const promoteBtw = useCallback(
    async (threadId: string, id: string) => {
      try {
        const thread = await api.threads.promoteBtw({ threadId, id });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const requestTeachReview = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.requestTeachReview({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const deleteThread = useCallback(async () => {
    if (!selectedThreadId) return;
    const threadId = selectedThreadId;
    try {
      await api.threads.delete({ threadId });
      const list = await api.threads.list();
      applyThreads(list);
      if (selectedRef.current === threadId) {
        const nextId = nextVisibleThreadId(list, threadId);
        setSelectedThreadId(nextId);
        setDetail(null);
      }
      setError(null);
    } catch (err) {
      setError({ scope: "run", message: errorMessage(err) });
    }
  }, [api, selectedThreadId, applyThreads]);

  const removeProject = useCallback(
    async (projectId: string) => {
      const pid = String(projectId ?? "");
      if (!pid) return;
      // Capture whether the open thread belongs to this project BEFORE the
      // remove — same "was the selected one the victim?" posture as deleteThread.
      const openId = selectedRef.current;
      const openBelongs =
        openId != null &&
        threadsRef.current.some(
          (t) => t.id === openId && t.projectId === pid,
        );
      try {
        await api.projects.remove({ projectId: pid });
        const [nextProjects, list] = await Promise.all([
          api.projects.list(),
          api.threads.list(),
        ]);
        setProjects(nextProjects);
        applyThreads(list);
        // Match deleteThread: only hand off when the selected thread was the
        // one that just vanished (here: lived in the removed project).
        if (openBelongs && openId != null && selectedRef.current === openId) {
          const nextId = nextVisibleThreadId(list, openId);
          setSelectedThreadId(nextId);
          setDetail(null);
        }
        setError(null);
      } catch (err) {
        // Re-throw so the App can show the error toast; do not swallow.
        throw err instanceof Error ? err : new Error(errorMessage(err));
      }
    },
    [api, applyThreads],
  );

  const applyThreadUpdate = useCallback(
    (thread: ThreadInfo) => {
      applyThreads(
        threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
      );
      setDetail((prev) =>
        prev && prev.thread.id === thread.id
          ? { ...prev, thread }
          : prev,
      );
    },
    [applyThreads],
  );

  const setupWorktree = useCallback(async () => {
    if (!selectedThreadId) return null;
    const threadId = selectedThreadId;
    const thread = await api.git.setupWorktree({ threadId });
    if (selectedRef.current !== threadId) return thread;
    applyThreadUpdate(thread);
    // Refresh detail in case main also mutates other fields.
    const d = await api.threads.get(threadId);
    if (selectedRef.current === threadId) setDetail(d);
    return thread;
  }, [api, selectedThreadId, applyThreadUpdate]);

  const mergeWorktree = useCallback(async () => {
    if (!selectedThreadId) return null;
    const threadId = selectedThreadId;
    const thread = await api.git.mergeWorktree({ threadId });
    if (selectedRef.current !== threadId) return thread;
    applyThreadUpdate(thread);
    const d = await api.threads.get(threadId);
    if (selectedRef.current === threadId) setDetail(d);
    return thread;
  }, [api, selectedThreadId, applyThreadUpdate]);

  const removeWorktree = useCallback(
    async (force = false) => {
      if (!selectedThreadId) return null;
      const threadId = selectedThreadId;
      const thread = await api.git.removeWorktree({ threadId, force });
      if (selectedRef.current !== threadId) return thread;
      applyThreadUpdate(thread);
      const d = await api.threads.get(threadId);
      if (selectedRef.current === threadId) setDetail(d);
      return thread;
    },
    [api, selectedThreadId, applyThreadUpdate],
  );

  const fetchDiff = useCallback(async () => {
    if (!selectedThreadId) {
      return { files: [], patch: "", truncated: false };
    }
    const threadId = selectedThreadId;
    return api.git.diff({ threadId });
  }, [api, selectedThreadId]);

  const fetchReviewContext = useCallback(async () => {
    if (!selectedThreadId) {
      return { annotation: null, symbols: [] as ReviewSymbol[], acceptedHunks: [] };
    }
    const threadId = selectedThreadId;
    return api.git.reviewContext({ threadId });
  }, [api, selectedThreadId]);

  const setReviewAccepted = useCallback(
    async (hashes: string[]) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      const thread = await api.git.setReviewAccepted({ threadId, hashes });
      if (selectedRef.current !== threadId) return;
      applyThreadUpdate(thread);
    },
    [api, selectedThreadId, applyThreadUpdate],
  );

  const commitChanges = useCallback(
    async (message: string) => {
      if (!selectedThreadId) {
        throw new Error("No thread selected");
      }
      const threadId = selectedThreadId;
      return api.git.commit({ threadId, message });
    },
    [api, selectedThreadId],
  );

  const revertFile = useCallback(
    async (path: string, status: string) => {
      if (!selectedThreadId) {
        throw new Error("No thread selected");
      }
      const threadId = selectedThreadId;
      return api.git.revertFile({ threadId, path, status });
    },
    [api, selectedThreadId],
  );

  const suggestCommitMessage = useCallback(async () => {
    if (!selectedThreadId) {
      throw new Error("No thread selected");
    }
    const threadId = selectedThreadId;
    return api.git.suggestCommitMessage({ threadId });
  }, [api, selectedThreadId]);

  const listFiles = useCallback(
    async (query: string) => {
      if (!selectedThreadId) return [];
      const threadId = selectedThreadId;
      const result = await api.files.list({ threadId, query });
      return result.files;
    },
    [api, selectedThreadId],
  );

  const resolvePaths = useCallback(
    async (paths: string[]) => {
      if (!selectedThreadId || paths.length === 0) {
        return paths.map((p) => ({ path: p, abs: null }));
      }
      try {
        const result = await api.files.resolve({
          threadId: selectedThreadId,
          paths,
        });
        return result.resolved;
      } catch {
        return paths.map((p) => ({ path: p, abs: null }));
      }
    },
    [api, selectedThreadId],
  );

  const openWorkspacePath = useCallback(
    async (abs: string, opts?: { reveal?: boolean }) => {
      if (!selectedThreadId || !abs) return;
      if (opts?.reveal) {
        await api.shell.reveal({ threadId: selectedThreadId, path: abs });
        return;
      }
      await api.shell.openPath({ threadId: selectedThreadId, path: abs });
    },
    [api, selectedThreadId],
  );

  const loadToolImage = useCallback(
    async (name: string) => {
      try {
        const result = await api.files.image({ name });
        return result.dataUrl;
      } catch {
        return null;
      }
    },
    [api],
  );

  const saveAttachmentImage = useCallback(
    async (dataUrl: string) => {
      if (!selectedThreadId) return null;
      const threadId = selectedThreadId;
      try {
        const result = await api.attachments.saveImage({ threadId, dataUrl });
        return result.attachment;
      } catch {
        return null;
      }
    },
    [api, selectedThreadId],
  );

  const pickAttachments = useCallback(async () => {
    if (isWebMode()) {
      if (!selectedThreadId) return [];
      return filesToAttachments(await pickWebImageFiles(), saveAttachmentImage);
    }
    const result = await api.attachments.pick();
    return result.attachments;
  }, [api, saveAttachmentImage, selectedThreadId]);

  const loadAttachmentImage = useCallback(
    async (path: string) => {
      try {
        const result = await api.attachments.readImage({ path });
        return result.dataUrl;
      } catch {
        return null;
      }
    },
    [api],
  );

  const dropAttachmentFiles = useCallback(
    async (files: File[]) => {
      // Absolute paths of dropped Files (including Finder directories)
      // exist only behind the Electron preload (webUtils). Web/dev
      // bridges fall back to saveImage, which cannot attach folders.
      const pathOf = api.attachments.droppedFilePath;
      if (!pathOf) return filesToAttachments(files, saveAttachmentImage);
      const paths = files
        .map((file) => {
          try {
            return pathOf(file);
          } catch {
            return "";
          }
        })
        .filter((p) => p.length > 0);
      if (!paths.length) return [];
      const result = await api.attachments.fromPaths({ paths });
      return result.attachments;
    },
    [api, saveAttachmentImage],
  );

  const pushBranch = useCallback(async () => {
    if (!selectedThreadId) {
      throw new Error("No thread selected");
    }
    const threadId = selectedThreadId;
    try {
      const result = await api.git.push({ threadId });
      setError(null);
      return result;
    } catch (err) {
      setError({ scope: "run", message: errorMessage(err) });
      throw err;
    }
  }, [api, selectedThreadId]);

  const createPr = useCallback(
    async (input: {
      title: string;
      body?: string;
      draft?: boolean;
      allowOversize?: boolean;
    }) => {
      if (!selectedThreadId) {
        throw new Error("No thread selected");
      }
      const threadId = selectedThreadId;
      try {
        const pr = await api.git.createPr({
          threadId,
          title: input.title,
          body: input.body,
          draft: input.draft,
          allowOversize: input.allowOversize,
        });
        if (selectedRef.current !== threadId) return pr;
        // createPr records prNumber/prUrl on the thread; refresh so the badge updates.
        const d = await api.threads.get(threadId);
        if (selectedRef.current === threadId) {
          applyThreadUpdate(d.thread);
          setDetail(d);
        }
        setError(null);
        return pr;
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreadUpdate],
  );

  const prStatus = useCallback(async () => {
    if (!selectedThreadId) return null;
    return api.git.prStatus({ threadId: selectedThreadId });
  }, [api, selectedThreadId]);

  const prChecks = useCallback(async () => {
    if (!selectedThreadId) return { ok: false as const, reason: "no PR" };
    return api.git.prChecks({ threadId: selectedThreadId });
  }, [api, selectedThreadId]);

  const prMerge = useCallback(async () => {
    if (!selectedThreadId) {
      throw new Error("No thread selected");
    }
    const threadId = selectedThreadId;
    try {
      const pr = await api.git.prMerge({ threadId });
      if (selectedRef.current !== threadId) return pr;
      const d = await api.threads.get(threadId);
      if (selectedRef.current === threadId) {
        applyThreadUpdate(d.thread);
        setDetail(d);
      }
      setError(null);
      return pr;
    } catch (err) {
      setError({ scope: "run", message: errorMessage(err) });
      throw err;
    }
  }, [api, selectedThreadId, applyThreadUpdate]);

  const listPrs = useCallback(
    async (projectPath: string) => {
      return api.git.listPrs(projectPath);
    },
    [api],
  );

  const listIssues = useCallback(
    async (projectPath: string) => {
      return api.issues.list(projectPath);
    },
    [api],
  );

  const setIssuePlanStatus = useCallback(
    async (projectPath: string, number: number, status: PlanStatus) => {
      return api.issues.setPlanStatus({ projectPath, number, status });
    },
    [api],
  );

  const createIssue = useCallback(
    async (projectPath: string, title: string, body: string) => {
      return api.issues.create({ projectPath, title, body });
    },
    [api],
  );

  const fetchIssue = useCallback(
    async (projectPath: string, ref: string) => {
      return api.issues.fetch({ projectPath, ref });
    },
    [api],
  );
  const listActivity = useCallback(async () => {
    return api.activity.list();
  }, [api]);

  const listUsageByDay = useCallback(async () => {
    return api.usage.byDay();
  }, [api]);

  const listDigest = useCallback(async (input?: { sinceMs?: number }) => {
    return api.digest.list(input);
  }, [api]);

  const markDigestSeen = useCallback(async () => {
    return api.digest.markSeen();
  }, [api]);

  const listThreadSummaries = useCallback(async () => {
    return api.threads.summaries();
  }, [api]);

  const listCrewTasks = useCallback(
    async (threadId: string) => {
      return api.threads.crewTasks({ threadId });
    },
    [api],
  );

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await api.providers.list());
    } catch {
      // Best-effort staleness fix; keep the boot list on failure.
    }
  }, [api]);

  const listCheckpoints = useCallback(
    async (threadId: string) => {
      return api.git.listCheckpoints({ threadId });
    },
    [api],
  );

  const restoreCheckpoint = useCallback(
    async (threadId: string, sha: string) => {
      await api.git.restoreCheckpoint({ threadId, sha });
    },
    [api],
  );

  const runStats = useCallback(
    async (threadId: string) => {
      try {
        return await api.git.runStats({ threadId });
      } catch {
        return [];
      }
    },
    [api],
  );

  const conflictForecast = useCallback(
    async (projectId: string) => {
      try {
        return await api.git.conflictForecast({ projectId });
      } catch {
        return { pairs: [], computedAt: 0 };
      }
    },
    [api],
  );

  const listLocalServers = useCallback(
    async (threadId: string) => {
      try {
        return await api.servers.list({ threadId });
      } catch {
        return [];
      }
    },
    [api],
  );

  const threadRootPath = useCallback((threadId: string): string | null => {
    const t = threadsRef.current.find((x) => x.id === threadId);
    if (!t) return null;
    if (t.worktreePath) return t.worktreePath;
    const p = projectById.get(t.projectId);
    return p?.path ?? null;
  }, [projectById]);

  const revealInFinder = useCallback(async () => {
    if (!selectedThreadId) return;
    const root = threadRootPath(selectedThreadId);
    if (!root) return;
    await api.shell.reveal({ threadId: selectedThreadId, path: root });
  }, [api, selectedThreadId, threadRootPath]);

  const openInEditor = useCallback(async () => {
    if (!selectedThreadId) return;
    const root = threadRootPath(selectedThreadId);
    if (!root) return;
    await api.shell.openPath({ threadId: selectedThreadId, path: root });
  }, [api, selectedThreadId, threadRootPath]);

  const gitSyncInfo = useCallback(
    async (threadId: string) => {
      try {
        return await api.git.syncInfo({ threadId });
      } catch {
        return { hasUpstream: false } as GitSyncInfo;
      }
    },
    [api],
  );

  const listDevScripts = useCallback(
    async (threadId: string) => {
      try {
        return await api.devserver.scripts({ threadId });
      } catch {
        return [];
      }
    },
    [api],
  );

  const gitFetch = useCallback(
    async (threadId: string) => {
      await api.git.fetch({ threadId });
    },
    [api],
  );

  const gitRepoInfo = useCallback(
    async (threadId: string): Promise<GitRepoInfo> => {
      try {
        return await api.git.repoInfo({ threadId });
      } catch {
        return { ok: false };
      }
    },
    [api],
  );

  const gitPull = useCallback(
    async (threadId: string): Promise<GitPullResult> => {
      try {
        return await api.git.pull({ threadId });
      } catch (err) {
        return {
          ok: false,
          reason:
            err instanceof Error && err.message ? err.message : "Pull failed",
        };
      }
    },
    [api],
  );

  const startDevServer = useCallback(
    async (threadId: string, script: string) => {
      return api.devserver.start({ threadId, script });
    },
    [api],
  );

  const stopDevServer = useCallback(
    async (threadId: string) => {
      return api.devserver.stop({ threadId });
    },
    [api],
  );

  const devServerStatus = useCallback(
    async (threadId: string) => {
      return api.devserver.status({ threadId });
    },
    [api],
  );

  const setVerifyCommand = useCallback(
    async (threadId: string, command: string | null) => {
      const thread = await api.threads.setVerifyCommand({ threadId, command });
      applyThreads(
        threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
      );
      setDetail((prev) =>
        prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
      );
    },
    [api, applyThreads],
  );

  const runVerify = useCallback(
    async (threadId: string) => {
      const result = await api.threads.runVerify({ threadId });
      applyThreads(
        threadsRef.current.map((t) =>
          t.id === threadId ? { ...t, verify: result } : t,
        ),
      );
      setDetail((prev) =>
        prev && prev.thread.id === threadId
          ? { ...prev, thread: { ...prev.thread, verify: result } }
          : prev,
      );
      return result;
    },
    [api, applyThreads],
  );

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = await api.settings.set(patch);
      setSettings(next);
      // Budget changes may affect how the meter is rendered.
      await refreshStatus();
      return next;
    },
    [api, refreshStatus],
  );

  const searchMemory = useCallback(
    async (input: { query: string; project?: string }) => {
      return api.memory.search(input);
    },
    [api],
  );

  const recentMemory = useCallback(
    async (input?: { limit?: number; project?: string }) => {
      const wantLimit =
        input?.limit != null && input.limit > 0 ? Math.floor(input.limit) : 20;
      const project =
        input?.project != null && input.project !== ""
          ? input.project
          : undefined;
      // Electron proxy may still ignore project on recent. Over-fetch so a
      // client-side filter can still surface project rows buried past limit 20.
      // The server canonicalizes the project key (display slugs like
      // "owner/repo" and cwd paths both map to the repo-root basename), so it
      // is authoritative: a client-side equality filter here would compare the
      // canonical key against the raw display slug and drop every row.
      const list = await api.memory.recent({
        limit: wantLimit,
        ...(project ? { project } : {}),
      });
      return list.slice(0, wantLimit);
    },
    [api],
  );

  const getMemory = useCallback(
    async (input: { id: string }) => {
      return api.memory.get(input);
    },
    [api],
  );

  const updateMemory = useCallback(
    async (input: { id: string; title: string; body: string }) => {
      return api.memory.update(input);
    },
    [api],
  );

  const removeMemory = useCallback(
    async (input: { id: string }) => {
      return api.memory.remove(input);
    },
    [api],
  );

  const storeMemory = useCallback(
    async (input: {
      type: MemoryEntryInfo["type"];
      title: string;
      body: string;
      project?: string;
      citations?: MemoryCitation[];
    }) => {
      return api.memory.store(input);
    },
    [api],
  );

  const lintAgentConfig = useCallback(
    async (input: { projectId: string }) => {
      return api.projects.lintAgentConfig(input);
    },
    [api],
  );

  const previewAgentConfig = useCallback(
    async (input: { projectId: string; targets?: string[] }) => {
      return api.projects.previewAgentConfig(input);
    },
    [api],
  );

  const writeAgentConfig = useCallback(
    async (input: { projectId: string; targets?: string[] }) => {
      return api.projects.writeAgentConfig(input);
    },
    [api],
  );

  const listSkills = useCallback(
    async (input?: { projectPath?: string }) => {
      return api.skills.list(input);
    },
    [api],
  );

  const addSkill = useCallback(
    async (input: SkillWrite) => {
      return api.skills.add(input);
    },
    [api],
  );

  const removeSkill = useCallback(
    async (input: { name: string }) => {
      return api.skills.remove(input);
    },
    [api],
  );

  const syncSkills = useCallback(async () => {
    return api.skills.sync();
  }, [api]);

  const listCliCommands = useCallback(
    async (input?: { projectPath?: string }) => {
      return api.skills.commands(input);
    },
    [api],
  );

  const searchThreads = useCallback(
    async (input: { query: string }) => {
      return api.threads.search(input);
    },
    [api],
  );

  /** Load another thread's transcript without marking it visited (#393). */
  const peekThread = useCallback(
    (id: string) => api.threads.peek(id),
    [api],
  );

  return {
    api,
    projects,
    threads,
    providers,
    workflows,
    automations,
    selectedThreadId,
    selectThread,
    detail,
    detailError,
    retryDetail,
    loading,
    selectedProjectId,
    error,
    clearError,
    addProject,
    createProject,
    updateProject,
    createThread,
    forkThread,
    startRun,
    rewindAndResubmit,
    queued,
    cancelQueued,
    retryQueued,
    startWorkflowRun,
    saveWorkflow,
    removeWorkflow,
    refreshWorkflows,
    refreshAutomations,
    addAutomation,
    updateAutomation,
    removeAutomation,
    runAutomationNow,
    stopRun,
    setPermissionMode,
    respondPermission,
    setProvider,
    setReasoningEffort,
    setArchived,
    setSettled,
    setPinned,
    setSnoozed,
    setMuted,
    setQuotaWaitAutoResume,
    resumeQuotaWait,
    renameThread,
    setNotes,
    resolveSuggestion,
    setFeltEstimate,
    startSpec,
    stopSpec,
    reviewSpec,
    specArtifact,
    dispatchSpec,
    convergeSpec,
    startTeach,
    stopTeach,
    startAsk,
    stopAsk,
    dismissBtw,
    promoteBtw,
    requestTeachReview,
    deleteThread,
    removeProject,
    setupWorktree,
    mergeWorktree,
    removeWorktree,
    fetchDiff,
    fetchReviewContext,
    setReviewAccepted,
    commitChanges,
    revertFile,
    suggestCommitMessage,
    listFiles,
    resolvePaths,
    openWorkspacePath,
    loadToolImage,
    pickAttachments,
    saveAttachmentImage,
    loadAttachmentImage,
    dropAttachmentFiles,
    pushBranch,
    createPr,
    prStatus,
    prChecks,
    prMerge,
    listPrs,
    listIssues,
    setIssuePlanStatus,
    createIssue,
    fetchIssue,
    listActivity,
    listUsageByDay,
    listDigest,
    markDigestSeen,
    listThreadSummaries,
    listCrewTasks,
    listCheckpoints,
    restoreCheckpoint,
    runStats,
    conflictForecast,
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
    appStatus,
    settings,
    saveSettings,
    refreshStatus,
    updateStatus,
    checkUpdate,
    downloadUpdate,
    applyUpdate,
    refreshProviders,
    projectById,
    searchMemory,
    recentMemory,
    getMemory,
    updateMemory,
    removeMemory,
    storeMemory,
    lintAgentConfig,
    previewAgentConfig,
    writeAgentConfig,
    listSkills,
    addSkill,
    removeSkill,
    syncSkills,
    listCliCommands,
    searchThreads,
    peekThread,
  };
}
