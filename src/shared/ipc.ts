// Typed IPC contract between the Electron main process and the React renderer.
// The preload script exposes `window.coder` implementing CoderApi.
// Invoke channel names are `${namespace}:${method}` and live in
// src/shared/ipcChannels.ts — preload and wireClient iterate that table
// (issue #623). Push channels: "threads:changed", "thread:updated",
// "thread:select".

/**
 * Retired (#568). The IPC type stays so old callers still typecheck;
 * list() is always [] and add/update reject.
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
  /** Retired (#568). Stripped on store load; never written. */
  spaceId?: string;
  /** When true, a background poller starts a thread for every issue that enters plan:todo (issue #165). Absent = off. */
  autoDispatch?: boolean;
  /**
   * Worktree retention (#316 / #559): how many SETTLED threads keep their
   * worktree on disk. Default 10. 0 = keep everything. Reclaiming only
   * ever removes the worktree directory — the branch always survives, so
   * no commit is ever lost to GC.
   */
  worktreeRetention?: number;
  /**
   * User override (#610): a path relative to the project checkout. Absent
   * means Automatic (detect from favicon / t3.json / HTML). Never an
   * absolute path.
   */
  iconPath?: string;
  /**
   * Derived data URL for the resolved icon. Main process only; never
   * persisted. Absent when the repo has no icon.
   */
  iconUrl?: string;
  /**
   * Windows doctor (#435). Only on the add/create return value when the
   * host is win32. Never persisted. Failed checks do not reject the add.
   */
  windowsDoctor?: WindowsDoctorReport;
}

/** One Windows doctor probe (#435). Advisory — never blocks add. */
export interface WindowsDoctorCheck {
  id: "longpaths" | "gitBash" | "node22" | "wslBoundary";
  ok: boolean;
  message: string;
  /** What to do. Only when !ok. */
  fix?: string;
}

/** Result of the win32 project-add doctor. Absent off win32 and on list(). */
export interface WindowsDoctorReport {
  checks: WindowsDoctorCheck[];
}

/** Anthropic six-axis bands (#412). */
export type AgentConfigGrade = "A" | "B" | "C" | "D" | "F";

export type AgentConfigAxisId =
  | "commands"
  | "architecture"
  | "patterns"
  | "conciseness"
  | "currency"
  | "actionability";

export interface AgentConfigAxisScore {
  id: AgentConfigAxisId;
  score: number;
  max: number;
  notes: string;
}

export interface AgentConfigIssue {
  severity: "error" | "warn" | "info";
  message: string;
}

export interface AgentConfigFileReport {
  path: string;
  bytes: number;
  score: number;
  grade: AgentConfigGrade;
  axes: AgentConfigAxisScore[];
  issues: AgentConfigIssue[];
  recommendations: string[];
}

export interface AgentConfigMemoryGap {
  id: string;
  type: MemoryEntryInfo["type"];
  title: string;
}

/** Lint of a repo's AGENTS.md / CLAUDE.md against the six-axis rubric + memory. */
export interface AgentConfigDoctorReport {
  projectId: string;
  files: AgentConfigFileReport[];
  score: number;
  grade: AgentConfigGrade;
  memory: {
    considered: number;
    covered: number;
    missing: AgentConfigMemoryGap[];
  };
  issues: AgentConfigIssue[];
  recommendations: string[];
}

export interface AgentConfigPreviewFile {
  path: string;
  content: string;
  exists: boolean;
}

export interface AgentConfigPreview {
  projectId: string;
  files: AgentConfigPreviewFile[];
}

export interface AgentConfigWriteResult {
  projectId: string;
  written: string[];
}

/** Optional remotes for projects.add. Empty/absent = local project. */
export interface AddProjectOptions {
  remoteHost?: string;
  remotePath?: string;
}

/** One directory in an `fs:browse` listing (#609). */
export interface FsBrowseEntry {
  name: string;
  fullPath: string;
  recent?: boolean;
}

export interface FsBrowseInput {
  /** Directory or partial path. Empty / `~` / `~/` lists home + recent projects. */
  path: string;
  /** SSH `user@host`. Omit/empty = this machine. */
  environment?: string | null;
  /** Active project cwd; required to resolve `./` and `../`. */
  cwd?: string | null;
}

export interface FsBrowseResult {
  parentPath: string;
  entries: FsBrowseEntry[];
  existed?: boolean;
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
  /** Retired (#568). Ignored; never persisted. */
  spaceId?: string;
  /** When true, a background poller starts a thread for every issue that enters plan:todo (issue #165). Absent = off. */
  autoDispatch?: boolean;
  /** Worktree retention (#316 / #559): 0 keeps everything, N > 0 sets the keep count. Default 10. */
  worktreeRetention?: number;
  /**
   * Relative project file to use as the icon, or null to restore
   * Automatic detection (#610).
   */
  iconPath?: string | null;
}

/**
 * One reclaimable worktree directory in a GC scan (#316).
 *
 * `orphan`    - no thread references the directory (crashed/reset store).
 * `retention` - a settled thread's worktree past its project's limit.
 * `blocked` names why a candidate is NOT safe to reclaim (uncommitted
 * changes, git refused). Blocked rows are shown but never pre-selected,
 * and gcClean skips them.
 */
export interface GcCandidate {
  path: string;
  bytes: number;
  reason: "orphan" | "retention";
  threadId: string | null;
  title: string | null;
  projectId: string | null;
  branch: string | null;
  /**
   * A worktree a fork created or one whose thread is archived (#624). It does
   * not occupy the project's keep-N retention buffer and `unmerged` does not
   * hold it back — the branch outlives the directory.
   */
  transient?: boolean;
  /**
   * Commits on this branch the project's branch does not have (#601). Absent
   * when there are none. NOT a `blocked` reason — GC removes directories and
   * never branches, so the commits survive — but work nobody landed must not
   * be reclaimed by accident, so these rows are never pre-selected and boot
   * retention skips them entirely (unless `transient`).
   */
  unmerged?: number;
  blocked?: string;
}

/** Worktree disk usage rolled up per project (#316). */
export interface ProjectDiskUsage {
  projectId: string;
  worktrees: number;
  bytes: number;
}

export interface GcScanResult {
  candidates: GcCandidate[];
  usage: ProjectDiskUsage[];
  /** Total bytes of every worktree under the worktree base. */
  totalBytes: number;
}

/** Batch cleanup: one dialog, one confirm, N directories (#316). */
export interface GcCleanInput {
  paths: string[];
}

export interface GcCleanResult {
  removed: string[];
  failed: Array<{ path: string; error: string }>;
  /** Bytes reclaimed, summed from the scan sizes of removed directories. */
  bytes: number;
}

/** One Vibe Kanban project as the importer sees it (#399). */
export interface VibeKanbanPreviewProject {
  name: string;
  path: string | null;
  exists: boolean;
  taskCount: number;
  worktreeCount: number;
}

/** Detect / dry-run of a Vibe Kanban data dir. */
export interface VibeKanbanPreview {
  found: boolean;
  dataDir: string | null;
  dbPath: string | null;
  projects: VibeKanbanPreviewProject[];
  taskCount: number;
  worktreeCount: number;
  alreadyImported: number;
}

export interface VibeKanbanImportResult {
  dataDir: string | null;
  dbPath: string | null;
  projectsAdded: number;
  projectsReused: number;
  threadsCreated: number;
  threadsSkipped: number;
  worktreesMapped: number;
  skipped: Array<{ title: string; reason: string }>;
}

export type ThreadStatus = "idle" | "working" | "done" | "failed" | "quota-wait";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/**
 * Computed (never persisted): whether this thread's next run is actually
 * confined. Agent × repo-location; see electron/sandbox.js.
 */
export interface ThreadSandbox {
  sandboxed: boolean;
  /** Hover/title copy: yes/no why, including where the process runs. */
  reason: string;
}

export interface ThreadInfo {
  id: string;
  projectId: string;
  title: string;
  branch: string | null;
  prNumber: number | null;
  /** Set alongside prNumber so the badge can link out without calling gh. */
  prUrl: string | null;
  status: ThreadStatus;
  /** Short reason a run failed ("Run error: ..."), null otherwise. Set when status becomes "failed" or "quota-wait", cleared when a run starts. */
  lastError: string | null;
  /**
   * Provider quota-wait (#462): epoch ms when the thread will auto-resume.
   * Only meaningful while status is "quota-wait". Distinct from snooze
   * (visibility only) and from Solenta's own budget cap (#286).
   */
  quotaWaitUntil?: number | null;
  /**
   * One-shot: this thread already woke from a quota-wait. The next quota
   * error fails the turn instead of parking again. Cleared on a human turn.
   */
  quotaWaitResumed?: boolean;
  /**
   * Per-thread auto-resume override. null/absent inherits the global
   * settings.quotaWaitAutoResume (default on). false is the opt-out.
   */
  quotaWaitAutoResume?: boolean | null;
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
  /**
   * Epoch ms of the last stream event the provider CLI produced on the active
   * run (issue #314). Absent/null until the run emits anything. Feeds the turn
   * watchdog; a run whose CLI hangs keeps runStartedAt but stops moving this.
   */
  lastEventAt?: number | null;
  /**
   * Epoch ms when the turn watchdog flagged the active run as quiet — no
   * stream event for the stall window, and not awaitingInput (issue #314).
   * Null/absent = healthy. ADVISORY ONLY: the run is not killed, so a
   * slow-but-alive CLI clears this by emitting anything. Only meaningful
   * while status is "working".
   */
  stalledAt?: number | null;
  /** Archived threads keep their history but are hidden from the default sidebar list. */
  archived: boolean;
  /** Set when this thread was imported from a Vibe Kanban card (#399). */
  vibeKanbanTaskId?: string | null;
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
   * without clearing it, and beats settle classification. A live snooze
   * also silences desktop notifications. A snoozed thread wakes early
   * ("raises its hand") when something outranks the snooze: a FRESH
   * failure, a run completion newer than snoozedAt, or awaitingInput.
   * Timer wakes are derived client-side — no event fires when
   * snoozedUntil passes. After wake, a Woke pill stays until visit.
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
   * One-tap estimate of time this thread saved the user (issue #401).
   * Null/absent = never asked or never answered; the transcript card asks
   * once a run completes. Never bumps updatedAt.
   */
  feltEstimate?: FeltEstimate | null;
  /**
   * Follow-up typed while a run was active (issue #92/#137); flushed at the
   * next settle. Persisted on the thread so a reload cannot drop it and the
   * sidebar can show a queue pending on an unselected thread.
   */
  queued: {
    prompt: string;
    attachments?: AttachmentInfo[];
    /**
     * Why the last delivery attempt failed (issue #314). Set by the main
     * process when draining the queue at a run terminal throws; the prompt
     * STAYS queued so nothing is lost and the composer can offer a retry.
     * Cleared on the next attempt.
     */
    error?: string | null;
  } | null;
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
  /**
   * Last known GitHub mergeability (issue #524). Set by prStatus when gh
   * returns `mergeable`. CONFLICTING flips the header next-action to
   * Update from main. Null when unknown or the PR is gone.
   */
  prMergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  /**
   * Verification gate (issue #296): a shell command the thread must pass
   * before a run may land "done". Null/empty = unarmed, runs settle on the
   * agent's word alone. Run in the thread's worktree (project root when the
   * thread has none) at every successful run terminal, so "done" means
   * proven, not claimed.
   */
  verifyCommand: string | null;
  /** Evidence from the latest verification attempt; null before the first. */
  verify: VerifyResult | null;
  /**
   * GitHub issue this thread was started from (planboard / "Start task").
   * Absent/null when unknown; the first user prompt is also scanned for
   * `GitHub issue #N:` as a fallback (issue #420).
   */
  issueNumber?: number | null;
  /**
   * Delayed post-merge re-check (issue #420). Absent/null until a PR
   * merges on a thread that has a verify command. 'Merged' is not 'worked'.
   */
  postMergeVerify?: PostMergeVerify | null;
  /** Agent harness backing this thread: a ProviderInfo.id ("claude", "codex", "grok", "opencode", "simulate"). */
  provider: string;
  /** Model override passed to the provider CLI when set (e.g. claude --model). */
  model: string | null;
  /** Provider session id, persisted after the first turn so follow-ups resume context. */
  sessionId: string | null;
  /**
   * One-shot context replay (issue #254). Set by `threads.rewind`, which
   * clears sessionId because a CLI session cannot be rewound: the next turn
   * therefore starts a FRESH session and the runner prefixes its prompt with
   * a digest of this thread's own RETAINED transcript tail (same builder as
   * the hand-off prefix, source = this thread). Cleared when that turn starts,
   * so it never leaks into turn two.
   */
  replayContext?: boolean;
  /** Passed to the provider CLI (claude --permission-mode). Sticky per thread. */
  permissionMode: PermissionMode;
  /**
   * Computed at read time (#436). Whether the next run is actually confined
   * (agent × repo location). Absent on store rows and older fixtures.
   */
  sandbox?: ThreadSandbox;
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
  /**
   * Hypothesis ledger (issue #303): approaches the agents on this thread tried
   * and how each turned out. Written only by the coder-threads MCP tool
   * `hypothesis_record` — never inferred from the transcript. Newest-last,
   * capped to HYPOTHESES_MAX. Absent until an agent records one.
   */
  hypotheses?: Hypothesis[];
  /**
   * Suggested-work chips (issue #550): out-of-scope findings the agent
   * offered as one-click follow-up work. Written only by the coder-threads
   * MCP tool `work_suggest`; resolved by threads.resolveSuggestion. Absent
   * until an agent suggests something.
   */
  suggestions?: WorkSuggestion[];
  /**
   * Spec mode (issue #269): the thread writes three gated artifacts before it
   * writes code. Absent = normal thread. Set by threads.startSpec, advanced
   * one stage per approval in threads.reviewSpec, cleared by threads.stopSpec.
   */
  spec?: ThreadSpec;
  /**
   * Hunk hashes the user marked reviewed (issue #421). The itinerary skips
   * these until the hunk body changes. Absent → none accepted yet.
   */
  reviewAcceptedHunks?: string[];
  /**
   * Teach mode (issue #373): hints-not-solutions persona, TODO(human)
   * markers, and skill-gated autonomy. Absent/null = off. Set by
   * threads.startTeach or threads.create({ teach: true }); cleared by
   * threads.stopTeach. Copied onto forks so an orchestrator crew stays
   * in teach mode across providers.
   */
  teach?: ThreadTeach | null;
  /**
   * Ask mode (issue #392): read-only repo Q&A from the code index and
   * memory. Never a worktree, never tools, never the daily budget.
   * Absent/false = off. Set by threads.startAsk or threads.create({ ask: true });
   * cleared by threads.stopAsk. Copied onto forks; a worker of an Ask
   * thread does not get a worktree.
   */
  ask?: boolean;
  /**
   * Side questions (issue #471): `/btw` cards on this thread. Not a new
   * thread, not the live turn, not the follow-up queue. Newest-last.
   * Absent → none. Dismiss removes a row; promote queues it as a follow-up.
   */
  btw?: BtwCard[];
}

/** One `/btw` side-question card (issue #471). */
export type BtwStatus = "running" | "done" | "error";
export type BtwSource = "fm" | "print" | "retrieval";
export interface BtwCard {
  id: string;
  question: string;
  status: BtwStatus;
  createdAt: number;
  answer?: string;
  error?: string;
  source?: BtwSource;
}

/** One code-index symbol for the review itinerary reuse scan. */
export interface ReviewSymbol {
  name: string;
  path: string;
}

/** Extras the Changes panel needs to build a review itinerary. */
export interface ReviewContext {
  annotation: unknown;
  symbols: ReviewSymbol[];
  acceptedHunks: string[];
}

/** Autonomy ladder while Teach mode is on (issue #373). */
export const TEACH_AUTONOMY_LEVELS = ["hint", "review", "pair"] as const;
export type TeachAutonomy = (typeof TEACH_AUTONOMY_LEVELS)[number];

/**
 * Passed teach_review counts that promote autonomy.
 * 0..2 hint, 3..7 review, 8+ pair.
 */
export const TEACH_REVIEW_THRESHOLDS = { review: 3, pair: 8 } as const;

/** A thread's teach-mode state (issue #373). */
export interface ThreadTeach {
  autonomy: TeachAutonomy;
  /** Human TODO(human) fills the agent has reviewed as correct. */
  reviewsPassed: number;
}

/** The three gated spec artifacts, in the order they are approved (issue #269). */
export const SPEC_ARTIFACTS = ["requirements", "design", "tasks"] as const;
export type SpecArtifact = (typeof SPEC_ARTIFACTS)[number];
/** "build" is the post-gate stage: all three approved, code may finally be written. */
export type SpecStage = SpecArtifact | "build";

/** Spec folder relative to the thread's worktree: artifacts diff like code. */
export const SPEC_DIR = ".solenta/specs";

/** A thread's spec-mode state (issue #269). The artifacts live on disk. */
export interface ThreadSpec {
  /** Folder name under SPEC_DIR holding this thread's artifacts. */
  slug: string;
  stage: SpecStage;
  /** The current stage's artifact is submitted and waiting on the user. */
  awaitingApproval: boolean;
}

/** Cap for ThreadInfo.notes / threads.setNotes (issue #194). */
export const THREAD_NOTES_MAX = 2000;

/**
 * One-tap estimate of how much time a finished thread saved the user
 * (issue #401, the "felt" half of felt-vs-actual). Recorded once, from the
 * transcript card shown when a run completes; "declined" means the user
 * dismissed the prompt, so the card stays gone without inventing a number.
 * The "actual" half is never estimated — it comes from the fleet evidence
 * (wall clock, agent-active time) and the two meet in src/fleet.ts.
 */
export type FeltEstimate =
  | { kind: "saved"; savedMs: number; at: number }
  | { kind: "declined"; at: number };

/** One-tap buckets offered by the felt-estimate card (issue #401). */
export const FELT_ESTIMATE_BUCKETS_MS: readonly number[] = [
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
];

/** Cap for a felt estimate so a corrupt/typed value cannot skew the rollup. */
export const FELT_ESTIMATE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-thread ledger caps: rows kept, chars per claim, chars per reason. */
export const HYPOTHESES_MAX = 50;
export const HYPOTHESIS_CLAIM_MAX = 200;
export const HYPOTHESIS_REASON_MAX = 500;

/**
 * What an agent tried, and how it turned out. "invalidated" is the point of
 * the feature: a ruled-out approach is what stops the next agent (or the next
 * best-of-N fork) from re-treading a dead end.
 */
export type HypothesisStatus = "validated" | "invalidated" | "inconclusive";

/** One entry of a thread's hypothesis ledger (issue #303). */
export interface Hypothesis {
  /** Stable id, unique within the thread (write timestamp + a counter). */
  id: string;
  /** The approach, one line, truncated to HYPOTHESIS_CLAIM_MAX. */
  claim: string;
  status: HypothesisStatus;
  /** The evidence behind the verdict, truncated to HYPOTHESIS_REASON_MAX. Empty when the agent gave none. */
  reason: string;
  at: number;
}

/* --------------------------------------------------- suggested work chips */

/** Per-thread suggested-work caps: rows kept, chars per title, chars per prompt. */
export const SUGGESTIONS_MAX = 20;
export const SUGGESTION_TITLE_MAX = 120;
export const SUGGESTION_PROMPT_MAX = 4000;

/**
 * Lifecycle of a suggested-work chip (issue #550). "open" renders as a chip;
 * every other status hides it. Dismissal is per-thread and permanent — a
 * dismissed chip never comes back, and nothing is ever auto-started.
 */
export type WorkSuggestionStatus = "open" | "started" | "filed" | "dismissed";

/**
 * Out-of-scope work the agent noticed mid-run (issue #550). Written only by
 * the coder-threads MCP tool `work_suggest` — never parsed out of the
 * transcript. Newest-last on the thread, capped to SUGGESTIONS_MAX.
 */
export interface WorkSuggestion {
  /** Stable id, unique within the thread (write timestamp + a counter). */
  id: string;
  /** Chip label, one line, truncated to SUGGESTION_TITLE_MAX. */
  title: string;
  /**
   * Self-contained prompt for the new thread (and issue body when filed),
   * truncated to SUGGESTION_PROMPT_MAX. Self-contained because the fork only
   * carries a digest, not the suggesting thread's context.
   */
  prompt: string;
  status: WorkSuggestionStatus;
  at: number;
  /** Thread started from this chip, set when status is "started". */
  startedThreadId?: string;
  /** Issue filed from this chip, set when status is "filed". */
  issueNumber?: number;
}

/* ------------------------------------------------------- crew task list */

/** Caps for the shared task list (issue #277). */
export const CREW_TASK_TITLE_MAX = 200;
export const CREW_TASK_NOTE_MAX = 2000;
export const CREW_TASKS_MAX = 100;
/**
 * Loop guardrail: a task may be claimed this many times before the crew has
 * to stop and escalate. Prevents a worker (or two workers in turn) grinding
 * the same failing task forever.
 */
export const CREW_TASK_ATTEMPT_CAP = 3;
/**
 * Loop guardrail: consecutive machine-delivered turns (worker notices, peer
 * messages, unblock wake-ups) on one thread with no human in between.
 * Reset by any user-sent prompt.
 */
export const CREW_AUTO_TURN_CAP = 25;

/**
 * "open" is claimable once every task in `needs` is done — blocked-ness is
 * derived from the graph, never stored, so completing a task unblocks its
 * dependents with no second write to go stale.
 */
export type CrewTaskStatus = "open" | "claimed" | "done";

/** One attempt at a task: who claimed it and when it was given back. */
export interface CrewTaskAttempt {
  /** Thread that claimed it. */
  threadId: string;
  at: number;
  /** Why the attempt ended, when it ended without completing. */
  outcome?: string;
}

/**
 * One entry of a crew's shared task list (issue #277). Tasks belong to the
 * crew ROOT thread (the orchestrator at the top of the handoffFrom chain);
 * every worker in that crew sees the same list and self-claims from it.
 */
export interface CrewTask {
  /** Short id, unique within the crew ("t1", "t2") — agents quote it. */
  id: string;
  title: string;
  /** Task ids that must be done before this one may be claimed. */
  needs: string[];
  status: CrewTaskStatus;
  /** Thread that holds the claim, null when open or done. */
  owner: string | null;
  /** Result of a done task: a summary, or a `branch:path` artifact ref. */
  note: string;
  /** Claim history, oldest first — drives the CREW_TASK_ATTEMPT_CAP guardrail. */
  attempts: CrewTaskAttempt[];
  createdAt: number;
  updatedAt: number;
}

/** A crew task plus the derived fields no store write can get stale. */
export interface CrewTaskView extends CrewTask {
  /** Some task in `needs` is not done yet. */
  blocked: boolean;
}

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
  /** Mirrors ThreadInfo: the turn watchdog flagged this run as quiet (issue #314). */
  stalledAt?: number | null;
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
   * Last turn's FULL prompt size: input + cache-read + cache-creation + output.
   * The numerator for the context ring. Under prompt caching plain input_tokens
   * is near zero, so anything that omits the cache fields reads as ~0% and then
   * jumps (issue #317). Absent when the provider reports too little to measure
   * it — the ring hides rather than guess.
   */
  contextTokens?: number;
  /**
   * Context window the CLI itself reported for the running model (codex
   * token_count carries model_context_window). Beats the static provider
   * catalog, which goes stale on model change. Absent when unreported.
   */
  contextWindow?: number;
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

/**
 * One provider/model cell in the usage-by-day rollup.
 *
 * The token split matters: under prompt caching `inputTokens` is only the
 * uncached remainder, so it is the *billable* number and not the prompt size
 * (#556, sibling of #317). Providers that report no cache fields leave both
 * cache counters at 0, which is why an all-zero row is "unreported", not free.
 */
export interface UsageEntry {
  costUsd: number;
  /**
   * Uncached input, billable at the full rate.
   *
   * Caveat for codex: its `input_tokens` ALREADY includes
   * `cached_input_tokens` (electron/codex.js:372, and the test "does not add
   * cached_input_tokens on turn.completed"), and it reports cumulative
   * totals, so deriving a per-turn cached delta needs a snapshot the store
   * does not keep. Codex therefore records its whole input here with
   * cachedInputTokens 0. Processed totals stay correct; codex's cache split
   * reads as "none reported" rather than a real zero. Fixing that is its own
   * change, not this one.
   */
  inputTokens: number;
  /** cache_read_input_tokens; 0 when the provider does not report it. */
  cachedInputTokens: number;
  /** cache_creation_input_tokens; 0 when the provider does not report it. */
  cacheWriteTokens: number;
  outputTokens: number;
  turns: number;
  /** Of costUsd, the share spent on runs that ended failed or stopped. */
  wastedUsd: number;
}

/**
 * Local calendar day "YYYY-MM-DD" -> provider -> model -> entry.
 * Days with no activity are simply absent. The store retains at most 90 days.
 */
export type UsageByDay = Record<
  string,
  Record<string, Record<string, UsageEntry>>
>;

/**
 * Per-thread usage cell. Project and title are the last seen values, copied in
 * at record time so a deleted thread still attributes its spend (#403, #339).
 */
export interface UsageThreadEntry extends UsageEntry {
  projectId: string;
  projectName: string;
  title: string;
  provider: string;
  model: string;
}

/** Local calendar day -> thread id -> entry. Same 90-day retention. */
export type UsageThreadsByDay = Record<
  string,
  Record<string, UsageThreadEntry>
>;

/** Everything the usage view needs in one round trip. */
export interface UsageReport {
  byDay: UsageByDay;
  threadsByDay: UsageThreadsByDay;
}

/**
 * One pull request seen by the fleet collector (issue #375), agent-authored
 * or not. `threadId` is the join to a Solenta thread by head branch: null
 * means a human opened it, which is what makes the review-tax comparison
 * possible.
 */
export interface FleetPr {
  projectId: string;
  number: number;
  url: string;
  title: string;
  headRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  /** Epoch ms. */
  createdAt: number;
  mergedAt: number | null;
  closedAt: number | null;
  additions: number;
  deletions: number;
  /** Epoch ms of the earliest review submitted on this PR; null when none. */
  firstReviewAt: number | null;
  /** Owning thread, matched by head branch; null = human-authored. */
  threadId: string | null;
}

/**
 * One thread's ground truth for the fleet view. Line durability is measured
 * with git blame against the default branch: `linesAdded` is what the
 * thread's squash-merged commits added, `linesSurviving` is how much of that
 * is still there today. Both are null when git could not answer (no merge
 * commit found, remote project, blame budget exhausted).
 */
export interface FleetThread {
  threadId: string;
  projectId: string;
  title: string;
  provider: string;
  model: string | null;
  createdAt: number;
  /** Last real activity (ThreadInfo.updatedAt). */
  endedAt: number;
  /** Summed per-run spans, NOT wall clock: the agent's actual working time. */
  activeMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  linesAdded: number | null;
  linesSurviving: number | null;
  /**
   * The user's one-tap estimate of time this thread saved them (issue #401),
   * from ThreadInfo.feltEstimate; null when never answered or declined.
   */
  feltSavedMs: number | null;
  /**
   * True when this thread's merged work is older than the durability window,
   * so surviving lines are a real durability signal rather than "nobody has
   * had time to touch it yet".
   */
  durabilityMeasurable: boolean;
}

/**
 * Raw fleet evidence (issue #375). Facts only — every rate, ratio and
 * comparison is pure and lives in `src/fleet.ts`, so the view can be
 * re-ranged without re-walking git or gh.
 */
export interface FleetEvidence {
  /** Epoch ms of collection. */
  collectedAt: number;
  /** Days a merged line must survive to count as durable (14). */
  durabilityWindowDays: number;
  threads: FleetThread[];
  prs: FleetPr[];
  /**
   * Per-project collection problems in plain words ("acme: gh missing",
   * "acme: blame budget reached, 12 commits unmeasured"). Never fatal, and
   * surfaced in the view so a partial number is never read as a full one.
   */
  notes: string[];
}

/**
 * Raw evidence for ONE thread that ran inside an unattended window (issue
 * #323). Main collects facts only — every judgement (merge-ready / needs-you
 * / discard, risk flags) is pure and lives in src/digest.ts, so the receipt
 * can be re-ranked without re-walking git.
 */
export interface DigestRun {
  threadId: string;
  projectId: string;
  /** Project slug, so a row reads without a projects lookup. */
  projectSlug: string;
  title: string;
  provider: string;
  status: ThreadStatus;
  /** The run stalled on a permission prompt / question nobody answered. */
  awaitingInput: boolean;
  lastError: string | null;
  /** Epoch ms of the thread's last real activity (ThreadInfo.updatedAt). */
  endedAt: number;
  /** Cumulative session cost and turns; 0 when the provider never billed. */
  costUsd: number;
  turns: number;
  /** Uncommitted working-tree changes in the thread's cwd. */
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Commits on the thread's branch ahead of the project's default branch. */
  commits: number;
  prNumber: number | null;
  prState: "OPEN" | "CLOSED" | "MERGED" | null;
  /**
   * Execution evidence scraped from the run's tool calls: did a test/build
   * command actually run in the window, did the last one fail, and its label
   * ("npm test"). This stands in for the verification stage of #296 until
   * that lands — a claim in prose is not evidence, a command that ran is.
   */
  checks: { ran: boolean; failed: boolean; label: string | null };
}

/** One unattended window's receipt: what ran since `sinceMs`. */
export interface DigestResult {
  /** Start of the window (the last time the digest was marked seen). */
  sinceMs: number;
  /** Epoch ms this receipt was collected. */
  generatedAt: number;
  runs: DigestRun[];
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
   * Proposed shell command when the tool input has a command/cmd/script
   * string (#509). The permission card edits this; null/absent means the
   * JSON preview stays read-only (Edit/Write/etc).
   */
  command?: string | null;
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
  /**
   * Present when the guardrail policy (#409) rated this call risky but not
   * deniable — show the reason so the user isn't approving blind. Denied
   * calls never reach here; they are answered without asking.
   */
  guardrail?: { rule: string | null; reason: string } | null;
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

/**
 * Outcome of `threads.rewind` (issue #254). `droppedMessages` is how much
 * transcript the rewind removed (the edited message and everything after it);
 * `restoredSha` is the checkpoint the WORKTREE was hard-reset to, or null when
 * files were left alone (not requested, no worktree, or no matching checkpoint
 * — none of which is an error).
 */
export interface RewindResult {
  thread: ThreadInfo;
  droppedMessages: number;
  restoredSha: string | null;
}

/** Per-checkpoint-pair `git diff --shortstat` for a completed turn. */
export interface RunStatInfo {
  sha: string;
  turn: number;
  files: number;
  additions: number;
  deletions: number;
}

/**
 * One pair of active threads whose work overlaps (issue #249). `overlap` is
 * every file both threads changed vs the base branch; `conflicts` is the
 * subset `git merge-tree` says would actually collide when they merge, so
 * `conflicts` non-empty means "these two will conflict", while overlap-only
 * means "same files, still auto-mergeable".
 */
export interface ConflictPairInfo {
  threadA: string;
  threadB: string;
  overlap: string[];
  conflicts: string[];
}

/** Conflict forecast for one project. `pairs` is empty when nothing overlaps. */
export interface ConflictForecast {
  pairs: ConflictPairInfo[];
  computedAt: number;
}

/**
 * Evidence from one run of a thread's verification command (issue #296).
 * `ok` is the only thing that lets a run go green; everything else is what
 * the fixer gets handed when it doesn't.
 */
export interface VerifyResult {
  /** Run whose terminal triggered this check; "manual" for threads.runVerify. */
  runId: string;
  command: string;
  ok: boolean;
  /** Process exit code; null when it was killed (timeout). */
  exitCode: number | null;
  /** True when the command was killed at VERIFY_TIMEOUT_MS. */
  timedOut: boolean;
  /** Tail of combined stdout+stderr, capped at VERIFY_LOG_MAX chars. */
  log: string;
  /** Checkpoint sha the evidence is pinned to; null outside a worktree. */
  sha: string | null;
  durationMs: number;
  at: number;
  /** 0 on the first check of a turn, +1 for each fix handed back. */
  attempt: number;
}

/**
 * One-shot delayed re-check after a thread's PR merges (issue #420).
 * Scheduled on the MERGED flip; the scheduler re-runs `verifyCommand`
 * against the merged default branch hours later.
 */
export type PostMergeVerifyStatus =
  | "scheduled"
  | "running"
  | "passed"
  | "failed"
  | "skipped";

export interface PostMergeVerify {
  /** Epoch ms when the delayed check should run. */
  dueAt: number;
  status: PostMergeVerifyStatus;
  /** When the check last ran or was skipped; null while still scheduled. */
  at: number | null;
  /** Evidence from the delayed check; independent of thread.verify. */
  result: VerifyResult | null;
  /** Fix thread spawned on regression; null until then. */
  fixThreadId: string | null;
  /** Why it was skipped, when status is skipped. */
  skipReason?: string | null;
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
  /** GitHub mergeability from `gh pr view --json mergeable`. */
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** PR base branch from `gh pr view --json baseRefName`. */
  baseRefName?: string;
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

/**
 * Check out a teammate's PR into a worktree thread (issue #611).
 * Failures stay in-band so the PR row can show them.
 */
export type CheckoutPrResult =
  | {
      ok: true;
      thread: ThreadInfo;
      prompt: string;
      readOnly: boolean;
      created: boolean;
    }
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

/** `gh issue create` result. Failures stay in-band so the UI can show them. */
export type CreateIssueResult =
  | { ok: true; number: number; url: string }
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

/**
 * Forge provider id (issue #608). Matches T3's SourceControlProviderKind so
 * add-project (#459) and later GitLab/Bitbucket/Azure issues share one list.
 */
export type SourceControlProviderKind =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "azure-devops";

/** Binary present and new enough / missing / too old to report auth. */
export type SourceControlProviderStatus = "available" | "missing" | "outdated";

export type SourceControlAuthStatus =
  | "authenticated"
  | "unauthenticated"
  | "unknown";

export interface SourceControlAuth {
  status: SourceControlAuthStatus;
  /** Login, email, or a one-line reason when not authenticated. */
  detail: string | null;
}

/**
 * One forge as Settings → Source Control renders it.
 * `installHint` is a copy-pasteable command (install, upgrade, or login).
 */
export interface SourceControlProvider {
  kind: SourceControlProviderKind;
  label: string;
  status: SourceControlProviderStatus;
  installHint: string;
  version: string | null;
  auth: SourceControlAuth;
}

/** Result of `sourceControl:discover` (cached until Rescan or an auth miss). */
export interface SourceControlDiscovery {
  sourceControlProviders: SourceControlProvider[];
  probedAt: number;
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

/**
 * Issue #285: a workflow template distilled from a finished thread. Shaped
 * like a save-ready template minus the ids so the user reviews and edits it
 * in the workflows editor before anything is stored.
 */
export interface DistilledWorkflow {
  name: string;
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
   * When true (the default), a MERGED PR auto-settles the thread. CLOSED
   * still always settles. Only an explicit false on disk turns it off, so
   * upgrades keep the previous "merge = done" behaviour.
   */
  autoSettleOnMerge: boolean;
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
   * First-run onboarding wizard has been finished or skipped (#628).
   * Absent/undefined/false means it has not been seen yet. Store-persisted
   * (not localStorage) so web mode and tests share the same flag.
   */
  onboardingSeen?: boolean;
  /**
   * Global desktop-notification switch. False silences every thread; true
   * (the default) leaves per-thread mute in charge. Only an explicit false
   * on disk turns it off, so upgrades keep notifying.
   */
  notifications: boolean;
  /**
   * Continue automatically when a provider usage limit resets (#462).
   * Default on; only an explicit false opts out (Claude's /config row).
   * Per-thread quotaWaitAutoResume overrides this.
   */
  quotaWaitAutoResume: boolean;
  /**
   * PR size cap in changed lines (additions + deletions vs the base branch),
   * enforced when a PR is created from the app (issue #402, DORA small
   * batches as a product default). Default 400; null disables the cap.
   * Oversized PRs can still be created via createPr's allowOversize override.
   */
  prDiffCapLines: number | null;
  /**
   * Update channel override; null follows the channel stamped at package
   * time. Has no effect in an unstamped dev tree (updates stay disabled).
   */
  updateChannel: "prod" | "nightly" | null;
  /**
   * Saved agent profiles, in user order. Applying one is exactly the three
   * per-thread calls the composer already makes (setProvider, then
   * setReasoningEffort, then setPermissionMode) — a profile stores the
   * combination, it does not introduce a fourth kind of thread state.
   */
  agentProfiles: AgentProfile[];
  /**
   * Described worker-model pool (issue #467). Orchestration workers default
   * to `defaultAlias` (or inherit the lead when the pool is empty). The lead
   * picks per spawn by alias from the one-line descriptions, not a raw
   * model id. `force` pins every worker to the default. Does not route the
   * user-facing thread (that is issue #246).
   */
  subagentPool: SubagentPool;
  /** OpenTelemetry export (issue #280). */
  otel: OtelSettings;
}

/**
 * OTLP export config. Solenta is the only place a cross-provider trace tree
 * exists, so it emits GenAI spans itself rather than relying on any one CLI.
 */
export interface OtelSettings {
  /**
   * OTLP/HTTP base endpoint, e.g. "http://127.0.0.1:4318". Spans POST to
   * `<endpoint>/v1/traces`. null (the default) turns export off entirely —
   * nothing is buffered and no network call is ever made.
   */
  endpoint: string | null;
  /** Extra headers on every OTLP POST (auth). Values are never echoed back. */
  headers: Record<string, string>;
  /**
   * When true, Claude Code spawns also get CLAUDE_CODE_ENABLE_TELEMETRY=1 and
   * OTEL_EXPORTER_OTLP_ENDPOINT pointed at the same collector, so its native
   * metrics land beside our spans. No effect when endpoint is null.
   */
  claudeMetrics: boolean;
}

/** Why a thread counted as an offender in failure-mode clustering. */
export type FailureKind = "failed" | "stalled" | "retried";

/** One offending thread inside a FailureMode. */
export interface FailureOffender {
  threadId: string;
  threadTitle: string;
  projectId: string;
  provider: string;
  kind: FailureKind;
  /** Epoch ms of the failure. */
  at: number;
}

/**
 * A recurring failure mode: one normalized error signature seen across
 * threads. Derived from the event log on demand — no LLM, no stored state.
 */
export interface FailureMode {
  /** Stable id: hash of the signature. */
  id: string;
  /** Normalized signature — paths, ids, numbers and quotes redacted. */
  signature: string;
  /** First raw error text that produced this signature, for display. */
  sample: string;
  /** Offender count (>= 2; one-offs are not a recurring mode). */
  count: number;
  /** Newest first, capped at 20. */
  offenders: FailureOffender[];
  /** Epoch ms of the newest offender. */
  lastAt: number;
}

/**
 * A named (provider, model, effort, permission) combination — "cheap scout"
 * vs "deep worker" — selectable from the composer's model picker.
 *
 * Order matters when applying: setProvider resets reasoningEffort to null on a
 * provider switch, so effort must be set after it (see Composer.pickEffort).
 */
export interface AgentProfile {
  /** Stable id; generated at create time, never reused. */
  id: string;
  /** Display name, 1-40 chars after trim. */
  name: string;
  /** ProviderInfo.id. Kept even when that CLI is not installed. */
  provider: string;
  /** Model override id; null = provider default. */
  model: string | null;
  /** null = provider default (no --effort flag). */
  reasoningEffort: ReasoningEffort | null;
  permissionMode: PermissionMode;
}

/**
 * One described candidate in the worker-model pool. The lead picks by
 * `alias`; `description` is the one-liner it sees.
 */
export interface SubagentPoolEntry {
  /** Lowercase slug the lead passes as thread_fork `pool`. 1-32 chars. */
  alias: string;
  /** ProviderInfo.id. Kept even when that CLI is not installed. */
  provider: string;
  /** Model override id; null = provider default. */
  model: string | null;
  /** One-line scenario. 1-160 chars after trim. */
  description: string;
}

/**
 * Settings-level menu of worker models. Empty `entries` means workers
 * inherit the lead's provider (today's behaviour).
 */
export interface SubagentPool {
  /** Alias workers use when the lead omits `pool`. null = inherit lead. */
  defaultAlias: string | null;
  /** When true, every worker uses `defaultAlias`; lead picks are ignored. */
  force: boolean;
  entries: SubagentPoolEntry[];
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

/**
 * A writable skills directory we fan a skill out to: one per provider that
 * reads SKILL.md, plus the cross-agent ~/.agents/skills convention.
 */
export type SkillTarget =
  | "claude"
  | "agents"
  | "codex"
  | "grok"
  | "opencode"
  | "kimi";

/** Where a skill was found on disk; "project" is the read-only project dir. */
export type SkillSource = SkillTarget | "project";

/** A discovered skill (SKILL.md) as surfaced to the Skills tab. */
export interface SkillInfo {
  name: string;
  description: string;
  source: SkillSource;
  /** Targets that currently hold this skill; empty for project skills. */
  installedIn: SkillTarget[];
  /**
   * Active targets this skill is missing from — non-empty means drift, and
   * skills.sync() clears it. Only targets whose CLI dir exists are counted.
   */
  missingFrom: SkillTarget[];
  /** SKILL.md size in bytes: the context this skill costs once invoked. */
  bytes: number;
}

/** Payload for skills:add; the skill fans out to every active target. */
export interface SkillWrite {
  name: string;
  description: string;
  body: string;
}

/**
 * A CLI skill or custom command for the composer `/` palette (#606).
 * Insert-only: the runner expands `/name args` into SKILL.md / command body.
 */
export interface CliSlashCommand {
  name: string;
  hint: string;
  kind: "insert";
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

/** Evidence a memory entry is pinned to (#395). */
export type MemoryCitation =
  | { kind: "file"; path: string; line?: number; endLine?: number; excerpt?: string }
  | { kind: "thread"; id: string }
  | { kind: "commit"; sha: string };

/** A shared-memory entry as surfaced to the UI (excerpt form unless fetched). */
export interface MemoryEntryInfo {
  id: string;
  type: "knowledge" | "task" | "convention" | "run" | "strategy";
  title: string;
  /** Excerpt in list/search results; full body from memory.get. */
  body: string;
  project: string | null;
  importance: number;
  createdAt: string;
  updatedAt: string;
  /** file:line / thread / commit evidence. Empty when the writer cited none. */
  citations?: MemoryCitation[];
}

/**
 * Renderer-facing API. Invoke method names are locked to
 * `src/shared/ipcChannels.ts` (IPC_CHANNEL_LOCK); keep JSDoc here.
 */
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
      citations?: MemoryCitation[];
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
   * Agent skills on disk (SKILL.md files). A skill is installed once and
   * mirrored into every active provider skills dir; list merges those into
   * one row per skill (plus read-only rows from <project>/.claude/skills).
   * add/remove/sync only ever touch the user dirs, never the project.
   */
  skills: {
    list(input?: { projectPath?: string }): Promise<SkillInfo[]>;
    add(input: SkillWrite): Promise<{ name: string; installedIn: SkillTarget[] }>;
    /** Removes the skill from every writable target it is installed in. */
    remove(input: { name: string }): Promise<void>;
    /** Copies every skill into the targets it is missing from. */
    sync(): Promise<{ copied: number; skills: string[] }>;
    /** CLI `/` extras: invocable skills and custom commands (#606). */
    commands(input?: { projectPath?: string }): Promise<CliSlashCommand[]>;
  };
  providers: {
    list(): Promise<ProviderInfo[]>;
  };
  /**
   * Forge CLI probe (issue #608). Cached until `{ rescan: true }` or a
   * mid-session auth failure (the gh stderr regex) invalidates it.
   */
  sourceControl: {
    discover(input?: { rescan?: boolean }): Promise<SourceControlDiscovery>;
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
    /**
     * Native file picker constrained to the project checkout. Resolves
     * `{ iconPath, iconUrl }` or null on cancel. Does not save — pass
     * iconPath to update() on submit. Rejects a file outside the project.
     */
    pickIcon(input: { projectId: string }): Promise<{
      iconPath: string;
      iconUrl: string | null;
    } | null>;
    /**
     * Preview a resolved icon without saving. `iconPath: null` is
     * Automatic (ignore a stored override). Omit iconPath to use the
     * stored override or auto-detect.
     */
    resolveIcon(input: {
      projectId: string;
      iconPath?: string | null;
    }): Promise<{ iconUrl: string | null }>;
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
    /** Six-axis lint of AGENTS.md / CLAUDE.md vs shared memory (#412). */
    lintAgentConfig(input: { projectId: string }): Promise<AgentConfigDoctorReport>;
    /** Preview generated agent-instruction files (does not write). */
    previewAgentConfig(input: {
      projectId: string;
      targets?: string[];
    }): Promise<AgentConfigPreview>;
    /** Write the previewed files into the project checkout. */
    writeAgentConfig(input: {
      projectId: string;
      targets?: string[];
    }): Promise<AgentConfigWriteResult>;
  };
  /**
   * Retired (#568). list() is always []; add/update throw;
   * remove is a no-op. Kept so an older renderer does not crash on boot.
   */
  spaces: {
    list(): Promise<SpaceInfo[]>;
    add(input: { name: string }): Promise<SpaceInfo>;
    update(input: { id: string; name: string }): Promise<SpaceInfo>;
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
     * Shared crew task list for the selected thread (issue #277). Read-only
     * from the renderer — agents claim and complete via MCP. Tasks belong
     * to the crew root (orchestrator at the top of the handoffFrom chain);
     * any thread in that crew resolves to the same list.
     */
    crewTasks(input: { threadId: string }): Promise<{
      rootThreadId: string;
      tasks: CrewTaskView[];
    }>;
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
      /** Turn Teach mode on at create (issue #373). */
      teach?: boolean;
      /**
       * Ask mode (issue #392): read-only Q&A, no worktree. Wins over
       * `worktree` and `orchestrate`.
       */
      ask?: boolean;
      /** Planboard issue this thread was started from (issue #420). */
      issueNumber?: number | null;
    }): Promise<ThreadInfo>;
    get(id: string): Promise<ThreadDetail>;
    /**
     * Same payload as get, but never stamps lastVisitedAt (issue #393).
     * Used to load a sibling run for the divergence compare so opening
     * the picker does not mark that thread read.
     */
    peek(id: string): Promise<ThreadDetail>;
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
      /**
       * Edited shell command (#509). Approving runs this instead of the
       * original; the inbox (#291) uses the same field. Ignored when the
       * pending tool has no command field.
       */
      updatedCommand?: string;
    }): Promise<void>;
    /** Archive or unarchive; archived threads are hidden by default but fully intact. */
    setArchived(input: { threadId: string; archived: boolean }): Promise<ThreadInfo>;
    /**
     * Set or clear the settle override. Rejects override "settled" while a
     * run is active: settling live work would hide it (t3's rule — anything
     * the resolution refuses to classify as settled is refused as a settle
     * target). An explicit "settled" also clears a live snooze so the row
     * leaves the snoozed shelf immediately. Does not bump updatedAt:
     * settling is bookkeeping, and bumping would push the thread to the top
     * of a list it is leaving.
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
     * Per-thread quota-wait auto-resume override (#462). true/false pins
     * the thread; null inherits the global settings.quotaWaitAutoResume.
     * Turning it off while parked cancels the wake timer but leaves the
     * card parked so Resume now still works.
     */
    setQuotaWaitAutoResume(input: {
      threadId: string;
      enabled: boolean | null;
    }): Promise<ThreadInfo>;
    /**
     * Set or clear the per-thread scratch pad. Trims, caps at
     * THREAD_NOTES_MAX, empty string clears. Never bumps updatedAt.
     */
    setNotes(input: { threadId: string; notes: string }): Promise<ThreadInfo>;
    /**
     * Record the one-tap felt estimate for a finished thread (issue #401).
     * savedMs is a non-negative duration (clamped to FELT_ESTIMATE_MAX_MS);
     * null records a decline so the card never asks again. Never bumps
     * updatedAt.
     */
    setFeltEstimate(input: {
      threadId: string;
      savedMs: number | null;
    }): Promise<ThreadInfo>;
    /**
     * Turn spec mode on (issue #269): the thread starts at the requirements
     * stage and the runner tells the agent to write the artifact and stop.
     * Idempotent — calling it on a spec thread returns it unchanged.
     */
    startSpec(input: { threadId: string }): Promise<ThreadInfo>;
    /**
     * Turn spec mode off (issue #500): drops thread.spec. Idempotent —
     * a non-spec thread is returned unchanged. Does not start a run and
     * does not delete artifacts on disk.
     */
    stopSpec(input: { threadId: string }): Promise<ThreadInfo>;
    /**
     * Answer the stage gate. "approve" advances to the next stage
     * (requirements → design → tasks → build); "revise" keeps the stage and
     * passes `feedback` back to the agent. Either way a run starts with the
     * stage's prompt. Rejects a thread that is not awaiting approval.
     */
    reviewSpec(input: {
      threadId: string;
      decision: "approve" | "revise";
      feedback?: string;
    }): Promise<ThreadInfo>;
    /**
     * Read one artifact off disk. `text` is null when the agent has not
     * written the file yet; `path` is absolute and always returned.
     */
    specArtifact(input: {
      threadId: string;
      stage: SpecArtifact;
    }): Promise<{ path: string; text: string | null }>;
    /**
     * Parse tasks.md, load it into the crew-task list, and fork one worker
     * per current-wave task (issue #537). Available at the build stage.
     * An empty wave is not an error — `reason` explains why nothing forked.
     */
    dispatchSpec(input: { threadId: string }): Promise<{
      thread: ThreadInfo;
      dispatched: Array<{ threadId: string; taskId: string; title: string }>;
      reason?: string;
    }>;
    /**
     * Start a converge run on the spec thread: compare the repo to the
     * approved artifacts and append missing checkboxes to tasks.md.
     */
    convergeSpec(input: { threadId: string }): Promise<ThreadInfo>;
    /**
     * Turn Teach mode on (issue #373): the runner prefixes every provider
     * turn with the hints-not-solutions persona and caps permission mode
     * to the current autonomy rung. Idempotent. Never bumps updatedAt.
     */
    startTeach(input: { threadId: string }): Promise<ThreadInfo>;
    /**
     * Turn Teach mode off. Leaves permission mode where it is. Idempotent.
     * Never bumps updatedAt.
     */
    stopTeach(input: { threadId: string }): Promise<ThreadInfo>;
    /**
     * Ask the agent to review the human's TODO(human) fills. Starts a run
     * with the review prompt. Rejects a thread that is not in teach mode.
     */
    requestTeachReview(input: { threadId: string }): Promise<ThreadInfo>;
    /**
     * Turn Ask mode on (issue #392): read-only Q&A from the index and
     * memory. Drops a pending worktree. Idempotent. Never bumps updatedAt.
     */
    startAsk(input: { threadId: string }): Promise<ThreadInfo>;
    /**
     * Turn Ask mode off. With `worktree: true` (Start work) the thread
     * becomes a regular isolated thread when the project can host one.
     * Idempotent. Never bumps updatedAt.
     */
    stopAsk(input: { threadId: string; worktree?: boolean }): Promise<ThreadInfo>;
    /**
     * Side question (issue #471): cheap read-only answer on a card, not a
     * new thread and not the live turn. Does not pause, steer, or queue
     * behind the current run. Never bumps updatedAt.
     */
    btw(input: { threadId: string; question: string }): Promise<ThreadInfo>;
    /** Drop a side-question card (cancels it if still running). */
    dismissBtw(input: { threadId: string; id: string }): Promise<ThreadInfo>;
    /**
     * Queue the side question as a follow-up (#468) and drop the card.
     * Uses threads.setQueued, so an existing queue is appended to.
     */
    promoteBtw(input: { threadId: string; id: string }): Promise<ThreadInfo>;
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
      /**
       * Give the fork its own worktree (issue #550 chips): sets
       * pendingWorktree so the runner materializes it on the first run,
       * same lazy path as forkWorkerThread. Ignored when the project
       * cannot host worktrees.
       */
      worktree?: boolean;
    }): Promise<ThreadInfo>;
    /**
     * Resolve a suggested-work chip (issue #550): flip its status to
     * "started" / "filed" / "dismissed" and stamp startedThreadId /
     * issueNumber. Rejects an unknown thread or suggestion id, and a
     * status of "open" (chips never reopen). Returns the updated thread.
     */
    resolveSuggestion(input: {
      threadId: string;
      suggestionId: string;
      status: Exclude<WorkSuggestionStatus, "open">;
      startedThreadId?: string;
      issueNumber?: number;
    }): Promise<ThreadInfo>;
    /**
     * Edit-and-resubmit (issue #254): rewind the thread to just before one of
     * its own past USER messages so an edited version can be re-sent from
     * there — a cheaper course correction than checkpoint archaeology.
     *
     * Rewind only truncates; it starts nothing. The renderer follows with the
     * usual `runs.start({ prompt })`, which appends the edited text as a new
     * user message (rewind must NOT append it, or it lands twice).
     *
     * What it does:
     *  - drops `messageId` and every message after it from the transcript,
     *    plus work-log items belonging to the dropped runs;
     *  - clears `sessionId` and sets `replayContext` (see that field): CLI
     *    sessions cannot be rewound, so the next turn is a fresh session
     *    seeded with a digest of the retained tail;
     *  - with `restoreFiles`, hard-resets the WORKTREE to the checkpoint of
     *    the last RETAINED turn (turn N = the Nth user message that survives),
     *    via the same guarded path as `git.restoreCheckpoint`.
     *
     * Usage history (`usageByThread`, spend) is NEVER rewritten: that money
     * was really spent.
     *
     * Rejects while a run is active, on an unknown thread, on a messageId
     * that is not a role "user" message of this thread, and on an empty
     * prompt. Missing worktree / missing checkpoint is NOT an error: the
     * transcript still rewinds and `restoredSha` comes back null.
     */
    rewind(input: {
      threadId: string;
      messageId: string;
      prompt: string;
      restoreFiles?: boolean;
    }): Promise<RewindResult>;
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
     * Sets the thread's verification command (issue #296). A non-empty
     * command arms the gate: from the next turn on, a run that would land
     * "done" instead runs this command and only goes green when it exits 0.
     * Empty / null disarms it. Trimmed, capped at 500 chars.
     */
    setVerifyCommand(input: {
      threadId: string;
      command: string | null;
    }): Promise<ThreadInfo>;
    /**
     * Runs the thread's verification command now and stores the result as
     * the thread's latest evidence. Rejects when no command is set or a run
     * is active. Manual counterpart to the automatic gate.
     */
    runVerify(input: { threadId: string }): Promise<VerifyResult>;
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
  usage: {
    /** Per-day usage ledger, by provider/model and by thread (90 days). */
    byDay(): Promise<UsageReport>;
  };
  insights: {
    /**
     * Recurring failure modes across every thread, ranked most-severe first
     * (count, then recency). Grouped by NORMALIZED error signature, so the
     * same failure in six threads is one mode with six offenders. Computed
     * from the stored transcripts on each call; cheap enough that the view
     * just re-reads it.
     */
    failureModes(): Promise<FailureMode[]>;
  };
  fleet: {
    /**
     * Ground truth for the agent-fleet analytics view (issue #375): every
     * thread's cost / time / line durability plus every PR of every local
     * project, agent-authored or human. Walks git and gh, so it is slower
     * than the other read endpoints — the view loads it on demand and
     * caches. Never rejects: per-project failures come back in `notes`.
     */
    evidence(input?: { days?: number }): Promise<FleetEvidence>;
  };
  digest: {
    /**
     * Receipt for the unattended window (issue #323): every non-archived
     * thread whose last activity falls after `sinceMs`, with cost, change
     * stats and check evidence. `sinceMs` defaults to the last markSeen
     * (12 hours ago when the digest has never been read).
     */
    list(input?: { sinceMs?: number }): Promise<DigestResult>;
    /** Closes the window: the next digest starts at `atMs` (default now). */
    markSeen(input?: { atMs?: number }): Promise<{ seenAt: number }>;
  };
  runs: {
    /**
     * Sends one turn to the thread's provider session (resuming the stored
     * sessionId when present). Streams tool/text events via thread:updated.
     * If the thread title is still the default "New Thread", main renames it
     * from the first line of the prompt.
     *
     * A prompt whose first token is an orchestration command (`/handoff`,
     * `/advisor`, `/committee` — issue #338) never reaches a provider: main
     * forks a worker per command instead and this thread is woken by their
     * results. The renderer sends the text unchanged either way.
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
    /**
     * #285: reads a finished thread's transcript and distills it into a
     * reusable workflow template draft. Nothing is saved — the caller shows
     * the draft for review and saves it through workflows.save.
     */
    distill(input: { threadId: string }): Promise<DistilledWorkflow>;
    stop(input: { threadId: string }): Promise<void>;
    /**
     * Resume a parked quota-wait thread now (#462). Resends the last user
     * prompt without appending it again. Rejects if the thread is not
     * parked. Counts as the one-shot wake.
     */
    resumeQuotaWait(input: { threadId: string }): Promise<{ runId: string }>;
  };
  git: {
    status(projectId: string): Promise<GitStatus>;
    // See PrInfo below for the shape createPr/prStatus return.
    /** Creates a git worktree + branch for the thread; later runs execute in it. */
    setupWorktree(input: { threadId: string }): Promise<ThreadInfo>;
    /** Working-tree changes in the thread's cwd (worktree if set, else project). */
    diff(input: { threadId: string }): Promise<DiffResult>;
    /**
     * Review itinerary extras (issue #421): author annotation file, code-index
     * symbols for the reuse scan, and hunk hashes already marked reviewed.
     */
    reviewContext(input: { threadId: string }): Promise<ReviewContext>;
    /** Persist hunk hashes the user marked reviewed on this thread. */
    setReviewAccepted(input: {
      threadId: string;
      hashes: string[];
    }): Promise<ThreadInfo>;
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
      /**
       * Explicit override for the prDiffCapLines guard (issue #402): create
       * the PR even though the diff exceeds the configured size cap.
       */
      allowOversize?: boolean;
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
     * Update the PR branch from its base (fetch + merge), push if HEAD
     * moved, then squash-merge via `gh pr merge --squash`. Conflicts
     * throw MERGE_CONFLICT: and leave the worktree conflicted. An empty
     * unique tree vs base tells the caller to close the PR.
     */
    prMerge(input: { threadId: string }): Promise<PrInfo>;
    /**
     * Open PRs for a project checkout via `gh pr list`. Never rejects for
     * missing gh / non-GitHub remotes / auth: those come back as
     * `{ ok: false, reason }`.
     */
    listPrs(projectPath: string): Promise<ListPrsResult>;
    /**
     * Check out a GitHub PR into a new worktree thread, or return the
     * existing one when this project already has that PR bound. Never
     * rejects for missing gh / auth / non-GitHub remotes: those come back
     * as `{ ok: false, reason }`.
     */
    checkoutPr(input: {
      projectId: string;
      prNumber: number;
    }): Promise<CheckoutPrResult>;
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
    /**
     * Predicted merge conflicts between the project's active worktree threads
     * (#249), computed with `git merge-tree` before anyone merges. Read-only
     * and never rejects: a project without a repo returns no pairs.
     */
    conflictForecast(input: {
      projectId: string;
    }): Promise<ConflictForecast>;
    /**
     * Worktree GC scan (#316): every reclaimable worktree with its size, plus
     * per-project disk usage. Read-only and never rejects — a directory git
     * cannot read comes back `blocked`.
     */
    gcScan(): Promise<GcScanResult>;
    /**
     * Batch cleanup: remove the given worktree directories in one shot (one
     * dialog, one confirm). Only ever removes directories a fresh scan still
     * reports as unblocked candidates; branches are never deleted.
     */
    gcClean(input: GcCleanInput): Promise<GcCleanResult>;
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
    /**
     * File an issue via `gh issue create` and label it plan:todo (issue
     * #550 "File on planboard" chip). The label ride-along is best-effort,
     * same degradation rules as setPlanStatus. Never rejects for missing
     * gh / non-GitHub remotes / auth: those come back as
     * `{ ok: false, reason }`.
     */
    create(input: {
      projectPath: string;
      title: string;
      body: string;
    }): Promise<CreateIssueResult>;
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
    /**
     * Resolve transcript path tokens against the thread worktree (or the
     * project checkout when no worktree is bound). Missing files, URLs, and
     * paths outside the workspace come back as `abs: null`.
     */
    resolve(input: {
      threadId: string;
      paths: string[];
    }): Promise<{ resolved: Array<{ path: string; abs: string | null }> }>;
  };
  /**
   * Environment-scoped directory listing for add-project (#609) and the
   * clone destination step (#459). Local readdir, or ls over SSH when
   * `environment` is set. Empty query includes a bounded recent-project list.
   */
  fs: {
    browse(input: FsBrowseInput): Promise<FsBrowseResult>;
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
     * drag-dropped File, including Finder directories. Absent on web/dev
     * bridges, which fall back to saveImage (images only).
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
  /**
   * Vibe Kanban import (#399). Preview/import read the local VK SQLite;
   * export writes a versioned JSON dump of projects, threads, and messages
   * (settings and tokens stay out). pickDataDir / export cancel as null.
   */
  vibeKanban: {
    preview(input?: { dataDir?: string }): Promise<VibeKanbanPreview>;
    import(input?: { dataDir?: string }): Promise<VibeKanbanImportResult>;
    pickDataDir(): Promise<string | null>;
    export(): Promise<string | null>;
  };
  /**
   * Native OS context menu (T3 `api.contextMenu.show`). Resolves the clicked
   * leaf id, or null if the user dismisses. Absent on web/dev — the renderer
   * falls back to a position:fixed portal on document.body.
   */
  contextMenu?: {
    show(
      items: {
        id: string;
        label: string;
        disabled?: boolean;
        separatorBefore?: boolean;
        children?: unknown[];
      }[],
      position?: { x: number; y: number },
    ): Promise<string | null>;
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
