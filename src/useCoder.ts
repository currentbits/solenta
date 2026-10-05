import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityItem,
  AppSettings,
  WebhookTestResult,
  AppStatus,
  AttachmentInfo,
  AutomationInfo,
  AutomationRunsResult,
  AutomationWrite,
  CheckpointInfo,
  CoderApi,
  DigestResult,
  CreateProjectInput,
  RunStatInfo,
  ConflictContext,
  ConflictForecast,
  DevServerState,
  TerminalState,
  DiffResult,
  ReviewContext,
  GitSyncInfo,
  GitRepoInfo,
  GitPullResult,
  FetchIssueResult,
  CreateIssueResult,
  LocalServerInfo,
  MergeLaneBeat,
  MergeLaneClaim,
  MergeLaneInfo,
  MergeLanePreview,
  MergeLaneRecycle,
  MergeLaneRestore,
  MergeSpotlight,
  McpCatalogEntry,
  McpImportPreview,
  McpInstallRequest,
  McpInstallResult,
  McpPreviewImportInput,
  McpServerDefinition,
  McpServerSaveInput,
  MemoryCitation,
  MemoryEntryInfo,
  MemoryMaintenanceReport,
  MemoryReviewResolution,
  AgentConfigDoctorReport,
  AgentConfigPreview,
  AgentConfigWriteResult,
  ProjectCodeMap,
  PermissionDecision,
  InputValues,
  PermissionMode,
  PlanStatus,
  SetPlanStatusResult,
  ListIssuesResult,
  ListPrsOptions,
  ListPrsResult,
  CheckoutPrResult,
  PrChecksResult,
  PrCommentResult,
  PrDetailResult,
  PrInfo,
  PrTemplateResult,
  ProjectInfo,
  ProjectUpdateInput,
  ProviderInfo,
  ReasoningEffort,
  CliSessionCandidate,
  CliSlashCommand,
  SkillCatalogEntry,
  SkillImportPreview,
  SkillInstallRequest,
  SkillInstallResult,
  SkillInfo,
  SkillPreviewImportInput,
  SkillTarget,
  SkillWrite,
  HarnessSourceId,
  HarnessSourceInfo,
  HarnessImportPreview,
  HarnessInstallRequest,
  HarnessInstallResult,
  SimulatorStatus,
  SpecArtifact,
  StayAwakeMode,
  StayAwakeStatus,
  ThreadDetail,
  ThreadInfo,
  ThreadMessagePin,
  ThreadSummariesInput,
  ThreadSummaryInfo,
  TrashedThreadInfo,
  CrewTaskView,
  CrewIntegration,
  UpdateStatus,
  UsageReport,
  VerifyResult,
  CommandRunResult,
  WorkflowTemplateInfo,
  WorkSuggestionStatus,
} from "./shared/ipc";
import { resolveCoderApi } from "./coderApi";
import {
  mergeThreadPatch,
  patchThreadList,
  reconcileThreadList,
} from "./threadPatch";
import type { DroppedFolder } from "./dropFiles";
import type { EditorId, EditorOption, ProviderUsage } from "./shared/ipc";
import {
  loadBootSnapshot,
  loadCachedThreadDetail,
  saveBootSnapshot,
  saveCachedThreadDetail,
} from "./bootSnapshot";
import { createThreadDetailCache } from "./threadDetailCache";
import { errorMessage } from "./coder/errorMessage";
import { useCoderMemory } from "./coder/useCoderMemory";
import { useCoderAgentTools } from "./coder/useCoderAgentTools";
import { useCoderInsights } from "./coder/useCoderInsights";
import { useCoderRepoTools } from "./coder/useCoderRepoTools";
import { useCoderProjects } from "./coder/useCoderProjects";
import { useCoderUpdates } from "./coder/useCoderUpdates";
import { useCoderWorkflows } from "./coder/useCoderWorkflows";
import { useCoderGitHub } from "./coder/useCoderGitHub";
import { useCoderWorkspace } from "./coder/useCoderWorkspace";
import { useCoderThreadActions } from "./coder/useCoderThreadActions";
import { useCoderRuns } from "./coder/useCoderRuns";
import { useCoderThreadRemoval } from "./coder/useCoderThreadRemoval";

const STATUS_POLL_MS = 60_000;
/** Debounce on the localStorage boot-snapshot writes (#364). */
const BOOT_SNAPSHOT_DEBOUNCE_MS = 500;
/** Renderer-side GitHub releases poll. One GET; 60 unauth req/hour is plenty. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export type WorkflowSaveInput = Omit<WorkflowTemplateInfo, "id" | "builtin"> & {
  id?: string;
};

function resolveApi(): CoderApi {
  return resolveCoderApi();
}

/** A follow-up typed during a run, waiting for that run to land. */
export interface QueuedMessage {
  prompt: string;
  items?: string[];
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
  /** The built-in Scratch workspace ("start without a project", #1411). */
  ensureScratchProject: () => Promise<ProjectInfo | null>;
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
      baseBranch?: string | null;
      inheritProvider?: boolean;
    },
  ) => Promise<ThreadInfo | null>;
  /**
   * Fork / hand off a thread (threads.fork). Selects the new thread the same
   * way createThread does, unless `select: false` (background starts such as
   * suggested-work chips keep the user on the thread they clicked from).
   * Plain fork: no provider override. Hand-off: pass provider (and optional
   * model). Errors surface via error scope "run".
   */
  forkThread: (
    threadId: string,
    opts?: {
      provider?: string;
      model?: string | null;
      worktree?: boolean;
      select?: boolean;
    },
  ) => Promise<ThreadInfo | null>;
  /**
   * Start a run, or queue the prompt when that thread is already working:
   * the queued text is delivered at the run's terminal (issue #92).
   * Pass `steer: true` to inject into the live turn instead (issue #156).
   */
  startRun: (
    prompt: string,
    threadId?: string,
    attachments?: AttachmentInfo[],
    opts?: { fromNotice?: boolean; steer?: boolean; fromQueue?: boolean },
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
  /** Drop a thread's queued follow-up. Defaults to the selected thread.
   *  Resolves true once the host clear lands; false if there was nothing
   *  to drop or the persist rejected (overlay restored). */
  cancelQueued: (threadId?: string) => Promise<boolean>;
  /** Re-send a queued prompt after a delivery failure (issue #314). */
  retryQueued: (threadId?: string) => void;
  /** Replace a thread's queued follow-up text in place (issue #364 / #809). */
  editQueued: (
    prompt: string,
    threadId?: string,
    items?: string[],
  ) => Promise<void>;
  /** Fetch a GitHub or Linear issue for a project checkout. */
  fetchIssue: (
    projectPath: string,
    ref: string,
  ) => Promise<FetchIssueResult>;
  /**
   * Multi-phase Build workflow for the selected thread. Passes templateId to
   * runs.startWorkflow (backend validates phase providers).
   */
  startWorkflowRun: (prompt: string, templateId?: string) => Promise<void>;
  /** Re-spawn a failed workflow phase agent after the run ended (#825 / #830). */
  retryWorkflowAgent: (agentId: string) => Promise<void>;
  /**
   * Persist a workflow template. The returned row is authoritative even when
   * the follow-up list refresh fails (#1138). Saving a builtin creates a copy.
   */
  saveWorkflow: (template: WorkflowSaveInput) => Promise<WorkflowTemplateInfo>;
  /** Remove a non-builtin template. Success stands even if list refresh fails. */
  removeWorkflow: (id: string) => Promise<void>;
  /** Reload workflows.list() into state. */
  refreshWorkflows: () => Promise<void>;
  /** Failed workflows.list after a successful save/remove, or a manual retry. */
  workflowListError: string | null;
  refreshAutomations: () => Promise<void>;
  addAutomation: (input: AutomationWrite) => Promise<AutomationInfo>;
  updateAutomation: (
    input: Partial<AutomationWrite> & { id: string },
  ) => Promise<AutomationInfo>;
  removeAutomation: (id: string) => Promise<void>;
  runAutomationNow: (id: string) => Promise<AutomationInfo>;
  /** Retained run threads for one automation; does not start a run. */
  listAutomationRuns: (id: string) => Promise<AutomationRunsResult>;
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
    updatedCommand?: string,
    inputValues?: InputValues,
  ) => Promise<void>;
  /** Dismiss the selected thread's persisted question card (issue #647). */
  clearQuestion: () => Promise<void>;
  /**
   * Set provider and/or model. Defaults to the selected thread.
   * Pass threadId when applying a profile to a thread that is not selected
   * (planboard Start task, forks).
   */
  setProvider: (input: {
    provider?: string;
    model?: string | null;
    threadId?: string;
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
   * Enable or disable Codex live web search. Defaults to the selected thread.
   * Pass threadId when applying to a fork that is not selected.
   */
  setWebSearch: (webSearch: boolean, threadId?: string) => Promise<void>;
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
  /** Replace a thread's user-defined tags. Does not require selection. */
  setTags: (threadId: string, tags: string[]) => Promise<void>;
  /** Recategorize a thread onto another project. Does not require selection. */
  setThreadProject: (threadId: string, projectId: string) => Promise<void>;
  setMuted: (threadId: string, muted: boolean) => Promise<void>;
  setEjected: (threadId: string, ejected: boolean) => Promise<void>;
  setCrossThreadInbound: (
    threadId: string,
    policy: "accept" | "queue-only" | "refuse",
  ) => Promise<void>;
  setQuotaWaitAutoResume: (
    threadId: string,
    enabled: boolean | null,
  ) => Promise<void>;
  resumeQuotaWait: (threadId: string) => Promise<void>;
  /** Rename a thread. Does not require selection. */
  renameThread: (threadId: string, title: string) => Promise<void>;
  /** Save scratch notes on a thread (header editor, issue #194). */
  setNotes: (threadId: string, notes: string) => Promise<void>;
  /** Replace the per-thread transcript bookmark list (issue #1217). */
  setMessagePins: (
    threadId: string,
    pins: ThreadMessagePin[],
  ) => Promise<void>;
  /** Change the recorded merge/PR base after create (#187). */
  setBaseBranch: (threadId: string, baseBranch: string | null) => Promise<void>;
  /** Draft workspace choice: arm or drop the lazy worktree before first send. */
  setPendingWorktree: (
    threadId: string,
    worktree: boolean,
    fromOrigin?: boolean,
  ) => Promise<void>;
  /** Retarget an idle worker onto the lead's current committed HEAD. */
  refreshWorkerSnapshot: (threadId: string) => Promise<void>;
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
  /** Move the selected thread to Recently deleted (after caller confirms). */
  deleteThread: () => Promise<boolean>;
  /** Recently deleted rows for the restore list. */
  trashedThreads: TrashedThreadInfo[];
  /** Restore a Recently deleted thread. Returns true on success. */
  restoreThread: (threadId: string) => Promise<boolean>;
  /** Permanently delete a live or trashed thread. */
  purgeThread: (threadId: string) => Promise<boolean>;
  /**
   * Remove a project ENTRY and its threads' history (after caller confirms).
   * Repo on disk is never touched. On success refreshes projects + threads;
   * if the open thread belonged to that project, selection hands off exactly
   * like deleteThread (nextVisibleThreadId + clear detail). Rejects on
   * failure so the caller can show an error toast.
   */
  removeProject: (projectId: string) => Promise<void>;
  setupWorktree: () => Promise<ThreadInfo | null>;
  /** Local branches for the stacked-thread base picker (#187). */
  listBaseBranches: (
    projectId: string,
  ) => Promise<{ defaultBranch: string; branches: string[] }>;
  mergeWorktree: (opts?: {
    ciWorkflowApproved?: boolean;
  }) => Promise<ThreadInfo | null>;
  /** Unmerged worktree files plus capped conflict-marker snippets (#163). */
  conflictContext: (threadId: string) => Promise<ConflictContext>;
  removeWorktree: (force?: boolean) => Promise<ThreadInfo | null>;
  fetchDiff: () => Promise<DiffResult>;
  fetchReviewContext: () => Promise<ReviewContext>;
  setReviewAccepted: (hashes: string[]) => Promise<void>;
  /** Commit selected (or all) changes in the selected thread's cwd. */
  commitChanges: (
    message: string,
    paths?: string[],
  ) => Promise<{ subject: string }>;
  /**
   * Remember the Git pane's staged path list so mergeWorktree can stage
   * the same subset. `null` means the pane has not chosen a subset.
   */
  setStagedPaths: (paths: string[] | null) => void;
  /** Discard one changed file in the selected thread's cwd. */
  revertFile: (path: string, status: string) => Promise<{ path: string }>;
  /** Draft a commit message with the thread's provider (never commits). */
  suggestCommitMessage: () => Promise<{ message: string }>;
  /** File paths for the composer @-mention popup and the file palette. */
  listFiles: (query: string, opts?: { limit?: number }) => Promise<string[]>;
  /** Fixed-string content search in the selected thread's project. */
  searchFileContents: (query: string) => Promise<
    Array<{ path: string; line: number; text: string }>
  >;
  /** Native folder picker for @-mention browse. */
  pickDirectory: () => Promise<string | null>;
  /** AppSnap window list. */
  listSnapWindows: () => Promise<Array<{ id: string; name: string }>>;
  /** AppSnap capture into the selected thread. */
  captureSnapWindow: (sourceId: string) => Promise<AttachmentInfo | null>;
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
  /** Native file/image/folder picker, or a web <input type=file> for files. */
  pickAttachments: (opts?: {
    includeImages?: boolean;
  }) => Promise<AttachmentInfo[]>;
  /** Web-only folder pick via showDirectoryPicker; persists through saveFolder. */
  pickFolderAttachments: () => Promise<AttachmentInfo[]>;
  /** Persist a pasted image for the selected thread; null when rejected. */
  saveAttachmentImage: (dataUrl: string) => Promise<AttachmentInfo | null>;
  /** Data URL for one attached image; null when it is gone. */
  loadAttachmentImage: (path: string) => Promise<string | null>;
  /**
   * Classify drag-dropped files as attachments. Native resolves absolute
   * paths via the Electron preload; web reads each File as a data URL
   * (saveImage / saveFile) and walks directory entries into saveFolder.
   */
  dropAttachmentFiles: (
    files: File[],
    folders?: DroppedFolder[],
  ) => Promise<AttachmentInfo[]>;
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
  prMerge: (opts?: { ciWorkflowApproved?: boolean }) => Promise<PrInfo>;
  /** Open PRs for a project checkout (`gh pr list`). Failures are in-band. */
  listPrs: (
    projectPath: string,
    opts?: ListPrsOptions,
  ) => Promise<ListPrsResult>;
  /** Check out a PR into a worktree thread. Failures are in-band. */
  checkoutPr: (input: {
    projectId: string;
    prNumber: number;
  }) => Promise<CheckoutPrResult>;
  /** Repo PULL_REQUEST_TEMPLATE files. Failures are in-band. */
  prTemplate: (projectPath: string) => Promise<PrTemplateResult>;
  /** Full PR for the in-app workspace. Failures are in-band. */
  prDetail: (input: {
    projectPath: string;
    prNumber: number;
  }) => Promise<PrDetailResult>;
  prEdit: (input: {
    projectPath: string;
    prNumber: number;
    title?: string;
    body?: string;
  }) => Promise<PrDetailResult>;
  prComment: (input: {
    projectPath: string;
    prNumber: number;
    body: string;
  }) => Promise<PrCommentResult>;
  prClose: (input: {
    projectPath: string;
    prNumber: number;
  }) => Promise<PrDetailResult>;
  prReady: (input: {
    projectPath: string;
    prNumber: number;
    undo?: boolean;
  }) => Promise<PrDetailResult>;
  prMergeAt: (input: {
    projectPath: string;
    prNumber: number;
  }) => Promise<PrDetailResult>;
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
  listProviderLimits: () => Promise<ProviderUsage[]>;
  /** Receipt for the last unattended window (issue #323). */
  listDigest: (input?: { sinceMs?: number }) => Promise<DigestResult>;
  /** Close the digest window so the next one starts now. */
  markDigestSeen: () => Promise<{ seenAt: number }>;
  /** Per-thread summaries for the Agents tab team view. */
  listThreadSummaries: (input?: ThreadSummariesInput) => Promise<ThreadSummaryInfo[]>;
  /** Shared crew task list for the selected thread (issue #277). Read-only. */
  listCrewTasks: (
    threadId: string,
  ) => Promise<{ rootThreadId: string; tasks: CrewTaskView[] }>;
  /** Lead Integration view (#954 / #982). */
  crewIntegration: (threadId: string) => Promise<CrewIntegration>;
  /** Squash a crew worker onto the lead worktree (#954). */
  integrateWorker: (
    leadThreadId: string,
    workerThreadId: string,
    opts?: { ciWorkflowApproved?: boolean },
  ) => Promise<{ noop: boolean; merged: boolean }>;
  /** Worktree checkpoints for a thread (newest-first). */
  listCheckpoints: (threadId: string) => Promise<CheckpointInfo[]>;
  /** Hard-reset the thread worktree to a checkpoint sha. */
  restoreCheckpoint: (threadId: string, sha: string) => Promise<void>;
  /** Per-checkpoint-pair shortstat for a thread. Never rejects. */
  runStats: (threadId: string) => Promise<RunStatInfo[]>;
  /** Checkpoint-to-checkpoint patch for one turn. Never rejects. */
  fetchTurnDiff: (threadId: string, sha: string) => Promise<DiffResult>;
  /** Predicted merge conflicts between active threads (#249). Never rejects. */
  conflictForecast: (projectId: string) => Promise<ConflictForecast>;
  /** Local TCP listeners whose cwd is the thread worktree or project. */
  listLocalServers: (threadId: string) => Promise<LocalServerInfo[]>;
  /** Reveal the selected thread root in Finder. */
  revealInFinder: () => Promise<void>;
  /** Open the selected thread root in the default editor. */
  openInEditor: () => Promise<void>;
  /** Thread details "Open in" (#1411): installed editors + open with one. */
  listEditors: () => Promise<EditorOption[]>;
  openWorktreeIn: (editor: EditorId) => Promise<void>;
  /** Ahead/behind vs upstream for a thread root. */
  gitSyncInfo: (threadId: string) => Promise<GitSyncInfo>;
  /** Fetch remotes for a thread root. */
  gitFetch: (threadId: string) => Promise<void>;
  /** Origin owner/repo + web URL for a thread root. Never rejects. */
  gitRepoInfo: (threadId: string) => Promise<GitRepoInfo>;
  /** `git pull --ff-only` for a thread root. Never rejects. */
  gitPull: (threadId: string) => Promise<GitPullResult>;
  /** Claim the next free numbered merge-queue lane (#346). */
  claimLane: (input: { threadId: string }) => Promise<MergeLaneClaim>;
  /** Claimed merge-queue lanes for a project (#346 / #1114). */
  listLanes: (input: { projectId: string }) => Promise<MergeLaneInfo[]>;
  /** Mirror a lane onto the project checkout. */
  previewLane: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
  /** Undo a lane preview on the project checkout. */
  restorePreview: (input: { projectId: string }) => Promise<MergeLaneRestore>;
  /** Tear down wedged lanes. Does not close issues or move main. */
  recycleWedgedLanes: (input: {
    projectId: string;
  }) => Promise<MergeLaneRecycle[]>;
  /** Per-repo Spotlight opt-in (#250 stretch). */
  setSpotlight: (input: {
    projectId: string;
    enabled: boolean;
  }) => Promise<MergeSpotlight>;
  /** Hot-swap a claimed lane onto the project checkout via preview/restore. */
  spotlightLane: (input: {
    projectId: string;
    lane: number;
  }) => Promise<MergeLanePreview>;
  /** Stamp lastBeat on a claimed lane. Does not recycle or close issues. */
  heartbeatLane: (input: {
    threadId: string;
    now?: number;
  }) => Promise<MergeLaneBeat | null>;
  /** Runnable package.json scripts (dev/start/serve) at the thread root. */
  listDevScripts: (threadId: string) => Promise<string[]>;
  /** Start the thread's npm dev script. */
  startDevServer: (threadId: string, script: string) => Promise<DevServerState>;
  /** Stop the thread's spawned dev server. */
  stopDevServer: (threadId: string) => Promise<DevServerState>;
  /** Live status for the thread's spawned dev server. */
  devServerStatus: (threadId: string) => Promise<DevServerState>;
  /**
   * Terminal pane shell session (#147). Passed through as the namespace:
   * the pane owns the open/poll/close lifecycle, so unwrapping four
   * callbacks here would only be four more props to thread through App.
   */
  terminal: {
    open: (threadId: string) => Promise<TerminalState>;
    write: (
      threadId: string,
      data: string,
      since: number,
    ) => Promise<TerminalState>;
    read: (threadId: string, since: number) => Promise<TerminalState>;
    close: (threadId: string) => Promise<TerminalState>;
  };
  /** Embedded Browser pane guest (issue #155). Desktop-only. */
  preview: CoderApi["preview"];
  /** Desktop-only iOS Simulator pane (#248). */
  simulator: CoderApi["simulator"];
  simulatorStatus: SimulatorStatus | null;
  /** Arm or clear the thread's verification command (issue #296). */
  setVerifyCommand: (threadId: string, command: string | null) => Promise<void>;
  /** Run the thread's verification command now. Rejects on an active run. */
  runVerify: (threadId: string) => Promise<VerifyResult>;
  /** Run the project's setup command or a named quick action (issue #153). */
  runCommand: (
    threadId: string,
    actionId?: string,
  ) => Promise<CommandRunResult>;
  /** Live spend + memory server status. */
  appStatus: AppStatus | null;
  /** Persisted app settings (daily budget). */
  settings: AppSettings | null;
  /** Patch settings; updates local state from the returned value. */
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  /** Derived stay-awake state from main (issue #364); null until loaded. */
  stayAwake: StayAwakeStatus | null;
  /** Set the stay-awake mode (persisted via settings.stayAwake). */
  setStayAwakeMode: (mode: StayAwakeMode) => Promise<AppSettings>;
  /** POST a test payload to the saved webhook URL (issue #167). */
  testWebhook: () => Promise<WebhookTestResult>;
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
   * Re-fetch providers.list() into state. Cheap and silent by default: fixes
   * the boot-only fetch going stale when a CLI is installed mid-session.
   * Pass `{ throwOnError: true }` to surface a list failure (onboarding
   * Recheck); the previous list is still kept.
   */
  refreshProviders: (options?: { throwOnError?: boolean }) => Promise<void>;
  projectById: Map<string, ProjectInfo>;
  /** Thin memory passthroughs; callers hold list/search state locally. */
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
    citations?: MemoryCitation[];
  }) => Promise<{ id: string }>;
  maintenanceMemory: (input?: {
    project?: string;
    summary?: boolean;
  }) => Promise<MemoryMaintenanceReport>;
  resolveMemory: (input: {
    id: number;
    resolution: MemoryReviewResolution;
  }) => Promise<{ ok: boolean; id: number; resolution: string }>;
  loadCodeMap: (input: { projectId: string }) => Promise<ProjectCodeMap>;
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
  /** Dedicated MCP CRUD; results are public redacted definitions only. */
  listMcpServers: () => Promise<McpServerDefinition[]>;
  saveMcpServer: (input: McpServerSaveInput) => Promise<McpServerDefinition>;
  removeMcpServer: (input: { name: string }) => Promise<void>;
  setMcpEnabled: (input: {
    name: string;
    enabled: boolean;
  }) => Promise<McpServerDefinition>;
  listMcpCatalog: () => Promise<McpCatalogEntry[]>;
  pickMcpImport: () => Promise<McpImportPreview | null>;
  previewMcpImport: (input: McpPreviewImportInput) => Promise<McpImportPreview>;
  installMcpImport: (input: McpInstallRequest) => Promise<McpInstallResult>;
  discardMcpImport: (input: { previewId: string }) => Promise<void>;
  /** Thin skills passthroughs; SkillsTab holds list state locally. */
  listSkills: (input?: { projectPath?: string }) => Promise<SkillInfo[]>;
  addSkill: (
    input: SkillWrite,
  ) => Promise<{ name: string; installedIn: SkillTarget[] }>;
  removeSkill: (input: { name: string }) => Promise<void>;
  syncSkills: () => Promise<{ copied: number; skills: string[] }>;
  listSkillCatalog: () => Promise<SkillCatalogEntry[]>;
  pickSkillImport: () => Promise<SkillImportPreview | null>;
  previewSkillImport: (
    input: SkillPreviewImportInput,
  ) => Promise<SkillImportPreview>;
  installSkillImport: (
    input: SkillInstallRequest,
  ) => Promise<SkillInstallResult>;
  discardSkillImport: (input: { previewId: string }) => Promise<void>;
  detectHarnessSources: () => Promise<HarnessSourceInfo[]>;
  previewHarnessImport: (input: {
    source: HarnessSourceId;
    projectPath?: string;
  }) => Promise<HarnessImportPreview>;
  installHarnessImport: (
    input: HarnessInstallRequest,
  ) => Promise<HarnessInstallResult>;
  discardHarnessImport: (input: { previewId: string }) => Promise<void>;
  listCliCommands: (input?: {
    provider?: string;
    projectPath?: string;
  }) => Promise<CliSlashCommand[]>;
  /** Codex / Grok / Claude / Cursor / OpenCode / Kimi / Muse CLI sessions on disk. */
  listCliSessions: (input?: {
    provider?: "codex" | "grok" | "claude" | "cursor" | "opencode" | "kimi" | "muse";
  }) => Promise<CliSessionCandidate[]>;
  /**
   * Import one listed CLI session as a Solenta thread in projectId.
   * Selects the thread the same way createThread does.
   */
  importCliSession: (input: {
    sessionId: string;
    projectId: string;
    provider?: "codex" | "grok" | "claude" | "cursor" | "opencode" | "kimi" | "muse";
  }) => Promise<ThreadInfo>;
  /** Full-content thread search (titles + message text); Sidebar owns debounce/state. */
  searchThreads: (input: { query: string }) => Promise<ThreadInfo[]>;
  /** Load another thread's transcript without marking it visited (#393). */
  peekThread: (id: string) => Promise<ThreadDetail>;
}

export function useCoder(): UseCoderResult {
  const api = useMemo(() => resolveApi(), []);
  // Render-first boot (#364): hydrate the first paint from the last persisted
  // lists; loadBootLists reconciles as soon as IPC answers.
  const bootSnapshot = useMemo(loadBootSnapshot, []);
  const [projects, setProjects] = useState<ProjectInfo[]>(
    () => bootSnapshot?.projects ?? [],
  );
  const [threads, setThreads] = useState<ThreadInfo[]>(
    () => bootSnapshot?.threads ?? [],
  );
  const [trashedThreads, setTrashedThreads] = useState<TrashedThreadInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplateInfo[]>([]);
  const [workflowListError, setWorkflowListError] = useState<string | null>(
    null,
  );
  const [automations, setAutomations] = useState<AutomationInfo[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    () => bootSnapshot?.selectedThreadId ?? null,
  );
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  /** Last threads.get failure for the selected thread; retry bumps the nonce. */
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRetryNonce, setDetailRetryNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CoderError | null>(null);
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [stayAwake, setStayAwake] = useState<StayAwakeStatus | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [simulatorStatus, setSimulatorStatus] =
    useState<SimulatorStatus | null>(null);
  const selectedRef = useRef<string | null>(
    bootSnapshot?.selectedThreadId ?? null,
  );
  /** Bumped on every threads:changed push so a late initial list cannot clobber it. */
  const threadsListGen = useRef(0);
  const threadsRef = useRef<ThreadInfo[]>(bootSnapshot?.threads ?? []);
  /** Prior status by thread id; used to detect working → settled for spend refresh. */
  const prevStatusRef = useRef<Map<string, ThreadInfo["status"]>>(new Map());
  /** Open detail, for merging streamed tails (thread:updated is a ThreadPatch). */
  const detailRef = useRef<ThreadDetail | null>(null);
  /** Bounded recent details so a switch back paints instantly (#364 / #1225). */
  const detailCacheRef = useRef(createThreadDetailCache());
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

  const stagedPathsRef = useRef<string[] | null>(null);
  useEffect(() => {
    stagedPathsRef.current = null;
  }, [selectedThreadId]);

  const setStagedPaths = useCallback((paths: string[] | null) => {
    stagedPathsRef.current = paths;
  }, []);

  useEffect(() => {
    detailRef.current = detail;
    if (detail) detailCacheRef.current.set(detail.thread.id, detail);
  }, [detail]);

  // Render-first boot (#364): persist the boot inputs so the next launch can
  // paint the last-known lists before IPC answers. Fire-and-forget
  // localStorage writes; the threadsListGen guards do not apply here.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      saveBootSnapshot({ projects, threads, selectedThreadId });
    }, BOOT_SNAPSHOT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [projects, threads, selectedThreadId]);

  // Same for the open transcript, so a relaunch (or a switch to a thread not
  // yet fetched this session) can paint it before threads.get answers.
  useEffect(() => {
    if (!detail) return;
    const handle = window.setTimeout(() => {
      saveCachedThreadDetail(detail);
    }, BOOT_SNAPSHOT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
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

  const refreshTrashed = useCallback(() => {
    if (typeof api.threads.listTrashed !== "function") return;
    void api.threads
      .listTrashed()
      .then((rows) => setTrashedThreads(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, [api]);

  const applyThreads = useCallback((next: ThreadInfo[]) => {
    const reconciled = reconcileThreadList(threadsRef.current, next);
    if (reconciled === threadsRef.current) return;
    detailCacheRef.current.retain(new Set(reconciled.map((t) => t.id)));
    threadsRef.current = reconciled;
    setThreads(reconciled);
  }, []);

  const cancelQueued = useCallback(
    (threadId?: string): Promise<boolean> => {
      const id = threadId ?? selectedRef.current;
      if (!id) return Promise.resolve(false);
      const held = threadsRef.current.find((t) => t.id === id);
      if (!held?.queued) return Promise.resolve(false);
      applyThreads(
        threadsRef.current.map((t) =>
          t.id === id ? { ...t, queued: null } : t,
        ),
      );
      return api.threads
        .setQueued({ threadId: id, prompt: null })
        .then(() => true)
        .catch((err) => {
          setError({ scope: "run", message: errorMessage(err) });
          // Host still has the prompt — put the overlay back. Do not
          // setQueued the old payload: that appends and duplicates.
          applyThreads(
            threadsRef.current.map((t) =>
              t.id === id ? { ...t, queued: held.queued } : t,
            ),
          );
          return false;
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
        let cleared = false;
        try {
          await api.threads.setQueued({ threadId: id, prompt: null });
          cleared = true;
          await api.runs.start({
            threadId: id,
            prompt: pending.prompt,
            attachments: pending.attachments,
          });
        } catch (err) {
          // A failed retry must not eat the prompt — that is the loss this
          // issue exists to kill. Re-enqueue only if the host actually
          // dropped it: setQueued appends, so compensating a failed clear
          // duplicates prompt and attachments (issue #925).
          const message = errorMessage(err);
          setError({ scope: "run", message });
          let queued: QueuedMessage = { ...pending, error: message };
          if (cleared) {
            try {
              const updated = await api.threads.setQueued({
                threadId: id,
                prompt: pending.prompt,
                attachments: pending.attachments,
              });
              if (updated.queued) {
                queued = { ...updated.queued, error: message };
              }
            } catch {
              // Keep the in-memory payload; a second restore miss must not
              // eat the prompt the user still has locally.
            }
          }
          applyThreads(
            threadsRef.current.map((t) =>
              t.id === id ? { ...t, queued } : t,
            ),
          );
        }
      })();
    },
    [api, applyThreads],
  );

  const editQueued = useCallback(
    async (prompt: string, threadId?: string, items?: string[]) => {
      const id = threadId ?? selectedRef.current;
      if (!id) return;
      const held = threadsRef.current.find((t) => t.id === id);
      if (!held?.queued) return;
      try {
        const updated = await api.threads.setQueued({
          threadId: id,
          prompt,
          attachments: held.queued.attachments,
          replace: true,
          ...(items ? { items } : {}),
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === updated.id ? updated : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === updated.id
            ? { ...prev, thread: updated }
            : prev,
        );
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
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

  const {
    applyUpdate,
    checkUpdate,
    downloadUpdate,
  } = useCoderUpdates({ api, setUpdateStatus });

  // Auto-update: check on boot, then every hour. The check only asks the
  // release API — downloading and swapping the bundle waits for a user click.
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
    const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
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
    let unsubBoot: (() => void) | undefined;
    let unsubSimulator: (() => void) | undefined;

    const loadBootLists = () => {
      const loadGen = threadsListGen.current;
      return (async () => {
        try {
          // status/settings are best-effort: missing IPC handlers (merge before
          // backend) must not blank the whole boot (no catch on this IIFE).
          // projects/threads/providers/workflows may also reject when the
          // window beat registerIpc (#618); boot:ready retries.
          const [p, list, prov, wfs, autos, status, sett] = await Promise.all([
            api.projects.list(),
            api.threads.list(),
            api.providers.list(),
            api.workflows.list(),
            api.automations.list().catch(() => [] as AutomationInfo[]),
            api.app.status().catch(() => null),
            api.settings.get().catch(() => null),
          ]);
          // Best-effort like status/settings: a stale backend without the
          // stayAwake channel must not blank the boot.
          const awake = await api.stayAwake
            .status()
            .catch(() => null as StayAwakeStatus | null);
          if (cancelled) return;
          setProjects(p);
          setProviders(prov);
          setWorkflows(wfs);
          setAutomations(autos);
          if (status != null) setAppStatus(status);
          if (sett != null) setSettings(sett);
          if (awake != null) setStayAwake(awake);
          for (const t of list) {
            prevStatusRef.current.set(t.id, t.status);
          }
          if (threadsListGen.current === loadGen) {
            applyThreads(list);
          }
          refreshTrashed();
          const source =
            threadsListGen.current === loadGen ? list : threadsRef.current;
          const preferred =
            source.find((t) => !t.archived && t.status === "working")?.id ??
            source.find((t) => !t.archived)?.id ??
            null;
          setSelectedThreadId((prev) => {
            // A hydrated selection (#364) may name a thread deleted since the
            // snapshot was written; fall back rather than pin a dead id.
            if (prev != null && source.some((t) => t.id === prev)) return prev;
            return preferred;
          });
          if (selectedRef.current == null && preferred) {
            selectedRef.current = preferred;
          }
        } catch {
          // IPC may not be registered yet (#618); boot:ready retries.
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    };

    unsubChanged = api.on("threads:changed", (next) => {
      threadsListGen.current += 1;
      applyThreads(next);
      refreshTrashed();
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

    unsubBoot = api.on("boot:ready", () => {
      void loadBootLists();
    });

    const unsubStayAwake = api.on("stayAwake:changed", (s) => {
      if (s && typeof s === "object" && typeof s.blocking === "boolean") {
        setStayAwake(s);
      }
    });
    try {
      unsubSimulator = api.on("simulator:changed", (next) => {
        if (!cancelled) setSimulatorStatus(next);
      });
    } catch {
      // Web/old preload: simulator pushes are desktop-only.
    }
    void loadBootLists();

    // Shared 60s interval for the spend meter (same pattern as sidebar age tick).
    const statusHandle = window.setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_MS);

    return () => {
      cancelled = true;
      unsubChanged?.();
      unsubUpdated?.();
      unsubSelect?.();
      unsubBoot?.();
      unsubStayAwake();
      unsubSimulator?.();
      window.clearInterval(statusHandle);
    };
  }, [api, applyThreads, refreshStatus, reloadDetail, refreshTrashed]);

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
    // Render-first (#364): paint the last-known transcript for this thread
    // immediately; the in-flight threads.get replaces it in one round-trip
    // (replaced wholesale, never merged, so a stale tail is fine). Skip when
    // the open detail is already this thread — the cache may be staler.
    const cached =
      detailCacheRef.current.get(selectedThreadId) ??
      loadCachedThreadDetail(selectedThreadId);
    if (cached && detailRef.current?.thread.id !== selectedThreadId) {
      setDetail(cached);
    }
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

  const {
    addProject,
    createProject,
    ensureScratchProject,
    updateProject,
  } = useCoderProjects({ api, setProjects, setError });

  const {
    createThread,
    forkThread,
    startRun,
    rewindAndResubmit,
  } = useCoderRuns({
    api,
    projects,
    settings,
    selectedProjectId,
    selectedThreadId,
    setSelectedThreadId,
    setDetail,
    setError,
    selectedRef,
    threadsRef,
    applyThreads,
  });

  const {
    refreshWorkflows,
    refreshAutomations,
    addAutomation,
    updateAutomation,
    removeAutomation,
    runAutomationNow,
    listAutomationRuns,
    startWorkflowRun,
    retryWorkflowAgent,
    saveWorkflow,
    removeWorkflow,
  } = useCoderWorkflows({
    api,
    selectedThreadId,
    setWorkflows,
    setWorkflowListError,
    setAutomations,
    setDetail,
    setError,
    selectedRef,
    threadsRef,
    applyThreads,
  });

  const {
    stopRun,
    setPermissionMode,
    respondPermission,
    clearQuestion,
    setProvider,
    setReasoningEffort,
    setWebSearch,
    setArchived,
    setSettled,
    setPinned,
    setSnoozed,
    setTags,
    setThreadProject,
    setMuted,
    setEjected,
    setCrossThreadInbound,
    setQuotaWaitAutoResume,
    resumeQuotaWait,
    renameThread,
    setNotes,
    setMessagePins,
    setBaseBranch,
    setPendingWorktree,
    refreshWorkerSnapshot,
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
  } = useCoderThreadActions({
    api,
    selectedThreadId,
    setSelectedThreadId,
    setDetail,
    setError,
    selectedRef,
    threadsRef,
    applyThreads,
  });

  const {
    deleteThread,
    restoreThread,
    purgeThread,
    removeProject,
  } = useCoderThreadRemoval({
    api,
    selectedThreadId,
    setSelectedThreadId,
    setProjects,
    setDetail,
    setError,
    selectedRef,
    threadsRef,
    detailCacheRef,
    refreshTrashed,
    applyThreads,
  });

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

  const {
    listBaseBranches,
    setupWorktree,
    mergeWorktree,
    conflictContext,
    removeWorktree,
    fetchDiff,
    fetchReviewContext,
    setReviewAccepted,
    commitChanges,
    revertFile,
    suggestCommitMessage,
    listFiles,
    searchFileContents,
    resolvePaths,
    openWorkspacePath,
    loadToolImage,
    saveAttachmentImage,
    pickDirectory,
    listSnapWindows,
    captureSnapWindow,
    pickAttachments,
    pickFolderAttachments,
    loadAttachmentImage,
    dropAttachmentFiles,
  } = useCoderWorkspace({
    api,
    selectedThreadId,
    setDetail,
    selectedRef,
    stagedPathsRef,
    applyThreadUpdate,
  });

  const {
    pushBranch,
    createPr,
    prStatus,
    prChecks,
    prMerge,
    listPrs,
    prTemplate,
    prDetail,
    prEdit,
    prComment,
    prClose,
    prReady,
    prMergeAt,
    checkoutPr,
    listIssues,
    setIssuePlanStatus,
    createIssue,
    fetchIssue,
  } = useCoderGitHub({
    api,
    selectedThreadId,
    setSelectedThreadId,
    setDetail,
    setError,
    selectedRef,
    threadsRef,
    applyThreads,
    applyThreadUpdate,
  });
  const {
    listActivity,
    listUsageByDay,
    listProviderLimits,
    listDigest,
    markDigestSeen,
    listThreadSummaries,
    listCrewTasks,
    crewIntegration,
  } = useCoderInsights(api);

  const integrateWorker = useCallback(
    async (
      leadThreadId: string,
      workerThreadId: string,
      opts?: { ciWorkflowApproved?: boolean },
    ) => {
      const result = await api.git.integrateWorker({
        leadThreadId,
        workerThreadId,
        ciWorkflowApproved: opts?.ciWorkflowApproved,
      });
      if (selectedRef.current === leadThreadId) {
        const d = await api.threads.get(leadThreadId);
        if (selectedRef.current === leadThreadId) {
          applyThreadUpdate(d.thread);
          setDetail(d);
        }
      }
      return result;
    },
    [api, applyThreadUpdate],
  );

  const refreshProviders = useCallback(
    async (options?: { throwOnError?: boolean }) => {
      try {
        setProviders(await api.providers.list());
      } catch (err) {
        // Best-effort staleness fix; keep the boot list on failure.
        if (options?.throwOnError) throw err;
      }
    },
    [api],
  );

  const listCheckpoints = useCallback(
    async (threadId: string) => {
      return api.git.listCheckpoints({ threadId });
    },
    [api],
  );

  const restoreCheckpoint = useCallback(
    async (threadId: string, sha: string) => {
      await api.git.restoreCheckpoint({ threadId, sha });
      // Transcript is now shorter than what we hold. Restore starts no run,
      // so nothing else would repair the open detail (issue #149).
      reloadDetail(threadId);
    },
    [api, reloadDetail],
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

  const fetchTurnDiff = useCallback(
    async (threadId: string, sha: string) => {
      try {
        return await api.git.turnDiff({ threadId, sha });
      } catch {
        return { files: [], patch: "", truncated: false };
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

  const listEditors = useCallback(async () => {
    try {
      return await api.shell.editors();
    } catch {
      return [] as EditorOption[];
    }
  }, [api]);

  const openWorktreeIn = useCallback(
    async (editor: EditorId) => {
      if (!selectedThreadId) return;
      const root = threadRootPath(selectedThreadId);
      if (!root) return;
      try {
        await api.shell.openIn({ threadId: selectedThreadId, path: root, editor });
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, selectedThreadId, threadRootPath],
  );

  const {
    gitSyncInfo,
    listDevScripts,
    gitFetch,
    gitRepoInfo,
    gitPull,
    claimLane,
    listLanes,
    previewLane,
    restorePreview,
    recycleWedgedLanes,
    setSpotlight,
    spotlightLane,
    heartbeatLane,
    startDevServer,
    stopDevServer,
    devServerStatus,
    terminal,
  } = useCoderRepoTools({ api, setProjects });

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

  const runCommand = useCallback(
    async (threadId: string, actionId?: string) => {
      return api.threads.runCommand({ threadId, actionId });
    },
    [api],
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

  const testWebhook = useCallback(() => api.settings.testWebhook(), [api]);

  // Mode change persists through settings; main re-evaluates the blocker and
  // pushes stayAwake:changed. The local mode mirrors the returned settings so
  // the control flips even where no push arrives (web, fakes).
  const setStayAwakeMode = useCallback(
    async (mode: StayAwakeMode) => {
      const next = await saveSettings({ stayAwake: mode });
      setStayAwake((prev) =>
        prev
          ? { ...prev, mode: next.stayAwake }
          : {
              mode: next.stayAwake,
              blocking: false,
              onBattery: false,
              anyWorking: false,
            },
      );
      return next;
    },
    [saveSettings],
  );

  const {
    searchMemory,
    recentMemory,
    getMemory,
    updateMemory,
    removeMemory,
    storeMemory,
    maintenanceMemory,
    resolveMemory,
    loadCodeMap,
  } = useCoderMemory(api);

  const {
    lintAgentConfig,
    previewAgentConfig,
    writeAgentConfig,
    listMcpServers,
    saveMcpServer,
    removeMcpServer,
    setMcpEnabled,
    listMcpCatalog,
    pickMcpImport,
    previewMcpImport,
    installMcpImport,
    discardMcpImport,
    listSkills,
    addSkill,
    removeSkill,
    syncSkills,
    listSkillCatalog,
    pickSkillImport,
    previewSkillImport,
    installSkillImport,
    discardSkillImport,
    detectHarnessSources,
    previewHarnessImport,
    installHarnessImport,
    discardHarnessImport,
    listCliCommands,
    listCliSessions,
  } = useCoderAgentTools(api);

  const importCliSession = useCallback(
    async (input: {
      sessionId: string;
      projectId: string;
      provider?: "codex" | "grok" | "claude" | "cursor" | "opencode" | "kimi" | "muse";
    }) => {
      const t = await api.threads.importCliSession({
        sessionId: input.sessionId,
        projectId: input.projectId,
        ...(input.provider ? { provider: input.provider } : {}),
      });
      const next = threadsRef.current.some((x) => x.id === t.id)
        ? threadsRef.current.map((x) => (x.id === t.id ? t : x))
        : [t, ...threadsRef.current];
      applyThreads(next);
      selectedRef.current = t.id;
      setSelectedThreadId(t.id);
      return t;
    },
    [api, applyThreads],
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
    workflowListError,
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
    ensureScratchProject,
    updateProject,
    createThread,
    listBaseBranches,
    forkThread,
    startRun,
    rewindAndResubmit,
    queued,
    cancelQueued,
    retryQueued,
    editQueued,
    startWorkflowRun,
    retryWorkflowAgent,
    saveWorkflow,
    removeWorkflow,
    refreshWorkflows,
    refreshAutomations,
    addAutomation,
    updateAutomation,
    removeAutomation,
    runAutomationNow,
    listAutomationRuns,
    stopRun,
    setPermissionMode,
    respondPermission,
    clearQuestion,
    setProvider,
    setReasoningEffort,
    setWebSearch,
    setArchived,
    setSettled,
    setPinned,
    setSnoozed,
    setTags,
    setThreadProject,
    setMuted,
    setEjected,
    setCrossThreadInbound,
    setQuotaWaitAutoResume,
    resumeQuotaWait,
    renameThread,
    setNotes,
    setMessagePins,
    setBaseBranch,
    setPendingWorktree,
    refreshWorkerSnapshot,
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
    trashedThreads,
    restoreThread,
    purgeThread,
    removeProject,
    setupWorktree,
    mergeWorktree,
    conflictContext,
    removeWorktree,
    fetchDiff,
    fetchReviewContext,
    setReviewAccepted,
    commitChanges,
    setStagedPaths,
    revertFile,
    suggestCommitMessage,
    listFiles,
    searchFileContents,
    pickDirectory,
    listSnapWindows,
    captureSnapWindow,
    resolvePaths,
    openWorkspacePath,
    loadToolImage,
    pickAttachments,
    pickFolderAttachments,
    saveAttachmentImage,
    loadAttachmentImage,
    dropAttachmentFiles,
    pushBranch,
    createPr,
    prStatus,
    prChecks,
    prMerge,
    listPrs,
    checkoutPr,
    prTemplate,
    prDetail,
    prEdit,
    prComment,
    prClose,
    prReady,
    prMergeAt,
    listIssues,
    setIssuePlanStatus,
    createIssue,
    fetchIssue,
    listActivity,
    listUsageByDay,
    listProviderLimits,
    listDigest,
    markDigestSeen,
    listThreadSummaries,
    listCrewTasks,
    crewIntegration,
    integrateWorker,
    listCheckpoints,
    restoreCheckpoint,
    runStats,
    fetchTurnDiff,
    conflictForecast,
    listLocalServers,
    revealInFinder,
    openInEditor,
    listEditors,
    openWorktreeIn,
    gitSyncInfo,
    gitFetch,
    gitRepoInfo,
    gitPull,
    claimLane,
    listLanes,
    previewLane,
    restorePreview,
    recycleWedgedLanes,
    setSpotlight,
    spotlightLane,
    heartbeatLane,
    listDevScripts,
    startDevServer,
    stopDevServer,
    devServerStatus,
    terminal,
    preview: api.preview,
    simulator: api.simulator,
    simulatorStatus,
    setVerifyCommand,
    runVerify,
    runCommand,
    appStatus,
    settings,
    saveSettings,
    stayAwake,
    setStayAwakeMode,
    testWebhook,
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
    maintenanceMemory,
    resolveMemory,
    loadCodeMap,
    lintAgentConfig,
    previewAgentConfig,
    writeAgentConfig,
    listMcpServers,
    saveMcpServer,
    removeMcpServer,
    setMcpEnabled,
    listMcpCatalog,
    pickMcpImport,
    previewMcpImport,
    installMcpImport,
    discardMcpImport,
    listSkills,
    addSkill,
    removeSkill,
    syncSkills,
    listSkillCatalog,
    pickSkillImport,
    previewSkillImport,
    installSkillImport,
    discardSkillImport,
    detectHarnessSources,
    previewHarnessImport,
    installHarnessImport,
    discardHarnessImport,
    listCliCommands,
    listCliSessions,
    importCliSession,
    searchThreads,
    peekThread,
  };
}
