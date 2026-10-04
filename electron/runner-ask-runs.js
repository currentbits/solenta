"use strict";

// createRunner seam: Ask-mode turns and `/btw` side questions (#1447, seam 2).
// Follows the seam convention in the header of electron/runner-watchdogs.js.

const { randomUUID } = require("node:crypto");
const services = require("./services.js");
const ask = require("./ask.js");
const btw = require("./btw.js");
const { sanitizeAttachments } = require("./runnerHelpers.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createAskRuns(ctx) {
  const {
    store,
    active,
    userDataPath,
    askComplete,
    searchMemory,
    bootstrapMemory,
    otel,
    resolveProvider,
    isReplayTurn,
    tryReadCodeIndex,
    appendMessage,
    pushDetail,
    pushThreadsChanged,
    clearRun,
    markRunFailed,
    finishSuccessfulTurn,
  } = ctx;

  /**
   * In-flight `/btw` cards, keyed `${threadId}:${cardId}`. Separate from
   * `active` so a side question never occupies the live turn (issue #471).
   * @type {Map<string, { threadId: string, id: string, handle?: { kill?: () => void }, stopping?: boolean }>}
   */
  const btwActive = new Map();

  /**
   * Ask-mode turn (issue #392): no budget, no worktree, no tool loop, no
   * usage row. fm → print-mode → retrieval-only. Returns { runId } the
   * same way every other start*Run does; completion is async.
   *
   * @param {object} input
   * @param {object} thread
   */
  async function startAskRun(input, thread) {
    const { threadId, prompt } = input;
    const attachments = sanitizeAttachments(input.attachments);
    const project = store.getProject(thread.projectId);
    const repoRoot = (project && project.path) || "";
    if (userDataPath && repoRoot) {
      try {
        require("./codeindex.js").maybeRefreshIndex({ userDataPath, repoRoot });
      } catch {
        /* never block */
      }
    }

    const runId = randomUUID();
    otel.startRun({
      threadId,
      runId,
      provider: "ask",
      model: thread.model || null,
      parentRunId: input.parentRunId || null,
    });
    if (!isReplayTurn(input)) {
      appendMessage(threadId, "user", prompt, runId, null, attachments);
    }

    let title = thread.title;
    if (title === "New Thread") {
      const firstLine = String(prompt).split(/\r?\n/)[0].trim();
      const max = services.THREAD_TITLE_MAX || 60;
      title = firstLine.slice(0, max) || "New Thread";
    }
    store.updateThread(
      threadId,
      {
        status: "working",
        title,
        runStartedAt: Date.now(),
        awaitingInput: false,
        // Any user turn supersedes an open question card (issue #647):
        // answering it IS this message, and so is changing the subject.
        pendingQuestion: null,
        pendingPlan: null,
        lastEventAt: null,
        stalledAt: null,
        stoppedAt: null,
        quotaWaitUntil: null,
        quotaWaitResumed: input.fromQuotaWait === true,
        pendingWorktree: false,
        ...services.clearSettledOnActivity(thread),
      },
      { touch: true },
    );
    store.save();
    pushDetail(threadId);
    pushThreadsChanged();

    /** @type {{ kill?: () => void }} */
    const handle = {};
    const entry = {
      kind: "ask",
      runId,
      handle: {
        kill() {
          if (typeof handle.kill === "function") handle.kill();
        },
      },
    };
    active.set(threadId, entry);

    const index = userDataPath && repoRoot
      ? tryReadCodeIndex(userDataPath, repoRoot)
      : null;
    const indexNote = services.codeIndexNoteFor(index);
    const matchNote = ask.formatMatchingFiles(index, prompt);
    const digestNote = ask.formatThreadDigest(store.getMessages(threadId));

    void (async () => {
      let memoryNote = "";
      try {
        const search =
          searchMemory ||
          (async (query, projectPath) => {
            if (!userDataPath) return [];
            const { createMemoryProxy } = require("./memory-proxy.js");
            const proxy = createMemoryProxy({ userDataPath });
            return await proxy.search({
              query,
              project: projectPath || undefined,
            });
          });
        const hits = await search(String(prompt || ""), repoRoot);
        memoryNote = ask.formatMemoryHits(hits);
      } catch {
        memoryNote = "";
      }
      try {
        const bootNote = await ask.prefetchBootstrapNote({
          userDataPath,
          projectPath: repoRoot,
          firstTurn: true,
          bootstrapMemory,
        });
        if (bootNote) {
          memoryNote = (memoryNote ? memoryNote + "\n" : "") + bootNote.trim();
        }
      } catch {
        // Fail-open: search hits still go out.
      }

      const pack = {
        question: String(prompt || ""),
        indexNote,
        memoryNote,
        digestNote,
        matchNote,
      };
      const askPrompt = ask.buildAskPrompt(pack);

      let answer = "";
      let source = "retrieval";
      try {
        const result = await askComplete({
          prompt: askPrompt,
          provider: resolveProvider(thread),
          model: thread.model,
          onHandle: (h) => {
            handle.kill = h && h.kill;
          },
        });
        if (result && result.text) {
          answer = result.text;
          source = result.source || "print";
        }
      } catch {
        answer = "";
      }
      if (!answer) answer = ask.retrievalFallback(pack);

      if (!active.has(threadId) || active.get(threadId) !== entry) return;
      if (entry.stopping) return;

      appendMessage(threadId, "assistant", answer, runId);
      if (source === "retrieval") {
        appendMessage(
          threadId,
          "event",
          "Answered from the repo map and memory (no model).",
          runId,
        );
      }
      clearRun(threadId);
      store.updateThread(
        threadId,
        { status: "done", runStartedAt: null },
        { touch: true },
      );
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      otel.endRun({ threadId, runId, status: "done" });
      // Skip notifyRunTerminal: that path checkpoints the worktree and
      // records agent spend. Ask must do neither.
      finishSuccessfulTurn(threadId);
    })().catch((err) => {
      if (!active.has(threadId) || active.get(threadId) !== entry) return;
      const errText = `Ask error: ${err && err.message ? err.message : String(err)}`;
      clearRun(threadId);
      const failure = markRunFailed(threadId, errText, runId);
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      otel.endRun({
        threadId,
        runId,
        status: "failed",
        error: failure.text,
      });
    });

    return { runId };
  }

  /**
   * Side question (issue #471). Does not take `active`, does not change
   * thread.status, does not append transcript messages, does not spend.
   * @param {{ threadId: string, question: string }} input
   */
  async function startBtw(input) {
    const threadId = input && input.threadId;
    const thread = store.getThread(threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    const { thread: next, card } = services.addBtw(store, {
      threadId,
      question: input.question,
    });
    const key = `${threadId}:${card.id}`;
    const entry = { threadId, id: card.id };
    btwActive.set(key, entry);
    pushDetail(threadId, undefined, { skipStamp: true });
    pushThreadsChanged();

    const project = store.getProject(thread.projectId);
    const repoRoot = (project && project.path) || "";
    if (userDataPath && repoRoot) {
      try {
        require("./codeindex.js").maybeRefreshIndex({ userDataPath, repoRoot });
      } catch {
        /* never block */
      }
    }
    const index =
      userDataPath && repoRoot
        ? tryReadCodeIndex(userDataPath, repoRoot)
        : null;
    const indexNote = services.codeIndexNoteFor(index);
    const matchNote = ask.formatMatchingFiles(index, card.question);
    const digestNote = ask.formatThreadDigest(store.getMessages(threadId));

    void (async () => {
      let memoryNote = "";
      try {
        const search =
          searchMemory ||
          (async (query, projectPath) => {
            if (!userDataPath) return [];
            const { createMemoryProxy } = require("./memory-proxy.js");
            const proxy = createMemoryProxy({ userDataPath });
            return await proxy.search({
              query,
              project: projectPath || undefined,
            });
          });
        const hits = await search(String(card.question || ""), repoRoot);
        memoryNote = ask.formatMemoryHits(hits);
      } catch {
        memoryNote = "";
      }
      try {
        const bootNote = await ask.prefetchBootstrapNote({
          userDataPath,
          projectPath: repoRoot,
          firstTurn: true,
          bootstrapMemory,
        });
        if (bootNote) {
          memoryNote = (memoryNote ? memoryNote + "\n" : "") + bootNote.trim();
        }
      } catch {
        // Fail-open: search hits still go out.
      }

      const pack = {
        question: String(card.question || ""),
        indexNote,
        memoryNote,
        digestNote,
        matchNote,
      };
      const askPrompt = btw.buildBtwPrompt(pack);

      let answer = "";
      let source = "retrieval";
      let errText = "";
      try {
        const result = await askComplete({
          prompt: askPrompt,
          provider: resolveProvider(thread),
          model: thread.model,
          onHandle: (h) => {
            const live = btwActive.get(key);
            if (!live || live.stopping) {
              if (h && typeof h.kill === "function") h.kill();
              return;
            }
            live.handle = h;
          },
        });
        if (result && result.text) {
          answer = result.text;
          source = result.source || "print";
        }
      } catch (err) {
        errText = err && err.message ? String(err.message) : String(err);
      }
      if (!answer && !errText) answer = ask.retrievalFallback(pack);

      const live = btwActive.get(key);
      if (!live || live.stopping) return;
      btwActive.delete(key);
      if (!store.getThread(threadId)) return;
      services.finishBtw(store, {
        threadId,
        id: card.id,
        answer,
        error: errText || undefined,
        source: answer ? source : undefined,
      });
      pushDetail(threadId, undefined, { skipStamp: true });
      pushThreadsChanged();
    })().catch(() => {
      const live = btwActive.get(key);
      if (!live || live.stopping) return;
      btwActive.delete(key);
      if (!store.getThread(threadId)) return;
      services.finishBtw(store, {
        threadId,
        id: card.id,
        error: "Side question failed",
      });
      pushDetail(threadId, undefined, { skipStamp: true });
      pushThreadsChanged();
    });

    return store.getThread(threadId) || next;
  }

  /**
   * Kill an in-flight side question (if any) and drop the card.
   * @param {{ threadId: string, id: string }} input
   */
  function cancelBtw(input) {
    const threadId = input && input.threadId;
    const id = input && input.id;
    const key = `${threadId}:${id}`;
    const entry = btwActive.get(key);
    if (entry) {
      entry.stopping = true;
      if (entry.handle && typeof entry.handle.kill === "function") {
        try {
          entry.handle.kill();
        } catch {
          /* ignore */
        }
      }
      btwActive.delete(key);
    }
    return services.dismissBtw(store, { threadId, id });
  }

  /**
   * Queue the side question as a follow-up and drop the card. Cancels
   * an in-flight completeAsk first so it cannot rewrite a gone card.
   * @param {{ threadId: string, id: string }} input
   */
  function promoteBtw(input) {
    const threadId = input && input.threadId;
    const id = input && input.id;
    const key = `${threadId}:${id}`;
    const entry = btwActive.get(key);
    if (entry) {
      entry.stopping = true;
      if (entry.handle && typeof entry.handle.kill === "function") {
        try {
          entry.handle.kill();
        } catch {
          /* ignore */
        }
      }
      btwActive.delete(key);
    }
    return services.promoteBtw(store, { threadId, id });
  }

  /** In-flight side questions (btw). Killed by stopAll, so they count as work. */
  function listActiveBtwCount() {
    return btwActive.size;
  }

  /** stopAll: kill every in-flight side question and forget them. */
  function stopAllBtw() {
    for (const entry of btwActive.values()) {
      entry.stopping = true;
      if (entry.handle && typeof entry.handle.kill === "function") {
        try {
          entry.handle.kill();
        } catch {
          /* ignore */
        }
      }
    }
    btwActive.clear();
  }

  return {
    startAskRun,
    startBtw,
    cancelBtw,
    promoteBtw,
    listActiveBtwCount,
    stopAllBtw,
  };
}

module.exports = { createAskRuns };
