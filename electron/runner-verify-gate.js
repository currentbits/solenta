"use strict";

// createRunner seam: verify gate and the turn-end trio (afterFailedTurn,
// afterSuccessfulTurn, finishSuccessfulTurn) (#1447, seam 7). Follows the
// seam convention in the header of electron/runner-watchdogs.js. startRun,
// maybeDrainQueued and the orchestration notice functions are read lazily
// from ctx: they re-enter the hub or live in a later seam.

const services = require("./services.js");
const {
  runVerifyCommand,
  buildFixPrompt,
  normalizeCommand,
  MAX_FIX_ATTEMPTS,
} = require("./verify.js");
const { prepareVerifyRun } = require("./verifyEfficiency.js");
const { maybeApplyFmTitle } = require("./fm-title.js");
const { refreshRecap } = require("./recap.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createVerifyGate(ctx) {
  const {
    store,
    active,
    lastWorkflowByThread,
    resolveProvider,
    shortError,
    appendMessage,
    pushDetail,
    pushThreadsChanged,
  } = ctx;

  /**
   * Failed worker (or any failed terminal) queues a notice. Never throws.
   * Does not drain a leftover follow-up (issue #1203).
   * @param {string} threadId
   */
  function afterFailedTurn(threadId) {
    try {
      const failed = store.getThread(threadId);
      const outcome =
        failed && failed.lastError ? String(failed.lastError) : "failed";
      services.releaseCrewTasks(store, { threadId, outcome });
    } catch {
      // silent
    }
    try {
      ctx.queueOrchNotice(threadId, "failed");
      ctx.flushOrchNotices(threadId);
    } catch {
      // silent
    }
    ctx.sweepDoneWorkers(threadId);
  }

  /**
   * After a successful turn lands status "done": best-effort worktree
   * checkpoint commit and orchestrator wake-up. Shared across every
   * provider path (and sim). Never throws into the run lifecycle.
   *
   * When the thread has a verifyCommand the gate runs here, after the
   * checkpoint so the evidence can pin to a sha that already exists.
   * Status flips back to "working" first: the thread must not sit green
   * while the command is in flight. Orch wake-up waits for the proof.
   * @param {string} threadId
   */
  function afterSuccessfulTurn(threadId) {
    // First completed assistant reply: best-effort fm title. Never blocks
    // checkpoint / verify; push if a title actually landed.
    void maybeApplyFmTitle(store, threadId)
      .then((title) => {
        if (!title) return;
        try {
          pushDetail(threadId);
          pushThreadsChanged();
        } catch {
          // silent
        }
      })
      .catch(() => {});
    // Recap (#239): rebuilt per finished turn, read on the next idle visit.
    void refreshRecap(store, threadId);

    let gated = false;
    try {
      gated = shouldVerify(threadId);
    } catch {
      gated = false;
    }
    if (gated) {
      try {
        // runStartedAt was cleared at the terminal; restamp it or the
        // sidebar shows "Working" with no elapsed time for however many
        // minutes the verify command takes.
        store.updateThread(
          threadId,
          { status: "working", runStartedAt: Date.now() },
          { touch: true },
        );
        store.save();
        pushThreadsChanged();
      } catch {
        // still try to run the command
      }
      void (async () => {
        let sha = null;
        try {
          const { maybeCreateCheckpoint } = require("./worktrees.js");
          const ckpt = await maybeCreateCheckpoint(store, threadId);
          if (ckpt && ckpt.sha) sha = ckpt.sha;
        } catch {
          // silent
        }
        if (!sha) sha = await worktreeHeadSha(threadId);
        await runVerifyGate(threadId, sha);
      })().catch((err) => {
        try {
          settleVerifyCrash(threadId, err);
        } catch {
          // silent
        }
      });
      return;
    }
    try {
      const { maybeCreateCheckpoint } = require("./worktrees.js");
      void maybeCreateCheckpoint(store, threadId);
    } catch {
      // silent
    }
    finishSuccessfulTurn(threadId);
  }

  /**
   * Armed when the thread has a non-empty verifyCommand and this was not
   * a simulate run. Simulate settles on the agent's word alone.
   * @param {string} threadId
   */
  function shouldVerify(threadId) {
    const thread = store.getThread(threadId);
    if (!thread) return false;
    if (resolveProvider(thread) === "simulate") return false;
    return Boolean(normalizeCommand(thread.verifyCommand));
  }

  /**
   * HEAD of the thread worktree, or null. Used when the tree was already
   * clean so maybeCreateCheckpoint made no commit to pin to.
   *
   * Async on purpose: an execFileSync here blocks the main process for the
   * length of a git call on every gated turn, which is the freeze the PR
   * refresher was rewritten to avoid.
   * @param {string} threadId
   */
  async function worktreeHeadSha(threadId) {
    try {
      const thread = store.getThread(threadId);
      if (!thread || !thread.worktreePath) return null;
      const { gitTryAsync } = require("./worktrees.js");
      const rev = await gitTryAsync(thread.worktreePath, ["rev-parse", "HEAD"]);
      if (!rev.ok || !rev.stdout) return null;
      return String(rev.stdout).trim() || null;
    } catch {
      return null;
    }
  }

  function lastRunIdFor(threadId) {
    const msgs = store.getMessages(threadId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].runId) return String(msgs[i].runId);
    }
    return "unknown";
  }

  /**
   * Attempt 0 on a fresh user turn. Increment only when the stored verify
   * is a failure from this same turn (the last user message is the fix
   * prompt we handed back). A new user prompt resets the counter so a
   * thread's whole life does not accumulate toward the cap.
   * @param {object} thread
   */
  function nextVerifyAttempt(thread) {
    const prev = thread.verify;
    if (!prev || prev.ok) return 0;
    const msgs = store.getMessages(thread.id) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "user") continue;
      if (String(msgs[i].text || "").startsWith("[verification failed]")) {
        return (Number(prev.attempt) || 0) + 1;
      }
      return 0;
    }
    return 0;
  }

  function finishSuccessfulTurn(threadId) {
    try {
      ctx.queueOrchNotice(threadId, "done");
      ctx.flushOrchNotices(threadId);
    } catch {
      // silent
    }
    ctx.sweepDoneWorkers(threadId);
    ctx.maybeDrainQueued(threadId);
  }

  function settleVerifyCrash(threadId, err) {
    const reason = err && err.message ? String(err.message) : String(err);
    appendMessage(threadId, "event", `Verification error: ${reason}`);
    store.updateThread(
      threadId,
      {
        status: "failed",
        runStartedAt: null,
        lastError: shortError(`Verification error: ${reason}`),
      },
      { touch: true },
    );
    store.save();
    pushThreadsChanged();
    afterFailedTurn(threadId);
  }

  /**
   * Run the thread's verify command and settle or hand a fix turn back.
   * Never rejects to the caller: spawn failures become an ok:false result.
   * @param {string} threadId
   * @param {string | null} sha
   */
  async function runVerifyGate(threadId, sha) {
    const thread = store.getThread(threadId);
    if (!thread) return;
    const command = normalizeCommand(thread.verifyCommand);
    // Cleared mid-flight: settle as if the gate was never armed.
    if (!command) {
      store.updateThread(
        threadId,
        { status: "done", runStartedAt: null },
        { touch: true },
      );
      store.save();
      finishSuccessfulTurn(threadId);
      return;
    }
    const project = store.getProject(thread.projectId);
    const cwd =
      thread.worktreePath || (project && project.path) || process.cwd();
    const attempt = nextVerifyAttempt(thread);
    const runId = lastRunIdFor(threadId);
    const prepared = prepareVerifyRun({ command, cwd, project });
    let raw;
    try {
      raw = await runVerifyCommand({
        command: prepared.command,
        cwd,
        project,
        env: prepared.env,
      });
    } catch (err) {
      raw = {
        ok: false,
        exitCode: null,
        timedOut: false,
        log: err && err.message ? String(err.message) : String(err),
        durationMs: 0,
      };
    }
    const latest = store.getThread(threadId);
    if (!latest || !normalizeCommand(latest.verifyCommand)) {
      if (latest) {
        store.updateThread(
        threadId,
        { status: "done", runStartedAt: null },
        { touch: true },
      );
        store.save();
        finishSuccessfulTurn(threadId);
      }
      return;
    }
    if (prepared.reason && raw && raw.log != null) {
      raw.log = `[verify] ${prepared.reason}\n${raw.log}`;
    }
    /** @type {import('../src/shared/ipc').VerifyResult} */
    const result = {
      runId,
      command: prepared.command,
      ok: Boolean(raw.ok),
      exitCode: raw.exitCode,
      timedOut: Boolean(raw.timedOut),
      log: raw.log || "",
      sha,
      durationMs: Number(raw.durationMs) || 0,
      at: Date.now(),
      attempt,
    };

    if (result.ok) {
      const secs = Math.round(result.durationMs / 1000);
      appendMessage(
        threadId,
        "event",
        `Verified: ${prepared.command} passed in ${secs}s`,
      );
      store.updateThread(
        threadId,
        { verify: result, status: "done", runStartedAt: null },
        { touch: true },
      );
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      finishSuccessfulTurn(threadId);
      return;
    }

    // `attempt` is how many fix prompts already went back, so this hands
    // out exactly MAX_FIX_ATTEMPTS of them — matching the "Fix attempt N
    // of M" line buildFixPrompt shows the agent.
    if (attempt < MAX_FIX_ATTEMPTS) {
      appendMessage(threadId, "event", `Verification failed: ${prepared.command}`);
      store.updateThread(threadId, { verify: result }, { touch: true });
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      const prompt = buildFixPrompt(result);
      Promise.resolve()
        .then(() => ctx.startRun({ threadId, prompt }))
        .catch((err) => {
          try {
            const reason =
              err && err.message ? String(err.message) : String(err);
            appendMessage(
              threadId,
              "event",
              `${prompt}\n\nNot delivered: ${reason}`,
            );
            if (!active.has(threadId)) {
              store.updateThread(
                threadId,
                {
                  status: "failed",
                  lastError: shortError(`Not delivered: ${reason}`),
                },
                { touch: true },
              );
            }
            store.save();
            pushDetail(threadId, lastWorkflowByThread.get(threadId) || null);
            pushThreadsChanged();
          } catch {
            // silent
          }
        });
      return;
    }

    appendMessage(threadId, "event", `Verification failed: ${command}`);
    store.updateThread(
      threadId,
      {
        verify: result,
        status: "failed",
        runStartedAt: null,
        lastError: shortError(`Verification failed: ${prepared.command}`),
      },
      { touch: true },
    );
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();
    afterFailedTurn(threadId);
  }

  return {
    afterFailedTurn,
    afterSuccessfulTurn,
    finishSuccessfulTurn,
  };
}

module.exports = { createVerifyGate };
