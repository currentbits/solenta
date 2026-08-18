/** Domain model for Solenta: projects, threads, messages, workflows, agents. */

export interface Project {
  id: string;
  /** e.g. "pingdotgg/t3code" */
  slug: string;
  name: string;
}

export type ThreadStatus = "idle" | "working" | "done" | "failed" | "quota-wait";

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  branch: string;
  prNumber?: number;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UserMessage {
  role: "user";
  id: string;
  threadId: string;
  content: string;
  createdAt: string;
}

export interface AssistantMessage {
  role: "assistant";
  id: string;
  threadId: string;
  content: string;
  createdAt: string;
  tokensUsed?: number;
}

export interface EventMessage {
  role: "event";
  id: string;
  threadId: string;
  kind: string;
  label: string;
  createdAt: string;
}

export type Message = UserMessage | AssistantMessage | EventMessage;

export interface WorkLogEntry {
  label: string;
  done: boolean;
  timestamp: string;
}

export type WorkflowPhaseName =
  | "seed"
  | "analyze"
  | "verify"
  | "judge"
  | "synthesize";

export type AgentRunStatus = "pending" | "running" | "settled" | "failed";

export interface AgentRun {
  /** e.g. "1:analyze:0" (phaseIndex:name:agentIndex) */
  id: string;
  /** e.g. "sonnet-5" */
  model: string;
  status: AgentRunStatus;
  tokensUsed: number;
  /** Engine-only: how many ticks this agent has been running. */
  ticksRunning?: number;
}

export interface WorkflowPhase {
  name: WorkflowPhaseName;
  agents: AgentRun[];
  /**
   * When true, agents may start as corresponding upstream agents settle
   * (without waiting for the full previous phase).
   */
  pipelined?: boolean;
}

export interface Workflow {
  id: string;
  /** e.g. "INTEGER-SAFARI" */
  name: string;
  phases: WorkflowPhase[];
}

export interface TokenUsage {
  total: number;
  byPhase: Record<string, number>;
}

export interface WorkflowProgress {
  settled: number;
  total: number;
  tokensTotal: number;
}

export interface PhaseSpec {
  name: WorkflowPhaseName;
  agentCount: number;
  model?: string;
  pipelined?: boolean;
}

export interface WorkflowSpec {
  id: string;
  name: string;
  phases: PhaseSpec[];
}
