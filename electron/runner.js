"use strict";

const { randomUUID } = require("node:crypto");
const services = require("./services.js");

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
 * @param {object} core
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

  /** @type {Map<string, { timer: ReturnType<typeof setInterval>, workflow: object, phaseAnnounced: Set<string>, phaseSettled: Set<string> }>} */
  const active = new Map();

  /** Last known core Workflow per thread (survives after run completes). */
  /** @type {Map<string, object>} */
  const lastWorkflowByThread = new Map();

  function pushDetail(threadId, workflow) {
    if (workflow) {
      lastWorkflowByThread.set(threadId, workflow);
    }
    const view = workflow ? mapWorkflowView(workflow, core) : null;
    const detail = services.getThreadDetail(store, threadId, view);
    pushFn("thread:updated", detail);
    return detail;
  }

  function pushThreadsChanged() {
    pushFn("threads:changed", services.listThreads(store));
  }

  function appendWorkLog(threadId, label, done) {
    store.appendWorkLog(threadId, {
      id: randomUUID(),
      label,
      done: Boolean(done),
      timestamp: Date.now(),
    });
  }

  function appendMessage(threadId, role, text) {
    store.appendMessage(threadId, {
      id: randomUUID(),
      role,
      text,
      createdAt: Date.now(),
    });
  }

  /**
   * Track phase transitions for work log.
   * @param {string} threadId
   * @param {object} workflow
   * @param {Set<string>} phaseAnnounced
   * @param {Set<string>} phaseSettled
   */
  function notePhaseEvents(threadId, workflow, phaseAnnounced, phaseSettled) {
    for (const phase of workflow.phases) {
      const hasRunning = phase.agents.some((a) => a.status === "running");
      const allTerminal = phase.agents.every(
        (a) => a.status === "settled" || a.status === "failed",
      );

      if (hasRunning && !phaseAnnounced.has(phase.name)) {
        phaseAnnounced.add(phase.name);
        appendWorkLog(
          threadId,
          `${capitalize(phase.name)} started`,
          false,
        );
      }

      if (allTerminal && phase.agents.length > 0 && !phaseSettled.has(phase.name)) {
        phaseSettled.add(phase.name);
        // mark the "started" item conceptually complete with a settle entry
        appendWorkLog(
          threadId,
          `${capitalize(phase.name)} settled`,
          true,
        );
      }
    }
  }

  function finishSuccess(threadId, workflow) {
    const progress = core.workflowProgress(workflow);
    const phaseNames = workflow.phases.map((p) => p.name).join(", ");
    const agentCount = progress.total;
    const text = [
      `Run complete: workflow ${workflow.name}.`,
      `Phases: ${phaseNames}.`,
      `Agents: ${agentCount}.`,
      `Total tokens: ${progress.tokensTotal}.`,
    ].join(" ");

    appendMessage(threadId, "assistant", text);
    store.updateThread(threadId, { status: "done" });
    store.save();
    pushDetail(threadId, workflow);
    pushThreadsChanged();
  }

  function clearRun(threadId) {
    const entry = active.get(threadId);
    if (entry) {
      clearIntervalFn(entry.timer);
      active.delete(threadId);
    }
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

    appendMessage(threadId, "user", prompt);

    let title = thread.title;
    if (title === "New Thread") {
      const firstLine = String(prompt).split(/\r?\n/)[0].trim();
      title = firstLine.slice(0, 60) || "New Thread";
    }

    store.updateThread(threadId, { status: "working", title });

    const workflowId = randomUUID();
    const name = workflowNameFromThreadId(threadId);
    const workflow = core.createWorkflow({
      id: workflowId,
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

    const phaseAnnounced = new Set();
    const phaseSettled = new Set();

    // initial push before first tick so UI sees workflow
    notePhaseEvents(threadId, workflow, phaseAnnounced, phaseSettled);
    pushDetail(threadId, workflow);

    let current = workflow;

    const timer = setIntervalFn(() => {
      try {
        current = core.tick(current);
        notePhaseEvents(threadId, current, phaseAnnounced, phaseSettled);
        store.save();
        pushDetail(threadId, current);

        if (core.isComplete(current)) {
          clearRun(threadId);
          finishSuccess(threadId, current);
          return;
        }

        if (core.isFailed(current) || core.isStuck(current)) {
          clearRun(threadId);
          store.updateThread(threadId, { status: "failed" });
          appendMessage(
            threadId,
            "event",
            core.isFailed(current)
              ? "Run failed"
              : "Run stuck and cannot progress",
          );
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
        );
        store.save();
        // Keep open thread views in sync (status + event message), same as failed/stuck.
        pushDetail(threadId, current);
        pushThreadsChanged();
      }
    }, tickMs);

    const entry = {
      timer,
      phaseAnnounced,
      phaseSettled,
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return current;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

    return { workflowId };
  }

  /**
   * @param {{ threadId: string }} input
   */
  async function stopRun(input) {
    const { threadId } = input;
    if (!active.has(threadId)) {
      // idempotent stop when nothing running
      return;
    }

    // Capture last workflow before clearing the timer so push and
    // getActiveWorkflow / threads:get stay consistent (do not push null
    // while lastWorkflowByThread still holds the stopped run).
    const entry = active.get(threadId);
    const lastWorkflow =
      (entry && entry.workflow) ||
      lastWorkflowByThread.get(threadId) ||
      null;

    clearRun(threadId);
    appendMessage(threadId, "event", "Run stopped");
    appendWorkLog(threadId, "Run stopped", true);
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
      clearRun(threadId);
    }
  }

  return {
    startRun,
    stopRun,
    getActiveWorkflow,
    isRunning,
    stopAll,
    workflowNameFromThreadId,
    /** Map core Workflow to WorkflowView using this runner's core. */
    toWorkflowView(workflow) {
      return mapWorkflowView(workflow, core);
    },
  };
}

module.exports = {
  createRunner,
  workflowNameFromThreadId,
  toWorkflowView: mapWorkflowView,
  ADJECTIVES,
  NOUNS,
};
