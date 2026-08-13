// Typed IPC contract between the Electron main process and the React renderer.
// The preload script exposes `window.coder` implementing CoderApi.
// Invoke channel names mirror the method paths: "projects:list", "projects:add",
// "projects:addViaDialog", "threads:list", "threads:create", "threads:get",
// "runs:start", "runs:stop", "git:status".
// Push channels: "threads:changed", "thread:updated", "thread:select".

export interface ProjectInfo {
  id: string;
  /** e.g. "pingdotgg/t3code", derived from git remote or folder name */
  slug: string;
  name: string;
  path: string;
}

export type ThreadStatus = "idle" | "working" | "done" | "failed";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ThreadInfo {
  id: string;
  projectId: string;
  title: string;
  branch: string | null;
  prNumber: number | null;
  /** Set alongside prNumber so the badge can link out without calling gh. */
  prUrl: string | null;
  status: ThreadStatus;
  createdAt: number;
  /**
   * Last REAL activity: a message appended, a run status change, or a title
   * change. Internal mutations (permission mode, worktree bookkeeping, store
   * migration) must NOT bump this; the sidebar age label derives from it.
   */
  updatedAt: number;
  /** Set while a run is active on this thread; drives the Working elapsed label. */
  runStartedAt: number | null;
  /** Archived threads keep their history but are hidden from the default sidebar list. */
  archived: boolean;
  /**
   * Explicit settle lifecycle override (t3-style). "settled" pins the thread
   * into the settled fold; "active" pins it OUT (suppresses auto-settle);
   * null means no override, resolution falls to PR state and inactivity.
   * The backend clears a "settled" override on real activity (a new run),
   * so an override never goes stale silently.
   */
  settledOverride: "settled" | "active" | null;
  /** Epoch ms when the current override was accepted; null without one. */
  settledAt: number | null;
  /**
   * Source thread id when this thread was created by fork/hand-off; null
   * otherwise. While set AND sessionId is null, the runner prefixes the
   * FIRST turn's prompt with one context block built from the source
   * thread's last assistant message (a hand-off summary, not a replay).
   * After that first turn the session carries its own context.
   */
  handoffFrom: string | null;
  /**
   * Epoch ms when the user pinned this thread; null = unpinned. Pinned
   * threads render first and NEVER auto-settle (t3's rule). Pin and an
   * explicit settle are mutually exclusive: setPinned(true) clears a
   * "settled" override, setSettled("settled") clears the pin — conflicts
   * can then only arise from raced writes, not normal use.
   */
  pinnedAt: number | null;
  /**
   * Snooze: hidden from the attention list until this epoch ms passes.
   * Snooze is VISIBILITY ONLY — it never touches the agent, suspends a pin
   * without clearing it, and beats settle classification. A snoozed thread
   * wakes early ("raises its hand") when something outranks the snooze:
   * a FRESH failure or a run completion newer than snoozedAt. Timer wakes
   * are derived client-side — no event fires when snoozedUntil passes.
   */
  snoozedUntil: number | null;
  /** Epoch ms when the snooze was set; the raised-hand comparisons anchor here. */
  snoozedAt: number | null;
  /**
   * Epoch ms of the last time the user LOOKED at this thread. Stamped by the
   * main process inside threads.get — selecting a thread IS visiting it; no
   * separate markVisited channel. Unread = updatedAt > lastVisitedAt. Null on
   * legacy threads (renderer treats null as visited-at-creation so old
   * threads don't all light up on upgrade).
   */
  lastVisitedAt: number | null;
  /**
   * Last KNOWN PR state, persisted when prStatus/createPr succeed and by the
   * main-process background refresher (refreshPrStates). That refresher runs
   * async/serialized gh (never execFileSync) every ~5 min plus once shortly
   * after startup, skips archived + terminal MERGED/CLOSED, and stays silent
   * on non-GitHub origins / gh failures so it cannot reintroduce the old
   * prStatus main-process freeze or permanent non-GitHub error. Selecting a
   * thread still refreshes via prStatus. MERGED/CLOSED auto-settle the
   * thread; OPEN blocks inactivity auto-settle entirely.
   */
  prState: "OPEN" | "CLOSED" | "MERGED" | null;
  /** Agent harness backing this thread: a ProviderInfo.id ("claude", "codex", "grok", "opencode", "simulate"). */
  provider: string;
  /** Model override passed to the provider CLI when set (e.g. claude --model). */
  model: string | null;
  /** Provider session id, persisted after the first turn so follow-ups resume context. */
  sessionId: string | null;
  /** Passed to the provider CLI (claude --permission-mode). Sticky per thread. */
  permissionMode: PermissionMode;
  /**
   * Reasoning effort for this thread, or null to use the provider's default.
   * Ignored by providers whose `efforts` list is empty.
   */
  reasoningEffort: ReasoningEffort | null;
  /** Absolute path of the thread's git worktree, when one was set up. */
  worktreePath: string | null;
}

/** A tool invocation surfaced from the agent's stream. */
export interface ToolCallInfo {
  /** Provider tool_use id, used to pair the result. */
  id: string;
  /** Tool name, e.g. "Bash", "Edit", "Read". */
  name: string;
  /** Pretty-printed JSON of the tool input (main truncates to ~2000 chars). */
  input: string;
  /** Result text once the tool finished (main truncates to ~4000 chars). */
  output: string | null;
  isError: boolean;
  done: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "event" | "tool";
  /** For role "tool" this is a one-line summary, e.g. "Bash: npm test". */
  text: string;
  createdAt: number;
  /** Set when the message belongs to a run (streamed agent output, run events). */
  runId?: string | null;
  /** Present exactly when role === "tool". */
  tool?: ToolCallInfo;
}

/** Cumulative session usage across turns of a thread. */
export interface SessionUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  /**
   * Last turn's input+output tokens; the numerator for the context ring.
   * Absent on usage recorded before this field existed.
   */
  contextTokens?: number;
}

export interface FileChange {
  path: string;
  /** git status letter: M, A, D, R, ?? etc. */
  status: string;
  additions: number;
  deletions: number;
}

export interface DiffResult {
  files: FileChange[];
  /** Unified diff text, truncated by main to ~100k chars. */
  patch: string;
  truncated: boolean;
}

/**
 * One step of a run's work log. Exactly ONE item exists per step: it is
 * created with done: false when the step starts and the SAME item flips to
 * done: true when the step completes. Items carry the runId of the run they
 * belong to; the renderer groups items by runId into one Work Log card per
 * run, placed chronologically in the conversation by the group's earliest
 * timestamp.
 */
export interface WorkLogItem {
  id: string;
  runId: string;
  label: string;
  done: boolean;
  timestamp: number;
}

export type AgentStatus = "pending" | "running" | "settled" | "failed";

export interface AgentView {
  id: string;
  model: string;
  status: AgentStatus;
  tokensUsed: number;
}

export interface PhaseView {
  name: string;
  pipelined: boolean;
  agents: AgentView[];
}

export interface WorkflowView {
  id: string;
  name: string;
  phases: PhaseView[];
  settled: number;
  total: number;
  tokensTotal: number;
  complete: boolean;
}

export interface ThreadDetail {
  thread: ThreadInfo;
  messages: ChatMessage[];
  workLog: WorkLogItem[];
  /** Only populated by the simulate provider; null for real sessions. */
  workflow: WorkflowView | null;
  /** Cumulative provider usage for this thread; null before the first turn. */
  usage: SessionUsage | null;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  dirty: boolean;
}

/**
 * Ahead/behind vs @{upstream}. No repo or no upstream is in-band, not thrown.
 */
export type GitSyncInfo =
  | { hasUpstream: false }
  | { hasUpstream: true; ahead: number; behind: number };

/** A GitHub pull request opened from a thread's branch. */
/** One auto-committed turn checkpoint in a thread's worktree. */
export interface CheckpointInfo {
  sha: string;
  /** 1-based turn number parsed from the checkpoint message. */
  turn: number;
  message: string;
  /** Epoch ms of the commit. */
  at: number;
}

/** Per-checkpoint-pair `git diff --shortstat` for a completed turn. */
export interface RunStatInfo {
  sha: string;
  turn: number;
  files: number;
  additions: number;
  deletions: number;
}

/** A TCP listener whose process cwd is the thread worktree or project. */
export interface LocalServerInfo {
  pid: number;
  command: string;
  host: string;
  port: number;
  url: string;
}

/** Per-thread `npm run` dev server started from the Environment tab. */
export interface DevServerState {
  running: boolean;
  script?: string;
  url?: string;
  startedAt?: number;
  lastLines?: string[];
}

export interface PrInfo {
  number: number;
  url: string;
  /** gh's state, uppercased: OPEN, CLOSED or MERGED. */
  state: "OPEN" | "CLOSED" | "MERGED";
  /** The head branch the PR was opened from. */
  branch: string;
  /** False when an existing PR was returned instead of a new one. */
  created: boolean;
  /** PR title from gh, when the interactive status fetch included it. */
  title?: string;
  /** Added line count from gh, when present. */
  additions?: number;
  /** Deleted line count from gh, when present. */
  deletions?: number;
  /** Changed file count from gh, when present. */
  changedFiles?: number;
}

/** One CI check from `gh pr checks`. */
export type PrCheckBucket =
  | "pass"
  | "fail"
  | "pending"
  | "skipping"
  | "cancel";

export interface PrCheckInfo {
  name: string;
  bucket: PrCheckBucket;
  link?: string;
}

/** Per-thread prChecks result. Failures stay in-band so the UI can retry. */
export type PrChecksResult =
  | { ok: true; checks: PrCheckInfo[] }
  | { ok: false; reason: string };

/**
 * One row from `gh pr list`. Optional fields are absent when gh is too old
 * for the extra --json keys and listPrs fell back to the short field set.
 */
export interface PrListItem {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefName: string;
  isDraft?: boolean;
  additions?: number;
  deletions?: number;
  /** ISO timestamp from gh when the extra JSON fields are available. */
  updatedAt?: string;
}

/** Per-project listPrs result. Failures stay in-band so the UI can retry. */
export type ListPrsResult =
  | { ok: true; prs: PrListItem[] }
  | { ok: false; reason: string };

/** A GitHub issue fetched via `gh issue view`. */
export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** Per-project issue fetch. Failures stay in-band so the UI can show them. */
export type FetchIssueResult =
  | { ok: true; issue: IssueInfo }
  | { ok: false; reason: string };

/**
 * How hard a model should think. Persisted per thread, sent to the CLI.
 *
 * These are the levels the installed CLIs actually accept, verified against
 * them rather than copied from a design: `claude --effort` takes low, medium,
 * high, xhigh, max, and `grok --reasoning-effort` takes low, medium, high.
 * A provider advertises its own subset through ProviderInfo.efforts.
 *
 * Getting this wrong is silent: claude answers an unknown value with
 * "Warning: Unknown --effort value ... ignoring it" and runs at its default,
 * so a typo here costs the user the setting without an error.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Ordered lowest to highest; the picker renders one segment per level. */
export const REASONING_EFFORTS: ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** A model the picker can offer, with the copy it needs to describe it. */
export interface ModelInfo {
  /** The id passed to the CLI, e.g. "claude-opus-5". */
  id: string;
  /** Short display name, e.g. "Opus (1M context)". */
  label: string;
  /** One line on what it is for, e.g. "Best for everyday, complex tasks". */
  description: string;
  /** Vendor line under the label, e.g. "Anthropic". */
  vendor: string;
  /** True for the provider's suggested default. */
  recommended?: boolean;
  /**
   * Context window size in tokens, only when the vendor documents it.
   * The context ring hides itself when this is absent; never guessed.
   */
  contextTokens?: number;
}

export interface ProviderInfo {
  id: string;
  /** Display name, e.g. "Claude Code". */
  name: string;
  /** Whether the CLI binary was found on this machine. */
  available: boolean;
  /** Whether follow-up turns resume a persistent session. */
  supportsResume: boolean;
  /** Selectable model ids for the picker; empty = no model choice. */
  models: string[];
  /**
   * Describes each entry of `models`, in the same order. Empty when the
   * provider offers no model choice. `models` stays the source of truth for
   * validation so existing callers keep working.
   */
  modelInfo: ModelInfo[];
  /**
   * Effort levels this provider actually honours, lowest to highest. Empty
   * when the CLI has no such flag, and the picker then hides the control
   * rather than offering a setting that does nothing.
   */
  efforts: ReasoningEffort[];
}

/** One phase of a user-defined workflow template. */
export interface WorkflowPhaseSpec {
  /** Display name, e.g. "analyze". */
  name: string;
  /** 1-4 agents fan out in parallel within the phase. */
  agentCount: number;
  /** Instruction appended to every agent prompt of this phase. */
  instruction: string;
  /** ProviderInfo.id executing this phase's agents. */
  provider: string;
  model: string | null;
}

export interface WorkflowTemplateInfo {
  id: string;
  name: string;
  /** Builtin templates cannot be removed; saving one creates a copy. */
  builtin: boolean;
  phases: WorkflowPhaseSpec[];
}

export type AutomationPreset = "hourly" | "daily" | "weekly";

/** A scheduled agent run (Synara-style automation). */
export interface AutomationInfo {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  provider: string;
  model: string | null;
  preset: AutomationPreset;
  /** 0-23 for daily/weekly; null for hourly. */
  hour: number | null;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number;
  lastError: string | null;
}

export interface AutomationWrite {
  projectId: string;
  name: string;
  prompt: string;
  provider: string;
  model?: string | null;
  preset: AutomationPreset;
  hour?: number | null;
  enabled?: boolean;
}

export interface AppSettings {
  /** Hard daily spend cap across all providers; null = no cap. */
  dailyBudgetUsd: number | null;
  /**
   * Days of silence before a quiet thread auto-settles (t3's window).
   * null disables the inactivity path entirely — threads then settle only
   * via PR state or an explicit settle. Positive integer when set. The
   * renderer's default when this is absent/undefined stays
   * AUTO_SETTLE_AFTER_DAYS (3): the setting overrides the constant, it
   * does not replace it.
   */
  autoSettleAfterDays: number | null;
}

export interface AppStatus {
  /** Aggregated cost of all runs that finished today (local time). */
  spendTodayUsd: number;
  memory: {
    running: boolean;
    adopted: boolean;
    port: number | null;
    /** Live counts from the server; null when it is not running. */
    entries: number | null;
    vectors: number | null;
    /** Last janitor step failure, or null when clean/unknown. */
    lastError: string | null;
  };
  /** Which build is running: a stale packaged bundle looks like a broken app. */
  build: {
    version: string;
    /** Short commit the bundle was packaged from; null in a dev tree. */
    sha: string | null;
    time: string | null;
  };
}

/** A shared-memory entry as surfaced to the UI (excerpt form unless fetched). */
export interface MemoryEntryInfo {
  id: string;
  type: "knowledge" | "task" | "convention" | "run";
  title: string;
  /** Excerpt in list/search results; full body from memory.get. */
  body: string;
  project: string | null;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export interface CoderApi {
  app: {
    status(): Promise<AppStatus>;
  };
  /**
   * Proxied to the local shared-memory server by the main process (the
   * renderer never sees the bearer token). Every method rejects with
   * "Memory server is not running." when it is unavailable.
   */
  memory: {
    search(input: { query: string; project?: string }): Promise<MemoryEntryInfo[]>;
    recent(input?: { limit?: number; project?: string }): Promise<MemoryEntryInfo[]>;
    get(input: { id: string }): Promise<MemoryEntryInfo>;
    store(input: {
      type: MemoryEntryInfo["type"];
      title: string;
      body: string;
      project?: string;
    }): Promise<{ id: string }>;
    /**
     * Corrects an entry by superseding it: the old row is retained and marked,
     * a new row carries the corrected content. Returns the successor id.
     */
    update(input: { id: string; title: string; body: string }): Promise<{ id: string }>;
    /** Permanently removes an entry and its dependents (vectors, mentions, queue rows). */
    remove(input: { id: string }): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  providers: {
    list(): Promise<ProviderInfo[]>;
  };
  workflows: {
    list(): Promise<WorkflowTemplateInfo[]>;
    /** Saves a template; omit id to create. Saving a builtin creates a copy. */
    save(template: Omit<WorkflowTemplateInfo, "id" | "builtin"> & { id?: string }): Promise<WorkflowTemplateInfo>;
    /** Removes a non-builtin template. */
    remove(input: { id: string }): Promise<void>;
  };
  automations: {
    list(): Promise<AutomationInfo[]>;
    add(input: AutomationWrite): Promise<AutomationInfo>;
    update(input: Partial<AutomationWrite> & { id: string }): Promise<AutomationInfo>;
    remove(input: { id: string }): Promise<void>;
    /** Fire one immediately and recompute nextRunAt. */
    runNow(input: { id: string }): Promise<AutomationInfo>;
  };
  projects: {
    list(): Promise<ProjectInfo[]>;
    /** Validates the path is a git repo; rejects otherwise. */
    add(path: string): Promise<ProjectInfo>;
    /** Opens a native folder picker; resolves null if the user cancels. */
    addViaDialog(): Promise<ProjectInfo | null>;
    /**
     * Remove the project ENTRY and delete its threads' conversation history
     * (t3-style "Remove project"). The repository on disk is never touched.
     * Rejects while any of its threads has an active run, or still has a
     * worktree (merge or delete those in the Git tab first) — the same
     * guards as threads.delete, because this is that action fanned out.
     * The renderer confirms destructively BEFORE calling (thread count,
     * path, "permanently clears conversation history"); this call does not
     * prompt.
     */
    remove(input: { projectId: string }): Promise<void>;
  };
  threads: {
    list(): Promise<ThreadInfo[]>;
    /**
     * Full-content search: matches thread titles AND message text
     * (case-insensitive substring), newest activity first, max 50. Includes
     * archived threads; the renderer styles them as usual.
     */
    search(input: { query: string }): Promise<ThreadInfo[]>;
    create(input: { projectId: string; title: string }): Promise<ThreadInfo>;
    get(id: string): Promise<ThreadDetail>;
    /** Sticky permission mode for future turns of this thread. */
    setPermissionMode(input: { threadId: string; mode: PermissionMode }): Promise<ThreadInfo>;
    /** Archive or unarchive; archived threads are hidden by default but fully intact. */
    setArchived(input: { threadId: string; archived: boolean }): Promise<ThreadInfo>;
    /**
     * Set or clear the settle override. Rejects override "settled" while a
     * run is active: settling live work would hide it (t3's rule — anything
     * the resolution refuses to classify as settled is refused as a settle
     * target). Does not bump updatedAt: settling is bookkeeping, and bumping
     * would push the thread to the top of a list it is leaving.
     */
    setSettled(input: {
      threadId: string;
      override: "settled" | "active" | null;
    }): Promise<ThreadInfo>;
    /**
     * Pin or unpin. Pinning clears a "settled" override (mutual exclusion,
     * see pinnedAt doc); settling clears the pin. Never bumps updatedAt.
     */
    setPinned(input: { threadId: string; pinned: boolean }): Promise<ThreadInfo>;
    /**
     * Snooze until an epoch ms, or clear with null. Rejects a non-null
     * `until` that is not strictly in the future, naming the value. Stamps
     * snoozedAt = now alongside. Never bumps updatedAt; never touches the
     * agent or the run lifecycle.
     */
    setSnoozed(input: { threadId: string; until: number | null }): Promise<ThreadInfo>;
    /**
     * Fork / hand off a thread: creates a NEW thread in the same project,
     * copying provider/model/permissionMode unless overridden (a provider
     * override is the hand-off case). The new thread starts with sessionId
     * null and handoffFrom = the source id; the runner injects the one-time
     * context prefix on its first turn (see handoffFrom). Title defaults to
     * "Fork: <source title>" truncated like createThread titles. Rejects an
     * unknown source thread, and an override provider/model invalid by the
     * same rules as setProvider. The SOURCE thread is never modified.
     */
    fork(input: {
      threadId: string;
      provider?: string;
      model?: string | null;
    }): Promise<ThreadInfo>;
    /**
     * Sets the thread's provider and/or model. A provider change on a
     * session-bearing thread is allowed and clears sessionId (CLI sessions
     * are not portable; the next send starts fresh); it is rejected only
     * while a run is active. (Round 34 replaced the old hard lock.)
     * Model validation: when the provider's models list is non-empty the
     * model must come from it; when the list is EMPTY any non-empty string
     * is accepted and passed to the CLI as-is (custom model ids, e.g codex
     * -m). Model alone may still be changed between turns for providers
     * whose sessions tolerate it.
     */
    setProvider(input: { threadId: string; provider?: string; model?: string | null }): Promise<ThreadInfo>;
    /**
     * Sets reasoning effort for the thread. Rejects when the provider does not
     * support the level, rather than silently accepting a setting that would
     * never reach the CLI.
     */
    setReasoningEffort(input: {
      threadId: string;
      effort: ReasoningEffort | null;
    }): Promise<ThreadInfo>;
    /**
     * Permanently deletes the thread with its messages and work log. Rejects
     * while a run is active, and rejects when the thread still has a worktree
     * (merge or delete the worktree in the Git tab first) so no work is lost.
     */
    delete(input: { threadId: string }): Promise<void>;
  };
  runs: {
    /**
     * Sends one turn to the thread's provider session (resuming the stored
     * sessionId when present). Streams tool/text events via thread:updated.
     * If the thread title is still the default "New Thread", main renames it
     * from the first line of the prompt.
     */
    start(input: { threadId: string; prompt: string }): Promise<{ runId: string }>;
    /**
     * Starts an orchestrated multi-phase workflow run (the Build action)
     * from a template (default template when templateId omitted). Each phase
     * runs its agents as REAL one-shot calls on the phase's provider/model;
     * outputs chain phase to phase, every agent's full output is appended as
     * a role "tool" dossier message, and the last phase's output becomes the
     * assistant answer. Live state streams through ThreadDetail.workflow.
     * Rejects while any run is active, and at start when a phase's provider
     * binary is unavailable (naming it).
     */
    startWorkflow(input: { threadId: string; prompt: string; templateId?: string }): Promise<{ runId: string }>;
    stop(input: { threadId: string }): Promise<void>;
  };
  git: {
    status(projectId: string): Promise<GitStatus>;
    // See PrInfo below for the shape createPr/prStatus return.
    /** Creates a git worktree + branch for the thread; later runs execute in it. */
    setupWorktree(input: { threadId: string }): Promise<ThreadInfo>;
    /** Working-tree changes in the thread's cwd (worktree if set, else project). */
    diff(input: { threadId: string }): Promise<DiffResult>;
    /**
     * Commits every change in the thread's cwd (git add -A + commit -m).
     * Rejects on an empty message or when there is nothing to commit.
     */
    commit(input: { threadId: string; message: string }): Promise<{ subject: string }>;
    /**
     * Discards one file's changes: untracked files are deleted, staged-new
     * files are removed from index and disk, tracked files are restored from
     * HEAD. `path`/`status` come from the diff file list.
     */
    revertFile(input: {
      threadId: string;
      path: string;
      status: string;
    }): Promise<{ path: string }>;
    /**
     * Drafts a commit message for the thread's uncommitted changes with the
     * thread's provider CLI in print mode. Never commits. Rejects when there
     * are no changes or the provider CLI is unavailable.
     */
    suggestCommitMessage(input: { threadId: string }): Promise<{ message: string }>;
    /**
     * Squash-merges the thread's worktree branch into the project's default
     * branch (committing any uncommitted worktree changes first), then removes
     * the worktree and branch. Rejects with a descriptive Error on conflicts
     * or a dirty project checkout; nothing is force-removed on failure.
     */
    mergeWorktree(input: { threadId: string }): Promise<ThreadInfo>;
    /**
     * Deletes the thread's worktree and branch WITHOUT merging. Rejects when
     * the worktree has uncommitted changes or unmerged commits unless force
     * is true; the rejection message lists what would be lost.
     */
    removeWorktree(input: { threadId: string; force?: boolean }): Promise<ThreadInfo>;
    /**
     * Pushes the thread's current branch (worktree branch if set, else the
     * project's checked-out branch) to origin with -u. Rejects with a clear
     * message when no remote is configured or the push fails.
     */
    push(input: { threadId: string }): Promise<{ remote: string; branch: string }>;
    /**
     * Pushes the thread's branch, then opens a GitHub PR against the project's
     * default branch via the gh CLI, and records prNumber/prUrl on the thread.
     *
     * Idempotent: when a PR already exists for the branch it is returned as-is
     * (created: false) rather than erroring. Rejects with a plain-language
     * message when gh is missing, gh is not authenticated, the remote is not
     * GitHub, or the branch has no commits to propose.
     */
    createPr(input: {
      threadId: string;
      title: string;
      body?: string;
      draft?: boolean;
    }): Promise<PrInfo>;
    /**
     * Current PR for the thread's branch, or null when there is none. Reads
     * live state from gh so a PR merged or closed outside the app is reflected.
     * Rejects only on the same environment failures as createPr.
     */
    prStatus(input: { threadId: string }): Promise<PrInfo | null>;
    /**
     * CI checks for the thread's current PR via `gh pr checks`. Failures
     * stay in-band (`{ ok: false, reason }`) so the card can retry.
     */
    prChecks(input: { threadId: string }): Promise<PrChecksResult>;
    /**
     * Squash-merge the thread's current OPEN PR (`gh pr merge --squash`)
     * and return the refreshed PrInfo. Rejects with gh's own message.
     */
    prMerge(input: { threadId: string }): Promise<PrInfo>;
    /**
     * Open PRs for a project checkout via `gh pr list`. Never rejects for
     * missing gh / non-GitHub remotes / auth: those come back as
     * `{ ok: false, reason }`.
     */
    listPrs(projectPath: string): Promise<ListPrsResult>;
    /**
     * Checkpoints: after each successful turn that changed files, the runner
     * auto-commits in the thread's WORKTREE ("coder-checkpoint: turn N").
     * Never fires on the main repo, never when the worktree is clean.
     * listCheckpoints returns newest-first; empty for threads without a
     * worktree. restoreCheckpoint hard-resets the WORKTREE to the given sha;
     * rejects while a run is active, when the worktree is missing, or when
     * the sha is not one of this thread's checkpoints (never an arbitrary
     * reset target). The renderer confirms destructively BEFORE calling.
     */
    listCheckpoints(input: { threadId: string }): Promise<CheckpointInfo[]>;
    restoreCheckpoint(input: { threadId: string; sha: string }): Promise<void>;
    /**
     * Ahead/behind vs the thread root's upstream. Never rejects: not a repo
     * or no upstream returns `{ hasUpstream: false }`.
     */
    syncInfo(input: { threadId: string }): Promise<GitSyncInfo>;
    /** `git fetch` in the thread root. */
    fetch(input: { threadId: string }): Promise<void>;
    /**
     * Per-checkpoint-pair shortstat for a thread. Checkpoint N diffs against
     * N-1 (first checkpoint diffs against its parent). Empty when the thread
     * has no worktree or checkpoints. Never rejects.
     */
    runStats(input: { threadId: string }): Promise<RunStatInfo[]>;
  };
  issues: {
    /**
     * Fetch a GitHub issue for a project checkout via `gh issue view`.
     * Never rejects for missing gh / non-GitHub remotes / auth / missing
     * issue: those come back as `{ ok: false, reason }`.
     */
    fetch(input: { projectPath: string; ref: string }): Promise<FetchIssueResult>;
  };
  files: {
    /**
     * Repo-relative paths for the composer's @-mention popup: tracked plus
     * untracked (gitignored excluded), substring-filtered, top 20. Uses the
     * thread's worktree when bound, else the project checkout.
     */
    list(input: { threadId: string; query?: string }): Promise<{ files: string[] }>;
  };
  servers: {
    /**
     * Listening TCP processes whose cwd is the thread's worktree (or the
     * project path when no worktree is bound). Empty on any lsof failure.
     */
    list(input: { threadId: string }): Promise<LocalServerInfo[]>;
  };
  /**
   * Reveal a path in Finder (`shell.showItemInFolder`) or open it with the
   * default app (`shell.openPath`). `path` must exist and be the thread
   * worktree / project root or inside them.
   */
  shell: {
    reveal(input: { threadId: string; path: string }): Promise<void>;
    openPath(input: { threadId: string; path: string }): Promise<void>;
  };
  devserver: {
    /** Runnable scripts (dev, start, serve) present in the thread root. */
    scripts(input: { threadId: string }): Promise<string[]>;
    /** Start `npm run <script>` for the thread. Already-running is a no-op. */
    start(input: { threadId: string; script: string }): Promise<DevServerState>;
    /** Stop the thread's spawned server (process group). */
    stop(input: { threadId: string }): Promise<DevServerState>;
    /** Live status, including a captured URL and recent log tail. */
    status(input: { threadId: string }): Promise<DevServerState>;
  };
  /** Returns an unsubscribe function. */
  on(channel: "threads:changed", cb: (threads: ThreadInfo[]) => void): () => void;
  on(channel: "thread:updated", cb: (detail: ThreadDetail) => void): () => void;
  /** Desktop notification click: select this thread. */
  on(channel: "thread:select", cb: (threadId: string) => void): () => void;
}

declare global {
  interface Window {
    coder: CoderApi;
  }
}
