"use strict";

// createRunner seam: simulated and generic CLI runs (#1447, seam 11).
// Follows the seam convention in the header of electron/runner-watchdogs.js.

const { parseAgentCommand } = require("./agent.js");
const { normalizeProjectEnv } = require("./worktreeEnv.js");
const path = require("node:path");
const threadSecrets = require("./threadSecrets.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createGenericRun(ctx) {
  const {
    capitalize,
    shortError,
    PUSH_THROTTLE_MS,
    crossesBoundary,
    resolveSpawn,
    formatRunExitError,
    beginWorkLogStep,
    completeWorkLogStep,
    core,
    appendMessage,
    store,
    pushDetail,
    pushThreadsChanged,
    afterSuccessfulTurn,
    abortIfCancelled,
    setIntervalFn,
    clearRun,
    appendDoneWorkLog,
    afterFailedTurn,
    markRunFailed,
    tickMs,
    claimPreparingRun,
    clearIntervalFn,
    settleCancelledLaunch,
    stampPreparingSteps,
    active,
    runAgentFn,
    notifyRunTerminal,
    lastAssistantText,
  } = ctx;

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
    // Sim path does not call notifyRunTerminal; still checkpoint on success.
    afterSuccessfulTurn(threadId);
  }

  /**
   * Start a simulated multi-phase @coder/core ticker run.
   */
  function startSimulatedRun(threadId, prompt, runId, name) {
    if (abortIfCancelled(threadId, runId)) return { runId };
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
          const errLabel = core.isFailed(current)
            ? "Run failed"
            : "Run stuck and cannot progress";
          store.updateThread(
            threadId,
            {
              status: "failed",
              runStartedAt: null,
              lastError: shortError(errLabel),
            },
            { touch: true },
          );
          appendMessage(threadId, "event", errLabel, runId);
          appendDoneWorkLog(threadId, runId, "Run error");
          store.save();
          pushDetail(threadId, current);
          pushThreadsChanged();
          afterFailedTurn(threadId);
        }
      } catch (err) {
        clearRun(threadId);
        const errText = `Run error: ${err && err.message ? err.message : String(err)}`;
        markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, current);
        pushThreadsChanged();
        afterFailedTurn(threadId);
      }
    }, tickMs);

    const entry = claimPreparingRun(threadId, runId, {
      kind: "sim",
      timer,
      phaseItemIds,
      phaseSettled,
    });
    if (!entry) {
      clearIntervalFn(timer);
      settleCancelledLaunch(threadId, runId);
      return { runId };
    }
    Object.defineProperty(entry, "workflow", {
      get() {
        return current;
      },
      enumerable: true,
      configurable: true,
    });

    return { runId };
  }

  /**
   * Start a real generic agent child-process run (CODER_AGENT_CMD).
   */
  function startGenericRun(threadId, prompt, runId, name) {
    if (abortIfCancelled(threadId, runId)) return { runId };
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
    stampPreparingSteps(threadId, runId, { startingId, respondingId });

    store.save();
    pushThreadsChanged();
    pushDetail(threadId, realState);

    /** @type {string | null} */
    let assistantMsgId = null;
    /** Latest streamed text not yet written to the store. */
    let pendingText = null;
    let lastPushAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let pushTimer = null;

    const localCwd = thread.worktreePath || project.path;

    const entry = claimPreparingRun(threadId, runId, {
      kind: "generic",
      startingId,
      respondingId,
      realState,
    });
    if (!entry) {
      completeWorkLogStep(threadId, startingId);
      completeWorkLogStep(threadId, respondingId);
      settleCancelledLaunch(threadId, runId);
      return { runId };
    }
    Object.defineProperty(entry, "workflow", {
      get() {
        return realState;
      },
      enumerable: true,
      configurable: true,
    });

    function guard() {
      const e = active.get(threadId);
      if (!e || e.stopping || e.runId !== runId) return null;
      if (e.kind !== "generic") return null;
      return e;
    }

    function applyPendingText() {
      if (pendingText == null) return;
      const text = pendingText;
      pendingText = null;
      realState.charCount = text.length;
      if (!assistantMsgId) {
        assistantMsgId = appendMessage(threadId, "assistant", text, runId);
      } else {
        store.updateMessage(threadId, assistantMsgId, { text });
      }
    }

    function cancelPushTimer() {
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
      }
    }

    function flushPush() {
      pushTimer = null;
      lastPushAt = Date.now();
      applyPendingText();
      if (!guard()) return;
      store.save();
      pushDetail(threadId, realState);
    }

    function throttledPush() {
      const now = Date.now();
      const elapsed = now - lastPushAt;
      if (elapsed >= PUSH_THROTTLE_MS) {
        cancelPushTimer();
        flushPush();
        return;
      }
      if (!pushTimer) {
        pushTimer = setTimeout(flushPush, PUSH_THROTTLE_MS - elapsed);
      }
    }

    // Stop/error/clearRun must land pending text before the terminal push.
    entry.flushStream = () => {
      cancelPushTimer();
      applyPendingText();
    };

    const crossing = crossesBoundary(project);
    const spawn = crossing
      ? resolveSpawn(project, command, [...args, String(prompt ?? "")], localCwd)
      : { binary: command, args, cwd: localCwd };
    if (abortIfCancelled(threadId, runId)) return { runId };
    const handle = runAgentFn({
      command: spawn.binary,
      args: spawn.args,
      prompt,
      appendPrompt: !crossing,
      cwd: spawn.cwd,
      env: threadSecrets.withEnv(threadId, {
        ...process.env,
        ...normalizeProjectEnv(project && project.env),
      }),
      onChunk: (text) => {
        if (!guard()) return;
        realState.charCount = text.length;
        pendingText = text;
        throttledPush();
      },
      onDone: (exitCode, fullText, stderrText) => {
        cancelPushTimer();
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "generic") return;

        if (fullText && fullText.length > 0) {
          pendingText = fullText;
        }
        applyPendingText();

        clearRun(threadId);

        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);

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
          notifyRunTerminal(
            threadId,
            "done",
            fullText || lastAssistantText(threadId, runId),
          );
          return;
        }

        realState.agentStatus = "failed";
        const errText = formatRunExitError(exitCode, stderrText);
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text);
      },
      onError: (err) => {
        cancelPushTimer();
        const e = active.get(threadId);
        if (!e || e.stopping || e.runId !== runId) return;
        if (e.kind !== "generic") return;

        applyPendingText();
        clearRun(threadId);
        completeWorkLogStep(threadId, e.startingId);
        completeWorkLogStep(threadId, e.respondingId);
        realState.agentStatus = "failed";
        const msg = err && err.message ? err.message : String(err);
        const errText = `Run error: ${msg}`;
        const failure = markRunFailed(threadId, errText, runId);
        appendDoneWorkLog(threadId, runId, "Run error");
        store.save();
        pushDetail(threadId, realState);
        pushThreadsChanged();
        notifyRunTerminal(threadId, "failed", failure.text);
      },
    });

    entry.handle = handle;
    completeWorkLogStep(threadId, startingId);
    store.save();
    pushDetail(threadId, realState);

    return { runId };
  }

  return { startSimulatedRun, startGenericRun };
}

module.exports = { createGenericRun };
