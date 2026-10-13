"use strict";

// createRunner seam: orchestration notices, the Codex park/release timing,
// and crew sweeps (#1447, seam 9). Follows the seam convention in the header
// of electron/runner-watchdogs.js. startRun is read lazily. clearRun calls
// noteCodexRelease, startRun reads autoTurns and codexSessionHeld, and
// stopAll clears the timers through cancelAll(); all via this factory's
// return.

const services = require("./services.js");
const { noticePrompt } = require("./runnerHelpers.js");
const fs = require("node:fs");
const {
  gitTry,
  branchLanded,
  recordedBaseBranch,
  repoDefaultBranch,
} = require("./worktrees.js");
const { normalizeCommand } = require("./verify.js");
const { readAnnotation } = require("./reviewItinerary.js");

/** Body cap for the structured worker result in a wake notice (#1427). */
const WORKER_RESULT_MAX = 2000;
const WORKER_RESULT_END = "[/worker result]";

/**
 * Structured result for a finished worker (#1427), built from data Solenta
 * already stores: diffstat vs the lead snapshot, the verify verdict, the
 * worker's ruled-out hypotheses, and its review-itinerary risks. The body
 * is capped at WORKER_RESULT_MAX; "" when there is nothing to report.
 * src/workerResult.ts parses the `[worker result <id>]` fence.
 * @param {object} thread - the worker
 * @returns {string}
 */
function workerResultBlock(thread) {
  const lines = [];
  const command = normalizeCommand(thread.verifyCommand);
  const v = thread.verify;
  // The gate runs after every turn while a command is set, so thread.verify
  // is the last turn's verdict. A cleared command leaves a stale one: skip.
  if (command && v) {
    const how = v.ok
      ? `passed in ${Math.round((Number(v.durationMs) || 0) / 1000)}s`
      : v.timedOut
        ? "failed (timed out)"
        : `failed (exit ${v.exitCode == null ? "?" : v.exitCode})`;
    lines.push(`Verify: ${how}: ${v.command || command}`);
  }
  const base =
    typeof thread.leadSnapshotSha === "string" ? thread.leadSnapshotSha.trim() : "";
  if (base && thread.worktreePath) {
    // ponytail: sync, but commit-to-commit (no worktree scan) and once per
    // finished worker. Keeps notice order and stop-is-sacred (#32) intact.
    const tip = thread.branch ? String(thread.branch) : "HEAD";
    const res = gitTry(
      thread.worktreePath,
      ["diff", "--stat=100", "--stat-count=40", "--summary", `${base}..${tip}`],
      { raw: true, timeout: 5000 },
    );
    const out = res.ok ? res.stdout.split("\n").filter((l) => l.trim()) : [];
    if (out.length) {
      // A symlink replacing a directory (core/dist, #1427) must survive the cap.
      const links = out.filter((l) => / mode 120000 /.test(l));
      lines.push(`Changes since lead snapshot ${base.slice(0, 7)}:`);
      lines.push(...links, ...out.filter((l) => !links.includes(l)));
    } else if (res.ok) {
      lines.push(`Changes since lead snapshot ${base.slice(0, 7)}: none`);
    }
  }
  const ruled = (Array.isArray(thread.hypotheses) ? thread.hypotheses : [])
    .filter((h) => h && h.status === "invalidated" && String(h.claim || "").trim())
    .map((h) => {
      const reason = String(h.reason || "").trim();
      return `- ${String(h.claim).trim()}${reason ? ` — ${reason}` : ""}`;
    });
  if (ruled.length) lines.push("Ruled out:", ...ruled);
  const note = thread.worktreePath ? readAnnotation(thread.worktreePath, thread.id) : null;
  const open = [];
  if (note) {
    for (const c of Array.isArray(note.chunks) ? note.chunks : []) {
      for (const r of c && Array.isArray(c.risks) ? c.risks : []) {
        if (String(r || "").trim()) open.push(`- ${c.area ? `${c.area}: ` : ""}${String(r).trim()}`);
      }
    }
    for (const r of Array.isArray(note.risks) ? note.risks : []) {
      if (String(r || "").trim()) open.push(`- ${String(r).trim()}`);
    }
  }
  if (open.length) lines.push("Open review items:", ...open);
  if (!lines.length) return "";
  let body = lines.join("\n");
  if (body.length > WORKER_RESULT_MAX) {
    const cut = body.slice(0, WORKER_RESULT_MAX);
    body = `${cut.slice(0, Math.max(cut.lastIndexOf("\n"), 0))}\n… (truncated)`;
  }
  return `\n[worker result ${thread.id}]\n${body}\n${WORKER_RESULT_END}`;
}

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

  /** threadId: a notice turn is between flush and startRun (#1501). */
  const noticeStarting = new Set();

  /**
   * Pending wake-ups: threadId -> notice lines, persisted in the store so a
   * crash cannot lose them (#1426). Worker-finished notices, peer messages,
   * and task-unblock pokes share this one queue. Idle threads start a run
   * immediately; a running thread flushes at its own terminal. A lead whose
   * row has heldNotices (restored after a restart) waits for "Resume crew".
   * @returns {Record<string, string[]>}
   */
  function queues() {
    if (!store.data.orchNoticesByThread) store.data.orchNoticesByThread = {};
    return store.data.orchNoticesByThread;
  }

  /**
   * Consecutive machine-delivered turns per thread (issue #277), persisted
   * (#1426) so a restart cannot reset the cap. A notice flush increments; a
   * user-initiated startRun resets to 0. At CREW_AUTO_TURN_CAP the next
   * flush is refused through the same undeliverable path as the
   * orchestration-budget gate.
   */
  const autoTurns = {
    /** @param {string} threadId */
    get(threadId) {
      const all = store.data.autoTurnsByThread;
      return (all && Number(all[threadId])) || 0;
    },
    /** @param {string} threadId @param {number} n */
    set(threadId, n) {
      if (!store.data.autoTurnsByThread) store.data.autoTurnsByThread = {};
      if (n) store.data.autoTurnsByThread[threadId] = n;
      else delete store.data.autoTurnsByThread[threadId];
      store.save();
    },
  };

  /** Drop a thread's queue and its hold. Does not save. */
  function dropQueue(threadId) {
    delete queues()[threadId];
    const t = store.getThread(threadId);
    if (t && t.heldNotices) store.updateThread(threadId, { heldNotices: null });
  }

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
      if (!entry) continue;
      const t = store.getThread(id);
      // A preparing Codex launch is about to open this session (#1430 R6).
      if (entry.kind === "preparing") {
        if (!t || resolveProvider(t) !== "codex") continue;
      } else if (entry.kind !== "codex") {
        continue;
      }
      if (entry.sessionId && String(entry.sessionId) === sid) return true;
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
   * Append a line to the notice queue and put it on disk now, not after the
   * save debounce: owed work must survive a crash (#1426). Caller already
   * checked the thread exists. Does not flush.
   * @param {string} threadId
   * @param {string} line
   * @param {boolean} [hold] - hold the queue for "Resume crew"
   */
  function enqueueNotice(threadId, line, hold = false) {
    const all = queues();
    const notes = Array.isArray(all[threadId]) ? all[threadId] : [];
    notes.push(line);
    all[threadId] = notes;
    const t = store.getThread(threadId);
    if (hold || (t && t.heldNotices)) {
      store.updateThread(threadId, { heldNotices: notes.length });
      pushThreadsChanged();
    }
    store.saveNow();
  }

  /**
   * Dedupe key for one worker run (#1426). Marks it noticed and returns
   * true the first time; a replayed finish returns false. "A missed wake
   * is cheaper than a duplicate one."
   * @param {object} worker
   * @param {string} key
   */
  function claimNoticeKey(worker, key) {
    if (!key) return true;
    if (worker.noticeKey === key) return false;
    store.updateThread(worker.id, { noticeKey: key });
    return true;
  }

  /**
   * Queue a line for a thread and try to deliver it as a run. Same rules as
   * worker-finished notices: idle threads start immediately, a running
   * thread flushes at its own terminal. The caller owns the prefix (peer
   * lines arrive as `[peer from …]`); do not add `[orchestration]`.
   * Unknown threadId is a silent no-op. Never throws.
   * @param {{ threadId?: unknown, line?: unknown, resume?: boolean }} [input]
   */
  function deliverNotice(input) {
    try {
      const threadId =
        input && input.threadId != null ? String(input.threadId) : "";
      if (!threadId || !store.getThread(threadId)) return;
      const line = input && input.line != null ? String(input.line) : "";
      if (!line) return;
      // Auto-resume after restart is the user's standing consent (#1426).
      if (input.resume) store.updateThread(threadId, { heldNotices: null });
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
    let runId = "";
    const msgs = store.getMessages(threadId) || [];
    for (let i = msgs.length - 1; i >= 0 && !(line && runId); i--) {
      const m = msgs[i];
      if (!m) continue;
      if (!runId && m.runId) runId = String(m.runId);
      if (!line && m.role === "assistant" && m.text != null && String(m.text)) {
        line = String(m.text).split(/\r?\n/)[0];
      }
    }
    if (!claimNoticeKey(thread, runId)) return;
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
        merge +
        safeWorkerResultBlock(thread),
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
    const notes = queues()[threadId];
    if (!Array.isArray(notes) || notes.length === 0) return;
    if (active.has(threadId)) return;
    const thread = store.getThread(threadId);
    if (!thread) {
      dropQueue(threadId);
      return;
    }
    // Held after a restart until the user resumes the crew (#1426).
    if (thread.heldNotices) return;
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
    dropQueue(threadId);
    store.save();
    const prompt = noticePrompt(notes);
    // The start below is deferred, so a queued drain from the same terminal
    // would win the idle slot and this notice would bounce off "already
    // active" (#1501). Hold the drain until the notice turn owns the thread.
    noticeStarting.add(threadId);
    let started = false;
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
      .then(() => {
        started = true;
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
    })
      .finally(() => {
        noticeStarting.delete(threadId);
        // A notice turn that already ended skipped the drain while held
        // above; run it now. A refused notice leaves the queue parked.
        if (started && !active.has(threadId)) ctx.maybeDrainQueued(threadId);
      });
  }

  /** @param {string} threadId */
  function isNoticeStarting(threadId) {
    return noticeStarting.has(threadId);
  }

  /**
   * A worker whose branch ref (current, or kept after GC / a missing dir)
   * still has commits off its base (#1404). A null worktreePath does not
   * mean nothing was left to land. Unknown counts as unlanded.
   * ponytail: sync git per excess worker; retained ones re-check on every
   * crew terminal. Cache by ref sha if crews grow past a handful kept.
   * @param {object} t
   * @returns {boolean}
   */
  function holdsUnlandedBranch(t) {
    const branch = t.branch || t.retainedBranch;
    if (!branch) return false;
    if (String(t.prState || "").toUpperCase() === "MERGED") return false;
    const project = store.getProject(t.projectId);
    if (!project || !project.path || project.remoteHost) return true;
    if (!fs.existsSync(project.path)) return true;
    try {
      // Ref deleted (merged and cleaned, or by hand): nothing left to keep.
      const ref = gitTry(project.path, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}^{commit}`,
      ]);
      if (!ref.ok) return false;
      const base = recordedBaseBranch(t) || repoDefaultBranch(project.path);
      return !branchLanded(project.path, branch, base);
    } catch {
      return true;
    }
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
      if (holdsUnlandedBranch(t)) continue;
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
    const pending = queues()[threadId];
    dropQueue(threadId);
    store.save();
    if (Array.isArray(pending) && pending.length > 0) {
      // Same trace as flushOrchNotices' undeliverable path: the orchestrator
      // still sees what its crew did, as an event that starts no run.
      const body = pending.join("\n");
      const headed = /^\s*\[/.test(body) ? body : "[orchestration] " + body;
      appendMessage(threadId, "event", headed);
    }
    return { stopped, traced: !!(pending && pending.length > 0) };
  }

  /**
   * "Resume crew" (#1426): release the hold a restart put on this lead's
   * notices and deliver them under the usual budget and auto-turn gates.
   * @param {{ threadId?: unknown }} input
   */
  function resumeCrew(input) {
    const threadId = input && input.threadId != null ? String(input.threadId) : "";
    if (!store.getThread(threadId)) throw new Error(`Unknown thread: ${threadId}`);
    store.updateThread(threadId, { heldNotices: null });
    store.save();
    pushThreadsChanged();
    flushOrchNotices(threadId);
  }

  /**
   * Boot: tell each lead about workers a crash or quit cut off mid-run
   * (#1426), held until the user resumes. Keyed by the interruption, so a
   * second boot adds nothing. Never throws.
   */
  function noticeInterruptedWorkers() {
    for (const t of store.getThreads()) {
      try {
        if (t.interruptedBy !== "restart" || !t.orchWorker || !t.handoffFrom) continue;
        const parentId = String(t.handoffFrom);
        if (!store.getThread(parentId)) continue;
        if (!claimNoticeKey(t, `restart:${t.interruptedAt}`)) continue;
        enqueueNotice(parentId, interruptedLine(t), true);
      } catch {
        // one bad row must not block the rest
      }
    }
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
    isNoticeStarting,
    resumeCrew,
    noticeInterruptedWorkers,
    cancelAll() {
      for (const id of [...codexReleaseFlush.keys()]) {
        cancelCodexReleaseFlush(id);
      }
      recentlyReleasedCodex.clear();
      codexParkNotified.clear();
    },
  };
}

/**
 * The lead's notice for a worker a restart cut off: where its work is and
 * whether anything is uncommitted.
 * @param {object} t - the worker
 */
function interruptedLine(t) {
  const title = t.title ? ` ("${t.title}")` : "";
  let where = "";
  if (t.worktreePath) {
    const head = gitTry(t.worktreePath, ["log", "-1", "--format=%h %s"], { timeout: 5000 });
    const dirty = gitTry(t.worktreePath, ["status", "--porcelain"], { raw: true, timeout: 5000 });
    const changed = dirty.ok ? dirty.stdout.split("\n").filter((l) => l.trim()).length : null;
    where =
      ` Worktree: ${t.worktreePath}, branch ${t.branch || "(unknown)"}.` +
      (head.ok && head.stdout ? ` Last commit: ${String(head.stdout).trim()}.` : "") +
      (changed == null
        ? ""
        : changed
          ? ` The tree has ${changed} uncommitted change${changed === 1 ? "" : "s"}.`
          : " The tree is clean.");
  }
  return (
    `Worker thread ${t.id}${title} was interrupted by an app restart mid-run and is not running.` +
    where +
    ` Decide whether to re-dispatch it (thread_send) or review what it left.`
  );
}

/** queueOrchNotice never throws; a broken block just drops out. */
function safeWorkerResultBlock(thread) {
  try {
    return workerResultBlock(thread);
  } catch {
    return "";
  }
}

module.exports = { createOrchNotices, workerResultBlock, WORKER_RESULT_MAX };
