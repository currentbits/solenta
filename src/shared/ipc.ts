// Typed IPC contract between the Electron main process and the React renderer.
// The preload script exposes `window.coder` implementing CoderApi.
// Invoke channel names mirror the method paths: "projects:list", "projects:add",
// "projects:addViaDialog", "threads:list", "threads:create", "threads:get",
// "runs:start", "runs:stop", "git:status".
// Push channels: "threads:changed", "thread:updated".

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
  /** Agent harness backing this thread: a ProviderInfo.id ("claude", "codex", "grok", "opencode", "simulate"). */
  provider: string;
  /** Model override passed to the provider CLI when set (e.g. claude --model). */
  model: string | null;
  /** Provider session id, persisted after the first turn so follow-ups resume context. */
  sessionId: string | null;
  /** Passed to the provider CLI (claude --permission-mode). Sticky per thread. */
  permissionMode: PermissionMode;
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

export interface AppSettings {
  /** Hard daily spend cap across all providers; null = no cap. */
  dailyBudgetUsd: number | null;
}

export interface AppStatus {
  /** Aggregated cost of all runs that finished today (local time). */
  spendTodayUsd: number;
  memory: {
    running: boolean;
    adopted: boolean;
    port: number | null;
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
  projects: {
    list(): Promise<ProjectInfo[]>;
    /** Validates the path is a git repo; rejects otherwise. */
    add(path: string): Promise<ProjectInfo>;
    /** Opens a native folder picker; resolves null if the user cancels. */
    addViaDialog(): Promise<ProjectInfo | null>;
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
     * Sets the thread's provider and/or model. Rejects once the thread has a
     * sessionId (context lives with the provider; switching would lose it).
     * Model validation: when the provider's models list is non-empty the
     * model must come from it; when the list is EMPTY any non-empty string
     * is accepted and passed to the CLI as-is (custom model ids, e.g codex
     * -m). Model alone may still be changed between turns for providers
     * whose sessions tolerate it.
     */
    setProvider(input: { threadId: string; provider?: string; model?: string | null }): Promise<ThreadInfo>;
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
    /** Creates a git worktree + branch for the thread; later runs execute in it. */
    setupWorktree(input: { threadId: string }): Promise<ThreadInfo>;
    /** Working-tree changes in the thread's cwd (worktree if set, else project). */
    diff(input: { threadId: string }): Promise<DiffResult>;
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
  };
  /** Returns an unsubscribe function. */
  on(channel: "threads:changed", cb: (threads: ThreadInfo[]) => void): () => void;
  on(channel: "thread:updated", cb: (detail: ThreadDetail) => void): () => void;
}

declare global {
  interface Window {
    coder: CoderApi;
  }
}
