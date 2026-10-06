"use strict";

const services = require("./services.js");
const cliSessions = require("./cli-sessions.js");
const { crewIntegration } = require("./crewIntegration.js");
const { retireAgent, runRetention } = require("./ipc-shared.js");

/**
 * Shared get/peek payload. Selecting a thread (get) stamps lastVisitedAt;
 * peeking a sibling for the divergence compare must not (issue #393).
 */
function threadDetailFor(ctx, id, markVisited) {
  const workflow =
    typeof ctx.runner.getActiveWorkflow === "function"
      ? ctx.runner.getActiveWorkflow(id)
      : null;
  let view = null;
  if (workflow && ctx.runner.toWorkflowView) {
    // Surface workflow for simulate (core) and orchestrated multi-phase runs.
    if (
      workflow.__orchestrated ||
      (!workflow.__real && !workflow.__claude && !workflow.__codex)
    ) {
      view = ctx.runner.toWorkflowView(workflow);
    }
  }
  return services.getThreadDetail(ctx.store, id, view, {
    markVisited,
    pendingPermission: ctx.runner.getPendingPermission
      ? ctx.runner.getPendingPermission(id)
      : null,
  });
}

/** IPC_HANDLERS rows for threads:*; ipc.js spreads them in. */
module.exports = {
  "threads:list": async (ctx) => {
    services.expireTrashedThreads(ctx.store, {
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
      log: ctx.log,
    });
    return services.listThreads(ctx.store);
  },
  "threads:summaries": async (ctx, input) => {
    return services.threadSummaries(ctx.store, input || undefined);
  },
  "threads:crewTasks": async (ctx, input) => {
    return services.listCrewTasks(ctx.store, input || {});
  },
  "threads:crewIntegration": async (ctx, input) => {
    return crewIntegration(ctx.store, input || {});
  },
  "threads:search": async (ctx, input) => {
    return services.searchThreads(ctx.store, input || { query: "" });
  },
  "threads:listCliSessions": async (_ctx, input) => {
    if (input && input.provider === "claude") {
      return cliSessions.listClaudeSessions();
    }
    if (input && input.provider === "cursor") {
      return cliSessions.listCursorSessions();
    }
    if (input && input.provider === "opencode") {
      return cliSessions.listOpenCodeSessions();
    }
    if (input && input.provider === "grok") {
      return cliSessions.listGrokSessions();
    }
    if (input && input.provider === "kimi") {
      return cliSessions.listKimiSessions();
    }
    if (input && input.provider === "muse") {
      return cliSessions.listMuseSessions();
    }
    return cliSessions.listCodexSessions();
  },
  "threads:importCliSession": async (ctx, input) => {
    // Home is CODEX_HOME / GROK_HOME / CLAUDE_CONFIG_DIR / CURSOR_HOME /
    // OPENCODE_HOME / KIMI_CODE_HOME / XDG_DATA_HOME/muse on this process.
    // Ignore any renderer-supplied path.
    const args = {
      sessionId: input && input.sessionId,
      projectId: input && input.projectId,
    };
    let thread;
    if (input && input.provider === "claude") {
      thread = cliSessions.importClaudeSession(ctx.store, args);
    } else if (input && input.provider === "cursor") {
      thread = cliSessions.importCursorSession(ctx.store, args);
    } else if (input && input.provider === "opencode") {
      thread = cliSessions.importOpenCodeSession(ctx.store, args);
    } else if (input && input.provider === "grok") {
      thread = cliSessions.importGrokSession(ctx.store, args);
    } else if (input && input.provider === "kimi") {
      thread = cliSessions.importKimiSession(ctx.store, args);
    } else if (input && input.provider === "muse") {
      thread = cliSessions.importMuseSession(ctx.store, args);
    } else {
      thread = cliSessions.importCodexSession(ctx.store, args);
    }
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    // Re-import may have absorbed new turns. Push the open transcript
    // the same way reclaim does. Tests (and boot) may lack a runner.
    if (thread && thread.id) {
      try {
        ctx.broadcast(
          "thread:updated",
          threadDetailFor(ctx, thread.id, false),
        );
      } catch {
        // Sidebar list still refreshed.
      }
    }
    return thread;
  },
  "threads:create": async (ctx, input) => {
    const thread = services.createThread(ctx.store, input);
    // Ask mode (issue #392): no worktree, no orchestrator fork. Wins over
    // both so a defaultWorktree setting cannot sneak a pending worktree
    // onto a read-only Q&A thread.
    if (input && input.ask === true) {
      services.startAsk(ctx.store, { threadId: thread.id });
      ctx.broadcast("threads:changed", services.listThreads(ctx.store));
      return ctx.store.getThread(thread.id);
    }
    // Orchestrator thread (issue #202): the first prompt is forked to a
    // worker, which is what gets the worktree — so this branch wins over
    // `worktree` and never touches the filesystem itself.
    if (input && input.orchestrate === true) {
      try {
        const project = ctx.store.getProject(thread.projectId);
        if (project && project.remoteHost) {
          throw new Error(
            "Orchestrator threads are not available for remote projects",
          );
        }
        ctx.store.updateThread(thread.id, { pendingFork: true });
        ctx.store.save();
      } catch (err) {
        // Atomic create, same as the worktree path below.
        // Rollback of a thread created this invoke: no run yet, no artifacts.
        try {
          services.deleteThread(ctx.store, { threadId: thread.id });
        } catch {
          /* best effort */
        }
        ctx.broadcast("threads:changed", services.listThreads(ctx.store));
        throw err;
      }
      if (input.teach === true) {
        services.startTeach(ctx.store, { threadId: thread.id });
      }
      ctx.broadcast("threads:changed", services.listThreads(ctx.store));
      return ctx.store.getThread(thread.id);
    }
    if (input && input.teach === true) {
      services.startTeach(ctx.store, { threadId: thread.id });
    }
    const scratchHost = ctx.store.getProject(thread.projectId);
    if (input && input.worktree === true && !(scratchHost && scratchHost.scratch === true)) {
      // Scratch has no git: the default-worktree setting does not apply there.
      try {
        if (!ctx.worktreeBase) {
          throw new Error("worktreeBase is not configured");
        }
        const project = ctx.store.getProject(thread.projectId);
        if (project && project.remoteHost) {
          throw new Error(
            "Worktree threads are not available for remote projects",
          );
        }
        // Lazy (t3-style): only mark intent here. The worktree + branch are
        // created by ensureWorktree at first run start, so a thread that
        // never runs leaves nothing on disk.
        ctx.store.updateThread(thread.id, { pendingWorktree: true });
        ctx.store.save();
      } catch (err) {
        // Atomic create: never leave a thread behind when its worktree
        // intent failed validation. worktreePath is still null here, so
        // deleteThread's guard does not fire.
        // Rollback of a thread created this invoke: no run yet, no artifacts.
        try {
          services.deleteThread(ctx.store, { threadId: thread.id });
        } catch {
          /* best effort */
        }
        ctx.broadcast("threads:changed", services.listThreads(ctx.store));
        throw err;
      }
    }
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return ctx.store.getThread(thread.id);
  },
  "threads:fork": async (ctx, input) => {
    const thread = services.forkThread(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return thread;
  },
  "threads:rewind": async (ctx, input) => {
    const result = await services.rewindThread(ctx.store, input, {
      isRunning: (id) => ctx.runner.isRunning(id),
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
      log: ctx.log,
    });
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return result;
  },
  "threads:get": async (ctx, id) => threadDetailFor(ctx, id, true),
  // Compare/sibling load (issue #393). Same payload as get, no visit stamp.
  "threads:peek": async (ctx, id) => threadDetailFor(ctx, id, false),
  "threads:respondPermission": async (ctx, input) => {
    // runner.respondPermission pushes the updated detail itself.
    ctx.runner.respondPermission(input);
  },
  "threads:clearQuestion": async (ctx, input) => {
    // Dismiss only (issue #647). Answering rides the normal send path, which
    // clears the card in startRun / setQueued. Pushes its own detail.
    ctx.runner.clearQuestion(input);
  },
  "threads:setPermissionMode": async (ctx, input) => {
    const updated = services.setPermissionMode(ctx.store, input);
    services.recordLastUsedDefaults(ctx.store, input.threadId);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    // Drop a synthesized plan card from the open thread (issue #707).
    if (ctx.runner.refreshDetail) ctx.runner.refreshDetail(input.threadId);
    return updated;
  },
  "threads:setArchived": async (ctx, input) => {
    const updated = services.setArchived(ctx.store, input, {
      getIosSimulator: ctx.getIosSimulator,
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
      log: ctx.log,
    });
    if (updated && updated.archived) {
      retireAgent(ctx, updated.id);
    }
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    if (updated && updated.archived) await runRetention(ctx);
    return updated;
  },
  "threads:setSettled": async (ctx, input) => {
    const updated = services.setSettled(ctx.store, input);
    if (updated && updated.settledOverride === "settled") {
      retireAgent(ctx, updated.id);
    }
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setPinned": async (ctx, input) => {
    const updated = services.setPinned(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setQueued": async (ctx, input) => {
    const updated = services.setQueued(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setSnoozed": async (ctx, input) => {
    const updated = services.setSnoozed(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setTags": async (ctx, input) => {
    const updated = services.setTags(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setThreadProject": async (ctx, input) => {
    const updated = services.setThreadProject(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setMuted": async (ctx, input) => {
    const updated = services.setMuted(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setEjected": async (ctx, input) => {
    // #960: releasing the session writer is the point of eject, and it must
    // happen BEFORE setEjected, which may launch the resume command in
    // $TERMINAL: a CLI started first meets the live writer lock and exits.
    // Stop this thread's child only — a crew cascade would kill workers the
    // user did not ask to park.
    if (
      input &&
      input.ejected === true &&
      ctx.runner &&
      typeof ctx.runner.isRunning === "function" &&
      typeof ctx.runner.stopRun === "function" &&
      ctx.runner.isRunning(input.threadId)
    ) {
      await ctx.runner.stopRun({
        threadId: input.threadId,
        cascadeCrew: false,
      });
    }
    // #979: an idle Claude keep-alive still holds the session writer after
    // the Solenta turn has ended (stopRun is a no-op then). Same retire as
    // settle/archive/delete — this thread only, no crew cascade.
    if (input && input.ejected === true && ctx.store.getThread(input.threadId)) {
      retireAgent(ctx, input.threadId);
    }
    const updated = services.setEjected(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    if (updated && input && input.ejected === false) {
      try {
        ctx.broadcast("thread:updated", threadDetailFor(ctx, input.threadId, false));
      } catch {
        // Thread gone between reclaim and the detail push.
      }
    }
    return ctx.store.getThread(input.threadId) || updated;
  },
  "threads:setCrossThreadInbound": async (ctx, input) => {
    const updated = services.setCrossThreadInbound(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setQuotaWaitAutoResume": async (ctx, input) => {
    const updated = services.setQuotaWaitAutoResume(ctx.store, input);
    if (ctx.runner && typeof ctx.runner.refreshQuotaWait === "function") {
      ctx.runner.refreshQuotaWait(input.threadId);
    }
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setPrWatch": async (ctx, input) => {
    const updated = services.setPrWatch(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setNotes": async (ctx, input) => {
    const updated = services.setNotes(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setMessagePins": async (ctx, input) => {
    const updated = services.setMessagePins(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setBaseBranch": async (ctx, input) => {
    const updated = services.setBaseBranch(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setPendingWorktree": async (ctx, input) => {
    const updated = services.setPendingWorktree(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:refreshWorkerSnapshot": async (ctx, input) => {
    const updated = services.refreshWorkerSnapshot(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:resolveSuggestion": async (ctx, input) => {
    const updated = services.resolveSuggestion(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    if (ctx.runner && typeof ctx.runner.refreshDetail === "function") {
      try {
        ctx.runner.refreshDetail(input && input.threadId);
      } catch {
        /* chip already persisted; a missed push is a refresh away */
      }
    }
    return updated;
  },
  "threads:setFeltEstimate": async (ctx, input) => {
    const updated = services.setFeltEstimate(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:startSpec": async (ctx, input) => {
    const updated = services.startSpec(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:stopSpec": async (ctx, input) => {
    const updated = services.stopSpec(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:reviewSpec": async (ctx, input) => {
    const { thread, prompt } = services.reviewSpec(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    await ctx.runner.startRun({ threadId: input.threadId, prompt });
    return thread;
  },
  "threads:specArtifact": async (ctx, input) => {
    return services.readSpecArtifact(ctx.store, input);
  },
  "threads:dispatchSpec": async (ctx, input) => {
    const result = services.dispatchSpec(ctx.store, input);
    const workers = services.forkSpecWave(ctx.store, {
      threadId: input.threadId,
      wave: result.wave,
    });
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    for (const w of workers) {
      await ctx.runner.startRun({ threadId: w.thread.id, prompt: w.prompt });
    }
    return {
      thread: ctx.store.getThread(input.threadId),
      dispatched: workers.map((w) => ({
        threadId: w.thread.id,
        taskId: w.task.id,
        title: w.task.title,
      })),
      reason: result.reason,
    };
  },
  "threads:convergeSpec": async (ctx, input) => {
    const { thread, prompt } = services.convergeSpec(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    await ctx.runner.startRun({ threadId: input.threadId, prompt });
    return thread;
  },
  "threads:startTeach": async (ctx, input) => {
    const updated = services.startTeach(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:startAsk": async (ctx, input) => {
    const updated = services.startAsk(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:stopAsk": async (ctx, input) => {
    const updated = services.stopAsk(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:btw": async (ctx, input) => {
    const start =
      ctx.runner && typeof ctx.runner.startBtw === "function"
        ? ctx.runner.startBtw
        : async (body) => services.addBtw(ctx.store, body).thread;
    const updated = await start(input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:dismissBtw": async (ctx, input) => {
    const cancel =
      ctx.runner && typeof ctx.runner.cancelBtw === "function"
        ? ctx.runner.cancelBtw
        : (body) => services.dismissBtw(ctx.store, body);
    const updated = await cancel(input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:promoteBtw": async (ctx, input) => {
    const promote =
      ctx.runner && typeof ctx.runner.promoteBtw === "function"
        ? ctx.runner.promoteBtw
        : (body) => services.promoteBtw(ctx.store, body);
    const updated = await promote(input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:stopTeach": async (ctx, input) => {
    const updated = services.stopTeach(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:requestTeachReview": async (ctx, input) => {
    const { thread, prompt } = services.requestTeachReview(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    await ctx.runner.startRun({ threadId: input.threadId, prompt });
    return thread;
  },
  "threads:rename": async (ctx, input) => {
    const updated = services.renameThread(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setProvider": async (ctx, input) => {
    const updated = services.setProvider(ctx.store, input);
    services.recordLastUsedDefaults(ctx.store, input.threadId);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setReasoningEffort": async (ctx, input) => {
    const updated = services.setReasoningEffort(ctx.store, input);
    services.recordLastUsedDefaults(ctx.store, input.threadId);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setWebSearch": async (ctx, input) => {
    const updated = services.setWebSearch(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setVerifyCommand": async (ctx, input) => {
    const updated = services.setVerifyCommand(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:runVerify": async (ctx, input) => {
    const result = await services.runVerifyNow(ctx.store, input, {
      runner: ctx.runner,
    });
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return result;
  },
  "threads:runCommand": async (ctx, input) => {
    return services.runCommand(ctx.store, input, {
      runner: ctx.runner,
      broadcast: ctx.broadcast,
    });
  },
  "threads:delete": async (ctx, input) => {
    services.trashThread(ctx.store, input, {
      isRunning: (id) => ctx.runner.isRunning(id),
      getIosSimulator: ctx.getIosSimulator,
      log: ctx.log,
    });
    retireAgent(ctx, input.threadId);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
  },
  "threads:restore": async (ctx, input) => {
    const thread = services.restoreThread(ctx.store, input, {
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
      log: ctx.log,
    });
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return thread;
  },
  "threads:purge": async (ctx, input) => {
    services.deleteThread(ctx.store, input, {
      isRunning: (id) => ctx.runner.isRunning(id),
      getIosSimulator: ctx.getIosSimulator,
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
      log: ctx.log,
    });
    retireAgent(ctx, input.threadId);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
  },
  "threads:listTrashed": async (ctx) => {
    services.expireTrashedThreads(ctx.store, {
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
      log: ctx.log,
    });
    return services.listTrashed(ctx.store);
  },
};
