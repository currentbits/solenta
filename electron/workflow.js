"use strict";

const { randomUUID } = require("node:crypto");
const { runClaude } = require("./claude.js");

const PUSH_THROTTLE_MS = 250;

/**
 * Deterministic non-negative int seed from threadId + runId.
 * @param {string} threadId
 * @param {string} runId
 */
function hashSeed(threadId, runId) {
  const s = `${threadId}${runId}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) >>> 0;
}

/**
 * Capitalize first letter for work log labels.
 * @param {string} name
 */
function capitalize(name) {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Build the initial WorkflowView for a multi-phase real run.
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.name
 * @param {string} opts.model
 */
function buildWorkflowView({ runId, name, model }) {
  const phases = [
    {
      name: "seed",
      pipelined: false,
      agents: [
        {
          id: "0:seed:0",
          model,
          status: "pending",
          tokensUsed: 0,
        },
      ],
    },
    {
      name: "analyze",
      pipelined: false,
      agents: [
        {
          id: "1:analyze:0",
          model,
          status: "pending",
          tokensUsed: 0,
        },
        {
          id: "1:analyze:1",
          model,
          status: "pending",
          tokensUsed: 0,
        },
      ],
    },
    {
      name: "synthesize",
      pipelined: false,
      agents: [
        {
          id: "2:synthesize:0",
          model,
          status: "pending",
          tokensUsed: 0,
        },
      ],
    },
  ];
  return recomputeView({
    __orchestrated: true,
    id: runId,
    name,
    phases,
  });
}

/**
 * Recompute settled/total/tokensTotal/complete from agent statuses.
 * @param {object} view
 */
function recomputeView(view) {
  let settled = 0;
  let total = 0;
  let tokensTotal = 0;
  for (const phase of view.phases) {
    for (const agent of phase.agents) {
      total += 1;
      tokensTotal += Number(agent.tokensUsed) || 0;
      if (agent.status === "settled" || agent.status === "failed") {
        settled += 1;
      }
    }
  }
  view.settled = settled;
  view.total = total;
  view.tokensTotal = tokensTotal;
  view.complete =
    total > 0 &&
    settled === total &&
    view.phases.every((p) =>
      p.agents.every((a) => a.status === "settled"),
    );
  return view;
}

/**
 * Public WorkflowView strip (no internal flags).
 * @param {object} view
 */
function toPublicView(view) {
  if (!view) return null;
  recomputeView(view);
  return {
    id: view.id,
    name: view.name,
    phases: view.phases.map((phase) => ({
      name: phase.name,
      pipelined: Boolean(phase.pipelined),
      agents: phase.agents.map((agent) => ({
        id: agent.id,
        model: agent.model,
        status: agent.status,
        tokensUsed: agent.tokensUsed,
      })),
    })),
    settled: view.settled,
    total: view.total,
    tokensTotal: view.tokensTotal,
    complete: view.complete,
  };
}

/**
 * @param {object} view
 * @param {string} agentId
 */
function findAgent(view, agentId) {
  for (const phase of view.phases) {
    for (const agent of phase.agents) {
      if (agent.id === agentId) return agent;
    }
  }
  return null;
}

/**
 * Spawn one one-shot Claude call (no --resume). Resolves with text/usage/ok.
 * @param {object} opts
 * @returns {{ handle: { kill: () => void }, done: Promise<object> }}
 */
function spawnAgentClaude(opts) {
  const {
    prompt,
    cwd,
    permissionMode,
    model,
    onText,
  } = opts;

  let text = "";
  let resultText = "";
  let usage = null;
  let finished = false;

  /** @type {(value: object) => void} */
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function finish(payload) {
    if (finished) return;
    finished = true;
    resolveDone(payload);
  }

  const handle = runClaude({
    binary: process.env.CODER_CLAUDE_BIN || "claude",
    prompt,
    cwd,
    permissionMode: permissionMode || "default",
    sessionId: null,
    model: model || null,
    onEvent: (ev) => {
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block && block.type === "text" && typeof block.text === "string") {
            text += block.text;
            if (typeof onText === "function") onText(text);
          }
        }
      }
      if (ev.type === "result") {
        const u = ev.usage || {};
        usage = {
          inputTokens: Number(u.input_tokens) || 0,
          outputTokens: Number(u.output_tokens) || 0,
          costUsd: Number(ev.total_cost_usd) || 0,
        };
        if (typeof ev.result === "string" && ev.result) {
          resultText = ev.result;
        }
      }
    },
    onExit: ({ code, stderr }) => {
      const finalText = resultText || text;
      const ok = code === 0;
      finish({
        ok,
        text: finalText,
        usage,
        code,
        stderr: String(stderr || ""),
      });
    },
    onError: (err) => {
      const msg = err && err.message ? err.message : String(err);
      finish({
        ok: false,
        text: resultText || text,
        usage,
        code: 1,
        stderr: msg,
        error: err,
      });
    },
  });

  return { handle, done };
}

/**
 * Build agent prompts for each phase role.
 * @param {object} opts
 */
function buildAgentPrompt(opts) {
  const { role, userPrompt, seedPlan, analyzeTexts } = opts;
  if (role === "seed") {
    return (
      "You are the planning agent for this task. Produce a concise plan " +
      `(max 15 lines) plus the key questions to investigate. Task: ${userPrompt}`
    );
  }
  if (role === "analyze1") {
    return (
      "You are analyze agent 1 of 2. Focus on implementation approach and concrete steps. " +
      "Answer in max 30 lines.\n\n" +
      `Plan from seed:\n${seedPlan}\n\n` +
      `Original task: ${userPrompt}`
    );
  }
  if (role === "analyze2") {
    return (
      "You are analyze agent 2 of 2. Focus on risks, edge cases, and testing. " +
      "Answer in max 30 lines.\n\n" +
      `Plan from seed:\n${seedPlan}\n\n` +
      `Original task: ${userPrompt}`
    );
  }
  // synthesize
  const a1 = (analyzeTexts && analyzeTexts[0]) || "(analyze 1 unavailable)";
  const a2 = (analyzeTexts && analyzeTexts[1]) || "(analyze 2 unavailable)";
  return (
    "Given the plan and both analyses, produce the final answer to the ORIGINAL user prompt. " +
    "The answer must be self-contained.\n\n" +
    `Original user prompt:\n${userPrompt}\n\n` +
    `Plan:\n${seedPlan}\n\n` +
    `Analysis 1 (implementation approach and concrete steps):\n${a1}\n\n` +
    `Analysis 2 (risks, edge cases, and testing):\n${a2}`
  );
}

/**
 * Start an orchestrated multi-phase workflow run.
 *
 * @param {object} deps
 * @param {string} deps.threadId
 * @param {string} deps.prompt
 * @param {import('./store').Store} deps.store
 * @param {object} deps.core - @coder/core (nameForSeed)
 * @param {(channel: string, payload: unknown) => void} deps.pushFn
 * @param {Map<string, object>} deps.active
 * @param {(threadId: string) => void} deps.clearRun
 * @param {(threadId: string, workflow: object | null) => object | null} deps.pushDetail
 * @param {() => void} deps.pushThreadsChanged
 * @param {(threadId: string, runId: string, label: string) => string} deps.beginWorkLogStep
 * @param {(threadId: string, itemId: string) => void} deps.completeWorkLogStep
 * @param {(threadId: string, runId: string, label: string) => void} deps.appendDoneWorkLog
 * @param {(threadId: string, role: string, text: string, runId?: string | null) => string} deps.appendMessage
 * @returns {Promise<{ runId: string }>}
 */
async function startWorkflowRun(deps) {
  const {
    threadId,
    prompt,
    store,
    core,
    active,
    clearRun,
    pushDetail,
    pushThreadsChanged,
    beginWorkLogStep,
    completeWorkLogStep,
    appendDoneWorkLog,
    appendMessage,
  } = deps;

  if (active.has(threadId)) {
    throw new Error("A run is already active on this thread");
  }

  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }

  if (thread.provider !== "claude") {
    throw new Error("Workflow runs currently require the Claude provider.");
  }

  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }

  const runId = randomUUID();
  const model = thread.model || "default";
  const cwd = thread.worktreePath || project.path;
  const permissionMode = thread.permissionMode || "default";
  const seed = hashSeed(threadId, runId);
  const name =
    typeof core.nameForSeed === "function"
      ? core.nameForSeed(seed)
      : `WF-${seed}`;

  appendMessage(threadId, "user", prompt, runId);

  let title = thread.title;
  if (title === "New Thread") {
    const firstLine = String(prompt).split(/\r?\n/)[0].trim();
    title = firstLine.slice(0, 60) || "New Thread";
  }

  store.updateThread(
    threadId,
    { status: "working", title, runStartedAt: Date.now() },
    { touch: true },
  );

  const view = buildWorkflowView({ runId, name, model });

  const kickoffText = [
    "Kicked off 4 subagents",
    "seed 1: plan the task",
    "analyze 2: parallel deep dives",
    "synthesize 1: final answer",
  ].join("\n");
  appendMessage(threadId, "event", kickoffText, runId);

  /** @type {Map<string, string>} */
  const phaseItemIds = new Map();
  /** Live child handles for stopRun */
  /** @type {Map<string, { kill: () => void }>} */
  const liveHandles = new Map();
  /** Accumulated usage across agents */
  let aggInput = 0;
  let aggOutput = 0;
  let aggCost = 0;

  /** @type {{ lastPush: number, pending: boolean, timer: ReturnType<typeof setTimeout> | null }} */
  const throttle = { lastPush: 0, pending: false, timer: null };

  function flushPush() {
    throttle.lastPush = Date.now();
    throttle.pending = false;
    if (throttle.timer) {
      clearTimeout(throttle.timer);
      throttle.timer = null;
    }
    recomputeView(view);
    store.save();
    pushDetail(threadId, view);
  }

  function schedulePush(force) {
    if (force) {
      flushPush();
      return;
    }
    const now = Date.now();
    const elapsed = now - throttle.lastPush;
    if (elapsed >= PUSH_THROTTLE_MS) {
      flushPush();
      return;
    }
    if (throttle.pending) return;
    throttle.pending = true;
    throttle.timer = setTimeout(() => {
      flushPush();
    }, PUSH_THROTTLE_MS - elapsed);
  }

  function beginPhase(phaseName) {
    if (phaseItemIds.has(phaseName)) return;
    const id = beginWorkLogStep(threadId, runId, capitalize(phaseName));
    phaseItemIds.set(phaseName, id);
  }

  function completePhase(phaseName) {
    const id = phaseItemIds.get(phaseName);
    if (id) completeWorkLogStep(threadId, id);
  }

  function guard() {
    const e = active.get(threadId);
    if (!e || e.stopping || e.runId !== runId) return null;
    if (e.kind !== "workflow") return null;
    return e;
  }

  const entry = {
    kind: "workflow",
    runId,
    stopping: false,
    liveHandles,
    phaseItemIds,
    view,
    throttle,
  };
  Object.defineProperty(entry, "workflow", {
    get() {
      return view;
    },
    enumerable: true,
  });
  active.set(threadId, entry);

  store.save();
  pushThreadsChanged();
  schedulePush(true);

  // Fire-and-forget orchestration; errors handled inside.
  void runPhases().catch((err) => {
    if (!guard()) return;
    failRun(
      "workflow",
      err && err.message ? err.message : String(err),
    );
  });

  /**
   * @param {string} agentId
   * @param {string} stderrTail
   */
  function failRun(agentId, stderrTail) {
    if (!guard()) return;
    const e = active.get(threadId);
    if (e && e.throttle && e.throttle.timer) {
      clearTimeout(e.throttle.timer);
      e.throttle.timer = null;
    }
    // Mark any still-running agents failed
    for (const phase of view.phases) {
      for (const agent of phase.agents) {
        if (agent.status === "running" || agent.status === "pending") {
          agent.status = "failed";
        }
      }
    }
    for (const id of phaseItemIds.values()) {
      completeWorkLogStep(threadId, id);
    }
    const tail = String(stderrTail || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-8)
      .join("\n");
    const errText = tail
      ? `Run error (${agentId}):\n${tail}`
      : `Run error (${agentId})`;
    appendMessage(threadId, "event", errText, runId);
    appendDoneWorkLog(threadId, runId, "Run error");
    store.updateThread(
      threadId,
      { status: "failed", runStartedAt: null },
      { touch: true },
    );
    recomputeView(view);
    store.save();
    clearRun(threadId);
    pushDetail(threadId, view);
    pushThreadsChanged();
  }

  /**
   * Run one agent, updating view live. Returns result or null if stopped.
   * @param {object} spec
   */
  async function runOneAgent(spec) {
    const { agentId, role, agentPrompt } = spec;
    if (!guard()) return null;

    const agent = findAgent(view, agentId);
    if (!agent) return null;

    agent.status = "running";
    agent.tokensUsed = 0;
    schedulePush(true);

    let charCount = 0;
    const { handle, done } = spawnAgentClaude({
      prompt: agentPrompt,
      cwd,
      permissionMode,
      model: thread.model || null,
      onText: (t) => {
        if (!guard()) return;
        charCount = t.length;
        agent.tokensUsed = Math.ceil(charCount / 4) || 1;
        schedulePush(false);
      },
    });

    liveHandles.set(agentId, handle);

    const result = await done;
    liveHandles.delete(agentId);

    if (!guard()) {
      // Stopped mid-flight: leave status as-is if stop already marked failed
      if (agent.status === "running") agent.status = "failed";
      return null;
    }

    if (result.ok) {
      agent.status = "settled";
      if (result.usage) {
        agent.tokensUsed =
          (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
        aggInput += result.usage.inputTokens || 0;
        aggOutput += result.usage.outputTokens || 0;
        aggCost += result.usage.costUsd || 0;
      } else {
        agent.tokensUsed = Math.ceil((result.text || "").length / 4) || 1;
      }
    } else {
      agent.status = "failed";
      if (result.usage) {
        agent.tokensUsed =
          (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
        aggInput += result.usage.inputTokens || 0;
        aggOutput += result.usage.outputTokens || 0;
        aggCost += result.usage.costUsd || 0;
      }
    }

    schedulePush(true);
    return result;
  }

  async function runPhases() {
    // ── seed ──────────────────────────────────────────────────────────
    beginPhase("seed");
    schedulePush(true);

    const seedResult = await runOneAgent({
      agentId: "0:seed:0",
      role: "seed",
      agentPrompt: buildAgentPrompt({ role: "seed", userPrompt: prompt }),
    });
    if (!guard()) return;
    completePhase("seed");

    if (!seedResult || !seedResult.ok) {
      failRun(
        "0:seed:0",
        (seedResult && seedResult.stderr) || "seed agent failed",
      );
      return;
    }
    const seedPlan = seedResult.text || "";

    // ── analyze (concurrent) ──────────────────────────────────────────
    beginPhase("analyze");
    schedulePush(true);

    const analyzeSpecs = [
      {
        agentId: "1:analyze:0",
        role: "analyze1",
        agentPrompt: buildAgentPrompt({
          role: "analyze1",
          userPrompt: prompt,
          seedPlan,
        }),
        label: "Analyze 1",
      },
      {
        agentId: "1:analyze:1",
        role: "analyze2",
        agentPrompt: buildAgentPrompt({
          role: "analyze2",
          userPrompt: prompt,
          seedPlan,
        }),
        label: "Analyze 2",
      },
    ];

    const analyzeResults = await Promise.all(
      analyzeSpecs.map((s) =>
        runOneAgent({
          agentId: s.agentId,
          role: s.role,
          agentPrompt: s.agentPrompt,
        }).then((r) => ({ spec: s, result: r })),
      ),
    );

    if (!guard()) return;
    completePhase("analyze");

    const a0 = analyzeResults[0];
    const a1 = analyzeResults[1];
    const a0ok = a0 && a0.result && a0.result.ok;
    const a1ok = a1 && a1.result && a1.result.ok;

    if (!a0ok && !a1ok) {
      const failId =
        a0 && a0.result && !a0.result.ok
          ? a0.spec.agentId
          : a1
            ? a1.spec.agentId
            : "1:analyze:0";
      const stderr =
        (a0 && a0.result && a0.result.stderr) ||
        (a1 && a1.result && a1.result.stderr) ||
        "both analyze agents failed";
      failRun(failId, stderr);
      return;
    }

    if (!a0ok || !a1ok) {
      const failed = !a0ok ? a0 : a1;
      const label = failed.spec.label || "Analyze";
      // Human-friendly: "Analyze 2 failed, continuing"
      appendDoneWorkLog(
        threadId,
        runId,
        `${label} failed, continuing`,
      );
      schedulePush(true);
    }

    const analyzeTexts = [
      a0ok ? a0.result.text : "",
      a1ok ? a1.result.text : "",
    ];

    // ── synthesize ────────────────────────────────────────────────────
    beginPhase("synthesize");
    schedulePush(true);

    const synthResult = await runOneAgent({
      agentId: "2:synthesize:0",
      role: "synthesize",
      agentPrompt: buildAgentPrompt({
        role: "synthesize",
        userPrompt: prompt,
        seedPlan,
        analyzeTexts,
      }),
    });

    if (!guard()) return;
    completePhase("synthesize");

    if (!synthResult || !synthResult.ok) {
      failRun(
        "2:synthesize:0",
        (synthResult && synthResult.stderr) || "synthesize agent failed",
      );
      return;
    }

    // ── success ───────────────────────────────────────────────────────
    if (!guard()) return;

    appendMessage(
      threadId,
      "assistant",
      synthResult.text || "",
      runId,
    );

    const prev = store.getUsage(threadId) || {
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 0,
    };
    store.setUsage(threadId, {
      model: prev.model || thread.model || model,
      inputTokens: prev.inputTokens + aggInput,
      outputTokens: prev.outputTokens + aggOutput,
      costUsd: prev.costUsd + aggCost,
      turns: prev.turns + 1,
    });

    recomputeView(view);
    store.updateThread(
      threadId,
      { status: "done", runStartedAt: null },
      { touch: true },
    );
    store.save();
    clearRun(threadId);
    pushDetail(threadId, view);
    pushThreadsChanged();
  }

  return { runId };
}

/**
 * Stop a workflow entry: kill all live children, mark running agents failed.
 * Caller handles messages/status/clearRun.
 * @param {object} entry
 */
function stopWorkflowEntry(entry) {
  if (!entry || entry.kind !== "workflow") return;
  entry.stopping = true;
  if (entry.throttle && entry.throttle.timer) {
    clearTimeout(entry.throttle.timer);
    entry.throttle.timer = null;
  }
  if (entry.liveHandles) {
    for (const handle of entry.liveHandles.values()) {
      try {
        handle.kill();
      } catch {
        // ignore
      }
    }
    entry.liveHandles.clear();
  }
  if (entry.view) {
    for (const phase of entry.view.phases) {
      for (const agent of phase.agents) {
        if (agent.status === "running" || agent.status === "pending") {
          agent.status = "failed";
        }
      }
    }
    recomputeView(entry.view);
  }
  if (entry.phaseItemIds) {
    // caller completes work-log steps
  }
}

module.exports = {
  startWorkflowRun,
  stopWorkflowEntry,
  buildWorkflowView,
  recomputeView,
  toPublicView,
  hashSeed,
  buildAgentPrompt,
  PUSH_THROTTLE_MS,
};
