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

export interface ThreadInfo {
  id: string;
  projectId: string;
  title: string;
  branch: string | null;
  prNumber: number | null;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "event";
  text: string;
  createdAt: number;
  /** Set when the message belongs to a run (streamed agent output, run events). */
  runId?: string | null;
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
  workflow: WorkflowView | null;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  dirty: boolean;
}

export interface CoderApi {
  projects: {
    list(): Promise<ProjectInfo[]>;
    /** Validates the path is a git repo; rejects otherwise. */
    add(path: string): Promise<ProjectInfo>;
    /** Opens a native folder picker; resolves null if the user cancels. */
    addViaDialog(): Promise<ProjectInfo | null>;
  };
  threads: {
    list(): Promise<ThreadInfo[]>;
    create(input: { projectId: string; title: string }): Promise<ThreadInfo>;
    get(id: string): Promise<ThreadDetail>;
  };
  runs: {
    /**
     * Starts a simulated multi-phase workflow run on the thread.
     * If the thread title is still the default "New Thread", main renames it
     * from the first line of the prompt. Emits thread:updated on every tick.
     */
    start(input: { threadId: string; prompt: string }): Promise<{ workflowId: string }>;
    stop(input: { threadId: string }): Promise<void>;
  };
  git: {
    status(projectId: string): Promise<GitStatus>;
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
