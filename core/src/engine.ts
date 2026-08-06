import type {
  AgentRun,
  AgentRunStatus,
  TokenUsage,
  Workflow,
  WorkflowProgress,
  WorkflowSpec,
} from "./types.js";

/** Fixed tokens accrued per tick while an agent is running. */
export const TOKENS_PER_TICK = 100;

/** Number of running ticks required before an agent settles. */
export const TICKS_TO_SETTLE = 2;

const DEFAULT_MODEL = "sonnet-5";

function isTerminalStatus(status: AgentRunStatus): boolean {
  return status === "settled" || status === "failed";
}

function cloneWorkflow(workflow: Workflow): Workflow {
  return {
    id: workflow.id,
    name: workflow.name,
    phases: workflow.phases.map((phase) => {
      const cloned: Workflow["phases"][number] = {
        name: phase.name,
        agents: phase.agents.map((agent) => ({ ...agent })),
      };
      if (phase.pipelined !== undefined) {
        cloned.pipelined = phase.pipelined;
      }
      return cloned;
    }),
  };
}

function assertValidAgentCount(name: string, agentCount: number): void {
  if (!Number.isInteger(agentCount) || agentCount < 1) {
    throw new Error(
      `Invalid agentCount for phase "${name}": expected a positive integer, got ${agentCount}`,
    );
  }
}

/**
 * Build a workflow from a spec: each phase gets N pending agents
 * with deterministic ids like "1:analyze:0" (phaseIndex:name:agentIndex).
 * Phase index is included so duplicate phase names cannot collide.
 */
export function createWorkflow(spec: WorkflowSpec): Workflow {
  return {
    id: spec.id,
    name: spec.name,
    phases: spec.phases.map((phaseSpec, phaseIndex) => {
      assertValidAgentCount(phaseSpec.name, phaseSpec.agentCount);
      const phase: Workflow["phases"][number] = {
        name: phaseSpec.name,
        agents: Array.from({ length: phaseSpec.agentCount }, (_, i) => {
          const agent: AgentRun = {
            id: `${phaseIndex}:${phaseSpec.name}:${i}`,
            model: phaseSpec.model ?? DEFAULT_MODEL,
            status: "pending",
            tokensUsed: 0,
            ticksRunning: 0,
          };
          return agent;
        }),
      };
      if (phaseSpec.pipelined !== undefined) {
        phase.pipelined = phaseSpec.pipelined;
      }
      return phase;
    }),
  };
}

/** Phase barrier: every agent has reached a terminal status (settled or failed). */
function phaseFullyTerminal(workflow: Workflow, phaseIndex: number): boolean {
  const phase = workflow.phases[phaseIndex];
  if (!phase) return true;
  return phase.agents.every((a) => isTerminalStatus(a.status));
}

/**
 * Whether agent at `agentIndex` in `phaseIndex` is allowed to leave pending.
 *
 * Non-pipelined: previous phase must be fully terminal (or no previous).
 * Pipelined: corresponding upstream agent (same index) must be settled
 * (failed upstream does not unlock the lane).
 * If this phase has more agents than the previous, extra agents wait for
 * the previous phase to fully terminal.
 */
function agentCanStart(
  workflow: Workflow,
  phaseIndex: number,
  agentIndex: number,
): boolean {
  if (phaseIndex === 0) return true;

  const phase = workflow.phases[phaseIndex];
  if (!phase) return false;

  const prev = workflow.phases[phaseIndex - 1];
  if (!prev) return true;

  if (phase.pipelined) {
    const upstream = prev.agents[agentIndex];
    if (upstream) {
      // Only successful settle unlocks the matching pipelined lane.
      return upstream.status === "settled";
    }
    // No matching upstream lane: wait for full previous phase terminal
    return phaseFullyTerminal(workflow, phaseIndex - 1);
  }

  return phaseFullyTerminal(workflow, phaseIndex - 1);
}

/**
 * Advance the workflow one deterministic step:
 * 1. Accrue tokens for running agents; settle those that finished their ticks.
 * 2. Start eligible pending agents (pending -> running).
 *
 * Within each phase, at most one new agent starts per tick so settle times
 * stagger. That lets a pipelined successor begin while earlier lanes of the
 * upstream phase are still running.
 *
 * Returns a new workflow object (deep-cloned agents/phases) so React
 * `setWorkflow(tick(wf))` always sees a new top-level reference.
 * The input object is not mutated.
 */
export function tick(workflow: Workflow): Workflow {
  const next = cloneWorkflow(workflow);

  // Pass 1: progress running agents
  for (const phase of next.phases) {
    for (const agent of phase.agents) {
      if (agent.status !== "running") continue;
      agent.tokensUsed += TOKENS_PER_TICK;
      agent.ticksRunning = (agent.ticksRunning ?? 0) + 1;
      if ((agent.ticksRunning ?? 0) >= TICKS_TO_SETTLE) {
        agent.status = "settled";
      }
    }
  }

  // Pass 2: start at most one eligible pending agent per phase (lowest index)
  for (let p = 0; p < next.phases.length; p++) {
    const phase = next.phases[p]!;
    for (let i = 0; i < phase.agents.length; i++) {
      const agent = phase.agents[i]!;
      if (agent.status !== "pending") continue;
      if (agentCanStart(next, p, i)) {
        agent.status = "running";
        agent.ticksRunning = 0;
        break;
      }
    }
  }

  return next;
}

/**
 * Return a new workflow with the given agent marked failed.
 * Matches exactly one agent by id (ids include phase index so collisions
 * across same-named phases do not happen under createWorkflow).
 * Useful for tests and for the shell when an agent errors out.
 */
export function markAgentFailed(workflow: Workflow, agentId: string): Workflow {
  const next = cloneWorkflow(workflow);
  let match: AgentRun | undefined;
  for (const phase of next.phases) {
    for (const agent of phase.agents) {
      if (agent.id === agentId) {
        if (match) {
          throw new Error(
            `Ambiguous agent id "${agentId}": matched more than one agent`,
          );
        }
        match = agent;
      }
    }
  }
  if (!match) {
    throw new Error(`No agent with id "${agentId}"`);
  }
  match.status = "failed";
  return next;
}

export function workflowProgress(workflow: Workflow): WorkflowProgress {
  const agents = workflow.phases.flatMap((p) => p.agents);
  const settled = agents.filter((a) => a.status === "settled").length;
  const total = agents.length;
  const tokensTotal = agents.reduce((sum, a) => sum + a.tokensUsed, 0);
  return { settled, total, tokensTotal };
}

/** Aggregate token totals overall and per phase name. */
export function tokenUsage(workflow: Workflow): TokenUsage {
  const byPhase: Record<string, number> = {};
  let total = 0;
  for (const phase of workflow.phases) {
    let phaseTotal = 0;
    for (const agent of phase.agents) {
      phaseTotal += agent.tokensUsed;
    }
    byPhase[phase.name] = (byPhase[phase.name] ?? 0) + phaseTotal;
    total += phaseTotal;
  }
  return { total, byPhase };
}

/** True when every agent has status "settled" (success path). */
export function isComplete(workflow: Workflow): boolean {
  const agents = workflow.phases.flatMap((p) => p.agents);
  if (agents.length === 0) return true;
  return agents.every((a) => a.status === "settled");
}

/** True when any agent has status "failed". */
export function isFailed(workflow: Workflow): boolean {
  return workflow.phases.some((p) =>
    p.agents.some((a) => a.status === "failed"),
  );
}

/**
 * True when the workflow cannot progress: not successfully complete,
 * nothing running, and either a failure exists or no pending agent can start.
 * Prevents silent deadlocks after a failed agent.
 */
export function isStuck(workflow: Workflow): boolean {
  if (isComplete(workflow)) return false;

  const agents = workflow.phases.flatMap((p) => p.agents);
  if (agents.some((a) => a.status === "running")) return false;

  // If any pending agent could start on the next tick, not stuck.
  for (let p = 0; p < workflow.phases.length; p++) {
    const phase = workflow.phases[p]!;
    for (let i = 0; i < phase.agents.length; i++) {
      const agent = phase.agents[i]!;
      if (agent.status === "pending" && agentCanStart(workflow, p, i)) {
        return false;
      }
    }
  }

  return true;
}
