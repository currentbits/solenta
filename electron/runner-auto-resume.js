"use strict";

// createRunner seam: opt-in resume after restart (issue #1512 I3). Follows
// the seam convention in the header of electron/runner-watchdogs.js.
// deliverNotice is read lazily from ctx; stopRun calls cancel(), stopAll
// calls cancelAll().
//
// A run that was live at quit or crash carries `interruptedAt` (stamped by
// runner.stopAll and store.recoverInterruptedRuns, cleared by any new run).
// When settings.resumeInterruptedRuns is on, each eligible thread gets ONE
// machine-delivered follow-up turn. `autoResumedAt` is the marker: written
// and saved before anything starts, cleared only by a human turn, so the
// same interruption is never resumed twice, not even across another crash.

const fs = require("node:fs");
const services = require("./services.js");

const RESUME_LINE =
  "[restart] The app restarted while you were working. Continue where you left off.";
const RESUME_EVENT = "Resumed after restart";
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CONCURRENCY = 2;
// ponytail: polls `active` to free a slot; a run-terminal hook if it ever matters.
const POLL_MS = 1000;
/** A refused start (budget, missing CLI) never shows up in `active`. */
const START_GRACE_MS = 30_000;

/**
 * @param {object} t
 * @param {number} now
 * @param {number} maxAgeMs
 */
function isResumable(t, now, maxAgeMs) {
  if (!t || !Number.isFinite(t.interruptedAt)) return false;
  if (now - t.interruptedAt > maxAgeMs) return false;
  if (t.autoResumedAt) return false;
  if (!t.sessionId) return false;
  if (services.isTrashed(t) || t.archived) return false;
  if (t.settledOverride === "settled" || t.memoryConsolidate === true) {
    return false;
  }
  if (t.worktreePath && !fs.existsSync(t.worktreePath)) return false;
  return true;
}

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createAutoResume(ctx) {
  const { store, active, appendMessage, pushDetail, pushThreadsChanged } =
    ctx;

  /** Thread ids marked for resume whose turn has not been delivered yet. */
  let queue = [];

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  async function waitFor(predicate, timeoutMs, pollMs) {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) return;
      await sleep(pollMs);
    }
  }

  /**
   * Resume every eligible interrupted thread, at most `concurrency` at once.
   * Resolves once each resumed turn has finished (or never started).
   * @param {{ now?: number, maxAgeMs?: number, concurrency?: number, pollMs?: number, startGraceMs?: number }} [opts]
   * @returns {Promise<string[]>} the thread ids that were marked for resume
   */
  async function resumeInterruptedRuns(opts = {}) {
    if (store.getSettings().resumeInterruptedRuns !== true) return [];
    const now = opts.now ?? Date.now();
    const maxAgeMs = opts.maxAgeMs ?? MAX_AGE_MS;
    const pollMs = opts.pollMs ?? POLL_MS;
    const startGraceMs = opts.startGraceMs ?? START_GRACE_MS;
    const ids = store
      .getThreads()
      .filter((t) => !active.has(t.id) && isResumable(t, now, maxAgeMs))
      .map((t) => t.id);
    if (ids.length === 0) return [];
    // Marker first and on disk (save() is debounced): a crash from here on
    // cannot resume these again.
    for (const id of ids) store.updateThread(id, { autoResumedAt: now });
    store.saveNow();
    pushThreadsChanged();
    queue = [...ids];

    const resumeOne = async (id) => {
      const t = store.getThread(id);
      if (!t || services.isTrashed(t) || active.has(id)) return;
      appendMessage(id, "event", RESUME_EVENT);
      store.save();
      pushDetail(id, null);
      ctx.deliverNotice({ threadId: id, line: RESUME_LINE });
      await waitFor(() => active.has(id), startGraceMs, pollMs);
      await waitFor(() => !active.has(id), Infinity, pollMs);
    };
    const lane = async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        try {
          await resumeOne(id);
        } catch {
          // one thread's failure must not stall the rest
        }
      }
    };
    await Promise.all(
      Array.from({ length: opts.concurrency ?? CONCURRENCY }, lane),
    );
    return ids;
  }

  /** Stop is sacred: drop a queued resume for this thread. */
  function cancel(threadId) {
    queue = queue.filter((id) => id !== String(threadId));
  }

  return {
    resumeInterruptedRuns,
    cancel,
    cancelAll() {
      queue = [];
    },
  };
}

module.exports = {
  createAutoResume,
  isResumable,
  RESUME_LINE,
  RESUME_EVENT,
};
