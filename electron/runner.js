"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const services = require("./services.js");
const { runAgent, parseAgentCommand } = require("./agent.js");

const ADJECTIVES = [
  "INTEGER",
  "COPPER",
  "SILENT",
  "RAPID",
  "CRIMSON",
  "NOBLE",
  "BRIGHT",
  "ANCIENT",
  "FROZEN",
  "GOLDEN",
  "HIDDEN",
  "VIVID",
  "QUIET",
  "STARK",
  "LUNAR",
  "SOLAR",
];

const NOUNS = [
  "SAFARI",
  "RIVER",
  "FORGE",
  "PULSE",
  "ORBIT",
  "LANTERN",
  "CIPHER",
  "MIRROR",
  "HAVEN",
  "SPARK",
  "ANCHOR",
  "NEXUS",
  "VECTOR",
  "PHOENIX",
  "COMPASS",
  "SUMMIT",
];

/**
 * Deterministic ADJECTIVE-NOUN from threadId hash.
 * @param {string} threadId
 * @returns {string}
 */
function workflowNameFromThreadId(threadId) {
  let h = 0;
  for (let i = 0; i < threadId.length; i++) {
    h = (Math.imul(31, h) + threadId.charCodeAt(i)) | 0;
  }
  const adj = ADJECTIVES[Math.abs(h) % ADJECTIVES.length];
  const noun = NOUNS[Math.abs(h >>> 8) % NOUNS.length];
  return `${adj}-${noun}`;
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
 * Map core Workflow + progress helpers to WorkflowView (ipc contract).
 * @param {object} workflow
 * @param {object} coreApi
 */
function mapWorkflowView(workflow, coreApi) {
  const progress = coreApi.workflowProgress(workflow);
  return {
    id: workflow.id,
    name: workflow.name,
    phases: workflow.phases.map((phase) => ({
      name: phase.name,
      pipelined: Boolean(phase.pipelined),
      agents: phase.agents.map((agent) => ({
        id: agent.id,
        model: agent.model,
        status: agent.status,
        tokensUsed: agent.tokensUsed,
      })),
    })),
    settled: progress.settled,
    total: progress.total,
    tokensTotal: progress.tokensTotal,
    complete: coreApi.isComplete(workflow),
  };
}

/**
 * Build a real-run WorkflowView (single phase, one agent).
 * @param {object} state
 */
function buildRealWorkflowView(state) {
  const tokensUsed = Math.ceil((state.charCount || 0) / 4);
  const agentStatus = state.agentStatus || "running";
  const settled =
    agentStatus === "settled" || agentStatus === "failed" ? 1 : 0;
  return {
    id: state.runId,
    name: state.name,
    phases: [
      {
        name: "run",
        pipelined: false,
        agents: [
          {
            id: "agent:0",
            model: state.model,
            status: agentStatus,
            tokensUsed,
          },
        ],
      },
    ],
    settled,
    total: 1,
    tokensTotal: tokensUsed,
    complete: settled === 1,
  };
}

/**
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {object} opts.core - @coder/core API
 * @param {(channel: string, payload: unknown) => void} opts.pushFn
 * @param {number} [opts.tickMs]
 * @param {typeof setInterval} [opts.setIntervalFn]
 * @param {typeof clearInterval} [opts.clearIntervalFn]
 */
function createRunner(opts) {
  const {
    store,
    core,
    pushFn,
    tickMs = 700,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = opts;

  /**
   * @type {Map<string, object>}
   */
  const active = new Map();

  /** Last known workflow (core Workflow or real WorkflowView) per thread. */
  /** @type {Map<string, object>} */
  const lastWorkflowByThread = new Map();

  function isSimulated() {
    return process.env.CODER_SIMULATE === "1";
  }

  function pushDetail(threadId, workflow) {
    if (workflow) {
      lastWorkflowByThread.set(threadId, workflow);
    }
    const view = workflow
      ? workflow.__real
        ? buildRealWorkflowView(workflow)
        : mapWorkflowView(workflow, core)
      : null;
    const detail = services.getThreadDetail(store, threadId, view);
    pushFn("thread:updated", detail);
    return detail;
  }

  function pushThreadsChanged() {
    pushFn("threads:changed", services.listThreads(store));
  }

  /**
   * Create a work-log step item (done:false). Returns its id.
   * @param {string} threadId
   * @param {string} runId
   * @param {string} label
   */
  function beginWorkLogStep(threadId, runId, label) {
    const id = randomUUID();
    store.appendWorkLog(threadId, {
      id,
      runId,
      label,
      done: false,
      timestamp: Date.now(),
    });
    return id;
  }

  /**
   * Flip an existing work-log step to done:true.
   * @param {string} threadId
   * @param {string} itemId
   */
  function completeWorkLogStep(threadId, itemId) {
    if (!itemId) return;
    store.updateWorkLogItem(threadId, itemId, { done: true });
  }

  /**
   * Append a terminal work-log item (already done).
   * @param {string} threadId
   * @param {string} runId
   * @param {string} label
   */
  function appendDoneWorkLog(threadId, runId, label) {
    store.appendWorkLog(threadId, {
      id: randomUUID(),
      runId,
      label,
      done: true,
      timestamp: Date.now(),
    });
  }

  /**
   * @param {string} threadId
   * @param {string} role
   * @param {string} text
   * @param {string | null} [runId]
   */
  function appendMessage(threadId, role, text, runId = null) {
    /** @type {{ id: string, role: string, text: string, createdAt: number, runId?: string }} */
    const msg = {
      id: randomUUID(),
      role,
      text,
      createdAt: Date.now(),
    };
    if (runId) msg.runId = runId;
    store.appendMessage(threadId, msg);
    return msg.id;
  }

  /**
   * Track phase transitions for simulated work log (one item per phase).
   * @param {string} threadId
   * @param {string} runId
   * @param {object} workflow
   * @param {Map<string, string>} phaseItemIds
   * @param {Set<string>} phaseSettled
   */
  function notePhaseEvents(threadId, runId, workflow, phaseItemIds, phaseSettled) {
    for (const phase of workflow.phases) {
      const hasRunning = phase.agents.some((a) => a.status === "running");
      const allTerminal = phase.agents.every(
        (a) => a.status === "settled" || a.status === "failed",
      );

      if (hasRunning && !phaseItemIds.has(phase.name)) {
        const id = beginWorkLogStep(
          threadId,
          runId,
          capitalize(phase.name),
        );
        phaseItemIds.set(phase.name, id);
      }

      if (
        allTerminal &&
        phase.agents.length > 0 &&
        !phaseSettled.has(phase.name)
      ) {
        phaseSettled.add(phase.name);
        completeWorkLogStep(threadId, phaseItemIds.get(phase.name));
      }
    }
  }

  function finishSuccessSim(threadId, runId, workflow) {
    const progress = core.workflowProgress(workflow);
    const phaseNames = workflow.phases.map((p) => p.name).join(", ");
    const agentCount = progress.total;
    const text = [
      `Run complete: workflow ${workflow.name}.`,
      `Phases: ${phaseNames}.`,
      `Agents: ${agentCount}.`,
      `Total tokens: ${progress.tokensTotal}.`,
    ].join(" ");

    appendMessage(threadId, "assistant", text, runId);
    store.updateThread(threadId, { status: "done" });
    store.save();
    pushDetail(threadId, workflow);
    pushThreadsChanged();
  }

  function clearRun(threadId) {
    const entry = active.get(threadId);
    if (!entry) return;
    if (entry.timer) {
      clearIntervalFn(entry.timer);
    }
    active.delete(threadId);
  }

  /**
   * Start a simulated multi-phase @coder/core ticker run.
   */
  function startSimulatedRun(threadId, prompt, runId, name) {
    const workflow = core.createWorkflow({
      id: runId,
      name,
      phases: [
        { name: "seed", agentCount: 1 },
        { name: "analyze", agentCount: 4 },
        { name: "verify", agentCount: 4, pipelined: true },
        { name: "judge", agentCount: 3 },
        { name: "synthesize", agentCount: 1 },
      ],
    });

    store.save();
    pushThreadsChanged();

    /** @type {Map<string, string>} */
    const phaseItemIds = new Map();
    const phaseSettled = new Set();

    notePhaseEvents(threadId, runId, workflow, phaseItemIds, phaseSettled);
    pushDetail(threadId, workflow);

    let current = workflow;

    const timer = setIntervalFn(() => {
      try {
        current = core.tick(current);
        notePhaseEvents(threadId, runId, current, phaseItemIds, phaseSettled);
        store.save();
        pushDetail(threadId, current);

        if (core.isComplete(current)) {
          clearRun(threadId);
          finishSuccessSim(threadId, runId, current);
          return;
        }

        if (core.isFailed(current) || core.isStuck(current)) {
          clearRun(threadId);
          store.updateThread(threadId, { status: "failed" });
          const errLabel = core.isFailed(current)
            ? "Run failed"
            : "Run stuck and cannot progress";
          appendMessage(threadId, "event", errLabel, runId);
          appendDoneWorkLog(threadId, runId, "Run error");
          store.save();
          pushDetail(threadId, current);
          pushThreadsChanged();
        }
      } catch (err) {
        clearRun(threadId);
        store.updateThread(threadId, { status: "failed" });
        appendMessage(
          threadId,
          "event",
          `Run error: ${err && err.message ? err.message : String(err)}`,
          runId,
        );
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, current);
        pushThreadsChanged();
      }
    }, tickMs);

    const entry = {
      kind: "sim",
      timer,
      runId,
      phaseItemIds,
      phaseSettled,
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return current;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

    return { workflowId: runId };
  }

  /**
   * Start a real agent child-process run.
   */
  function startRealRun(threadId, prompt, runId, name) {
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    const { command, args } = parseAgentCommand(process.env.CODER_AGENT_CMD);
    const model = path.basename(command);

    /** Mutable real-run state (also used as lastWorkflow source). */
    const realState = {
      __real: true,
      runId,
      name,
      model,
      agentStatus: "running",
      charCount: 0,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const respondingId = beginWorkLogStep(threadId, runId, "Agent responding");

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, realState);

    /** @type {string | null} */
    let assistantMsgId = null;

    const entry = {
      kind: "real",
      runId,
      stopping: false,
      handle: null,
      startingId,
      respondingId,
      realState,
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return realState;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

    const handle = runAgent({
      command,
      args,
      prompt,
      cwd: project.path,
      onChunk: (text) => {
        // Only act on THIS run. After stop+restart, active may hold a newer
        // entry for the same thread; late chunks from a killed agent must not
        // overwrite lastWorkflowByThread or push the old run's view.
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;

        realState.charCount = text.length;

        if (!assistantMsgId) {
          assistantMsgId = appendMessage(threadId, "assistant", text, runId);
        } else {
          store.updateMessage(threadId, assistantMsgId, { text });
        }

        store.save();
        pushDetail(threadId, realState);
      },
      onDone: (exitCode, fullText, stderrText) => {
        const e = active.get(threadId);
        // Stop already handled this run, or a newer run owns the thread slot.
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "real") return;

        clearRun(threadId);

        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);

        // Ensure final assistant text is stored even if no chunk arrived.
        if (fullText && fullText.length > 0) {
          if (!assistantMsgId) {
            assistantMsgId = appendMessage(
              threadId,
              "assistant",
              fullText,
              runId,
            );
          } else {
            store.updateMessage(threadId, assistantMsgId, { text: fullText });
          }
          realState.charCount = fullText.length;
        }

        if (exitCode === 0) {
          realState.agentStatus = "settled";
          store.updateThread(threadId, { status: "done" });
          store.save();
          pushDetail(threadId, realState);
          pushThreadsChanged();
          return;
        }

        realState.agentStatus = "failed";
        const stderrTail = String(stderrText || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        const errText = stderrTail
          ? `Run error (exit ${exitCode}):\n${stderrTail}`
          : `Run error (exit ${exitCode == null ? "?" : exitCode})`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.updateThread(threadId, { status: "failed" });
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
      },
      onError: (err) => {
        const e = active.get(threadId);
        // Same identity guard: spawn failure for run A must not clear run B.
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "real") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);
        realState.agentStatus = "failed";
        const msg = err && err.message ? err.message : String(err);
        appendMessage(threadId, "event", `Run error: ${msg}`, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.updateThread(threadId, { status: "failed" });
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
      },
    });

    entry.handle = handle;
    // Process spawned: mark Starting agent done (spawn returned a handle).
    completeWorkLogStep(threadId, startingId);
    store.save();
    pushDetail(threadId, realState);

    return { workflowId: runId };
  }

  /**
   * @param {{ threadId: string, prompt: string }} input
   * @returns {Promise<{ workflowId: string }>}
   */
  async function startRun(input) {
    const { threadId, prompt } = input;
    if (active.has(threadId)) {
      throw new Error("A run is already active on this thread");
    }

    const thread = store.getThread(threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
    }

    const runId = randomUUID();
    appendMessage(threadId, "user", prompt, runId);

    let title = thread.title;
    if (title === "New Thread") {
      const firstLine = String(prompt).split(/\r?\n/)[0].trim();
      title = firstLine.slice(0, 60) || "New Thread";
    }

    store.updateThread(threadId, { status: "working", title });

    const name = workflowNameFromThreadId(threadId);

    if (isSimulated()) {
      return startSimulatedRun(threadId, prompt, runId, name);
    }
    return startRealRun(threadId, prompt, runId, name);
  }

  /**
   * @param {{ threadId: string }} input
   */
  async function stopRun(input) {
    const { threadId } = input;
    if (!active.has(threadId)) {
      return;
    }

    const entry = active.get(threadId);
    const runId = entry.runId;
    const lastWorkflow =
      (entry && entry.workflow) ||
      lastWorkflowByThread.get(threadId) ||
      null;

    entry.stopping = true;

    if (entry.kind === "real" && entry.handle) {
      try {
        entry.handle.kill();
      } catch {
        // ignore
      }
    }

    // Complete any open work-log steps for this run.
    if (entry.kind === "real") {
      completeWorkLogStep(threadId, entry.startingId);
      completeWorkLogStep(threadId, entry.respondingId);
    } else if (entry.kind === "sim" && entry.phaseItemIds) {
      for (const id of entry.phaseItemIds.values()) {
        completeWorkLogStep(threadId, id);
      }
    }

    clearRun(threadId);
    appendMessage(threadId, "event", "Run stopped", runId);
    appendDoneWorkLog(threadId, runId, "Run stopped");
    store.updateThread(threadId, { status: "idle" });
    store.save();
    pushDetail(threadId, lastWorkflow);
    pushThreadsChanged();
  }

  function getActiveWorkflow(threadId) {
    const entry = active.get(threadId);
    if (entry) return entry.workflow;
    return lastWorkflowByThread.get(threadId) || null;
  }

  function isRunning(threadId) {
    return active.has(threadId);
  }

  function stopAll() {
    for (const threadId of [...active.keys()]) {
      const entry = active.get(threadId);
      if (entry && entry.kind === "real" && entry.handle) {
        entry.stopping = true;
        try {
          entry.handle.kill();
        } catch {
          // ignore
        }
      }
      clearRun(threadId);
    }
  }

  function toWorkflowView(workflow) {
    if (!workflow) return null;
    if (workflow.__real) return buildRealWorkflowView(workflow);
    return mapWorkflowView(workflow, core);
  }

  return {
    startRun,
    stopRun,
    getActiveWorkflow,
    isRunning,
    stopAll,
    workflowNameFromThreadId,
    toWorkflowView,
  };
}

module.exports = {
  createRunner,
  workflowNameFromThreadId,
  toWorkflowView: mapWorkflowView,
  ADJECTIVES,
  NOUNS,
};
