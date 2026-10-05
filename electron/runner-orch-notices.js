"use strict";

// createRunner seam: orchestration notices, the Codex park/release timing,
// and crew sweeps (#1447, seam 9). Follows the seam convention in the header
// of electron/runner-watchdogs.js. startRun is read lazily. clearRun calls
// noteCodexRelease, startRun reads autoTurns and codexSessionHeld, and
// stopAll clears the timers through cancelAll(); all via this factory's
// return.

const services = require("./services.js");
const { noticePrompt } = require("./runnerHelpers.js");

// Issue #213: keep only the newest N worker threads per orchestrator so
// fan-out cannot grow the store without bound. No settings knob; skipped
// threads still occupy a keep slot.
const MAX_WORKERS_PER_ORCHESTRATOR = 20;

const CODEX_WRITER_LOCK_COPY =
  "This Codex session is still owned by another process. Quit Codex Desktop or the other CLI that has it open. The worker notice is waiting and will resume once the session is free.";

const CODEX_EJECTED_COPY =
  "This Codex session was ejected. Solenta will not resume it. The worker notice is waiting.";

/** Flock can lag Solenta's child exit; one bounded re-flush, no loop. */
const CODEX_WRITER_RELEASE_MS = 400;

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createOrchNotices(ctx) {
  const {
    store,
    active,
    lastWorkflowByThread,
    getIosSimulator,
    resolveProvider,
    looksWriterLock,
    shortError,
    appendMessage,
    pushDetail,
    pushThreadsChanged,
    stopRun,
  } = ctx;

  /**
   * Pending wake-ups: threadId -> notice lines. Worker-finished notices,
   * peer messages, and task-unblock pokes share this one queue. Idle
   * threads start a run immediately; a running thread flushes at its own
   * terminal. The orchestrator no longer needs the user to relay.
   * @type {Map<string, string[]>}
   */
  const orchNotices = new Map();

  /**
   * Consecutive machine-delivered turns per thread (issue #277). A notice
   * flush increments; a user-initiated startRun resets to 0. At
   * CREW_AUTO_TURN_CAP the next flush is refused through the same
   * undeliverable path as the orchestration-budget gate.
   * @type {Map<string, number>}
   */
  const autoTurns = new Map();

  /** sessionId -> Date.now() when a Solenta Codex child left `active`. */
  const recentlyReleasedCodex = new Map();
  /** threadId -> timeout for one bounded post-release flush. */
  const codexReleaseFlush = new Map();
  /** threadId: recovery copy already posted for a parked notice. */
  const codexParkNotified = new Set();

  function cancelCodexReleaseFlush(threadId) {
    const timer = codexReleaseFlush.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    codexReleaseFlush.delete(threadId);
  }

  function noteCodexRelease(sessionId) {
    const sid = sessionId != null ? String(sessionId) : "";
    if (!sid) return;
    recentlyReleasedCodex.set(sid, Date.now());
  }

  function scheduleCodexReleaseFlush(threadId) {
    if (codexReleaseFlush.has(threadId)) return;
    const timer = setTimeout(() => {
      codexReleaseFlush.delete(threadId);
      try {
        flushOrchNotices(threadId);
      } catch {
        // silent
      }
    }, CODEX_WRITER_RELEASE_MS);
    if (typeof timer.unref === "function") timer.unref();
    codexReleaseFlush.set(threadId, timer);
  }

  /**
   * True when another Solenta Codex child still holds this sessionId
   * (live or shutting down).
   * @param {string} sessionId
   * @param {string} exceptThreadId
   */
  function codexSessionHeld(sessionId, exceptThreadId) {
    const sid = String(sessionId || "");
    if (!sid) return false;
    for (const [id, entry] of active) {
      if (id === exceptThreadId) continue;
      if (!entry || entry.kind !== "codex") continue;
      if (entry.sessionId && String(entry.sessionId) === sid) return true;
      const t = store.getThread(id);
      if (t && t.sessionId && String(t.sessionId) === sid) return true;
    }
    return false;
  }

  /**
   * Park a machine-delivered Codex wake-up: writer-lock, eject, or a
   * sibling Solenta child still owns the session. `{ wait: true }` is the
   * one-shot delay after our own child just released.
   * @param {object} thread
   * @returns {{ copy?: string, wait?: boolean } | null}
   */
  function parkCodexFromNotice(thread) {
    if (!thread) return null;
    if (resolveProvider(thread) !== "codex") return null;
    if (thread.ejected === true) return { copy: CODEX_EJECTED_COPY };
    const sid = thread.sessionId ? String(thread.sessionId) : "";
    if (sid && recentlyReleasedCodex.has(sid)) {
      const age = Date.now() - recentlyReleasedCodex.get(sid);
      if (age >= 0 && age < CODEX_WRITER_RELEASE_MS) return { wait: true };
    }
    if (sid && codexSessionHeld(sid, thread.id)) {
      return { copy: CODEX_WRITER_LOCK_COPY };
    }
    if (
      thread.lastErrorKind === "writer-lock" ||
      looksWriterLock(thread.lastError)
    ) {
      return { copy: CODEX_WRITER_LOCK_COPY };
    }
    return null;
  }

  /**
   * Append a line to the notice queue. Caller already checked the thread
   * exists. Does not flush.
   * @param {string} threadId
   * @param {string} line
   */
  function enqueueNotice(threadId, line) {
    const notes = orchNotices.get(threadId) || [];
    notes.push(line);
    orchNotices.set(threadId, notes);
  }

  /**
   * Queue a line for a thread and try to deliver it as a run. Same rules as
   * worker-finished notices: idle threads start immediately, a running
   * thread flushes at its own terminal. The caller owns the prefix (peer
   * lines arrive as `[peer from …]`); do not add `[orchestration]`.
   * Unknown threadId is a silent no-op. Never throws.
   * @param {{ threadId?: unknown, line?: unknown }} [input]
   */
  function deliverNotice(input) {
    try {
      const threadId =
        input && input.threadId != null ? String(input.threadId) : "";
      if (!threadId || !store.getThread(threadId)) return;
      const line = input && input.line != null ? String(input.line) : "";
      if (!line) return;
      enqueueNotice(threadId, line);
      flushOrchNotices(threadId);
    } catch {
      // silent
    }
  }

  /**
   * Queue a worker-finished notice for the worker's orchestrator, then try
   * to deliver. No-op for non-workers. Never throws.
   * @param {string} threadId - the worker whose run just landed
   * @param {"done" | "failed"} status
   */
  function queueOrchNotice(threadId, status) {
    const thread = store.getThread(threadId);
    if (!thread || !thread.orchWorker || !thread.handoffFrom) return;
    const parentId = String(thread.handoffFrom);
    if (!store.getThread(parentId)) return;
    let line = "";
    const msgs = store.getMessages(threadId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === "assistant" && m.text != null && String(m.text)) {
        line = String(m.text).split(/\r?\n/)[0];
        break;
      }
    }
    const title = thread.title ? ` ("${thread.title}")` : "";
    // Its commits are on its own branch and nowhere else until someone lands
    // them — say so at the one moment the lead is awake and looking at this
    // worker. But this notice is machine-delivered: telling the lead to merge
    // here is what put 13 worker branches on main in a day. Landing is the
    // user's call, so what the lead owes them right now is the report.
    const merge =
      status === "done" && thread.worktreePath
        ? ` Its work is still only on branch ${thread.branch || "(its own)"}:` +
          ` check it, then tell the user what it built and ask whether to merge` +
          ` it (thread_merge) or open a pull request (thread_pr) with` +
          ` workerThreadId ${threadId}. Do not land it before they answer —` +
          ` not even onto your own branch. If other workers have finished too,` +
          ` ask about all of them in one question and name the order you would` +
          ` land them in.`
        : "";
    enqueueNotice(
      parentId,
      `Worker thread ${threadId}${title} finished with status ${status}.` +
        (line ? ` Last reply: ${line}` : "") +
        merge,
    );
    flushOrchNotices(parentId);
  }

  /**
   * Deliver queued worker notices as one run on the orchestrator thread.
   * Skips while the orchestrator is mid-run (every terminal path calls
   * clearRun before this hook, so its own terminal re-flushes). Never throws.
   * @param {string} threadId - the orchestrator thread
   */
  function flushOrchNotices(threadId) {
    const notes = orchNotices.get(threadId);
    if (!notes || notes.length === 0) return;
    if (active.has(threadId)) return;
    const thread = store.getThread(threadId);
    if (!thread) {
      orchNotices.delete(threadId);
      return;
    }
    const park = parkCodexFromNotice(thread);
    if (park) {
      if (park.wait) {
        scheduleCodexReleaseFlush(threadId);
        return;
      }
      if (!codexParkNotified.has(threadId)) {
        codexParkNotified.add(threadId);
        try {
          appendMessage(threadId, "event", park.copy);
          store.save();
          pushDetail(threadId, lastWorkflowByThread.get(threadId) || null);
          pushThreadsChanged();
        } catch {
          // silent
        }
      }
      return;
    }
    codexParkNotified.delete(threadId);
    orchNotices.delete(threadId);
    const prompt = noticePrompt(notes);
    // Per-orchestration ceiling (issue #67) and consecutive auto-turn cap
    // (issue #277): refuse the wake-up here, not in startRun, so user-sent
    // turns (and "Retry turn" after raising a cap) still run. The catch
    // below surfaces the refusal exactly like the daily-budget gate.
    Promise.resolve()
      .then(() => {
        services.assertUnderOrchestrationBudget(store, threadId);
        const n = autoTurns.get(threadId) || 0;
        if (n >= services.CREW_AUTO_TURN_CAP) {
          throw new Error(
            `Crew auto-turn cap reached (${services.CREW_AUTO_TURN_CAP} consecutive machine-delivered turns). A human turn resets it.`,
          );
        }
        autoTurns.set(threadId, n + 1);
        return ctx.startRun({ threadId, prompt, fromNotice: true });
      })
      .catch((err) => {
      // Undeliverable (budget gate, missing CLI): the orchestration stops
      // advancing right here, so say why and land the thread "failed" —
      // that badges the sidebar, arms "Retry turn", and fires the desktop
      // notification (issue #34). A quiet event alone reads as "still going".
      try {
        const reason = err && err.message ? String(err.message) : String(err);
        appendMessage(threadId, "event", `${prompt}\n\nNot delivered: ${reason}`, null, null, null, { fromNotice: true });
        // A run that raced in after the active guard above owns the status;
        // only an idle orchestrator is really stalled.
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
  }

  /**
   * Archive one orchestrator's finished workers once its crew is quiet.
   * "Quiet" means no crew member has a LIVE run: a worker left at "working"
   * by a crash or a CLI that never lands would otherwise pin the whole crew
   * open forever (issue #15).
   * @param {string} threadId - the orchestrator thread
   */
  function sweepCrew(threadId) {
    const crew = store
      .getThreads()
      .filter((t) => t.orchWorker && t.handoffFrom === threadId);
    if (crew.length === 0) return;
    // Every terminal path calls clearRun before this hook, so a worker that
    // just landed is already out of `active`.
    if (crew.some((t) => t.status === "working" && active.has(t.id))) return;
    let changed = false;
    const simReleaseOpts = {
      getIosSimulator,
      log: (msg) => {
        try {
          console.warn(msg);
        } catch {
          // never throw from logging
        }
      },
    };
    for (const t of crew) {
      // Done is finished. Idle is finished only after the worker has run:
      // stoppedAt (#183), a session, or a transcript. getMessages hydrates
      // a shard, so only an unarchived idle row with neither cheaper mark
      // pays for it. A fresh fork and a pendingFork stay visible (#979).
      if (t.archived || t.pendingFork) continue;
      let finished = t.status === "done";
      if (!finished && t.status === "idle") {
        finished =
          Boolean(t.stoppedAt) ||
          Boolean(t.sessionId) ||
          (store.getMessages(t.id) || []).length > 0;
      }
      if (finished && !t.archived) {
        // Not real activity: no touch, same as threads:setArchived.
        store.updateThread(t.id, { archived: true });
        void services.scheduleSimulatorRelease(simReleaseOpts, "releaseThread", {
          threadId: t.id,
        });
        changed = true;
      }
    }
    // Newest first. Equal createdAt (same-ms forks) break ties by insertion
    // index so the later-minted worker is kept.
    const indexed = crew.map((t, i) => ({ t, i }));
    indexed.sort((a, b) => (b.t.createdAt - a.t.createdAt) || (b.i - a.i));
    for (let i = MAX_WORKERS_PER_ORCHESTRATOR; i < indexed.length; i++) {
      const t = indexed[i].t;
      if (
        t.status !== "done" &&
        t.status !== "failed" &&
        t.status !== "stopped"
      ) {
        continue;
      }
      if (active.has(t.id) || t.worktreePath || t.pinnedAt) continue;
      services.purgeThread(store, t.id);
      void services.scheduleSimulatorRelease(simReleaseOpts, "releaseThread", {
        threadId: t.id,
      });
      changed = true;
    }
    if (changed) {
      store.save();
      pushThreadsChanged();
    }
  }

  /**
   * Sweep the crews this run terminal can settle: the thread's own workers
   * (it is an orchestrator) and, when the thread is itself a worker, its
   * orchestrator's crew — the orchestrator can be finished for good, in
   * which case its terminal never comes again and waiting for it leaves the
   * workers open forever (issue #15). Never throws.
   * @param {string} threadId
   */
  function sweepDoneWorkers(threadId) {
    try {
      sweepCrew(threadId);
      const self = store.getThread(threadId);
      if (self && self.orchWorker && self.handoffFrom) {
        sweepCrew(String(self.handoffFrom));
      }
    } catch {
      // silent
    }
  }

  /**
   * Stop is sacred (issue #32): stopping an orchestrator takes its crew with
   * it. Depth-first, so a worker that is itself an orchestrator brings its own
   * crew down too. Every stopped worker lands as "stopped", which queues no
   * wake-up notice, and pending ones are demoted to an event once the crew is
   * down, so nothing restarts the orchestrator the user just stopped.
   * @param {string} threadId - the orchestrator being stopped
   * @param {Set<string>} seen - guards a handoffFrom cycle
   * @returns {Promise<{ stopped: number, traced: boolean }>} workers whose
   *   live run was stopped, and whether a notice trace was written
   */
  async function stopCrew(threadId, seen) {
    if (seen.has(threadId)) return { stopped: 0, traced: false };
    seen.add(threadId);
    const crew = store
      .getThreads()
      .filter((t) => t.orchWorker && String(t.handoffFrom) === threadId);
    let stopped = 0;
    for (const worker of crew) {
      const id = String(worker.id);
      const wasActive = active.has(id);
      await stopRun({ threadId: id }, seen);
      if (wasActive) stopped++;
    }
    const pending = orchNotices.get(threadId);
    orchNotices.delete(threadId);
    if (pending && pending.length > 0) {
      // Same trace as flushOrchNotices' undeliverable path: the orchestrator
      // still sees what its crew did, as an event that starts no run.
      const body = pending.join("\n");
      const headed = /^\s*\[/.test(body) ? body : "[orchestration] " + body;
      appendMessage(threadId, "event", headed);
    }
    return { stopped, traced: !!(pending && pending.length > 0) };
  }

  /**
   * True while the thread's current turn chain was delivered by the machine
   * (a worker-finished or peer notice) rather than started by a human. Read
   * by orchServer to refuse a worker merge/PR the user never approved: on an
   * auto turn, nobody has answered the lead's question yet.
   * @param {string} threadId
   */
  function isAutoTurn(threadId) {
    return (autoTurns.get(threadId) || 0) > 0;
  }

  return {
    autoTurns,
    noteCodexRelease,
    codexSessionHeld,
    deliverNotice,
    queueOrchNotice,
    flushOrchNotices,
    sweepCrew,
    sweepDoneWorkers,
    stopCrew,
    isAutoTurn,
    cancelAll() {
      for (const id of [...codexReleaseFlush.keys()]) {
        cancelCodexReleaseFlush(id);
      }
      recentlyReleasedCodex.clear();
      codexParkNotified.clear();
    },
  };
}

module.exports = { createOrchNotices };
