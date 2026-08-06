"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const services = require("./services.js");
const { runAgent, parseAgentCommand } = require("./agent.js");
const {
  runClaude,
  truncate,
  toolSummary,
  flattenContent,
  INPUT_TRUNCATE,
  OUTPUT_TRUNCATE,
} = require("./claude.js");
const codexParse = require("./codex.js");
const { runCodex } = codexParse;
const kimiParse = require("./kimi.js");
const { runKimi } = kimiParse;
const {
  getProvider,
  resolveBin,
  isBinAvailable,
} = require("./providers.js");
const { getClaudeMcpArgs } = require("./memory-sup.js");
const workflowEngine = require("./workflow.js");

const KIMI_PUSH_THROTTLE_MS = 250;

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
 * Kept for generic agent path internal tracking; contract says workflow
 * is only for simulate, so pushDetail passes null for real providers.
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
 * Resolve which provider handles this startRun.
 * Env overrides win for tests/smoke: CODER_SIMULATE, CODER_AGENT_CMD.
 * @param {object} thread
 */
function resolveProvider(thread) {
  if (process.env.CODER_SIMULATE === "1") return "simulate";
  if (process.env.CODER_AGENT_CMD) return "generic";
  const p = thread && thread.provider;
  if (p === "generic" || p === "simulate") return p;
  if (p && getProvider(p)) return p;
  return "claude";
}

/**
 * Ensure the provider CLI binary is available; throw a clear Error if not.
 * @param {import('./providers').ProviderEntry} entry
 */
function assertProviderBinary(entry) {
  if (!entry || entry.kind === "simulate") return;
  const bin = resolveBin(entry);
  if (!isBinAvailable(bin)) {
    throw new Error(
      `Provider binary not found: ${bin}. Install it or set ${entry.binEnv || "the provider binary env var"}.`,
    );
  }
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

  /** Last known workflow (core Workflow or real state) per thread. */
  /** @type {Map<string, object>} */
  const lastWorkflowByThread = new Map();

  function pushDetail(threadId, workflow) {
    // Deleted threads must not resurrect via late agent/sim pushes.
    if (threadId == null || !store.getThread(threadId)) {
      return null;
    }
    if (workflow) {
      lastWorkflowByThread.set(threadId, workflow);
    }
    let view = null;
    if (workflow) {
      if (workflow.__orchestrated) {
        // Real multi-phase workflow: already a WorkflowView shape.
        view = workflowEngine.toPublicView(workflow);
      } else if (workflow.__real) {
        // Contract: workflow only for simulate / orchestrated
        view = null;
      } else if (workflow.__claude || workflow.__codex || workflow.__kimi) {
        view = null;
      } else {
        view = mapWorkflowView(workflow, core);
      }
    }
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
   * @param {object | null} [tool]
   */
  function appendMessage(threadId, role, text, runId = null, tool = null) {
    /** @type {{ id: string, role: string, text: string, createdAt: number, runId?: string, tool?: object }} */
    const msg = {
      id: randomUUID(),
      role,
      text,
      createdAt: Date.now(),
    };
    if (runId) msg.runId = runId;
    if (tool) msg.tool = tool;
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
    store.updateThread(
      threadId,
      { status: "done", runStartedAt: null },
      { touch: true },
    );
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
          store.updateThread(
            threadId,
            { status: "failed", runStartedAt: null },
            { touch: true },
          );
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
        store.updateThread(
          threadId,
          { status: "failed", runStartedAt: null },
          { touch: true },
        );
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

    return { runId };
  }

  /**
   * Start a real generic agent child-process run (CODER_AGENT_CMD).
   */
  function startGenericRun(threadId, prompt, runId, name) {
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

    const cwd = thread.worktreePath || project.path;

    const entry = {
      kind: "generic",
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
      cwd,
      onChunk: (text) => {
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
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "generic") return;

        clearRun(threadId);

        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);

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
          store.updateThread(
            threadId,
            { status: "done", runStartedAt: null },
            { touch: true },
          );
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
        store.updateThread(
          threadId,
          { status: "failed", runStartedAt: null },
          { touch: true },
        );
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
      },
      onError: (err) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "generic") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);
        realState.agentStatus = "failed";
        const msg = err && err.message ? err.message : String(err);
        appendMessage(threadId, "event", `Run error: ${msg}`, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.updateThread(
          threadId,
          { status: "failed", runStartedAt: null },
          { touch: true },
        );
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
      },
    });

    entry.handle = handle;
    completeWorkLogStep(threadId, startingId);
    store.save();
    pushDetail(threadId, realState);

    return { runId };
  }

  /**
   * Start a Claude Code stream-json session turn.
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} [providerEntry]
   */
  function startClaudeRun(threadId, prompt, runId, providerEntry) {
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    const entryDef = providerEntry || getProvider("claude");
    assertProviderBinary(entryDef);

    const claudeState = {
      __claude: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, claudeState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** @type {string} */
    let assistantText = "";
    /** tool_use id -> message id */
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    /** @type {string | null} */
    let capturedModel = null;
    /** @type {string | null} */
    let capturedSessionId = thread.sessionId || null;
    let sawResult = false;

    const cwd = thread.worktreePath || project.path;
    const binary = resolveBin(entryDef);
    const args = entryDef.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
    });
    // Inject coder-memory MCP before the trailing prompt when healthy.
    const mcpArgs = getClaudeMcpArgs();
    if (mcpArgs.length > 0 && args.length > 0) {
      args.splice(args.length - 1, 0, ...mcpArgs);
    } else if (mcpArgs.length > 0) {
      args.push(...mcpArgs);
    }

    const entry = {
      kind: "claude",
      runId,
      stopping: false,
      handle: null,
      startingId,
      workingId,
      claudeState,
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return claudeState;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "claude") return null;
      return e;
    }

    const handle = runClaude({
      binary,
      args,
      prompt,
      cwd,
      permissionMode: thread.permissionMode || "default",
      sessionId: thread.sessionId || null,
      model: thread.model || null,
      onEvent: (ev) => {
        if (!guard()) return;

        const type = ev && ev.type;

        if (type === "system" && ev.subtype === "init") {
          if (typeof ev.session_id === "string" && ev.session_id) {
            capturedSessionId = ev.session_id;
            store.updateThread(threadId, { sessionId: ev.session_id });
          }
          if (typeof ev.model === "string" && ev.model) {
            capturedModel = ev.model;
          }
          completeWorkLogStep(threadId, startingId);
          store.save();
          pushDetail(threadId, claudeState);
          pushThreadsChanged();
          return;
        }

        if (type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
          for (const block of ev.message.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type === "text" && typeof block.text === "string") {
              assistantText += block.text;
              if (!assistantMsgId) {
                assistantMsgId = appendMessage(
                  threadId,
                  "assistant",
                  assistantText,
                  runId,
                );
              } else {
                store.updateMessage(threadId, assistantMsgId, {
                  text: assistantText,
                });
              }
            } else if (block.type === "tool_use") {
              const toolId = String(block.id || randomUUID());
              const toolName = String(block.name || "tool");
              const inputObj = block.input != null ? block.input : {};
              let inputStr;
              try {
                inputStr = truncate(
                  JSON.stringify(inputObj, null, 2),
                  INPUT_TRUNCATE,
                );
              } catch {
                inputStr = truncate(String(inputObj), INPUT_TRUNCATE);
              }
              const summary = toolSummary(toolName, inputObj);
              const tool = {
                id: toolId,
                name: toolName,
                input: inputStr,
                output: null,
                isError: false,
                done: false,
              };
              const msgId = appendMessage(
                threadId,
                "tool",
                summary,
                runId,
                tool,
              );
              toolMsgById.set(toolId, msgId);
            }
          }
          store.save();
          pushDetail(threadId, claudeState);
          return;
        }

        if (type === "user" && ev.message && Array.isArray(ev.message.content)) {
          for (const block of ev.message.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type !== "tool_result") continue;
            const toolUseId = String(block.tool_use_id || "");
            const msgId = toolMsgById.get(toolUseId);
            if (!msgId) {
              // Fall back: search messages for matching tool.id
              const found = store
                .getMessages(threadId)
                .find(
                  (m) =>
                    m.role === "tool" &&
                    m.tool &&
                    m.tool.id === toolUseId,
                );
              if (!found) continue;
              const output = truncate(
                flattenContent(block.content),
                OUTPUT_TRUNCATE,
              );
              store.updateMessage(threadId, found.id, {
                tool: {
                  ...found.tool,
                  output,
                  isError: Boolean(block.is_error),
                  done: true,
                },
              });
              continue;
            }
            const existing = store
              .getMessages(threadId)
              .find((m) => m.id === msgId);
            if (!existing || !existing.tool) continue;
            const output = truncate(
              flattenContent(block.content),
              OUTPUT_TRUNCATE,
            );
            store.updateMessage(threadId, msgId, {
              tool: {
                ...existing.tool,
                output,
                isError: Boolean(block.is_error),
                done: true,
              },
            });
          }
          store.save();
          pushDetail(threadId, claudeState);
          return;
        }

        if (type === "result") {
          sawResult = true;
          if (!guard()) return;

          completeWorkLogStep(threadId, startingId);
          completeWorkLogStep(threadId, workingId);

          if (typeof ev.session_id === "string" && ev.session_id) {
            capturedSessionId = ev.session_id;
          }
          if (capturedSessionId) {
            store.updateThread(threadId, { sessionId: capturedSessionId });
          }

          // Accumulate usage
          const prev = store.getUsage(threadId) || {
            model: null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            turns: 0,
          };
          const usage = ev.usage || {};
          const inputTokens =
            prev.inputTokens + (Number(usage.input_tokens) || 0);
          const outputTokens =
            prev.outputTokens + (Number(usage.output_tokens) || 0);
          const costUsd =
            prev.costUsd + (Number(ev.total_cost_usd) || 0);
          const model =
            capturedModel || prev.model || null;
          store.setUsage(threadId, {
            model,
            inputTokens,
            outputTokens,
            costUsd,
            turns: prev.turns + 1,
          });

          // Assistant text from stream, or fall back to result field
          if (!assistantText && typeof ev.result === "string" && ev.result) {
            assistantText = ev.result;
            if (!assistantMsgId) {
              assistantMsgId = appendMessage(
                threadId,
                "assistant",
                assistantText,
                runId,
              );
            } else {
              store.updateMessage(threadId, assistantMsgId, {
                text: assistantText,
              });
            }
          }

          const ok = ev.subtype === "success";
          store.updateThread(
            threadId,
            {
              status: ok ? "done" : "failed",
              sessionId: capturedSessionId,
              runStartedAt: null,
            },
            { touch: true },
          );

          if (!ok) {
            appendMessage(
              threadId,
              "event",
              `Run error: result subtype ${ev.subtype || "unknown"}`,
              runId,
            );
            appendDoneWorkLog(threadId, runId, "Run error");
          }

          store.save();
          // Free the thread slot immediately so the next turn can start;
          // onExit will no-op via the runId identity guard.
          clearRun(threadId);
          pushDetail(threadId, claudeState);
          pushThreadsChanged();
          return;
        }
      },
      onExit: ({ code, stderr, gotResult }) => {
        const e = active.get(threadId);
        // Result already cleared this run, or a newer run owns the slot.
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "claude") return;

        clearRun(threadId);

        // If we already handled a result event, finalize work-log and exit.
        if (sawResult || gotResult) {
          completeWorkLogStep(threadId, e.startingId);
          completeWorkLogStep(threadId, e.workingId);
          store.save();
          pushDetail(threadId, claudeState);
          pushThreadsChanged();
          return;
        }

        // Nonzero (or any) exit without result: failed
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        const stderrTail = String(stderr || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        const errText = stderrTail
          ? `Run error (exit ${code == null ? "?" : code}):\n${stderrTail}`
          : `Run error (exit ${code == null ? "?" : code})`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.updateThread(
          threadId,
          { status: "failed", runStartedAt: null },
          { touch: true },
        );
        store.save();
        pushDetail(threadId, claudeState);
        pushThreadsChanged();
      },
      onError: (err) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "claude") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        appendMessage(threadId, "event", `Run error: ${msg}`, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.updateThread(
          threadId,
          { status: "failed", runStartedAt: null },
          { touch: true },
        );
        store.save();
        pushDetail(threadId, claudeState);
        pushThreadsChanged();
      },
    });

    entry.handle = handle;
    store.save();
    pushDetail(threadId, claudeState);

    return { runId };
  }

  /**
   * Start a Codex JSONL session turn.
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} providerEntry
   */
  function startCodexRun(threadId, prompt, runId, providerEntry) {
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    assertProviderBinary(providerEntry);

    const codexState = {
      __codex: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, codexState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** @type {string} */
    let assistantText = "";
    /** command item id -> message id */
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    /** @type {string | null} */
    let capturedSessionId = thread.sessionId || null;
    let sawTerminalUsage = false;
    let finishedFromStream = false;

    const cwd = thread.worktreePath || project.path;
    const binary = resolveBin(providerEntry);
    const args = providerEntry.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
    });

    const entry = {
      kind: "codex",
      runId,
      stopping: false,
      handle: null,
      startingId,
      workingId,
      codexState,
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return codexState;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "codex") return null;
      return e;
    }

    function ensureAssistant(text) {
      if (!assistantMsgId) {
        assistantMsgId = appendMessage(threadId, "assistant", text, runId);
      } else {
        store.updateMessage(threadId, assistantMsgId, { text });
      }
    }

    function applyUsage(usageInfo) {
      if (!usageInfo) return;
      const prev = store.getUsage(threadId) || {
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: 0,
      };
      store.setUsage(threadId, {
        model: usageInfo.model || prev.model || thread.model || null,
        inputTokens: prev.inputTokens + (usageInfo.inputTokens || 0),
        outputTokens: prev.outputTokens + (usageInfo.outputTokens || 0),
        costUsd: prev.costUsd + 0,
        turns: prev.turns + 1,
      });
      sawTerminalUsage = true;
    }

    const handle = runCodex({
      binary,
      args,
      cwd,
      onEvent: (ev) => {
        if (!guard()) return;

        // Session / thread id
        if (
          codexParse.isSessionStartEvent(ev) ||
          codexParse.extractSessionId(ev)
        ) {
          const sid = codexParse.extractSessionId(ev);
          if (sid) {
            capturedSessionId = sid;
            store.updateThread(threadId, { sessionId: sid });
            completeWorkLogStep(threadId, startingId);
            store.save();
            pushDetail(threadId, codexState);
            pushThreadsChanged();
          }
        }

        // Agent message growth (replace with latest full text when item.completed,
        // append deltas when msg carries delta only).
        const agentText = codexParse.extractAgentMessageText(ev);
        if (agentText != null) {
          const type = String(ev.type || "");
          const isDelta =
            (ev.msg &&
              typeof ev.msg === "object" &&
              /delta/i.test(String(ev.msg.type || ""))) ||
            /delta/i.test(type);
          if (isDelta) {
            assistantText += agentText;
          } else if (
            type === "item.completed" ||
            type === "item_completed" ||
            (ev.item && ev.item.type === "agent_message")
          ) {
            // Full message on completed item
            assistantText = agentText;
          } else if (!assistantText) {
            assistantText = agentText;
          } else if (!assistantText.endsWith(agentText)) {
            assistantText += agentText;
          }
          ensureAssistant(assistantText);
          store.save();
          pushDetail(threadId, codexState);
        }

        // Command execution -> tool messages
        const cmd = codexParse.extractCommandItem(ev);
        if (cmd) {
          if (cmd.phase === "started") {
            const tool = {
              id: cmd.id,
              name: "Command",
              input: truncate(cmd.command, INPUT_TRUNCATE),
              output: null,
              isError: false,
              done: false,
            };
            const summary = cmd.command
              ? `Command: ${cmd.command.length > 80 ? `${cmd.command.slice(0, 80)}…` : cmd.command}`
              : "Command";
            const msgId = appendMessage(
              threadId,
              "tool",
              summary,
              runId,
              tool,
            );
            toolMsgById.set(cmd.id, msgId);
          } else if (cmd.phase === "completed") {
            let msgId = toolMsgById.get(cmd.id);
            if (!msgId) {
              const tool = {
                id: cmd.id,
                name: "Command",
                input: truncate(cmd.command, INPUT_TRUNCATE),
                output: null,
                isError: false,
                done: false,
              };
              const summary = cmd.command
                ? `Command: ${cmd.command.length > 80 ? `${cmd.command.slice(0, 80)}…` : cmd.command}`
                : "Command";
              msgId = appendMessage(threadId, "tool", summary, runId, tool);
              toolMsgById.set(cmd.id, msgId);
            }
            const existing = store
              .getMessages(threadId)
              .find((m) => m.id === msgId);
            if (existing && existing.tool) {
              const isError =
                cmd.exitCode != null && Number(cmd.exitCode) !== 0;
              store.updateMessage(threadId, msgId, {
                tool: {
                  ...existing.tool,
                  input: truncate(
                    cmd.command || existing.tool.input,
                    INPUT_TRUNCATE,
                  ),
                  output: truncate(cmd.output || "", OUTPUT_TRUNCATE),
                  isError,
                  done: true,
                },
              });
            }
          }
          store.save();
          pushDetail(threadId, codexState);
        }

        // Usage
        const usageInfo = codexParse.extractUsage(ev);
        if (usageInfo) {
          applyUsage(usageInfo);
          store.save();
          pushDetail(threadId, codexState);
        }
      },
      onExit: ({ code, stderr }) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "codex") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        if (capturedSessionId) {
          store.updateThread(threadId, { sessionId: capturedSessionId });
        }

        // If we never saw usage, still count a turn with zero tokens when ok
        if (!sawTerminalUsage && code === 0) {
          applyUsage({ inputTokens: 0, outputTokens: 0, model: thread.model });
        }

        if (code === 0) {
          store.updateThread(
            threadId,
            {
              status: "done",
              sessionId: capturedSessionId,
              runStartedAt: null,
            },
            { touch: true },
          );
          store.save();
          pushDetail(threadId, codexState);
          pushThreadsChanged();
          finishedFromStream = true;
          return;
        }

        const stderrTail = String(stderr || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        const errText = stderrTail
          ? `Run error (exit ${code == null ? "?" : code}):\n${stderrTail}`
          : `Run error (exit ${code == null ? "?" : code})`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.updateThread(
          threadId,
          { status: "failed", runStartedAt: null },
          { touch: true },
        );
        store.save();
        pushDetail(threadId, codexState);
        pushThreadsChanged();
        void finishedFromStream;
      },
      onError: (err) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "codex") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        appendMessage(threadId, "event", `Run error: ${msg}`, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.updateThread(
          threadId,
          { status: "failed", runStartedAt: null },
          { touch: true },
        );
        store.save();
        pushDetail(threadId, codexState);
        pushThreadsChanged();
      },
    });

    entry.handle = handle;
    store.save();
    pushDetail(threadId, codexState);

    return { runId };
  }

  /**
   * Start a Kimi stream-json (with plain-text fallback) session turn.
   * After the first successful turn, sessionId is the sentinel "cwd"
   * (kimi sessions are per working directory; see providers.js).
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {import('./providers').ProviderEntry} providerEntry
   */
  function startKimiRun(threadId, prompt, runId, providerEntry) {
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    assertProviderBinary(providerEntry);

    const kimiState = {
      __kimi: true,
      runId,
    };

    const startingId = beginWorkLogStep(threadId, runId, "Starting agent");
    const workingId = beginWorkLogStep(threadId, runId, "Agent working");

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, kimiState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** @type {string} */
    let assistantText = "";
    /** @type {Map<string, string>} */
    const toolMsgById = new Map();
    let sawUsage = false;
    let lastPushAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let pushTimer = null;

    const cwd = thread.worktreePath || project.path;
    const binary = resolveBin(providerEntry);
    const args = providerEntry.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
    });

    const entry = {
      kind: "kimi",
      runId,
      stopping: false,
      handle: null,
      startingId,
      workingId,
      kimiState,
    };
    Object.defineProperty(entry, "workflow", {
      get() {
        return kimiState;
      },
      enumerable: true,
    });
    active.set(threadId, entry);

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "kimi") return null;
      return e;
    }

    function flushPush() {
      pushTimer = null;
      lastPushAt = Date.now();
      if (!guard()) return;
      store.save();
      pushDetail(threadId, kimiState);
    }

    function throttledPush() {
      const now = Date.now();
      const elapsed = now - lastPushAt;
      if (elapsed >= KIMI_PUSH_THROTTLE_MS) {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        flushPush();
        return;
      }
      if (!pushTimer) {
        pushTimer = setTimeout(flushPush, KIMI_PUSH_THROTTLE_MS - elapsed);
      }
    }

    function ensureAssistant(text) {
      if (!assistantMsgId) {
        assistantMsgId = appendMessage(threadId, "assistant", text, runId);
      } else {
        store.updateMessage(threadId, assistantMsgId, { text });
      }
    }

    function applyUsage(usageInfo) {
      if (!usageInfo) return;
      const prev = store.getUsage(threadId) || {
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: 0,
      };
      store.setUsage(threadId, {
        model: prev.model || thread.model || null,
        inputTokens: prev.inputTokens + (usageInfo.inputTokens || 0),
        outputTokens: prev.outputTokens + (usageInfo.outputTokens || 0),
        costUsd: prev.costUsd + 0,
        turns: prev.turns + 1,
      });
      sawUsage = true;
    }

    completeWorkLogStep(threadId, startingId);

    const handle = runKimi({
      binary,
      args,
      cwd,
      onEvent: (ev) => {
        if (!guard()) return;

        const text = kimiParse.extractAssistantText(ev);
        if (text != null) {
          assistantText += text;
          ensureAssistant(assistantText);
          throttledPush();
        }

        const tool = kimiParse.extractToolEvent(ev);
        if (tool) {
          if (tool.phase === "start") {
            const toolMeta = {
              id: tool.id,
              name: tool.name,
              input: tool.input,
              output: null,
              isError: false,
              done: false,
            };
            const summary = tool.input
              ? `${tool.name}: ${tool.input.length > 80 ? `${tool.input.slice(0, 80)}…` : tool.input}`
              : tool.name;
            const msgId = appendMessage(
              threadId,
              "tool",
              summary,
              runId,
              toolMeta,
            );
            toolMsgById.set(tool.id, msgId);
          } else if (tool.phase === "end") {
            let msgId = toolMsgById.get(tool.id);
            if (!msgId) {
              const toolMeta = {
                id: tool.id,
                name: tool.name,
                input: tool.input,
                output: null,
                isError: false,
                done: false,
              };
              msgId = appendMessage(
                threadId,
                "tool",
                tool.name,
                runId,
                toolMeta,
              );
              toolMsgById.set(tool.id, msgId);
            }
            const existing = store
              .getMessages(threadId)
              .find((m) => m.id === msgId);
            if (existing && existing.tool) {
              store.updateMessage(threadId, msgId, {
                tool: {
                  ...existing.tool,
                  input: tool.input || existing.tool.input,
                  output: tool.output,
                  isError: tool.isError,
                  done: true,
                },
              });
            }
          } else {
            // single fire-and-complete
            const toolMeta = {
              id: tool.id,
              name: tool.name,
              input: tool.input,
              output: tool.output,
              isError: tool.isError,
              done: true,
            };
            appendMessage(threadId, "tool", tool.name, runId, toolMeta);
          }
          throttledPush();
        }

        const usageInfo = kimiParse.extractUsage(ev);
        if (usageInfo) {
          applyUsage(usageInfo);
          throttledPush();
        }
      },
      onExit: ({ code, stderr, fullStdout, gotJson }) => {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "kimi") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);

        // Hard fallback: no parsable JSON -> entire stdout as plain text.
        if (!gotJson && fullStdout && fullStdout.length > 0) {
          assistantText = fullStdout.replace(/\s+$/, "");
          ensureAssistant(assistantText);
        }

        if (!sawUsage && code === 0) {
          applyUsage({ inputTokens: 0, outputTokens: 0 });
        }

        if (code === 0) {
          // Kimi sessions are per cwd; sentinel "cwd" drives -c on later turns.
          store.updateThread(
            threadId,
            {
              status: "done",
              sessionId: "cwd",
              runStartedAt: null,
            },
            { touch: true },
          );
          store.save();
          pushDetail(threadId, kimiState);
          pushThreadsChanged();
          return;
        }

        const stderrTail = String(stderr || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        const errText = stderrTail
          ? `Run error (exit ${code == null ? "?" : code}):\n${stderrTail}`
          : `Run error (exit ${code == null ? "?" : code})`;
        appendMessage(threadId, "event", errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.updateThread(
          threadId,
          { status: "failed", runStartedAt: null },
          { touch: true },
        );
        store.save();
        pushDetail(threadId, kimiState);
        pushThreadsChanged();
      },
      onError: (err) => {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "kimi") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.workingId);
        const msg = err && err.message ? err.message : String(err);
        appendMessage(threadId, "event", `Run error: ${msg}`, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.updateThread(
          threadId,
          { status: "failed", runStartedAt: null },
          { touch: true },
        );
        store.save();
        pushDetail(threadId, kimiState);
        pushThreadsChanged();
      },
    });

    entry.handle = handle;
    store.save();
    pushDetail(threadId, kimiState);

    return { runId };
  }

  /**
   * Start a text-provider run (grok / opencode) via agent.js.
   * @param {string} threadId
   * @param {string} prompt
   * @param {string} runId
   * @param {string} name
   * @param {import('./providers').ProviderEntry} providerEntry
   */
  function startTextProviderRun(threadId, prompt, runId, name, providerEntry) {
    const thread = store.getThread(threadId);
    const project = store.getProject(thread.projectId);
    if (!project) {
      throw new Error(`Unknown project for thread: ${threadId}`);
    }

    assertProviderBinary(providerEntry);

    const binary = resolveBin(providerEntry);
    const args = providerEntry.buildArgs({
      prompt,
      sessionId: thread.sessionId || null,
      permissionMode: thread.permissionMode || "default",
      model: thread.model || null,
    });
    const model = path.basename(binary);

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
    const cwd = thread.worktreePath || project.path;

    const entry = {
      kind: "text",
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
      command: binary,
      args,
      prompt,
      appendPrompt: false,
      cwd,
      onChunk: (text) => {
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
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "text") return;

        clearRun(threadId);

        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);

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

        // Best-effort usage: ceil(chars/4), cost 0
        const tokens = Math.ceil((realState.charCount || 0) / 4);
        const prev = store.getUsage(threadId) || {
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          turns: 0,
        };
        store.setUsage(threadId, {
          model: prev.model || model,
          inputTokens: prev.inputTokens,
          outputTokens: prev.outputTokens + tokens,
          costUsd: prev.costUsd,
          turns: prev.turns + 1,
        });

        if (exitCode === 0) {
          realState.agentStatus = "settled";
          store.updateThread(
            threadId,
            { status: "done", runStartedAt: null },
            { touch: true },
          );
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
        store.updateThread(
          threadId,
          { status: "failed", runStartedAt: null },
          { touch: true },
        );
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
      },
      onError: (err) => {
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "text") return;

        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);
        realState.agentStatus = "failed";
        const msg = err && err.message ? err.message : String(err);
        appendMessage(threadId, "event", `Run error: ${msg}`, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.updateThread(
          threadId,
          { status: "failed", runStartedAt: null },
          { touch: true },
        );
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
      },
    });

    entry.handle = handle;
    completeWorkLogStep(threadId, startingId);
    store.save();
    pushDetail(threadId, realState);

    return { runId };
  }

  /**
   * @param {{ threadId: string, prompt: string }} input
   * @returns {Promise<{ runId: string }>}
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

    const provider = resolveProvider(thread);
    // Fail before mutating thread state when the CLI is missing.
    if (provider !== "simulate" && provider !== "generic") {
      const entryDef = getProvider(provider) || getProvider("claude");
      assertProviderBinary(entryDef);
    }

    const runId = randomUUID();
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

    const name = workflowNameFromThreadId(threadId);

    if (provider === "simulate") {
      return startSimulatedRun(threadId, prompt, runId, name);
    }
    if (provider === "generic") {
      return startGenericRun(threadId, prompt, runId, name);
    }

    const entryDef = getProvider(provider) || getProvider("claude");
    if (entryDef.kind === "claude-stream") {
      return startClaudeRun(threadId, prompt, runId, entryDef);
    }
    if (entryDef.kind === "codex-json") {
      return startCodexRun(threadId, prompt, runId, entryDef);
    }
    if (entryDef.kind === "kimi-stream") {
      return startKimiRun(threadId, prompt, runId, entryDef);
    }
    if (entryDef.kind === "text") {
      return startTextProviderRun(threadId, prompt, runId, name, entryDef);
    }
    return startClaudeRun(threadId, prompt, runId, getProvider("claude"));
  }

  /**
   * Orchestrated multi-phase Build workflow from a user-defined template.
   * @param {{ threadId: string, prompt: string, templateId?: string }} input
   * @returns {Promise<{ runId: string }>}
   */
  async function startWorkflowRun(input) {
    return workflowEngine.startWorkflowRun({
      threadId: input.threadId,
      prompt: input.prompt,
      templateId: input.templateId,
      store,
      core,
      pushFn,
      active,
      clearRun,
      pushDetail,
      pushThreadsChanged,
      beginWorkLogStep,
      completeWorkLogStep,
      appendDoneWorkLog,
      appendMessage,
    });
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

    if (entry.kind === "workflow") {
      workflowEngine.stopWorkflowEntry(entry);
    } else if (
      (entry.kind === "generic" ||
        entry.kind === "claude" ||
        entry.kind === "codex" ||
        entry.kind === "kimi" ||
        entry.kind === "text" ||
        entry.kind === "real") &&
      entry.handle
    ) {
      try {
        entry.handle.kill();
      } catch {
        // ignore
      }
    }

    // Complete any open work-log steps for this run.
    if (
      entry.kind === "generic" ||
      entry.kind === "real" ||
      entry.kind === "text"
    ) {
      completeWorkLogStep(threadId, entry.startingId);
      completeWorkLogStep(threadId, entry.respondingId);
    } else if (
      entry.kind === "claude" ||
      entry.kind === "codex" ||
      entry.kind === "kimi"
    ) {
      completeWorkLogStep(threadId, entry.startingId);
      completeWorkLogStep(threadId, entry.workingId);
    } else if (
      (entry.kind === "sim" || entry.kind === "workflow") &&
      entry.phaseItemIds
    ) {
      for (const id of entry.phaseItemIds.values()) {
        completeWorkLogStep(threadId, id);
      }
    }

    clearRun(threadId);
    appendMessage(threadId, "event", "Run stopped", runId);
    appendDoneWorkLog(threadId, runId, "Run stopped");
    store.updateThread(
      threadId,
      { status: "idle", runStartedAt: null },
      { touch: true },
    );
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
      if (entry && entry.kind === "workflow") {
        workflowEngine.stopWorkflowEntry(entry);
      } else if (
        entry &&
        (entry.kind === "generic" ||
          entry.kind === "claude" ||
          entry.kind === "codex" ||
          entry.kind === "kimi" ||
          entry.kind === "text" ||
          entry.kind === "real") &&
        entry.handle
      ) {
        entry.stopping = true;
        try {
          entry.handle.kill();
        } catch {
          // ignore
        }
      }
      clearRun(threadId);
      // App lifecycle / test teardown: clear run clock without sidebar bump.
      store.updateThread(threadId, { runStartedAt: null });
    }
  }

  function toWorkflowView(workflow) {
    if (!workflow) return null;
    if (workflow.__orchestrated) {
      return workflowEngine.toPublicView(workflow);
    }
    if (
      workflow.__real ||
      workflow.__claude ||
      workflow.__codex ||
      workflow.__kimi
    ) {
      if (workflow.__real) return buildRealWorkflowView(workflow);
      return null;
    }
    return mapWorkflowView(workflow, core);
  }

  return {
    startRun,
    startWorkflowRun,
    stopRun,
    getActiveWorkflow,
    isRunning,
    stopAll,
    workflowNameFromThreadId,
    toWorkflowView,
    resolveProvider,
  };
}

module.exports = {
  createRunner,
  workflowNameFromThreadId,
  toWorkflowView: mapWorkflowView,
  resolveProvider,
  ADJECTIVES,
  NOUNS,
};
