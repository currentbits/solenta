// Typed IPC contract between the Electron main process and the React renderer.
// The preload script exposes `window.coder` implementing CoderApi.
// Invoke channel names mirror the method paths: "projects:list", "projects:add",
// "projects:addViaDialog", "threads:list", "threads:create", "threads:get",
// "runs:start", "runs:stop", "git:status".
// Push channels: "threads:changed", "thread:updated", "thread:select".

/**
 * A named sidebar group ("Space"). Store array order IS display order.
 * ponytail: no icon field — a name holds an emoji fine. No manual ordering
 * within a space either: project order stays activity-derived
 * (buildSidebarGroups). Add both when someone actually asks.
 */
export interface SpaceInfo {
  id: string;
  name: string;
}

export interface ProjectInfo {
  id: string;
  /** e.g. "pingdotgg/t3code", derived from git remote or folder name */
  slug: string;
  name: string;
  path: string;
  /** When set, the project lives on this host (user@host) and agents run over ssh. */
  remoteHost?: string;
  /** Absolute path on the remote host. Required when remoteHost is set. */
  remotePath?: string;
  /** Space membership. Absent = unassigned (renders in the trailing group). */
  spaceId?: string;
}

/** Optional remotes for projects.add. Empty/absent = local project. */
export interface AddProjectOptions {
  remoteHost?: string;
  remotePath?: string;
}

/**
 * Input for projects.create: a plain folder name plus the absolute path of
 * an existing parent directory. The backend mkdirs name inside parentDir,
 * git-inits it, and adds it as a project.
 */
export interface CreateProjectInput {
  name: string;
  parentDir: string;
}

/**
 * Patch for projects.update. An empty remoteHost string clears the remote
 * config, turning the project local again; a non-empty host requires an
 * absolute remotePath.
 */
export interface ProjectUpdateInput {
  projectId: string;
  name?: string;
  remoteHost?: string;
  remotePath?: string;
  /** Space membership: an id assigns, empty string ("") unassigns. */
  spaceId?: string;
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
  /** Short reason a run failed ("Run error: ..."), null otherwise. Set when status becomes "failed", cleared when a run starts. */
  lastError: string | null;
  createdAt: number;
  /**
   * Last REAL activity: a message appended, a run status change, or a title
   * change. Internal mutations (permission mode, worktree bookkeeping, store
   * migration) must NOT bump this; the sidebar age label derives from it.
   */
  updatedAt: number;
  /** Set while a run is active on this thread; drives the Working elapsed label. */
  runStartedAt: number | null;
  /**
   * True while the active run is blocked on the user (a permission prompt or
   * an agent question). Only meaningful when status is "working" — the
   * sidebar renders Waiting instead of Working. Cleared when the prompt is
   * answered and defensively at the next run start (a killed CLI can leave
   * it stale, but the working guard keeps a stale flag invisible).
   */
  awaitingInput?: boolean;
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
   * Muted: this thread never posts a desktop notification, however loud its
   * run gets. Notification-only — it does not hide the thread, pause it, or
   * change settle classification. For fan-outs where every worker settling
   * would otherwise ping (issue #87).
   */
  muted: boolean;
  /**
   * Free-text user scratch pad (issue #194). Empty string when unset.
   * Never bumps updatedAt. Purely user-facing: the agent never reads it
   * (this is NOT agent memory).
   */
  notes: string;
  /**
   * Follow-up typed while a run was active (issue #92/#137); flushed at the
   * next settle. Persisted on the thread so a reload cannot drop it and the
   * sidebar can show a queue pending on an unselected thread.
   */
  queued: { prompt: string; attachments?: AttachmentInfo[] } | null;
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
  /**
   * Worktree requested but not yet created — it materializes at first run
   * (lazy, t3-style), so a thread that never runs leaves nothing on disk.
   */
  pendingWorktree?: boolean;
  /**
   * Orchestrator thread: the first prompt is forked to a worker that holds
   * the worktree and does the work, instead of running here (issue #202).
   * Cleared once that fork happens; later prompts run this thread's own LLM.
   */
  pendingFork?: boolean;
  /**
   * In-session subagents spawned via the Agent tool, tracked by the runner
   * from the CLI stream (issue #21). Newest-last, capped to 20 rows.
   */
  subagents?: SubagentInfo[];
  /**
   * The agent's live working plan, mirrored by the runner from its todo list
   * (claude TodoWrite) and shown on the Planboard next to the GitHub issues
   * (issue #76). Absent until the agent writes a todo list; the newest list
   * replaces the previous one and outlives the run.
   */
  planSteps?: PlanStep[];
  /**
   * The last plan the user APPROVED (ExitPlanMode), kept so the thread's plan
   * card outlives the approval prompt (issue #75). Truncated on write — this
   * rides every threads:changed push. Absent until a plan is approved; a
   * rejected plan never lands here and the newest approved plan replaces it.
   */
  plan?: string;
}

/** Cap for ThreadInfo.notes / threads.setNotes (issue #194). */
export const THREAD_NOTES_MAX = 2000;

/** One step of an agent's working plan, in the agent's own order. */
export interface PlanStep {
  step: string;
  status: PlanStatus;
}

/** One in-session subagent (Agent tool call) surfaced in the Agents panel. */
export interface SubagentInfo {
  /** tool_use id of the spawning Agent call. */
  id: string;
  /** The Agent call's short description (falls back to the tool summary). */
  description: string;
  /** subagent_type from the tool input, e.g. "general-purpose"; null when absent. */
  agentType: string | null;
  status: "running" | "done" | "failed";
}

/**
 * Lightweight per-thread row for the Agents tab team view (threads:summaries).
 * Roles derive from handoffFrom: a summary WITH handoffFrom is a Worker; a
 * thread another summary's handoffFrom points to is an Orchestrator.
 */
export interface ThreadSummaryInfo {
  id: string;
  title: string;
  provider: string;
  status: ThreadStatus;
  handoffFrom: string | null;
  /** Mirrors ThreadInfo: drives the "waiting on N · elapsed" line (issue #42). */
  runStartedAt: number | null;
  /** Mirrors ThreadInfo: a worker stalled on a permission prompt. */
  awaitingInput?: boolean;
  /**
   * First line of the thread's last assistant message and its timestamp;
   * null when the thread has no assistant message yet.
   */
  lastActivity: { text: string; at: number } | null;
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
  /**
   * Filenames of images the tool returned (screenshots, Read of a PNG), kept
   * under userData/tool-images. Load one with files.image({ name }).
   */
  images?: string[];
}

/**
 * An image or folder the user attached to a chat message (composer chips).
 * `path` is absolute: agents run on this machine and read it with their
 * normal file tools, so nothing is copied or embedded.
 */
export interface AttachmentInfo {
  kind: "image" | "folder";
  path: string;
  /** Display name (basename of path). */
  name: string;
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
  /** Images/folders the user attached (role "user" only). */
  attachments?: AttachmentInfo[];
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

/** One row in the cross-thread activity feed. */
export type ActivityKind = "created" | "started" | "done" | "failed";

export interface ActivityItem {
  id: string;
  threadId: string;
  projectId: string;
  kind: ActivityKind;
  /** Epoch ms of the real event. Never invented. */
  at: number;
  threadTitle: string;
}

/** One provider/model cell in the usage-by-day rollup. */
export interface UsageEntry {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/**
 * Local calendar day "YYYY-MM-DD" -> provider -> model -> entry.
 * Days with no activity are simply absent. The store retains at most 90 days.
 */
export type UsageByDay = Record<string, Record<string, Record<string, UsageEntry>>>;

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

/**
 * A live "may I use this tool?" prompt from the agent CLI, awaiting the
 * user's decision. Runner-ephemeral: it exists only while the run is active
 * and is never persisted; answering routes through threads.respondPermission.
 */
export interface PendingPermissionInfo {
  /** Provider control-request id; pass back when responding. */
  requestId: string;
  /** Tool name, e.g. "Bash", "Edit". */
  toolName: string;
  /** One-line summary, e.g. "Bash: npm test". */
  summary: string;
  /** Pretty-printed JSON of the tool input (truncated like ToolCallInfo). */
  input: string;
  /**
   * Present when the agent is asking the user a question (AskUserQuestion):
   * render an option picker instead of the generic allow/deny prompt and
   * answer via respondPermission's `answers`.
   */
  questions?: PendingQuestion[] | null;
  /**
   * Present when the agent is asking to leave plan mode (ExitPlanMode): the
   * plan markdown, rendered in the prompt panel instead of the raw JSON.
   */
  plan?: string | null;
}

/** One question of an AskUserQuestion prompt. */
export interface PendingQuestion {
  question: string;
  /** Short chip label, e.g. "Auth method". */
  header: string;
  /** True: the user may pick several options (answer joins labels with ", "). */
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/** User decision on a PendingPermissionInfo. "allowAlways" also allows the tool for the rest of the CLI session. */
export type PermissionDecision = "allow" | "allowAlways" | "deny";

export interface ThreadDetail {
  thread: ThreadInfo;
  messages: ChatMessage[];
  workLog: WorkLogItem[];
  /** Only populated by the simulate provider; null for real sessions. */
  workflow: WorkflowView | null;
  /** Cumulative provider usage for this thread; null before the first turn. */
  usage: SessionUsage | null;
  /** Oldest unanswered permission prompt of the active run; absent/null when none. */
  pendingPermission?: PendingPermissionInfo | null;
}

/**
 * A streamed thread update ("thread:updated"). `messages` and `workLog` are
 * TAILS: everything from `messagesFrom` / `workLogFrom` onward, with the
 * untouched prefix left out (the biggest transcripts are megabytes and this
 * is pushed on every chunk). Merge with mergeThreadPatch; a missing index
 * means 0, so a plain full ThreadDetail is also a valid patch.
 */
export interface ThreadPatch extends ThreadDetail {
  messagesFrom?: number;
  workLogFrom?: number;
  /**
   * Push counter for this thread, 1-based. A gap means a push was dropped
   * (web socket reconnect), so the prefix we hold may be stale: refetch
   * instead of merging. Absent on full pushes.
   */
  seq?: number;
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

/**
 * Origin owner/repo plus an https web URL for the thread root. In-band
 * failure: no repo, no origin, or an unparseable remote is `{ ok: false }`.
 */
export type GitRepoInfo =
  | { ok: true; owner: string; repo: string; webUrl: string }
  | { ok: false };

/**
 * `git pull --ff-only` outcome. Never rejects: dirty tree, no upstream,
 * diverged, and not-a-repo all come back as `{ ok: false, reason }`.
 */
export type GitPullResult =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

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

/** One row from `gh issue list`, for the Planboard. */
export interface PlanIssue {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  /** Label names, e.g. ["plan:doing", "roadmap"]. */
  labels: string[];
  /** ISO timestamp from gh, when present. */
  updatedAt?: string;
}

/** Per-project listIssues result. Failures stay in-band so the UI can retry. */
export type ListIssuesResult =
  | { ok: true; issues: PlanIssue[] }
  | { ok: false; reason: string };

/** Planboard column an issue can be moved to, as a plan:* label. */
export type PlanStatus = "todo" | "doing" | "done";

/** Label-move result. Failures stay in-band (missing gh, auth, label). */
export type SetPlanStatusResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * How hard a model should think. Persisted per thread, sent to the CLI.
 *
 * These are the levels the installed CLIs actually accept, verified against
 * them rather than copied from a design: `claude --effort` takes low, medium,
 * high, xhigh, max, and `grok --reasoning-effort` takes low, medium, high, xhigh.
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
   * Per-orchestration spend ceiling (USD): an orchestrator thread's own
   * turns plus its orchWorker crew may not collectively exceed this. When
   * they do, the next orchestration wake-up is refused and the thread lands
   * failed with the reason (issue #67). null = no ceiling.
   */
  orchestrationBudgetUsd: number | null;
  /**
   * Days of silence before a quiet thread auto-settles (t3's window).
   * null disables the inactivity path entirely — threads then settle only
   * via PR state or an explicit settle. Positive integer when set. The
   * renderer's default when this is absent/undefined stays
   * AUTO_SETTLE_AFTER_DAYS (3): the setting overrides the constant, it
   * does not replace it.
   */
  autoSettleAfterDays: number | null;
  /**
   * User-registered MCP servers (Skills tab). Built-ins coder-memory and
   * coder-threads are app-owned and never appear here. Enabled entries are
   * folded into every provider's MCP injection on the next turn.
   */
  mcpServers: McpServerInfo[];
  /**
   * When true, plain "New thread" creates an isolated worktree thread by
   * default (local projects only; remote projects always get plain threads).
   * The caret's "New worktree thread" stays an explicit opt-in either way.
   */
  defaultWorktree: boolean;
  /**
   * When true, plain "New thread" creates an ORCHESTRATOR thread: its first
   * prompt is forked to a worker that holds the worktree (issue #202). Wins
   * over defaultWorktree — an orchestrator never holds one itself. Local
   * projects only; remote projects always get plain threads.
   */
  defaultOrchestrate: boolean;
  /**
   * Global desktop-notification switch. False silences every thread; true
   * (the default) leaves per-thread mute in charge. Only an explicit false
   * on disk turns it off, so upgrades keep notifying.
   */
  notifications: boolean;
  /**
   * Update channel override; null follows the channel stamped at package
   * time. Has no effect in an unstamped dev tree (updates stay disabled).
   */
  updateChannel: "prod" | "nightly" | null;
}

/** A user-registered MCP server entry (settings slice). */
export interface McpServerInfo {
  /** Lowercase slug: /^[a-z0-9-]+$/; coder-memory/coder-threads are reserved. */
  name: string;
  /** http(s) MCP endpoint. */
  url: string;
  /** Optional bearer token; never echoed back by the UI once stored. */
  token?: string;
  enabled: boolean;
}

/** Where a skill was found on disk. */
export type SkillSource = "claude" | "agents" | "project";

/** A discovered skill (SKILL.md) as surfaced to the Skills tab. */
export interface SkillInfo {
  name: string;
  description: string;
  source: SkillSource;
}

/** Payload for skills:add; target picks the user skill dir to write into. */
export interface SkillWrite {
  target: "claude" | "agents";
  name: string;
  description: string;
  body: string;
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
    /** Update channel stamped at package time; null in a dev tree. */
    channel: "prod" | "nightly" | null;
  };
}

/** Result of an auto-update check (app.checkUpdate). */
export interface UpdateStatus {
  /**
   * disabled: build carries no channel/tag stamp (dev tree, local bundle).
   * none: already on the channel's latest release.
   * available: newer release exists and has not been installed — it never is
   *   without a user click, and on non-macOS / no matching asset / a failed
   *   install it never is at all; `url` links the release page.
   * staged: new bundle downloaded, verified and swapped in; restart to run it.
   */
  state: "disabled" | "none" | "available" | "staged" | "error";
  channel: "prod" | "nightly" | null;
  /** Tag of the newer release, when one exists. */
  tag: string | null;
  /** Release page URL for manual installs. */
  url: string | null;
  error: string | null;
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
    /** Check the release channel. Read-only: never installs anything. */
    checkUpdate(): Promise<UpdateStatus>;
    /** User-initiated install: download, verify the digest, stage the swap. */
    downloadUpdate(): Promise<UpdateStatus>;
    /** Relaunch into a staged update. */
    applyUpdate(): Promise<void>;
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
  /**
   * Agent skills on disk (SKILL.md files). list reads the two user skill
   * dirs plus the selected project's .claude/skills; add/remove only ever
   * touch the user dirs (~/.claude/skills, ~/.agents/skills).
   */
  skills: {
    list(input?: { projectPath?: string }): Promise<SkillInfo[]>;
    add(input: SkillWrite): Promise<{ name: string }>;
    remove(input: { target: "claude" | "agents"; name: string }): Promise<void>;
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
    /** Validates the path is a git repo; rejects otherwise. Optional remotes skip the local checkout. */
    add(path: string, opts?: AddProjectOptions): Promise<ProjectInfo>;
    /** Create a new folder + git repo at parentDir/name, then add it as a project. */
    create(input: CreateProjectInput): Promise<ProjectInfo>;
    /** Patch name and/or SSH remote fields of an existing project. */
    update(input: ProjectUpdateInput): Promise<ProjectInfo>;
    /** Opens a native folder picker; resolves null if the user cancels. */
    addViaDialog(): Promise<ProjectInfo | null>;
    /**
     * Native directory picker without the add: resolves the chosen absolute
     * path, or null on cancel. Rejects where no native dialog exists (web).
     */
    pickDirectory(): Promise<string | null>;
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
  /**
   * Named sidebar groups. List order is display order (creation order).
   * Removing a space unassigns its projects; it never touches projects
   * themselves.
   */
  spaces: {
    list(): Promise<SpaceInfo[]>;
    /** Rejects an empty name. Duplicate names are allowed (ids are the key). */
    add(input: { name: string }): Promise<SpaceInfo>;
    /** Rename. Rejects an empty name or an unknown id. */
    update(input: { id: string; name: string }): Promise<SpaceInfo>;
    /** Drops the space and clears spaceId on every project that used it. */
    remove(input: { id: string }): Promise<void>;
  };
  threads: {
    list(): Promise<ThreadInfo[]>;
    /**
     * Per-thread summaries for the Agents tab team view: role fields
     * (handoffFrom) plus the first line of the last assistant message.
     * Cheap: no git or provider calls.
     */
    summaries(): Promise<ThreadSummaryInfo[]>;
    /**
     * Full-content search: matches thread titles, notes, AND message text
     * (case-insensitive substring), newest activity first, max 50. Includes
     * archived threads; the renderer styles them as usual.
     */
    search(input: { query: string }): Promise<ThreadInfo[]>;
    /**
     * Create a thread. With `worktree: true` the thread immediately gets its
     * own git worktree + `coder/<slug>-<id>` branch (local projects only);
     * creation fails atomically when the worktree cannot be created.
     *
     * With `orchestrate: true` the thread is an ORCHESTRATOR: its first
     * prompt is forked to a worker thread which holds the worktree and does
     * the work. Wins over `worktree` — an orchestrator never holds one
     * itself — and rejects on remote projects. Also fails atomically.
     */
    create(input: {
      projectId: string;
      title: string;
      worktree?: boolean;
      orchestrate?: boolean;
    }): Promise<ThreadInfo>;
    get(id: string): Promise<ThreadDetail>;
    /** Sticky permission mode for future turns of this thread. */
    setPermissionMode(input: { threadId: string; mode: PermissionMode }): Promise<ThreadInfo>;
    /**
     * Answer the active run's pending permission prompt (ThreadDetail.
     * pendingPermission). Rejects when the run ended or the request was
     * already answered; the updated detail arrives via thread:updated.
     */
    respondPermission(input: {
      threadId: string;
      requestId: string;
      decision: PermissionDecision;
      /**
       * For question prompts (pendingPermission.questions): the chosen answer
       * per question text; sent to the agent as updatedInput.answers.
       */
      answers?: Record<string, string>;
    }): Promise<void>;
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
     * Persist or clear the type-ahead queue (issue #137). prompt === null
     * clears; a non-null prompt APPENDS to any existing queue so two mid-run
     * sends cannot race-replace each other across the async hop. Never
     * bumps updatedAt: queueing is not activity, same rule as setPinned.
     */
    setQueued(input: {
      threadId: string;
      prompt: string | null;
      attachments?: AttachmentInfo[];
    }): Promise<ThreadInfo>;
    /**
     * Snooze until an epoch ms, or clear with null. Rejects a non-null
     * `until` that is not strictly in the future, naming the value. Stamps
     * snoozedAt = now alongside. Never bumps updatedAt; never touches the
     * agent or the run lifecycle.
     */
    setSnoozed(input: { threadId: string; until: number | null }): Promise<ThreadInfo>;
    /** Mute/unmute desktop notifications for one thread. Never bumps updatedAt. */
    setMuted(input: { threadId: string; muted: boolean }): Promise<ThreadInfo>;
    /**
     * Set or clear the per-thread scratch pad. Trims, caps at
     * THREAD_NOTES_MAX, empty string clears. Never bumps updatedAt.
     */
    setNotes(input: { threadId: string; notes: string }): Promise<ThreadInfo>;
    /**
     * Rename a thread. Trims, truncates to THREAD_TITLE_MAX, rejects an
     * empty title. Never bumps updatedAt.
     */
    rename(input: { threadId: string; title: string }): Promise<ThreadInfo>;
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
  activity: {
    /** Cross-thread newest-first feed of created/started/done/failed. */
    list(): Promise<ActivityItem[]>;
  };
  runs: {
    /**
     * Sends one turn to the thread's provider session (resuming the stored
     * sessionId when present). Streams tool/text events via thread:updated.
     * If the thread title is still the default "New Thread", main renames it
     * from the first line of the prompt.
     */
    start(input: {
      threadId: string;
      prompt: string;
      attachments?: AttachmentInfo[];
    }): Promise<{ runId: string }>;
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
     * Origin owner/repo + https web URL for the thread root. Never rejects:
     * `{ ok: false }` when there is no repo, no origin, or a remote project.
     */
    repoInfo(input: { threadId: string }): Promise<GitRepoInfo>;
    /**
     * `git pull --ff-only` in the thread root. Never rejects: dirty tree, no
     * upstream, diverged, and not-a-repo come back as `{ ok: false, reason }`.
     */
    pull(input: { threadId: string }): Promise<GitPullResult>;
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
    /**
     * Issues for a project checkout via `gh issue list --state all`, for the
     * Planboard. Never rejects for missing gh / non-GitHub remotes / auth:
     * those come back as `{ ok: false, reason }`.
     */
    list(projectPath: string): Promise<ListIssuesResult>;
    /**
     * Swap an issue's plan:* label via `gh issue edit`, so starting work from
     * the Planboard moves the card. Never rejects: failures come back as
     * `{ ok: false, reason }`.
     */
    setPlanStatus(input: {
      projectPath: string;
      number: number;
      status: PlanStatus;
    }): Promise<SetPlanStatusResult>;
  };
  files: {
    /**
     * Repo-relative paths for the composer's @-mention popup: tracked plus
     * untracked (gitignored excluded), substring-filtered, top 20. Uses the
     * thread's worktree when bound, else the project checkout.
     */
    list(input: { threadId: string; query?: string }): Promise<{ files: string[] }>;
    /**
     * One image a tool produced, as a data URL (ToolCallInfo.images holds the
     * names). null when the file is gone or the name is not an image.
     */
    image(input: { name: string }): Promise<{ dataUrl: string | null }>;
  };
  /**
   * Composer attachments: images and folders the user pins to a message.
   * Only absolute paths travel; the agent reads them with its file tools.
   * pick needs a native dialog, so it rejects in web mode (the renderer
   * hides the attach button when no Electron bridge is present).
   */
  attachments: {
    /**
     * Native picker for images and folders (multi-select). Non-image files
     * are skipped: those belong to the @-mention flow instead.
     */
    pick(): Promise<{ attachments: AttachmentInfo[] }>;
    /**
     * Classify absolute paths (e.g. resolved from a drag-drop) as image or
     * folder via statSync; anything else is skipped.
     */
    fromPaths(input: { paths: string[] }): Promise<{ attachments: AttachmentInfo[] }>;
    /**
     * Persist a pasted image (data URL) under userData/attachments/<threadId>
     * and return its AttachmentInfo. null when the payload is not an image.
     */
    saveImage(input: {
      threadId: string;
      dataUrl: string;
    }): Promise<{ attachment: AttachmentInfo | null }>;
    /**
     * One attached image as a data URL (the CSP allows data:, not file:).
     * null when the path is missing, not an image, or too large.
     */
    readImage(input: { path: string }): Promise<{ dataUrl: string | null }>;
    /**
     * Electron-only (preload, webUtils.getPathForFile): absolute path of a
     * drag-dropped File. Absent on web/dev bridges, where drop is disabled.
     */
    droppedFilePath?(file: File): string;
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
  on(channel: "thread:updated", cb: (patch: ThreadPatch) => void): () => void;
  /** Desktop notification click: select this thread. */
  on(channel: "thread:select", cb: (threadId: string) => void): () => void;
}

declare global {
  interface Window {
    coder: CoderApi;
  }
}
