"use strict";

// createRunner seam: stall + lane-heartbeat watchdogs (#1447, seam 1).
//
// Seam convention (template for every createRunner split step):
// - One flat file per seam, `electron/runner-<seam>.js`, exporting
//   `create<Seam>(ctx)`. Flat, not `electron/runner/`: package-app.sh and
//   package-cross.sh copy only `electron/*.js`, so a subdirectory would be
//   dropped from the packaged app.
// - `ctx` is built once in createRunner. Destructure deps at the top of the
//   factory so function bodies move verbatim. That is safe only for what
//   already exists when the factory runs: opts bindings, owned Maps, and the
//   hoisted function declarations inside createRunner.
// - Anything that does not exist yet at factory time (functions another seam
//   adds to ctx later, or a const defined after the factory call) must be read
//   lazily at call time: `ctx.startRun(...)`, never destructured.
// - The factory owns the seam's Maps and timers and returns its functions,
//   plus a `dispose()` for stopAll when it owns a timer.
// - Do not require("./runner.js") from a seam (circular); take module-level
//   runner functions such as resolveProvider through ctx.

const { heartbeatLane } = require("./mergeQueue.js");

/**
 * @param {object} ctx - createRunner context (see header)
 */
function createWatchdogs(ctx) {
  const {
    store,
    active,
    nowFn,
    resolveProvider,
    appendMessage,
    pushDetail,
    pushThreadsChanged,
  } = ctx;

  /**
   * Advisory stall sweep (issue #314). Scans every thread, not just `active`:
   * a working row with no live run is the zombie this issue names. Never
   * kills the CLI — a slow-but-alive stream clears stalledAt via stampLastEvent.
   * STALL_MS is read at check time so a test can shorten the window.
   */
  function checkStalls() {
    const stallMs = Number(process.env.CODER_STALL_MS) || 10 * 60 * 1000;
    const now = Date.now();
    for (const thread of store.getThreads()) {
      if (thread.status !== "working") continue;
      if (thread.awaitingInput) continue;
      if (thread.stalledAt) continue;
      const last = thread.lastEventAt ?? thread.runStartedAt ?? now;
      if (now - last <= stallMs) continue;
      store.updateThread(thread.id, { stalledAt: now });
      const provider = resolveProvider(thread);
      const mins = Math.max(1, Math.round((now - last) / 60000));
      appendMessage(
        thread.id,
        "event",
        `No output from the ${provider} CLI for ${mins} min — the turn may be hung. Stop and retry if it stays quiet.`,
      );
      store.save();
      pushDetail(thread.id, undefined, { skipStamp: true });
      pushThreadsChanged();
    }
  }

  /**
   * Reset lastBeat on every active lane thread so the 30-minute watchdog
   * does not recycle a live run. Idle / wedged lanes are left alone.
   * @param {{ now?: number }} [opts]
   */
  function heartbeatActiveLanes(opts) {
    const at = opts && opts.now != null ? opts.now : nowFn();
    for (const threadId of active.keys()) {
      const live = store.getThread(threadId);
      if (!live || !live.lane) continue;
      try {
        heartbeatLane({ store, threadId, now: at });
      } catch {
        // never break the runner
      }
    }
  }

  // Native timer (not setIntervalFn): tests replace that hook for sim ticks.
  const stallTimer = setInterval(() => {
    try {
      checkStalls();
    } catch {
      // never break the runner
    }
    try {
      heartbeatActiveLanes();
    } catch {
      // never break the runner
    }
  }, 15_000);
  if (typeof stallTimer.unref === "function") stallTimer.unref();

  return {
    checkStalls,
    heartbeatActiveLanes,
    dispose() {
      clearInterval(stallTimer);
    },
  };
}

module.exports = { createWatchdogs };
