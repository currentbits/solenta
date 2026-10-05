/** Simulated run streaming for the browser-dev fixture: workflow and session ticks. */
import type {
  AgentView,
  SessionUsage,
  ThreadDetail,
  WorkflowPhaseSpec,
  WorkflowTemplateInfo,
  WorkflowView,
} from "../shared/ipc";
import { mockData } from "../mockData.ts";
import { TRAILER, id, capitalize } from "./util.ts";

export const TICK_MS = TRAILER ? 1600 : 700;
export function formatUsd(n: number): string {
  return n.toFixed(2);
}

export function dailyBudgetReachedMessage(spent: number, budget: number): string {
  return `Daily budget reached ($${formatUsd(spent)} of $${formatUsd(budget)}). Raise or clear the cap in Settings.`;
}

/** Per-thread run simulation bookkeeping. */
export type RunState = {
  runId: string;
  /** Phases that already have a work-log item (started). */
  announced: Set<string>;
  /** Phases whose work-log item was flipped to done. */
  settled: Set<string>;
  /** Streaming assistant message id for this run (created on first tick). */
  assistantMsgId: string | null;
  /** Session-style run step index (tool/text sequence). */
  sessionStep: number;
  /**
   * session: single-provider turn (runs.start)
   * simulate: mock multi-agent tick for provider === "simulate"
   * workflow: Build orchestration (runs.startWorkflow, template-driven)
   */
  kind: "session" | "simulate" | "workflow";
  /** Index of the currently running phase (startWorkflow only). */
  workflowStep: number;
  /** Phase instructions for dossier text (startWorkflow only). */
  phaseInstructions?: string[];
  /** usage.costUsd at run start; delta is billed to spendTodayUsd on end. */
  costBaseline: number;
};

export function mapAgentStatus(
  status: "active" | "done" | "pending" | "error",
): AgentView["status"] {
  if (status === "active") return "running";
  if (status === "done") return "settled";
  if (status === "error") return "failed";
  return "pending";
}

/** Workflow shaped like mock agents, mid-run (for the seeded working thread). */
export function seedWorkflowMidRun(): WorkflowView {
  const phaseOrder = mockData.agents.phases.map((p) => p.name);
  const agentsByPhase = new Map<string, AgentView[]>();
  const allAgents: AgentView[] = [];

  for (const g of mockData.agents.groups) {
    const phaseName =
      mockData.agents.phases.find((p) => p.id === g.id)?.name ?? g.name;
    const list: AgentView[] = g.agents.map((a) => ({
      id: a.label,
      model: a.model,
      status: mapAgentStatus(a.status),
      tokensUsed:
        a.status === "done" ? 10400 : a.status === "active" ? 8000 : 0,
    }));
    agentsByPhase.set(phaseName, list);
    allAgents.push(...list);
  }

  const phases = phaseOrder.map((name) => ({
    name,
    pipelined: true,
    agents: agentsByPhase.get(name) ?? [],
  }));

  const settled = allAgents.filter((a) => a.status === "settled").length;
  const tokensTotal = allAgents.reduce((s, a) => s + a.tokensUsed, 0);

  return {
    id: id("wf"),
    name: mockData.agents.name,
    phases,
    settled,
    total: allAgents.length || 5,
    tokensTotal: tokensTotal || 52000,
    complete: false,
  };
}

/** Fresh run: all agents pending across the mock phase layout. */
export function createFreshWorkflow(): WorkflowView {
  const phaseOrder = mockData.agents.phases.map((p) => p.name);
  const agentsByPhase = new Map<string, AgentView[]>();
  const allAgents: AgentView[] = [];

  for (const g of mockData.agents.groups) {
    const phaseName =
      mockData.agents.phases.find((p) => p.id === g.id)?.name ?? g.name;
    const list: AgentView[] = g.agents.map((a) => ({
      id: a.label,
      model: a.model,
      status: "pending" as const,
      tokensUsed: 0,
    }));
    agentsByPhase.set(phaseName, list);
    allAgents.push(...list);
  }

  for (const name of phaseOrder) {
    if (!agentsByPhase.has(name) || (agentsByPhase.get(name)?.length ?? 0) === 0) {
      const agent: AgentView = {
        id: `${name.toLowerCase()}:1`,
        model: "sonnet-5",
        status: "pending",
        tokensUsed: 0,
      };
      agentsByPhase.set(name, [agent]);
      allAgents.push(agent);
    }
  }

  const phases = phaseOrder.map((name) => ({
    name,
    pipelined: true,
    agents: agentsByPhase.get(name) ?? [],
  }));

  return {
    id: id("wf"),
    name: mockData.agents.name,
    phases,
    settled: 0,
    total: allAgents.length,
    tokensTotal: 0,
    complete: false,
  };
}

/**
 * Build a WorkflowView from a template. First phase agents start running so
 * the first thread:updated already shows progress.
 */
export function createWorkflowFromTemplate(
  template: WorkflowTemplateInfo,
): WorkflowView {
  const phases: WorkflowView["phases"] = template.phases.map((p, pi) => {
    const modelLabel = p.model ?? "default";
    const agents: AgentView[] = Array.from({ length: p.agentCount }, (_, i) => ({
      id: `${p.name}:${i + 1}`,
      model: modelLabel,
      status: pi === 0 ? ("running" as const) : ("pending" as const),
      tokensUsed: pi === 0 ? 200 + Math.floor(Math.random() * 100) : 0,
    }));
    return {
      name: p.name,
      pipelined: p.agentCount > 1,
      agents,
    };
  });
  return recomputeWorkflow(phases, {
    id: id("wf"),
    name: template.name,
    phases,
    settled: 0,
    total: 0,
    tokensTotal: 0,
    complete: false,
  });
}

export function buildKickoffText(
  wf: WorkflowView,
  phases: WorkflowPhaseSpec[],
): string {
  const lines = [`Kicked off ${wf.total} subagents`];
  for (const p of phases) {
    lines.push(
      `${capitalize(p.name)} · ${p.agentCount} · ${p.instruction}`,
    );
  }
  return lines.join("\n");
}

export function appendDossier(
  detail: ThreadDetail,
  run: RunState,
  t: number,
  phaseName: string,
  agent: AgentView,
  instruction: string,
  prompt: string,
): void {
  const short = prompt.split("\n")[0]?.slice(0, 60) || "the task";
  const output = [
    `Phase: ${phaseName}`,
    `Agent: ${agent.id}`,
    `Model: ${agent.model}`,
    `Instruction: ${instruction}`,
    "",
    `Findings for "${short}":`,
    `- Explored relevant modules for ${phaseName}`,
    `- Produced intermediate notes (${agent.tokensUsed} tokens)`,
  ].join("\n");

  detail.messages.push({
    id: id("msg"),
    role: "tool",
    text: `Dossier: ${phaseName} · ${agent.id}`,
    createdAt: t,
    runId: run.runId,
    tool: {
      id: id("tool"),
      name: "Dossier",
      input: JSON.stringify(
        {
          phase: phaseName,
          agentId: agent.id,
          model: agent.model,
          instruction,
        },
        null,
        2,
      ),
      output,
      isError: false,
      done: true,
    },
  });
}

/**
 * Advance template-driven Build workflow one phase per tick.
 * Settles the current phase (appending a dossier per agent), then starts the
 * next. Returns true when the workflow is complete after this tick.
 */
export function tickBuildWorkflow(
  detail: ThreadDetail,
  run: RunState,
  t: number,
  prompt: string,
): boolean {
  const wf = detail.workflow;
  if (!wf) return true;

  const phases = wf.phases.map((p) => ({
    ...p,
    agents: p.agents.map((a) => ({ ...a })),
  }));
  const step = run.workflowStep;
  const current = phases[step];
  if (!current) return true;

  const instruction =
    run.phaseInstructions?.[step] ?? `Run phase ${current.name}`;

  for (const a of current.agents) {
    a.status = "settled";
    a.tokensUsed += 900 + Math.floor(Math.random() * 500);
    appendDossier(detail, run, t, current.name, a, instruction, prompt);
  }

  const nextIndex = step + 1;
  const next = phases[nextIndex];
  if (next) {
    for (const a of next.agents) {
      a.status = "running";
      a.tokensUsed = 300 + Math.floor(Math.random() * 200);
    }
    run.workflowStep = nextIndex;
    detail.workflow = recomputeWorkflow(phases, wf);
    syncWorkLogForWorkflow(detail, run, t);
    return false;
  }

  run.workflowStep = nextIndex;
  detail.workflow = recomputeWorkflow(phases, wf);
  syncWorkLogForWorkflow(detail, run, t);

  for (const item of detail.workLog) {
    if (item.runId === run.runId) item.done = true;
  }
  const short = prompt.split("\n")[0]?.slice(0, 80) || "your request";
  const phaseNames = phases.map((p) => p.name).join(" → ");
  detail.messages.push({
    id: id("msg"),
    role: "assistant",
    text: `Workflow answer: completed ${wf.name} for "${short}". Phases: ${phaseNames}.`,
    createdAt: t,
    runId: run.runId,
  });
  detail.messages.push({
    id: id("evt"),
    role: "event",
    text: "Run complete",
    createdAt: t + 1,
    runId: run.runId,
  });
  bumpUsage(detail, {
    inputTokens: 2400,
    outputTokens: 980,
    costUsd: 0.012,
    turns: 1,
    model: detail.thread.model ?? "claude-opus-4",
  });
  return true;
}

export function recomputeWorkflow(phases: WorkflowView["phases"], base: WorkflowView): WorkflowView {
  const agents = phases.flatMap((p) => p.agents);
  const settled = agents.filter((a) => a.status === "settled").length;
  const tokensTotal = agents.reduce((s, a) => s + a.tokensUsed, 0);
  const complete =
    agents.length > 0 &&
    agents.every((a) => a.status === "settled" || a.status === "failed");
  return {
    ...base,
    phases,
    settled,
    total: agents.length,
    tokensTotal,
    complete,
  };
}

export function advanceWorkflow(wf: WorkflowView): WorkflowView {
  const phases = wf.phases.map((p) => ({
    ...p,
    agents: p.agents.map((a) => ({ ...a })),
  }));

  let acted = false;

  outerRunning: for (const phase of phases) {
    for (const agent of phase.agents) {
      if (agent.status === "running") {
        agent.status = "settled";
        agent.tokensUsed += 1800 + Math.floor(Math.random() * 900);
        acted = true;
        break outerRunning;
      }
    }
  }

  if (!acted) {
    outerPending: for (const phase of phases) {
      for (const agent of phase.agents) {
        if (agent.status === "pending") {
          agent.status = "running";
          agent.tokensUsed = 400 + Math.floor(Math.random() * 400);
          acted = true;
          break outerPending;
        }
      }
    }
  }

  return recomputeWorkflow(phases, wf);
}

/** Trailer-only: settle one worker, then fan out a whole phase at once. */
export function advanceWorkflowFanout(wf: WorkflowView): WorkflowView {
  const phases = wf.phases.map((p) => ({
    ...p,
    agents: p.agents.map((a) => ({ ...a })),
  }));

  for (const phase of phases) {
    const running = phase.agents.filter((a) => a.status === "running");
    if (running.length > 0) {
      const agent = running[0];
      agent.status = "settled";
      agent.tokensUsed += 1800 + Math.floor(Math.random() * 900);
      return recomputeWorkflow(phases, wf);
    }
  }

  for (const phase of phases) {
    const pending = phase.agents.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      for (const agent of pending) {
        agent.status = "running";
        agent.tokensUsed = 400 + Math.floor(Math.random() * 400);
      }
      return recomputeWorkflow(phases, wf);
    }
  }

  return recomputeWorkflow(phases, wf);
}

export function syncWorkLogForWorkflow(
  detail: ThreadDetail,
  run: RunState,
  t: number,
): void {
  const wf = detail.workflow;
  if (!wf) return;

  for (const phase of wf.phases) {
    const hasRunning = phase.agents.some((a) => a.status === "running");
    const allTerminal =
      phase.agents.length > 0 &&
      phase.agents.every(
        (a) => a.status === "settled" || a.status === "failed",
      );
    const label = capitalize(phase.name);

    if (hasRunning && !run.announced.has(phase.name)) {
      run.announced.add(phase.name);
      detail.workLog.push({
        id: id("wl"),
        runId: run.runId,
        label,
        done: false,
        timestamp: t,
      });
    }

    if (allTerminal && !run.settled.has(phase.name)) {
      run.settled.add(phase.name);
      if (!run.announced.has(phase.name)) {
        run.announced.add(phase.name);
        detail.workLog.push({
          id: id("wl"),
          runId: run.runId,
          label,
          done: true,
          timestamp: t,
        });
      } else {
        const item = detail.workLog.find(
          (w) => w.runId === run.runId && w.label === label,
        );
        if (item) {
          item.done = true;
        }
      }
    }
  }
}

export function streamAssistant(detail: ThreadDetail, run: RunState, t: number): void {
  const snippets = [
    "Mapping the request against the current worktree layout.",
    "Agents are exploring the relevant modules in parallel.",
    "Drafting a plan from the analyze phase findings.",
    "Cross-checking types and edge cases before the patch.",
  ];
  const settled = detail.workflow?.settled ?? 0;
  const total = detail.workflow?.total ?? 1;
  const progress = Math.min(
    snippets.length,
    1 + Math.floor((settled / Math.max(total, 1)) * (snippets.length - 1)),
  );
  const text = snippets.slice(0, progress).join("\n\n");

  if (!run.assistantMsgId) {
    const msgId = id("msg");
    run.assistantMsgId = msgId;
    detail.messages.push({
      id: msgId,
      role: "assistant",
      text,
      createdAt: t,
      runId: run.runId,
    });
    return;
  }

  const existing = detail.messages.find((m) => m.id === run.assistantMsgId);
  if (existing) {
    existing.text = text;
  }
}

export function emptyUsage(model: string | null = "claude-opus-4"): SessionUsage {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    turns: 0,
    contextTokens: 0,
  };
}

export function bumpUsage(detail: ThreadDetail, delta: Partial<SessionUsage> & { model?: string | null }): void {
  const prev = detail.usage ?? emptyUsage(delta.model ?? "claude-opus-4");
  const turnTokens = (delta.inputTokens ?? 0) + (delta.outputTokens ?? 0);
  detail.usage = {
    model: delta.model !== undefined ? delta.model : prev.model,
    inputTokens: prev.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: prev.outputTokens + (delta.outputTokens ?? 0),
    costUsd: prev.costUsd + (delta.costUsd ?? 0),
    turns: prev.turns + (delta.turns ?? 0),
    contextTokens: turnTokens > 0 ? turnTokens : prev.contextTokens ?? 0,
  };
}

/**
 * Session provider ticks:
 * 0 open assistant text
 * 1 Bash tool (running)
 * 2 Bash done + more text
 * 3 Edit tool (running)
 * 4 Edit done + final text + complete
 */
export function tickSessionRun(detail: ThreadDetail, run: RunState, t: number): boolean {
  const step = run.sessionStep;

  if (step === 0) {
    const msgId = id("msg");
    run.assistantMsgId = msgId;
    detail.messages.push({
      id: msgId,
      role: "assistant",
      text: "I'll inspect the repo and apply a small fix.",
      createdAt: t,
      runId: run.runId,
    });
    bumpUsage(detail, {
      inputTokens: 420,
      outputTokens: 80,
      costUsd: 0.0042,
      model: "claude-opus-4",
    });
    run.sessionStep = 1;
    return false;
  }

  if (step === 1) {
    detail.messages.push({
      id: id("msg"),
      role: "tool",
      text: "Bash: npm test",
      createdAt: t,
      runId: run.runId,
      tool: {
        id: id("tool"),
        name: "Bash",
        input: JSON.stringify({ command: "npm test" }, null, 2),
        output: null,
        isError: false,
        done: false,
      },
    });
    run.sessionStep = 2;
    return false;
  }

  if (step === 2) {
    const bash = [...detail.messages]
      .reverse()
      .find((m) => m.role === "tool" && m.tool?.name === "Bash" && !m.tool.done);
    if (bash?.tool) {
      bash.tool.done = true;
      bash.tool.output =
        "✓ test/timeline.test.ts (8)\n\n  8 passing\n\nexit 0";
      bash.text = "Bash: npm test";
    }
    if (run.assistantMsgId) {
      const asst = detail.messages.find((m) => m.id === run.assistantMsgId);
      if (asst) {
        asst.text +=
          "\n\nTests are green. Next I'll patch the permission mode selector.";
      }
    }
    bumpUsage(detail, { inputTokens: 210, outputTokens: 120, costUsd: 0.0031 });
    run.sessionStep = 3;
    return false;
  }

  if (step === 3) {
    detail.messages.push({
      id: id("msg"),
      role: "tool",
      text: "Edit: src/components/Composer.tsx",
      createdAt: t,
      runId: run.runId,
      tool: {
        id: id("tool"),
        name: "Edit",
        input: JSON.stringify(
          {
            path: "src/components/Composer.tsx",
            old_string: 'access: "Full access"',
            new_string: "permissionMode selector",
          },
          null,
          2,
        ),
        output: null,
        isError: false,
        done: false,
      },
    });
    run.sessionStep = 4;
    return false;
  }

  // step >= 4: finish Edit + close run
  const edit = [...detail.messages]
    .reverse()
    .find((m) => m.role === "tool" && m.tool?.name === "Edit" && !m.tool.done);
  if (edit?.tool) {
    edit.tool.done = true;
    edit.tool.output = "Applied 1 edit to Composer.tsx";
  }
  detail.messages.push({
    id: id("msg"),
    role: "assistant",
    text: "Done. Permission mode is wired to threads.setPermissionMode and the session card reflects live usage.",
    createdAt: t,
    runId: run.runId,
  });
  detail.messages.push({
    id: id("evt"),
    role: "event",
    text: "Run complete",
    createdAt: t + 1,
    runId: run.runId,
  });
  bumpUsage(detail, {
    inputTokens: 380,
    outputTokens: 160,
    costUsd: 0.0055,
    turns: 1,
  });
  run.sessionStep = 5;
  return true;
}
