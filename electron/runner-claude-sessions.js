"use strict";

// createRunner seam: kept-alive interactive Claude CLIs (#1447, seam 6).
// Follows the seam convention in the header of electron/runner-watchdogs.js.
// startClaudeRun and stopAll stay in runner.js and reach the Map and
// CLAUDE_ACK_MS through this factory's return.

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createClaudeSessions(ctx) {
  const { active, finishRunningSubagents } = ctx;

  /**
   * Live interactive Claude CLI processes per thread, kept across turns so
   * harness background tasks survive turn settle and the permission channel
   * never closes mid-request (issue #8). Reused when the spawn parameters
   * still match; killed on param change, thread delete, idle timeout, or
   * app quit. `dispatch` rebinds to the current turn's handlers on reuse.
   * @type {Map<string, { handle: object, dispatch: { onEvent: Function, onExit: Function, onError: Function }, key: string, idleTimer: ReturnType<typeof setTimeout> | null }>}
   */
  const claudeSessions = new Map();

  // ponytail: fixed idle ceiling — background work longer than this must
  // detach (nohup); add child-process introspection if that ever hurts.
  const CLAUDE_IDLE_REAP_MS = 30 * 60 * 1000;
  // A reused warm CLI answers a stdin turn in milliseconds (measured on 2.1.219:
  // command_lifecycle at 0ms, system/init at ~31-46ms), so this is ~1000x the
  // real ACK. Read at arm time so a test can shorten the window.
  const CLAUDE_ACK_MS = 60_000;

  // ponytail: fixed LRU cap — an 8-worker fan-out otherwise leaves 8 idle CLIs
  // resident for the full half hour (issue #36). Make it a setting if 3 chafes.
  const CLAUDE_IDLE_MAX = 3;

  /** Kill and forget a thread's kept-alive Claude CLI (if any). */
  function disposeClaudeSession(threadId) {
    const sess = claudeSessions.get(threadId);
    if (!sess) return;
    claudeSessions.delete(threadId);
    if (sess.idleTimer) clearTimeout(sess.idleTimer);
    try {
      if (sess.handle) sess.handle.kill();
    } catch {
      // already dead
    }
    finishRunningSubagents(threadId);
  }

  /**
   * Release a thread's kept-alive Claude CLI because the thread was archived,
   * settled, or deleted (#1383). A thread can archive ITSELF through the
   * thread_archive tool, so its turn may still be live: killing now SIGTERMs
   * the process making that call and the turn lands as "Run error (exit
   * 143)". Mid-turn, flag the session; scheduleClaudeIdleReap disposes it as
   * soon as the turn settles.
   */
  function retireClaudeSession(threadId) {
    const sess = claudeSessions.get(threadId);
    if (!sess) return;
    if (active.has(threadId)) {
      sess.retireAfterTurn = true;
      return;
    }
    disposeClaudeSession(threadId);
  }

  /** Arm the idle reaper after a turn settles; disarmed on reuse. */
  function scheduleClaudeIdleReap(threadId) {
    const sess = claudeSessions.get(threadId);
    if (sess && sess.retireAfterTurn) {
      disposeClaudeSession(threadId);
      return;
    }
    if (!sess || sess.idleTimer) return;
    sess.idleTimer = setTimeout(
      () => disposeClaudeSession(threadId),
      CLAUDE_IDLE_REAP_MS,
    );
    // Never hold the process open for a reap timer.
    if (typeof sess.idleTimer.unref === "function") sess.idleTimer.unref();
    // Re-insert so Map order reads least → most recently idled, then reap
    // everything past the cap. Sessions mid-turn have no timer: never counted,
    // never killed.
    claudeSessions.delete(threadId);
    claudeSessions.set(threadId, sess);
    const idle = [...claudeSessions]
      .filter(([, s]) => s.idleTimer)
      .map(([id]) => id);
    for (const id of idle.slice(0, Math.max(0, idle.length - CLAUDE_IDLE_MAX))) {
      disposeClaudeSession(id);
    }
  }

  return {
    claudeSessions,
    CLAUDE_ACK_MS,
    disposeClaudeSession,
    retireClaudeSession,
    scheduleClaudeIdleReap,
  };
}

module.exports = { createClaudeSessions };
