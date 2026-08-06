/**
 * In-memory CoderApi for plain Vite browser dev (no Electron preload).
 * Seeded from mockData so the built SPA remains demoable.
 * runs.start drives a setInterval (~700ms) that advances the fake workflow.
 *
 * Work log contract: exactly ONE item per step (label like "Seed"), created
 * with done:false when the step starts and flipped to done:true on completion.
 * Items and messages carry runId so the renderer can group and order the
 * conversation timeline.
 */
import type {
  AgentView,
  ChatMessage,
  CoderApi,
  ProjectInfo,
  ThreadDetail,
  ThreadInfo,
  WorkLogItem,
  WorkflowView,
} from "./shared/ipc";
import { mockData } from "./mockData";

const TICK_MS = 700;
const TITLE_MAX = 60;

type ListenerMap = {
  "threads:changed": Set<(threads: ThreadInfo[]) => void>;
  "thread:updated": Set<(detail: ThreadDetail) => void>;
};

/** Per-thread run simulation bookkeeping. */
type RunState = {
  runId: string;
  /** Phases that already have a work-log item (started). */
  announced: Set<string>;
  /** Phases whose work-log item was flipped to done. */
  settled: Set<string>;
  /** Streaming assistant message id for this run (created on first tick). */
  assistantMsgId: string | null;
};

function now() {
  return Date.now();
}

function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function ageToMs(age: string): number {
  const m = /^(\d+)([mhd])$/.exec(age);
  if (!m) return 3 * 60 * 60 * 1000;
  const n = Number(m[1]);
  if (m[2] === "m") return n * 60 * 1000;
  if (m[2] === "h") return n * 60 * 60 * 1000;
  return n * 24 * 60 * 60 * 1000;
}

function workingMinutes(label?: string): number {
  if (!label) return 2;
  const m = /(\d+)\s*m/.exec(label);
  return m ? Number(m[1]) : 2;
}

function capitalize(name: string): string {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function seedProjects(): ProjectInfo[] {
  const slugs = [...new Set(mockData.threads.map((t) => t.repoSlug))];
  return slugs.map((slug, i) => {
    const name = slug.includes("/") ? (slug.split("/").pop() ?? slug) : slug;
    return {
      id: `proj-${i + 1}`,
      slug,
      name,
      path: `/Users/demo/${slug}`,
    };
  });
}

function seedThreads(projects: ProjectInfo[]): ThreadInfo[] {
  const bySlug = new Map(projects.map((p) => [p.slug, p]));
  const t0 = now();
  return mockData.threads.map((card) => {
    const project = bySlug.get(card.repoSlug)!;
    const ageMs = ageToMs(card.age);
    const updatedAt =
      card.status === "working"
        ? t0 - workingMinutes(card.workingLabel) * 60 * 1000
        : t0 - ageMs;
    return {
      id: card.id,
      projectId: project.id,
      title: card.title,
      branch: card.branch,
      prNumber: card.prNumber,
      status: card.status,
      createdAt: t0 - ageMs - 60 * 60 * 1000,
      updatedAt,
    };
  });
}

function mapAgentStatus(
  status: "active" | "done" | "pending" | "error",
): AgentView["status"] {
  if (status === "active") return "running";
  if (status === "done") return "settled";
  if (status === "error") return "failed";
  return "pending";
}

/** Workflow shaped like mock agents, mid-run (for the seeded working thread). */
function seedWorkflowMidRun(): WorkflowView {
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
function createFreshWorkflow(): WorkflowView {
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

  // Empty phases (Verify/Judge/Synthesize in mock) get a single pending agent
  // so the pipeline can advance through every chip.
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

function recomputeWorkflow(phases: WorkflowView["phases"], base: WorkflowView): WorkflowView {
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

/**
 * One simulation step: settle a running agent (grow tokens), else start the
 * next pending agent. Returns true when the run is complete.
 */
function advanceWorkflow(wf: WorkflowView): WorkflowView {
  const phases = wf.phases.map((p) => ({
    ...p,
    agents: p.agents.map((a) => ({ ...a })),
  }));

  let acted = false;

  // Prefer settling a running agent first
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

/**
 * Sync work-log items for phase start/settle using flip semantics:
 * create one item (done:false) when a phase first has a running agent;
 * flip that same item to done:true when all agents are terminal.
 */
function syncWorkLogForWorkflow(
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
      // Ensure item exists even if we never saw running (edge: empty→settled).
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
          // Keep original timestamp so duration spans start→end via other items;
          // duration uses min/max across the group, so leave start time.
        }
      }
    }
  }
}

/** Grow (or create) a streaming assistant message for the active run. */
function streamAssistant(detail: ThreadDetail, run: RunState, t: number): void {
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

function seedDetail(thread: ThreadInfo): ThreadDetail {
  const tv = mockData.threadView;
  const t0 = thread.updatedAt;
  const runId = "run-seed-1";

  // User prompt that triggered the mid-run state, then work log + assistant.
  const messages: ChatMessage[] = [
    {
      id: "msg-user-seed",
      role: "user",
      text: "Modernize per-device provider settings storage.",
      createdAt: t0 - 130_000,
      runId,
    },
    {
      id: "evt-kickoff",
      role: "event",
      text: tv.kickoff.title,
      createdAt: t0 - 90_000,
      runId,
    },
    ...tv.messages.map((m, i) => ({
      id: m.id,
      role: "assistant" as const,
      text: m.paragraphs.join("\n\n"),
      createdAt: t0 - 60_000 + i * 15_000,
      runId,
    })),
  ];

  // Single item per step (labels only), all done for completed seed work;
  // last open step if thread is still working.
  const workLog: WorkLogItem[] = tv.workLog.steps.map((s, i) => ({
    id: s.id,
    runId,
    label: s.label,
    done: s.done,
    timestamp: t0 - 120_000 + i * 20_000,
  }));

  // Mid-run: add Seed (done) + Analyze (in progress) as phase-style items
  // if the mock steps are descriptive; also reflect active Analyze phase.
  if (thread.status === "working") {
    const hasAnalyze = workLog.some((w) => /analyze/i.test(w.label));
    if (!hasAnalyze) {
      workLog.push({
        id: id("wl"),
        runId,
        label: "Seed",
        done: true,
        timestamp: t0 - 100_000,
      });
      workLog.push({
        id: id("wl"),
        runId,
        label: "Analyze",
        done: false,
        timestamp: t0 - 40_000,
      });
    }
  }

  return {
    thread,
    messages,
    workLog,
    workflow: thread.status === "working" ? seedWorkflowMidRun() : null,
  };
}

function cloneDetail(d: ThreadDetail): ThreadDetail {
  return structuredClone(d);
}

function buildDevCoder(): CoderApi {
  const projects = seedProjects();
  let threads = seedThreads(projects);
  const details = new Map<string, ThreadDetail>();
  /** Active run timers keyed by thread id. */
  const runTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Simulation state for active (and recently active) runs. */
  const runStates = new Map<string, RunState>();

  for (const t of threads) {
    if (t.id === mockData.activeThreadId) {
      const detail = seedDetail(t);
      details.set(t.id, detail);
      if (t.status === "working") {
        const runId =
          detail.workLog[0]?.runId ?? detail.messages.find((m) => m.runId)?.runId ?? id("run");
        const announced = new Set<string>();
        const settled = new Set<string>();
        for (const item of detail.workLog) {
          if (item.runId !== runId) continue;
          announced.add(item.label);
          if (item.done) settled.add(item.label);
        }
        // Also key by phase names from workflow for syncWorkLogForWorkflow.
        if (detail.workflow) {
          for (const phase of detail.workflow.phases) {
            const label = capitalize(phase.name);
            const item = detail.workLog.find(
              (w) => w.runId === runId && w.label === label,
            );
            if (item) {
              announced.add(phase.name);
              if (item.done) settled.add(phase.name);
            }
            // Mock descriptive labels may not match phase names; still track
            // phase-style progress for new ticks via phase names.
            const allTerminal =
              phase.agents.length > 0 &&
              phase.agents.every(
                (a) => a.status === "settled" || a.status === "failed",
              );
            if (allTerminal) {
              announced.add(phase.name);
              settled.add(phase.name);
            } else if (phase.agents.some((a) => a.status === "running")) {
              announced.add(phase.name);
            }
          }
        }
        runStates.set(t.id, {
          runId,
          announced,
          settled,
          assistantMsgId:
            detail.messages.find((m) => m.role === "assistant" && m.runId === runId)
              ?.id ?? null,
        });
      }
    } else {
      details.set(t.id, {
        thread: t,
        messages: [],
        workLog: [],
        workflow: null,
      });
    }
  }

  const listeners: ListenerMap = {
    "threads:changed": new Set(),
    "thread:updated": new Set(),
  };

  const emitThreads = () => {
    const snapshot = threads.map((t) => ({ ...t }));
    for (const cb of listeners["threads:changed"]) cb(snapshot);
  };

  const emitDetail = (detail: ThreadDetail) => {
    const snap = cloneDetail(detail);
    for (const cb of listeners["thread:updated"]) cb(snap);
  };

  const syncThreadRow = (thread: ThreadInfo) => {
    threads = threads.map((t) => (t.id === thread.id ? { ...thread } : t));
    emitThreads();
  };

  const clearRunTimer = (threadId: string) => {
    const handle = runTimers.get(threadId);
    if (handle != null) {
      clearInterval(handle);
      runTimers.delete(threadId);
    }
  };

  const tickRun = (threadId: string) => {
    const detail = details.get(threadId);
    if (!detail?.workflow || detail.workflow.complete) {
      clearRunTimer(threadId);
      return;
    }

    let run = runStates.get(threadId);
    if (!run) {
      run = {
        runId: id("run"),
        announced: new Set(),
        settled: new Set(),
        assistantMsgId: null,
      };
      runStates.set(threadId, run);
    }

    const advanced = advanceWorkflow(detail.workflow);
    const t = now();
    let thread: ThreadInfo = {
      ...detail.thread,
      updatedAt: t,
    };

    detail.workflow = advanced;
    syncWorkLogForWorkflow(detail, run, t);
    streamAssistant(detail, run, t);

    if (advanced.complete) {
      thread = { ...thread, status: "done", updatedAt: t };
      // Final flip for any remaining announced items.
      for (const item of detail.workLog) {
        if (item.runId === run.runId) item.done = true;
      }
      detail.messages.push({
        id: id("evt"),
        role: "event",
        text: "Run complete",
        createdAt: t,
        runId: run.runId,
      });
      clearRunTimer(threadId);
    }

    detail.thread = thread;
    details.set(threadId, detail);
    syncThreadRow(thread);
    emitDetail(detail);
  };

  const startRunTimer = (threadId: string) => {
    clearRunTimer(threadId);
    const handle = setInterval(() => tickRun(threadId), TICK_MS);
    runTimers.set(threadId, handle);
  };

  // Keep the seeded working thread progressing in browser demos
  for (const t of threads) {
    if (t.status === "working") {
      startRunTimer(t.id);
    }
  }

  const api: CoderApi = {
    projects: {
      async list() {
        return projects.map((p) => ({ ...p }));
      },
      async add(path: string) {
        // Mirror real backend: reject paths that are not a git repo.
        if (/not-a-git|nongit/i.test(path)) {
          throw new Error("Not a git repository...");
        }
        const slug =
          path
            .replace(/\\/g, "/")
            .split("/")
            .filter(Boolean)
            .slice(-2)
            .join("/") || "local/project";
        const project: ProjectInfo = {
          id: id("proj"),
          slug,
          name: slug.includes("/") ? (slug.split("/").pop() ?? slug) : slug,
          path,
        };
        projects.push(project);
        return { ...project };
      },
      async addViaDialog() {
        // Browser has no native picker; invent a demo project path.
        const n = projects.length + 1;
        return api.projects.add(`/Users/demo/demo-org/project-${n}`);
      },
    },
    threads: {
      async list() {
        return threads.map((t) => ({ ...t }));
      },
      async create(input) {
        const t: ThreadInfo = {
          id: id("thread"),
          projectId: input.projectId,
          title: input.title,
          branch: null,
          prNumber: null,
          status: "idle",
          createdAt: now(),
          updatedAt: now(),
        };
        threads = [t, ...threads];
        details.set(t.id, {
          thread: t,
          messages: [],
          workLog: [],
          workflow: null,
        });
        emitThreads();
        return { ...t };
      },
      async get(threadId) {
        const d = details.get(threadId);
        if (!d) throw new Error(`Thread not found: ${threadId}`);
        const row = threads.find((t) => t.id === threadId);
        if (row) d.thread = { ...row };
        return cloneDetail(d);
      },
    },
    runs: {
      async start(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);

        if (
          detail.thread.status === "working" ||
          runTimers.has(input.threadId)
        ) {
          throw new Error("A run is already active on this thread");
        }

        const prompt = input.prompt.trim();
        const t = now();
        const runId = id("run");
        const run: RunState = {
          runId,
          announced: new Set(),
          settled: new Set(),
          assistantMsgId: null,
        };
        runStates.set(input.threadId, run);

        // User prompt first (same timestamp as run start; timeline sorts
        // messages before work logs on ties).
        detail.messages.push({
          id: id("msg"),
          role: "user",
          text: prompt,
          createdAt: t,
          runId,
        });

        let thread = { ...detail.thread };
        if (thread.title === "New Thread") {
          const firstLine =
            prompt.split("\n")[0]?.slice(0, TITLE_MAX) || "New Thread";
          thread = { ...thread, title: firstLine };
        }
        thread = {
          ...thread,
          status: "working",
          updatedAt: t,
          branch: thread.branch ?? "feat/local-run",
        };
        detail.thread = thread;
        detail.workflow = createFreshWorkflow();
        // Kick first agent into running immediately
        detail.workflow = advanceWorkflow(detail.workflow);
        syncWorkLogForWorkflow(detail, run, t);

        detail.messages.push({
          id: id("evt"),
          role: "event",
          text: `Kicked off ${detail.workflow.total} subagents`,
          createdAt: t + 1,
          runId,
        });
        streamAssistant(detail, run, t + 2);

        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        startRunTimer(input.threadId);
        return { workflowId: detail.workflow.id };
      },
      async stop(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);

        clearRunTimer(input.threadId);

        const t = now();
        const run = runStates.get(input.threadId);
        // Match real backend: idle, keep agent states, append stop event.
        const thread: ThreadInfo = {
          ...detail.thread,
          status: "idle",
          updatedAt: t,
        };
        detail.thread = thread;
        detail.messages.push({
          id: id("evt"),
          role: "event",
          text: "Run stopped",
          createdAt: t,
          runId: run?.runId,
        });
        // Leave workflow.agents as they were; mark incomplete
        if (detail.workflow) {
          detail.workflow = {
            ...detail.workflow,
            complete: false,
          };
        }
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
      },
    },
    git: {
      async status(_projectId) {
        return {
          isRepo: true,
          branch: "main",
          dirty: false,
        };
      },
    },
    on(channel, cb) {
      if (channel === "threads:changed") {
        const fn = cb as (threads: ThreadInfo[]) => void;
        listeners["threads:changed"].add(fn);
        return () => {
          listeners["threads:changed"].delete(fn);
        };
      }
      const fn = cb as (detail: ThreadDetail) => void;
      listeners["thread:updated"].add(fn);
      return () => {
        listeners["thread:updated"].delete(fn);
      };
    },
  };

  return api;
}

export const devCoder: CoderApi = buildDevCoder();
