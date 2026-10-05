"use strict";

// createRunner seam: worktree setup before a turn, and orchestration command
// dispatch (#1447, seam 3). Follows the seam convention in the header of
// electron/runner-watchdogs.js. startRun stays in runner.js, so it is read
// lazily as ctx.startRun.

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const services = require("./services.js");
const orchcommands = require("./orchcommands.js");
const { startWithPoolFailover } = require("./subagentPool.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createTurnSetup(ctx) {
  const {
    store,
    pushFn,
    userDataPath,
    otel,
    resolveProvider,
    isReplayTurn,
    shortError,
    providerBinAvailable,
    appendMessage,
    pushDetail,
    pushThreadsChanged,
  } = ctx;

  /**
   * Create or rematerialize the worktree for a thread that asked for one.
   * No-op for plain checkout threads. Throws on setup failure so the run
   * never silently drops the isolation the user asked for (#511).
   * @param {string} threadId
   */
  function materializePendingWorktree(threadId) {
    const thread = store.getThread(threadId);
    if (!thread) return;
    const wantsWorktree =
      Boolean(thread.pendingWorktree) || Boolean(thread.worktreePath);
    if (!wantsWorktree) return;
    if (!userDataPath) {
      throw new Error("worktreeBase is not configured");
    }
    const { prepareThreadWorktree } = require("./worktrees.js");
    prepareThreadWorktree({
      store,
      threadId,
      worktreeBase: path.join(userDataPath, "worktrees"),
      broadcast: pushFn,
    });
  }

  /**
   * Record a worktree-setup failure in the thread (user prompt + verbatim
   * git stderr event + status failed) so Retry-turn can fire, then throw
   * so callers (fork, drainQueued) know the agent never started.
   * @param {string} threadId
   * @param {string} prompt
   * @param {{ kind: string, path: string, name: string }[] | undefined} attachments
   * @param {any} err
   * @param {{ fromQuotaWait?: boolean, fromQuotaFailover?: boolean }} [opts]
   */
  function failWorktreeSetup(threadId, prompt, attachments, err, opts) {
    const errText = String((err && err.message) || err);
    const live = store.getThread(threadId);
    const runId = randomUUID();
    otel.startRun({
      threadId,
      runId,
      provider: live ? resolveProvider(live) : "claude",
      model: (live && live.model) || null,
    });
    if (!isReplayTurn(opts)) {
      appendMessage(threadId, "user", prompt, runId, null, attachments);
    }
    appendMessage(threadId, "event", errText, runId);
    store.updateThread(
      threadId,
      {
        status: "failed",
        runStartedAt: null,
        lastError: shortError(errText),
      },
      { touch: true },
    );
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();
    otel.endRun({
      threadId,
      runId,
      status: "failed",
      error: shortError(errText),
    });
    throw err instanceof Error ? err : new Error(errText);
  }

  /**
   * Dispatch one orchestration command (issue #338): fork a worker per
   * provider, start each with its role prompt, and let the ordinary
   * worker-finished notices wake this thread with the results.
   *
   * Only `/handoff` gets a worktree. `/advisor` and `/committee` are
   * read-only by contract and a worker worktree branches from the default
   * branch — a second opinion on the default branch is not a second opinion
   * on the work in progress — so they run in the project checkout instead
   * and are pointed at the caller's checkout in the prompt.
   *
   * @param {string} threadId - the lead thread
   * @param {any} thread
   * @param {import('./orchcommands.js').OrchCommand} cmd
   * @param {string} prompt - the raw prompt, kept verbatim in the transcript
   * @param {{ kind: string, path: string, name: string }[]} attachments
   */
  async function dispatchOrchCommand(
    threadId,
    thread,
    cmd,
    prompt,
    attachments,
  ) {
    // Fork every worker BEFORE starting any: committee members argue with
    // each other directly, so each one's prompt needs its peers' ids.
    const workers = cmd.providers.map((provider) =>
      services.forkWorkerThread(store, {
        threadId,
        provider,
        worktree: cmd.kind === "handoff",
        title: cmd.task,
      }),
    );
    const ids = workers.map((w) => w.id);
    const where =
      cmd.kind !== "handoff" && thread.worktreePath
        ? `\n\nThe thread that asked works in ${thread.worktreePath}. Inspect that checkout — do not edit it.`
        : "";

    // The fan-out is a span of the lead thread and parents every worker run,
    // so the crew reads as one trace tree (same shape as the pendingFork hop).
    const forkRunId = randomUUID();
    otel.startRun({
      threadId,
      runId: forkRunId,
      provider: resolveProvider(thread),
      model: thread.model || null,
    });

    let started = null;
    /** @type {string[]} */
    const failures = [];
    for (let i = 0; i < workers.length; i++) {
      const workerPrompt =
        orchcommands.workerPrompt(cmd.kind, cmd.task, {
          index: i,
          total: workers.length,
          peerIds: ids.filter((_, j) => j !== i),
        }) + where;
      try {
        const run = await startWithPoolFailover({
          store,
          worker: workers[i],
          prompt: workerPrompt,
          extra: { attachments, parentRunId: forkRunId },
          startRun: ctx.startRun,
          setProvider: services.setProvider,
          isAvailable: providerBinAvailable,
        });
        started = started || run;
      } catch (err) {
        // A worker that never started is an orphan: drop it, same contract
        // as the pendingFork path. Peers that DID start keep running — they
        // are real work, and killing them to report a clean failure would
        // throw away more than it explains.
        failures.push(
          `${workers[i].provider}: ${shortError(String((err && err.message) || err))}`,
        );
        try {
          // Worker never started a run; no durable artifacts to reclaim.
          services.deleteThread(store, { threadId: workers[i].id });
        } catch {
          /* best effort */
        }
      }
    }

    if (!started) {
      otel.endRun({
        threadId,
        runId: forkRunId,
        status: "failed",
        error: shortError(failures.join("; ")),
      });
      pushThreadsChanged();
      throw new Error(
        `/${cmd.kind} dispatched no workers — ${failures.join("; ")}`,
      );
    }

    otel.endRun({ threadId, runId: forkRunId, status: "done" });
    appendMessage(threadId, "user", prompt, forkRunId, null, attachments);
    const live = workers.filter((w) => store.getThread(w.id));
    appendMessage(
      threadId,
      "event",
      orchcommands.dispatchNote(
        cmd.kind,
        live.map((w) => ({ id: w.id, provider: w.provider })),
      ) + (failures.length ? `\nNot dispatched — ${failures.join("; ")}` : ""),
      forkRunId,
    );
    store.updateThread(
      threadId,
      { ...services.clearSettledOnActivity(thread) },
      { touch: true },
    );
    pushDetail(threadId);
    pushThreadsChanged();
    return started;
  }

  return {
    materializePendingWorktree,
    failWorktreeSetup,
    dispatchOrchCommand,
  };
}

module.exports = { createTurnSetup };
