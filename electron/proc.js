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
 * True when this ChildProcess still owns a live pid. `child.pid` survives
 * exit, so exitCode/signalCode plus kill(pid, 0) are the reuse guard —
 * never signal a pid we only found by scanning.
 *
 * @param {import("node:child_process").ChildProcess | null | undefined} child
 */
function childStillRunning(child) {
  if (!child || !child.pid) return false;
  if (child.exitCode != null || child.signalCode != null) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {{
 *   timer: ReturnType<typeof setTimeout> | null,
 *   done: Promise<void>,
 *   ref: () => void,
 * }} KillArm
 */

/** @type {Map<object, KillArm>} */
const pendingKills = new Map();

function graceMs(sigkillAfterMs) {
  const n = Number(sigkillAfterMs);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Shared TERM → wait → KILL. One arm per child: a second call joins the
 * in-flight timer instead of stacking SIGKILLs (PID-reuse).
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} sigkillAfterMs
 * @param {{ unref: boolean }} opts
 * @returns {KillArm}
 */
function armKillTree(child, sigkillAfterMs, opts) {
  const existing = pendingKills.get(child);
  if (existing) return existing;

  /** @type {KillArm} */
  const arm = {
    timer: null,
    done: Promise.resolve(),
    ref() {
      if (arm.timer && typeof arm.timer.ref === "function") arm.timer.ref();
    },
  };
  let settled = false;
  /** @type {(() => void) | null} */
  let resolveDone = null;
  arm.done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function finish() {
    if (settled) return;
    settled = true;
    if (arm.timer) {
      clearTimeout(arm.timer);
      arm.timer = null;
    }
    if (child && typeof child.removeListener === "function") {
      child.removeListener("exit", finish);
      child.removeListener("close", finish);
    }
    pendingKills.delete(child);
    if (resolveDone) resolveDone();
  }

  if (!childStillRunning(child)) {
    if (resolveDone) resolveDone();
    return arm;
  }

  pendingKills.set(child, arm);
  if (typeof child.once === "function") {
    child.once("exit", finish);
    child.once("close", finish);
  }
  if (settled || !childStillRunning(child)) {
    finish();
    return arm;
  }

  signalGroup(child, "SIGTERM");
  if (settled) return arm;

  arm.timer = setTimeout(() => {
    arm.timer = null;
    if (settled) return;
    if (childStillRunning(child)) {
      signalGroup(child, "SIGKILL");
    }
    if (settled) return;
    // Prefer `exit` so Node reaps (zombies still look alive to kill 0).
    // Cap the wait: a missing event must not hang quit.
    arm.timer = setTimeout(finish, 250);
    if (opts.unref && arm.timer && typeof arm.timer.unref === "function") {
      arm.timer.unref();
    }
  }, graceMs(sigkillAfterMs));
  if (opts.unref && typeof arm.timer.unref === "function") arm.timer.unref();
  return arm;
}

/**
 * SIGTERM the child's process group, then SIGKILL after `sigkillAfterMs`.
 * Returns the escalation timer so callers can clearTimeout in finish().
 *
 * Fire-and-forget for in-app Stop: the timer is unref'd so Stop is not held
 * open for the grace period. Final app exit must await awaitKillTree /
 * awaitPendingKills before app.exit — merely ref'ing is not enough against
 * an explicit exit, which discards timers (#1232).
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} sigkillAfterMs
 * @returns {ReturnType<typeof setTimeout> | null}
 */
function killTree(child, sigkillAfterMs) {
  return armKillTree(child, sigkillAfterMs, { unref: true }).timer;
}

/**
 * Final-teardown kill: TERM, wait for exit or the grace deadline, KILL
 * survivors. Resolves when the child has exited, or shortly after SIGKILL
 * if the exit event never arrives. Already-dead children resolve immediately
 * (no unconditional grace wait). Joins an in-flight killTree on the same
 * child and refs its timer so the wait outlives unref.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} sigkillAfterMs
 * @returns {Promise<void>}
 */
function awaitKillTree(child, sigkillAfterMs) {
  const arm = armKillTree(child, sigkillAfterMs, { unref: false });
  arm.ref();
  return arm.done;
}

/**
 * Await every in-flight killTree/awaitKillTree. Refs those timers so an
 * explicit app.exit later still happens after SIGKILL. Never rejects.
 * Empty pending set resolves immediately.
 *
 * @returns {Promise<void>}
 */
async function awaitPendingKills() {
  const arms = [...pendingKills.values()];
  for (const arm of arms) arm.ref();
  await Promise.all(arms.map((arm) => Promise.resolve(arm.done).catch(() => {})));
}

module.exports = {
  killTree,
  awaitKillTree,
  awaitPendingKills,
  agentSpawnOptions,
  signalGroup,
};
