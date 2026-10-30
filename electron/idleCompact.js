"use strict";

/**
 * Opt-in idle-thread compaction (issue #1765, AppSettings.idleCompactClaudeThreads).
 *
 * The "Compact first" chip (ThreadView.tsx handleCompact, shown around the
 * cold-compact window computed by src/contextRing.ts coldCompactTokens)
 * only appears AFTER the hour prompt-cache TTL has already lapsed, and the
 * user has to click it. This scheduler runs the identical mechanism
 * earlier and automatically: a bare `/compact` user turn so the provider
 * (Claude) runs its own native compaction (electron/compaction.js,
 * isNativeCompactTurn). Same call as the chip: runner.startRun({ threadId,
 * prompt: "/compact" }).
 */

const { randomUUID } = require("node:crypto");
const services = require("./services.js");

/** Keep in sync with CLAUDE_CACHE_TTL_MS (60 min) in src/contextRing.ts. */
const IDLE_COMPACT_MIN_IDLE_MS = 50 * 60 * 1000;
const IDLE_COMPACT_MAX_IDLE_MS = 58 * 60 * 1000;
/** Keep in sync with COLD_COMPACT_MIN_TOKENS in src/contextRing.ts. */
const IDLE_COMPACT_MIN_TOKENS = 50_000;

const IDLE_COMPACT_NOTE = "Compacted while idle to keep the prompt cache warm";

/**
 * True when `thread` is a Claude thread that has sat idle 50-58 minutes
 * (lastActivityAt = thread.updatedAt, same clock coldCompactTokens uses)
 * with a large-enough context, is not working/archived/trashed/snoozed/
 * settled or parked on quota-wait, and has not already been claimed for
 * this idle window.
 * @param {object} thread
 * @param {number | null | undefined} contextTokens
 * @param {number} now
 * @returns {boolean}
 */
function isIdleCompactCandidate(thread, contextTokens, now) {
  if (!thread || thread.provider !== "claude" || !thread.sessionId) {
    return false;
  }
  if (thread.status === "working" || thread.status === "quota-wait") {
    return false;
  }
  if (thread.archived || services.isTrashed(thread)) return false;
  if (thread.snoozedUntil != null && thread.snoozedUntil > now) return false;
  if (thread.settledOverride === "settled") return false;
  // Claimed by an earlier tick for this same idle window; a new turn
  // (electron/runner.js startRunFolded) clears this so the thread is
  // eligible again once it next goes cold.
  if (thread.idleCompactedAt != null) return false;
  if (contextTokens == null || contextTokens < IDLE_COMPACT_MIN_TOKENS) {
    return false;
  }
  const idleMs = now - thread.updatedAt;
  return idleMs >= IDLE_COMPACT_MIN_IDLE_MS && idleMs <= IDLE_COMPACT_MAX_IDLE_MS;
}

/**
 * One compaction turn. Claims the thread first so a slow/awaited run
 * cannot let a later tick in the same process double-fire, then appends a
 * quiet note once the turn is launched.
 * @param {{ store: object, runner: { startRun: Function }, broadcast?: Function }} ctx
 * @param {{ id: string }} thread
 * @param {number} now
 */
async function compactIdleThread(ctx, thread, now) {
  const { store, runner, broadcast } = ctx;
  store.updateThread(thread.id, { idleCompactedAt: now });
  try {
    await runner.startRun({
      threadId: thread.id,
      prompt: "/compact",
      fromIdleCompact: true,
    });
  } catch {
    // Daily budget hit mid-scan, session gone, etc: leave the claim so
    // this thread is not retried every tick; a new turn clears it.
    return;
  }
  store.appendMessage(thread.id, {
    id: randomUUID(),
    role: "event",
    text: IDLE_COMPACT_NOTE,
    createdAt: Date.now(),
  });
  store.save();
  if (typeof broadcast === "function") {
    broadcast("threads:changed", services.listThreads(store));
  }
}

/**
 * One unref'd interval (default 60s) that compacts qualifying idle Claude
 * threads one at a time, never two at once. Off unless
 * settings.idleCompactClaudeThreads is true. Skips the whole tick while
 * the daily budget is already spent (services.assertUnderDailyBudget) —
 * the same gate startRun itself enforces, checked here first so a maxed
 * budget does not spend a tick throwing starts.
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {{ startRun: Function }} opts.runner
 * @param {Function} [opts.broadcast]
 * @param {number} [opts.intervalMs]
 * @param {() => number} [opts.now]
 * @param {typeof setInterval} [opts.setIntervalFn]
 * @param {typeof clearInterval} [opts.clearIntervalFn]
 */
function createIdleCompactScheduler(opts) {
  const store = opts.store;
  const runner = opts.runner;
  const broadcast = opts.broadcast;
  const intervalMs = opts.intervalMs != null ? opts.intervalMs : 60_000;
  const nowFn = opts.now || Date.now;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;

  let running = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  /**
   * @returns {Promise<{ ran: boolean, compacted?: number }>}
   */
  async function trigger() {
    if (running) return { ran: false };
    running = true;
    try {
      if (store.getSettings().idleCompactClaudeThreads !== true) {
        return { ran: true, compacted: 0 };
      }
      try {
        services.assertUnderDailyBudget(store);
      } catch {
        return { ran: true, compacted: 0 };
      }
      const now = nowFn();
      const candidates = store.getThreads().filter((t) => {
        const usage = store.getUsage(t.id);
        return isIdleCompactCandidate(t, usage && usage.contextTokens, now);
      });
      for (const thread of candidates) {
        await compactIdleThread({ store, runner, broadcast }, thread, nowFn());
      }
      return { ran: true, compacted: candidates.length };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer != null) return;
    timer = setIntervalFn(() => {
      void trigger();
    }, intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer != null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  return { trigger, start, stop, isRunning: () => running };
}

module.exports = {
  IDLE_COMPACT_MIN_IDLE_MS,
  IDLE_COMPACT_MAX_IDLE_MS,
  IDLE_COMPACT_MIN_TOKENS,
  IDLE_COMPACT_NOTE,
  isIdleCompactCandidate,
  createIdleCompactScheduler,
};
