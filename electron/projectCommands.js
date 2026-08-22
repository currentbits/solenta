"use strict";

/**
 * Per-project setup + named quick actions (issue #153).
 *
 * setupCommand runs after a NEW worktree is created (async, logged). A
 * failed command never undoes the worktree. Named quickActions are the
 * same shell runner, triggered from the thread header.
 */

const { randomUUID } = require("node:crypto");
const {
  normalizeCommand,
  runVerifyCommand,
  VERIFY_TIMEOUT_MS,
  tailLog,
} = require("./verify.js");

/** Reserved actionId for the project's setupCommand. */
const SETUP_ID = "setup";
const QUICK_ACTION_MAX = 8;
const ACTION_NAME_MAX = 32;
/** npm install on a cold cache is slower than a test suite. */
const SETUP_TIMEOUT_MS = 30 * 60_000;
/** Tail dropped into the transcript event on failure. */
const EVENT_LOG_MAX = 1500;

/** @type {Map<string, Promise<unknown>>} */
const inflight = new Map();

let runFn = runVerifyCommand;

/**
 * Test hook: swap the shell runner. Pass null/undefined to restore.
 * @param {typeof runVerifyCommand | null | undefined} fn
 */
function setRunCommandFn(fn) {
  runFn = typeof fn === "function" ? fn : runVerifyCommand;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeSetupCommand(raw) {
  return normalizeCommand(raw);
}

/**
 * Drop junk rows, cap the list, mint ids. Empty / non-array → null so the
 * key can be deleted from the stored project.
 *
 * @param {unknown} raw
 * @returns {Array<{ id: string, name: string, command: string }> | null}
 */
function normalizeQuickActions(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const name =
      typeof row.name === "string"
        ? row.name.trim().slice(0, ACTION_NAME_MAX)
        : "";
    const command = normalizeCommand(row.command);
    if (!name || !command) continue;
    let id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id || id === SETUP_ID || seen.has(id)) id = randomUUID();
    seen.add(id);
    out.push({ id, name, command });
    if (out.length >= QUICK_ACTION_MAX) break;
  }
  return out.length ? out : null;
}

/**
 * @param {number} ms
 */
function formatDuration(ms) {
  const s = Number(ms) / 1000;
  if (!Number.isFinite(s) || s < 0) return "0s";
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}

/**
 * @param {string} name
 * @param {"start" | "end"} phase
 * @param {{ command: string, ok?: boolean, timedOut?: boolean, exitCode?: number | null, durationMs?: number, log?: string }} ran
 */
function eventText(name, phase, ran) {
  const tag = `[${name}]`;
  if (phase === "start") {
    return `${tag} running ${ran.command}`;
  }
  if (ran.ok) {
    return `${tag} ok in ${formatDuration(ran.durationMs || 0)}`;
  }
  const why = ran.timedOut
    ? `timed out in ${formatDuration(ran.durationMs || 0)}`
    : `failed: exit ${ran.exitCode == null ? "?" : ran.exitCode} in ${formatDuration(ran.durationMs || 0)}`;
  const log = ran.log ? `\n${tailLog(ran.log, EVENT_LOG_MAX)}` : "";
  return `${tag} ${why}${log}`;
}

/**
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {string} text
 */
function appendEvent(store, threadId, text) {
  const list = (store.getMessages(threadId) || []).slice();
  list.push({
    id: randomUUID(),
    role: "event",
    text,
    createdAt: Date.now(),
  });
  store.setMessages(threadId, list);
}

/**
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {(channel: string, payload: unknown) => void} [broadcast]
 */
function pushCommandState(store, threadId, broadcast) {
  if (typeof broadcast !== "function") return;
  try {
    const { getThreadDetail, listThreads } = require("./services.js");
    broadcast(
      "thread:updated",
      getThreadDetail(store, threadId, null, { markVisited: false }),
    );
    broadcast("threads:changed", listThreads(store));
  } catch {
    // thread gone mid-run
  }
}

/**
 * @param {object | null | undefined} project
 * @param {string | null | undefined} actionId
 * @returns {{ id: string, name: string, command: string, timeoutMs: number } | null}
 */
function resolveCommand(project, actionId) {
  if (!actionId || actionId === SETUP_ID) {
    const command = normalizeSetupCommand(project && project.setupCommand);
    if (!command) return null;
    return {
      id: SETUP_ID,
      name: "setup",
      command,
      timeoutMs: SETUP_TIMEOUT_MS,
    };
  }
  const actions = Array.isArray(project && project.quickActions)
    ? project.quickActions
    : [];
  const row = actions.find((a) => a && a.id === actionId);
  if (!row) return null;
  const command = normalizeCommand(row.command);
  if (!command) return null;
  const name =
    typeof row.name === "string" && row.name.trim()
      ? row.name.trim().slice(0, ACTION_NAME_MAX)
      : "action";
  return {
    id: row.id,
    name,
    command,
    timeoutMs: VERIFY_TIMEOUT_MS,
  };
}

/**
 * In-flight setup/action for this thread, or a resolved null.
 * @param {string} threadId
 */
function waitForCommand(threadId) {
  return inflight.get(String(threadId)) || Promise.resolve(null);
}

/**
 * Fire-and-forget: run setupCommand in `cwd` if the project has one.
 * Never throws. Joins an in-flight command on the same thread.
 *
 * @param {{
 *   store: import("./store").Store,
 *   threadId: string,
 *   cwd: string,
 *   project: object | null,
 *   broadcast?: (channel: string, payload: unknown) => void,
 * }} opts
 * @returns {Promise<import("../src/shared/ipc").CommandRunResult | null>}
 */
function kickWorktreeSetup(opts) {
  const { store, threadId, cwd, project, broadcast } = opts;
  const resolved = resolveCommand(project, SETUP_ID);
  if (!resolved) return Promise.resolve(null);
  return enqueue(store, {
    threadId,
    cwd,
    project,
    resolved,
    broadcast,
  });
}

/**
 * @param {import("./store").Store} store
 * @param {{
 *   threadId: string,
 *   cwd: string,
 *   project: object | null,
 *   resolved: { id: string, name: string, command: string, timeoutMs: number },
 *   broadcast?: (channel: string, payload: unknown) => void,
 * }} args
 */
function enqueue(store, args) {
  const threadId = String(args.threadId);
  const existing = inflight.get(threadId);
  if (existing) return existing;
  const p = runOne(store, args).finally(() => {
    if (inflight.get(threadId) === p) inflight.delete(threadId);
  });
  inflight.set(threadId, p);
  return p;
}

/**
 * @param {import("./store").Store} store
 * @param {{
 *   threadId: string,
 *   cwd: string,
 *   project: object | null,
 *   resolved: { id: string, name: string, command: string, timeoutMs: number },
 *   broadcast?: (channel: string, payload: unknown) => void,
 * }} args
 */
async function runOne(store, args) {
  const { threadId, cwd, project, resolved, broadcast } = args;
  appendEvent(
    store,
    threadId,
    eventText(resolved.name, "start", { command: resolved.command }),
  );
  store.save();
  pushCommandState(store, threadId, broadcast);

  let ran;
  try {
    ran = await runFn({
      command: resolved.command,
      cwd,
      project,
      timeoutMs: resolved.timeoutMs,
    });
  } catch (err) {
    ran = {
      ok: false,
      exitCode: null,
      timedOut: false,
      log: err && err.message ? err.message : String(err),
      durationMs: 0,
    };
  }

  /** @type {import("../src/shared/ipc").CommandRunResult} */
  const result = {
    name: resolved.name,
    command: resolved.command,
    ok: Boolean(ran && ran.ok),
    exitCode: ran && ran.exitCode != null ? ran.exitCode : null,
    timedOut: Boolean(ran && ran.timedOut),
    log: ran && ran.log ? String(ran.log) : "",
    durationMs: ran && typeof ran.durationMs === "number" ? ran.durationMs : 0,
    at: Date.now(),
  };
  appendEvent(store, threadId, eventText(resolved.name, "end", result));
  store.save();
  pushCommandState(store, threadId, broadcast);
  return result;
}

/**
 * Run setupCommand (actionId omitted or "setup") or a named quick action.
 * Rejects when the thread/project/command is missing, a run is active, or
 * another command is already in flight on this thread. Command failure is
 * a result, not a throw.
 *
 * @param {import("./store").Store} store
 * @param {{ threadId: string, actionId?: string }} input
 * @param {{
 *   runner?: { isRunning: (id: string) => boolean },
 *   broadcast?: (channel: string, payload: unknown) => void,
 * }} [deps]
 * @returns {Promise<import("../src/shared/ipc").CommandRunResult>}
 */
async function runCommand(store, input, deps) {
  const threadId = input && input.threadId;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (deps && deps.runner && deps.runner.isRunning(threadId)) {
    throw new Error("A run is already active on this thread");
  }
  if (inflight.has(threadId)) {
    throw new Error("A setup or action is already running on this thread");
  }
  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }
  const resolved = resolveCommand(project, input && input.actionId);
  if (!resolved) {
    if (!input || !input.actionId || input.actionId === SETUP_ID) {
      throw new Error("No setup command set for this project");
    }
    throw new Error("Unknown quick action");
  }
  const cwd = thread.worktreePath || project.path || process.cwd();
  return enqueue(store, {
    threadId,
    cwd,
    project,
    resolved,
    broadcast: deps && deps.broadcast,
  });
}

module.exports = {
  SETUP_ID,
  QUICK_ACTION_MAX,
  ACTION_NAME_MAX,
  SETUP_TIMEOUT_MS,
  EVENT_LOG_MAX,
  normalizeSetupCommand,
  normalizeQuickActions,
  kickWorktreeSetup,
  waitForCommand,
  runCommand,
  setRunCommandFn,
  formatDuration,
  eventText,
};
