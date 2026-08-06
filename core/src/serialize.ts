import type {
  AgentRun,
  AgentRunStatus,
  Workflow,
  WorkflowPhase,
  WorkflowPhaseName,
} from "./types.js";

const PHASE_NAMES = new Set<WorkflowPhaseName>([
  "seed",
  "analyze",
  "verify",
  "judge",
  "synthesize",
]);

const AGENT_STATUSES = new Set<AgentRunStatus>([
  "pending",
  "running",
  "settled",
  "failed",
]);

/**
 * Serialize a workflow to a JSON string of plain, JSON-safe data.
 * Suitable for persistence or IPC.
 */
export function serializeWorkflow(workflow: Workflow): string {
  return JSON.stringify(workflow);
}

/**
 * Parse and validate a workflow JSON string.
 * Throws a descriptive Error on malformed input.
 */
export function deserializeWorkflow(json: string): Workflow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed workflow JSON: parse failed (${msg})`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Malformed workflow JSON: expected a root object, got ${describe(parsed)}`,
    );
  }

  const root = parsed as Record<string, unknown>;

  if (typeof root.id !== "string") {
    throw new Error('Malformed workflow: missing or invalid string field "id"');
  }
  if (typeof root.name !== "string") {
    throw new Error(
      'Malformed workflow: missing or invalid string field "name"',
    );
  }
  if (!Array.isArray(root.phases)) {
    throw new Error(
      'Malformed workflow: missing or invalid array field "phases"',
    );
  }

  const phases: WorkflowPhase[] = root.phases.map((phaseRaw, phaseIndex) =>
    parsePhase(phaseRaw, phaseIndex),
  );

  assertUniqueAgentIds(phases);

  return {
    id: root.id,
    name: root.name,
    phases,
  };
}

/** Reject duplicate agent ids early at the parse boundary. */
function assertUniqueAgentIds(phases: WorkflowPhase[]): void {
  const seen = new Set<string>();
  for (const phase of phases) {
    for (const agent of phase.agents) {
      if (seen.has(agent.id)) {
        throw new Error(
          `Malformed workflow: duplicate agent id "${agent.id}"`,
        );
      }
      seen.add(agent.id);
    }
  }
}

function parsePhase(phaseRaw: unknown, phaseIndex: number): WorkflowPhase {
  if (
    phaseRaw === null ||
    typeof phaseRaw !== "object" ||
    Array.isArray(phaseRaw)
  ) {
    throw new Error(
      `Malformed workflow: phase[${phaseIndex}] must be an object`,
    );
  }
  const phase = phaseRaw as Record<string, unknown>;

  if (typeof phase.name !== "string") {
    throw new Error(
      `Malformed workflow: phase[${phaseIndex}] missing or invalid "name"`,
    );
  }
  if (!PHASE_NAMES.has(phase.name as WorkflowPhaseName)) {
    throw new Error(
      `Malformed workflow: phase[${phaseIndex}] has unknown phase name "${phase.name}"`,
    );
  }

  if (!Array.isArray(phase.agents)) {
    throw new Error(
      `Malformed workflow: phase[${phaseIndex}] missing or invalid array field "agents"`,
    );
  }

  // Same invariant as createWorkflow: every phase needs at least one agent.
  if (phase.agents.length < 1) {
    throw new Error(
      `Malformed workflow: phase[${phaseIndex}] ("${phase.name}") must have at least one agent`,
    );
  }

  const agents: AgentRun[] = phase.agents.map((agentRaw, agentIndex) =>
    parseAgent(agentRaw, phaseIndex, agentIndex),
  );

  const result: WorkflowPhase = {
    name: phase.name as WorkflowPhaseName,
    agents,
  };

  if (phase.pipelined !== undefined) {
    if (typeof phase.pipelined !== "boolean") {
      throw new Error(
        `Malformed workflow: phase[${phaseIndex}] "pipelined" must be a boolean`,
      );
    }
    result.pipelined = phase.pipelined;
  }

  return result;
}

function parseAgent(
  agentRaw: unknown,
  phaseIndex: number,
  agentIndex: number,
): AgentRun {
  const loc = `phase[${phaseIndex}].agents[${agentIndex}]`;
  if (
    agentRaw === null ||
    typeof agentRaw !== "object" ||
    Array.isArray(agentRaw)
  ) {
    throw new Error(`Malformed workflow: ${loc} must be an object`);
  }
  const agent = agentRaw as Record<string, unknown>;

  if (typeof agent.id !== "string") {
    throw new Error(`Malformed workflow: ${loc} missing or invalid "id"`);
  }
  if (typeof agent.model !== "string") {
    throw new Error(`Malformed workflow: ${loc} missing or invalid "model"`);
  }
  if (typeof agent.status !== "string") {
    throw new Error(`Malformed workflow: ${loc} missing or invalid "status"`);
  }
  if (!AGENT_STATUSES.has(agent.status as AgentRunStatus)) {
    throw new Error(
      `Malformed workflow: ${loc} has unknown status value "${agent.status}"`,
    );
  }
  if (typeof agent.tokensUsed !== "number" || !Number.isFinite(agent.tokensUsed)) {
    throw new Error(
      `Malformed workflow: ${loc} missing or invalid "tokensUsed"`,
    );
  }

  const result: AgentRun = {
    id: agent.id,
    model: agent.model,
    status: agent.status as AgentRunStatus,
    tokensUsed: agent.tokensUsed,
  };

  if (agent.ticksRunning !== undefined) {
    if (
      typeof agent.ticksRunning !== "number" ||
      !Number.isFinite(agent.ticksRunning)
    ) {
      throw new Error(
        `Malformed workflow: ${loc} "ticksRunning" must be a finite number`,
      );
    }
    result.ticksRunning = agent.ticksRunning;
  }

  return result;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
