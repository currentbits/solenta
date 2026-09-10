"use strict";

const { cacheEnv } = require("./verifyEfficiency.js");

/**
 * Spawn options for agent CLIs (claude, codex, kimi, opencode, generic).
 *
 * POSIX: detached so killTree can signal the process group.
 * Win32: do NOT detach. `detached: true` is CREATE_NEW_PROCESS_GROUP |
 * DETACHED_PROCESS. Combined with cross-spawn of a `.cmd` shim, the parent
 * waits on cmd.exe (exit 0, empty pipes) while the node grandchild's stdout
 * never arrives — smoke pass C, issue #480. Process-group kill already
 * falls back on Windows (`process.kill(-pid)` throws).
 *
 * `platform` is injectable so tests can lock the win32 branch on macOS.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {import("node:child_process").StdioOptions} [opts.stdio]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {NodeJS.Platform} [opts.platform]
 */
function agentSpawnOptions(opts = {}) {
  const platform = opts.platform || process.platform;
  const out = {
    cwd: opts.cwd,
    shell: false,
    detached: platform !== "win32",
    windowsHide: platform === "win32",
    stdio: opts.stdio,
  };
  const extra = opts.cwd
    ? cacheEnv({ cwd: opts.cwd, env: opts.env || process.env })
    : {};
  if (Object.keys(extra).length) {
    out.env = { ...(opts.env || process.env), ...extra };
  } else if (opts.env) {
    out.env = opts.env;
  }
  return out;
}

/**
 * Signal a child and its process group. Group kill needs the child to be
 * a group leader (`detached: true` at spawn). Falls back to the child pid
 * if the group signal throws (no group, already dead, Windows).
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} sig
 */
function signalGroup(child, sig) {
  const pid = child && child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already dead
    }
  }
}

/**
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 */
function childExited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
}

/**
 * In-flight TERM→KILL jobs, keyed by the ChildProcess we own. Re-killing the
 * same child returns the same promise; SIGKILL is skipped once `exit` has
 * fired so a reused pid is never signalled.
 * @type {Map<object, { child: object, pid: number, timer: ReturnType<typeof setTimeout> | null, promise: Promise<void>, hold: boolean }>}
 */
const jobs = new Map();

/**
 * SIGTERM the child's process group, then SIGKILL after `sigkillAfterMs`
 * if this ChildProcess still has not exited. Idempotent per child.
 *
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 * @param {number} sigkillAfterMs
 */
function startKill(child, sigkillAfterMs) {
  if (!child) {
    return { timer: null, promise: Promise.resolve() };
  }
  const existing = jobs.get(child);
  if (existing) return existing;

  const pidAtStart = child.pid;
  if (!pidAtStart || childExited(child)) {
    return { timer: null, promise: Promise.resolve() };
  }

  signalGroup(child, "SIGTERM");

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let settled = false;
  /** @type {() => void} */
  let resolveFn = () => {};
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });

  const job = { child, pid: pidAtStart, timer: null, promise, hold: false };
  jobs.set(child, job);

  function finish() {
    if (settled) return;
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
      job.timer = null;
    }
    try {
      child.removeListener("exit", onExit);
    } catch {
      // ignore
    }
    jobs.delete(child);
    resolveFn();
  }

  function onExit() {
    finish();
  }

  child.once("exit", onExit);
  if (childExited(child)) {
    finish();
    return job;
  }

  const delay = Math.max(0, Number(sigkillAfterMs) || 0);
  timer = setTimeout(() => {
    // Only the ChildProcess we started killing: skip if it already exited
    // (pid may have been reused by an unrelated process).
    if (!childExited(child) && child.pid === pidAtStart) {
      signalGroup(child, "SIGKILL");
    }
    if (childExited(child)) {
      finish();
      return;
    }
    // Wait for waitpid so callers don't observe a zombie. Bound so a child
    // that never emits 'exit' cannot hang quit. hasRef() is false inside a
    // fired timer, so copy hold from the job (reapTree / awaitPendingKills).
    timer = setTimeout(finish, 250);
    job.timer = timer;
    if (!job.hold && typeof timer.unref === "function") timer.unref();
  }, delay);
  job.timer = timer;
  return job;
}

/**
 * SIGTERM the child's process group, then SIGKILL after `sigkillAfterMs`.
 * Returns the escalation timer so callers can clearTimeout in finish().
 * Fire-and-forget: the timer is unref'd so ordinary Stop does not hold the
 * event loop. Final app exit must `reapTree` / `awaitPendingKills` before
 * `app.exit` — a ref'd timer is discarded by an explicit exit (#1232).
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} sigkillAfterMs
 * @returns {ReturnType<typeof setTimeout> | null}
 */
function killTree(child, sigkillAfterMs) {
  const job = startKill(child, sigkillAfterMs);
  job.hold = false;
  if (job.timer && typeof job.timer.unref === "function") job.timer.unref();
  return job.timer;
}

/**
 * Awaitable teardown for shutdown: TERM, wait for exit or the grace
 * deadline, KILL survivors, then resolve. Already-dead children resolve
 * immediately. The escalation timer is ref'd so a Node parent with no
 * other handles still lives long enough to send SIGKILL.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} sigkillAfterMs
 * @returns {Promise<void>}
 */
function reapTree(child, sigkillAfterMs) {
  const job = startKill(child, sigkillAfterMs);
  job.hold = true;
  if (job.timer && typeof job.timer.ref === "function") job.timer.ref();
  return job.promise;
}

/**
 * Wait for every in-flight killTree/reapTree job. Re-refs escalation
 * timers so an explicit exit cannot outrun SIGKILL. Never rejects.
 *
 * @returns {Promise<void>}
 */
function awaitPendingKills() {
  const waiting = [];
  for (const job of jobs.values()) {
    job.hold = true;
    if (job.timer && typeof job.timer.ref === "function") job.timer.ref();
    waiting.push(job.promise);
  }
  return Promise.allSettled(waiting).then(() => {});
}

module.exports = {
  killTree,
  reapTree,
  awaitPendingKills,
  agentSpawnOptions,
  signalGroup,
};
