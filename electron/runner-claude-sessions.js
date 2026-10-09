"use strict";

// createRunner seam: kept-alive interactive Claude CLIs (#1447, seam 6).
// Follows the seam convention in the header of electron/runner-watchdogs.js.
// startClaudeRun and stopAll stay in runner.js and reach the Map and
// CLAUDE_ACK_MS through this factory's return.

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createClaudeSessions(ctx) {
  const { active, store, finishRunningSubagents } = ctx;

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

  // ponytail: an idle CLI running background subagents is never reaped
  // (#1443), but a lost <task-notification> would pin it forever, so the
  // exemption lapses this long after the session went idle. Read at arm
  // time so a test can shorten it.
  const CLAUDE_SUBAGENT_STALE_MS = 2 * 60 * 60 * 1000;

  /** Idle session kept alive because its thread still runs a subagent. */
  function pinnedBySubagent(threadId, sess) {
    const thread = store.getThread(threadId);
    if (!thread || !Array.isArray(thread.subagents)) return false;
    if (!thread.subagents.some((r) => r.status === "running")) return false;
    const staleMs =
      Number(process.env.CODER_CLAUDE_SUBAGENT_STALE_MS) ||
      CLAUDE_SUBAGENT_STALE_MS;
    return Date.now() - sess.idleSince < staleMs;
  }

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

  /**
   * Arm the idle reaper after a turn settles; disarmed on reuse. Also called
   * when a background subagent settles between turns, so a session the
   * subagent pinned becomes reapable again (#1443).
   */
  function scheduleClaudeIdleReap(threadId) {
    // Mid-turn sessions are never armed (a subagent can settle mid-turn).
    if (active.has(threadId)) return;
    const sess = claudeSessions.get(threadId);
    if (sess && sess.retireAfterTurn) {
      disposeClaudeSession(threadId);
      return;
    }
    if (!sess) return;
    const fresh = !sess.idleTimer;
    if (fresh) sess.idleSince = Date.now();
    else clearTimeout(sess.idleTimer);
    armIdleTimer(threadId, sess);
    if (!fresh) return;
    // Re-insert so Map order reads least → most recently idled, then reap
    // everything past the cap. Sessions mid-turn have no timer: never counted,
    // never killed. Subagent-pinned sessions count but are skipped.
    claudeSessions.delete(threadId);
    claudeSessions.set(threadId, sess);
    const idle = [...claudeSessions].filter(([, s]) => s.idleTimer);
    let excess = idle.length - CLAUDE_IDLE_MAX;
    for (const [id, s] of idle) {
      if (excess <= 0) break;
      if (pinnedBySubagent(id, s)) continue;
      disposeClaudeSession(id);
      excess -= 1;
    }
  }

  /**
   * Idle reap after CLAUDE_IDLE_REAP_MS, or — while a subagent pins the
   * session — a re-check at the staleness deadline.
   */
  function armIdleTimer(threadId, sess) {
    const reapMs =
      Number(process.env.CODER_CLAUDE_IDLE_REAP_MS) || CLAUDE_IDLE_REAP_MS;
    const staleMs =
      Number(process.env.CODER_CLAUDE_SUBAGENT_STALE_MS) ||
      CLAUDE_SUBAGENT_STALE_MS;
    const delay = pinnedBySubagent(threadId, sess)
      ? sess.idleSince + staleMs - Date.now()
      : reapMs;
    sess.idleTimer = setTimeout(() => {
      if (claudeSessions.get(threadId) !== sess) return;
      if (pinnedBySubagent(threadId, sess)) armIdleTimer(threadId, sess);
      else disposeClaudeSession(threadId);
    }, Math.max(0, delay));
    // Never hold the process open for a reap timer.
    if (typeof sess.idleTimer.unref === "function") sess.idleTimer.unref();
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
