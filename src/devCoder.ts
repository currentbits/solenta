/**
 * In-memory CoderApi for plain Vite browser dev (no Electron preload).
 * Seeded from mockData so the built SPA remains demoable.
 *
 * Real provider sessions (provider !== "simulate"): streams text + tool cards,
 * accumulates SessionUsage, no workflow. Simulate provider keeps the old
 * multi-agent workflow tick for the seeded mid-run demo.
 */
import type {
  AgentView,
  ChatMessage,
  CoderApi,
  DiffResult,
  PermissionMode,
  ProjectInfo,
  SessionUsage,
  ThreadDetail,
  ThreadInfo,
  WorkLogItem,
  WorkflowView,
} from "./shared/ipc";
import { mockData } from "./mockData";

const TICK_MS = 700;
const TITLE_MAX = 60;
const WORKTREE_DELAY_MS = 450;

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
  /** Session-style run step index (tool/text sequence). */
  sessionStep: number;
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
  return mockData.threads.map((card, index) => {
    const project = bySlug.get(card.repoSlug)!;
    const ageMs = ageToMs(card.age);
    const updatedAt =
      card.status === "working"
        ? t0 - workingMinutes(card.workingLabel) * 60 * 1000
        : t0 - ageMs;
    const isSimulate = card.id === mockData.activeThreadId;
    return {
      id: card.id,
      projectId: project.id,
      title: card.title,
      branch: card.branch,
      prNumber: card.prNumber,
      status: card.status,
      createdAt: t0 - ageMs - 60 * 60 * 1000,
      updatedAt,
      provider: isSimulate ? "simulate" : index % 3 === 0 ? "generic" : "claude",
      sessionId: isSimulate
        ? "sim-seed-session-aabbccdd"
        : card.status === "done"
          ? `sess-${card.id.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`
          : null,
      permissionMode: (isSimulate
        ? "bypassPermissions"
        : index % 2 === 0
          ? "default"
          : "acceptEdits") as PermissionMode,
      worktreePath: null,
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

function advanceWorkflow(wf: WorkflowView): WorkflowView {
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

function emptyUsage(model: string | null = "claude-opus-4"): SessionUsage {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

function bumpUsage(detail: ThreadDetail, delta: Partial<SessionUsage> & { model?: string | null }): void {
  const prev = detail.usage ?? emptyUsage(delta.model ?? "claude-opus-4");
  detail.usage = {
    model: delta.model !== undefined ? delta.model : prev.model,
    inputTokens: prev.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: prev.outputTokens + (delta.outputTokens ?? 0),
    costUsd: prev.costUsd + (delta.costUsd ?? 0),
    turns: prev.turns + (delta.turns ?? 0),
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
function tickSessionRun(detail: ThreadDetail, run: RunState, t: number): boolean {
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

function seedDetail(thread: ThreadInfo): ThreadDetail {
  const tv = mockData.threadView;
  const t0 = thread.updatedAt;
  const runId = "run-seed-1";

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

  const workLog: WorkLogItem[] = tv.workLog.steps.map((s, i) => ({
    id: s.id,
    runId,
    label: s.label,
    done: s.done,
    timestamp: t0 - 120_000 + i * 20_000,
  }));

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

  const usage: SessionUsage | null =
    thread.provider === "simulate"
      ? {
          model: "simulate-multiagent",
          inputTokens: 18400,
          outputTokens: 6200,
          costUsd: 0.0,
          turns: 1,
        }
      : thread.sessionId
        ? {
            model: "claude-opus-4",
            inputTokens: 2400,
            outputTokens: 910,
            costUsd: 0.0184,
            turns: 2,
          }
        : null;

  return {
    thread,
    messages,
    workLog,
    workflow: thread.status === "working" && thread.provider === "simulate"
      ? seedWorkflowMidRun()
      : null,
    usage,
  };
}

function cloneDetail(d: ThreadDetail): ThreadDetail {
  return structuredClone(d);
}

function fakeDiff(thread: ThreadInfo): DiffResult {
  const branch = thread.branch ?? "main";
  const files = [
    {
      path: "src/components/Composer.tsx",
      status: "M",
      additions: 28,
      deletions: 6,
    },
    {
      path: "src/components/ThreadView.tsx",
      status: "M",
      additions: 94,
      deletions: 12,
    },
    {
      path: "src/devCoder.ts",
      status: "M",
      additions: 140,
      deletions: 40,
    },
  ];
  const patch = [
    `diff --git a/src/components/Composer.tsx b/src/components/Composer.tsx`,
    `index 1111111..2222222 100644`,
    `--- a/src/components/Composer.tsx`,
    `+++ b/src/components/Composer.tsx`,
    `@@ -100,7 +100,12 @@ export function Composer({`,
    `     <button type="button" className={styles.pill}>`,
    `-      {STATIC.access}`,
    `+      {permissionModeLabel(permissionMode)}`,
    `+      <span className={styles.caret}>▾</span>`,
    `     </button>`,
    ``,
    `diff --git a/src/components/ThreadView.tsx b/src/components/ThreadView.tsx`,
    `--- a/src/components/ThreadView.tsx`,
    `+++ b/src/components/ThreadView.tsx`,
    `@@ -1,4 +1,8 @@`,
    `+import type { DiffResult } from "../shared/ipc";`,
    `+// Changes panel + tool cards`,
    ` // branch: ${branch}`,
  ].join("\n");

  return {
    files,
    patch,
    truncated: false,
  };
}

function buildDevCoder(): CoderApi {
  const projects = seedProjects();
  let threads = seedThreads(projects);
  const details = new Map<string, ThreadDetail>();
  const runTimers = new Map<string, ReturnType<typeof setInterval>>();
  const runStates = new Map<string, RunState>();

  for (const t of threads) {
    if (t.id === mockData.activeThreadId) {
      const detail = seedDetail(t);
      details.set(t.id, detail);
      if (t.status === "working") {
        const runId =
          detail.workLog[0]?.runId ??
          detail.messages.find((m) => m.runId)?.runId ??
          id("run");
        const announced = new Set<string>();
        const settled = new Set<string>();
        for (const item of detail.workLog) {
          if (item.runId !== runId) continue;
          announced.add(item.label);
          if (item.done) settled.add(item.label);
        }
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
          sessionStep: 0,
        });
      }
    } else {
      details.set(t.id, {
        thread: t,
        messages: [],
        workLog: [],
        workflow: null,
        usage: t.sessionId
          ? {
              model: "claude-opus-4",
              inputTokens: 1200,
              outputTokens: 400,
              costUsd: 0.0091,
              turns: 1,
            }
          : null,
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

  const isSimulate = (thread: ThreadInfo) => thread.provider === "simulate";

  const tickRun = (threadId: string) => {
    const detail = details.get(threadId);
    if (!detail) {
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
        sessionStep: 0,
      };
      runStates.set(threadId, run);
    }

    const t = now();
    let thread: ThreadInfo = {
      ...detail.thread,
      updatedAt: t,
    };
    let complete = false;

    if (isSimulate(thread) && detail.workflow && !detail.workflow.complete) {
      const advanced = advanceWorkflow(detail.workflow);
      detail.workflow = advanced;
      syncWorkLogForWorkflow(detail, run, t);
      streamAssistant(detail, run, t);
      if (advanced.complete) {
        complete = true;
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
        bumpUsage(detail, {
          inputTokens: 900,
          outputTokens: 400,
          costUsd: 0,
          turns: 1,
          model: "simulate-multiagent",
        });
      }
    } else if (!isSimulate(thread)) {
      complete = tickSessionRun(detail, run, t);
    } else {
      complete = true;
    }

    if (complete) {
      thread = { ...thread, status: "done", updatedAt: t };
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
          provider: "claude",
          sessionId: null,
          permissionMode: "default",
          worktreePath: null,
        };
        threads = [t, ...threads];
        details.set(t.id, {
          thread: t,
          messages: [],
          workLog: [],
          workflow: null,
          usage: null,
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
      async setPermissionMode(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        const thread: ThreadInfo = {
          ...detail.thread,
          permissionMode: input.mode,
          updatedAt: now(),
        };
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
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
          sessionStep: 0,
        };
        runStates.set(input.threadId, run);

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

        // Persist a session id after the first turn so follow-ups resume.
        if (!thread.sessionId) {
          thread = { ...thread, sessionId: id("sess") };
        }

        thread = {
          ...thread,
          status: "working",
          updatedAt: t,
        };
        detail.thread = thread;

        if (isSimulate(thread)) {
          detail.workflow = createFreshWorkflow();
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
        } else {
          detail.workflow = null;
          // First session tick immediately so the UI isn't empty for 700ms.
          tickSessionRun(detail, run, t + 1);
        }

        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        startRunTimer(input.threadId);
        return { runId };
      },
      async stop(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);

        clearRunTimer(input.threadId);

        const t = now();
        const run = runStates.get(input.threadId);
        // Mark any in-flight tools done so cards settle.
        for (const m of detail.messages) {
          if (m.role === "tool" && m.tool && !m.tool.done && m.runId === run?.runId) {
            m.tool.done = true;
            m.tool.isError = true;
            m.tool.output = m.tool.output ?? "Stopped";
          }
        }
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
      async setupWorktree(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);

        await new Promise((r) => setTimeout(r, WORKTREE_DELAY_MS));

        const short =
          detail.thread.branch?.replace(/^.*\//, "") ||
          detail.thread.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 24) ||
          "local-run";
        const branch = detail.thread.branch ?? `feat/${short}`;
        const project = projects.find((p) => p.id === detail.thread.projectId);
        const worktreePath = `${project?.path ?? "/Users/demo/project"}/.coder/worktrees/${short}`;

        const thread: ThreadInfo = {
          ...detail.thread,
          branch,
          worktreePath,
          updatedAt: now(),
        };
        detail.thread = thread;
        details.set(input.threadId, detail);
        syncThreadRow(thread);
        emitDetail(detail);
        return { ...thread };
      },
      async diff(input) {
        const detail = details.get(input.threadId);
        if (!detail) throw new Error(`Thread not found: ${input.threadId}`);
        // Empty when brand-new idle thread with no messages.
        if (detail.messages.length === 0 && detail.thread.status === "idle") {
          return { files: [], patch: "", truncated: false };
        }
        return fakeDiff(detail.thread);
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
