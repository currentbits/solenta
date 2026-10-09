"use strict";

/**
 * Per-project setup + named quick actions (issue #153).
 *
 * setupCommand runs after a NEW worktree is created (async, logged). A
 * failed command never undoes the worktree. Named quickActions are the
 * same shell runner, triggered from the thread header.
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  normalizeCommand,
  runVerifyCommand,
  VERIFY_TIMEOUT_MS,
  tailLog,
} = require("./verify.js");
const { effectiveCommands } = require("./repoConfig.js");

/** Reserved actionId for the project's setupCommand. */
const SETUP_ID = "setup";
/** Reserved actionId for solenta.json `onSettle` (#1531). */
const ON_SETTLE_ID = "onSettle";
/** Teardown should be quick; the merged-PR cleanup waits on it. */
const ON_SETTLE_TIMEOUT_MS = 2 * 60_000;
const QUICK_ACTION_MAX = 8;
const ACTION_NAME_MAX = 32;
/** npm install on a cold cache is slower than a test suite. */
const SETUP_TIMEOUT_MS = 30 * 60_000;
/** Tail dropped into the transcript event on failure. */
const EVENT_LOG_MAX = 1500;

/** @type {Map<string, Promise<unknown>>} */
const inflight = new Map();
/** Inflight promises that are a new worktree's setup, not a quick action. */
const setupJobs = new WeakSet();
/** Thrown when a solenta.json command has not been approved (#1506). */
const REPO_CONFIG_UNTRUSTED = "REPO_CONFIG_UNTRUSTED";
const SUBMODULE_COMMAND = "git submodule update --init --recursive";

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
    if (!id || id === SETUP_ID || id === ON_SETTLE_ID || seen.has(id)) id = randomUUID();
    seen.add(id);
    out.push({ id, name, command });
    if (out.length >= QUICK_ACTION_MAX) break;
  }
  return out.length ? out : null;
}

/**
 * Per-project defaults for new threads (#1501). Shape only: the provider
 * id is kept even when that CLI is not installed or unknown here, and
 * createThread validates it at use. A model is only meaningful next to
 * the provider it was picked for, so it is dropped without one. Empty →
 * null so the key can be deleted from the stored project.
 *
 * @param {unknown} raw
 * @returns {{ provider?: string, model?: string, reasoningEffort?: string, permissionMode?: string, lastUsed?: true } | null}
 */
function normalizeThreadDefaults(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { PERMISSION_MODES } = require("./services-shared.js");
  /** @param {unknown} v @param {number} max */
  const str = (v, max) =>
    typeof v === "string" && v.trim() && v.trim().length <= max
      ? v.trim()
      : "";
  /** @type {{ provider?: string, model?: string, reasoningEffort?: string, permissionMode?: string, lastUsed?: true }} */
  const out = {};
  const r = /** @type {Record<string, unknown>} */ (raw);
  const provider = str(r.provider, 64);
  if (provider) {
    out.provider = provider;
    const model = str(r.model, 100);
    if (model) out.model = model;
  }
  const effort = str(r.reasoningEffort, 32);
  if (effort) out.reasoningEffort = effort;
  if (typeof r.permissionMode === "string" && PERMISSION_MODES.has(r.permissionMode)) {
    out.permissionMode = r.permissionMode;
  }
  if (r.lastUsed === true) out.lastUsed = true;
  return Object.keys(out).length ? out : null;
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
 * Setup (actionId omitted / "setup") or a named quick action, after the
 * project-over-solenta.json precedence (#1506). `fromRepo` rows only run
 * once the project has approved the file's current command hash.
 *
 * @param {object | null | undefined} project
 * @param {string | null | undefined} actionId
 * @returns {{ id: string, name: string, command: string, timeoutMs: number, fromRepo: boolean, hash: string | null, trusted: boolean } | null}
 */
function resolveCommand(project, actionId) {
  const eff = effectiveCommands(project);
  const trust = { hash: eff.hash, trusted: eff.trusted };
  if (!actionId || actionId === SETUP_ID) {
    if (!eff.setup) return null;
    return {
      id: SETUP_ID,
      name: "setup",
      command: eff.setup.command,
      timeoutMs: SETUP_TIMEOUT_MS,
      fromRepo: eff.setup.fromRepo,
      ...trust,
    };
  }
  if (actionId === ON_SETTLE_ID) {
    if (!eff.onSettle) return null;
    return {
      id: ON_SETTLE_ID,
      name: "onSettle",
      command: eff.onSettle.command,
      timeoutMs: ON_SETTLE_TIMEOUT_MS,
      fromRepo: eff.onSettle.fromRepo,
      ...trust,
    };
  }
  const row = eff.quickActions.find((a) => a && a.id === actionId);
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
    fromRepo: row.fromRepo,
    ...trust,
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
 * The new-worktree setup job in flight on this thread, or null. Quick
 * actions are not setup: the agent never waits on those (#1506).
 * @param {string} threadId
 */
function pendingSetup(threadId) {
  const p = inflight.get(String(threadId));
  return p && setupJobs.has(p) ? p : null;
}

/**
 * Fire-and-forget after a NEW worktree: `git submodule update` when the
 * checkout has .gitmodules (best-effort, a failure is a warning event),
 * then the setup command (project setting, else an approved solenta.json
 * `setup`). An unapproved solenta.json setup is skipped with an event
 * pointing at the Setup button, which asks for approval. Never throws.
 * Joins an in-flight command on the same thread.
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
  let resolved = resolveCommand(project, SETUP_ID);
  if (resolved && resolved.fromRepo && !resolved.trusted) {
    appendEvent(
      store,
      threadId,
      "[setup] skipped: solenta.json setup needs your approval. Press Setup in the thread details to review and run it.",
    );
    store.save();
    pushCommandState(store, threadId, broadcast);
    resolved = null;
  }
  const submodules = hasGitmodules(cwd);
  if (!resolved && !submodules) return Promise.resolve(null);
  const id = String(threadId);
  const existing = inflight.get(id);
  if (existing) return existing;
  const p = (async () => {
    if (submodules) {
      await runOne(store, {
        threadId: id,
        cwd,
        project,
        resolved: {
          id: "submodules",
          name: "submodules",
          command: SUBMODULE_COMMAND,
          timeoutMs: SETUP_TIMEOUT_MS,
        },
        broadcast,
        // Never sit on a credential prompt nobody can see. The runner
        // uses `env` as the whole environment, so start from ours.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    }
    return resolved
      ? runOne(store, { threadId: id, cwd, project, resolved, broadcast })
      : null;
  })().finally(() => {
    if (inflight.get(id) === p) inflight.delete(id);
  });
  setupJobs.add(p);
  inflight.set(id, p);
  return p;
}

/**
 * solenta.json `onSettle` (#1531): run once in a worktree thread's checkout
 * when it settles. `onSettleAt` on the thread marks this settle as handled;
 * new activity clears it (clearSettledOnActivity), so the next settle runs
 * again. Unapproved → a skipped event, like setup. Never throws; the
 * promise resolves when the command finishes (or times out), so callers
 * that delete the worktree next can wait, and the rest ignore it.
 *
 * @param {{
 *   store: import("./store").Store,
 *   threadId: string,
 *   broadcast?: (channel: string, payload: unknown) => void,
 * }} opts
 * @returns {Promise<import("../src/shared/ipc").CommandRunResult | null>}
 */
function runOnSettle(opts) {
  try {
    const { store, threadId, broadcast } = opts;
    const thread = store.getThread(threadId);
    if (!thread || !thread.worktreePath || thread.onSettleAt != null) {
      return Promise.resolve(null);
    }
    if (!fs.existsSync(thread.worktreePath)) return Promise.resolve(null);
    const project = store.getProject(thread.projectId);
    const resolved = resolveCommand(project, ON_SETTLE_ID);
    if (!resolved) return Promise.resolve(null);
    store.updateThread(threadId, { onSettleAt: Date.now() });
    if (resolved.fromRepo && !resolved.trusted) {
      appendEvent(
        store,
        threadId,
        "[onSettle] skipped: solenta.json commands need your approval. Press On settle in the thread details to review and run it.",
      );
      store.save();
      pushCommandState(store, threadId, broadcast);
      return Promise.resolve(null);
    }
    // Not joined to `inflight`: a settled thread has no run, and a quick
    // action still going must not swallow the teardown.
    return runOne(store, {
      threadId: String(threadId),
      cwd: thread.worktreePath,
      project,
      resolved,
      broadcast,
    }).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

/** @param {string} cwd */
function hasGitmodules(cwd) {
  try {
    return fs.statSync(path.join(cwd, ".gitmodules")).isFile();
  } catch {
    return false;
  }
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
 *   env?: Record<string, string>,
 * }} args
 */
async function runOne(store, args) {
  const { threadId, cwd, project, resolved, broadcast, env } = args;
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
      ...(env ? { env } : {}),
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
 * @param {{ threadId: string, actionId?: string, trustRepoConfig?: string }} input
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
  let runProject = project;
  if (resolved.fromRepo && !resolved.trusted) {
    // One approval per project and command set (#1506): the renderer shows
    // the file's commands and sends back the hash it showed. A stale hash
    // (file edited meanwhile) re-prompts instead of approving unseen code.
    if (!resolved.hash || input.trustRepoConfig !== resolved.hash) {
      throw new Error(
        `${REPO_CONFIG_UNTRUSTED}: approve this repo's solenta.json commands before they run`,
      );
    }
    runProject = { ...project, repoConfigTrust: resolved.hash };
    store.setProjects(
      store.getProjects().map((p) => (p.id === project.id ? runProject : p)),
    );
    store.save();
  }
  const cwd = thread.worktreePath || project.path || process.cwd();
  return enqueue(store, {
    threadId,
    cwd,
    project: runProject,
    resolved,
    broadcast: deps && deps.broadcast,
  });
}

module.exports = {
  SETUP_ID,
  ON_SETTLE_ID,
  ON_SETTLE_TIMEOUT_MS,
  QUICK_ACTION_MAX,
  ACTION_NAME_MAX,
  SETUP_TIMEOUT_MS,
  EVENT_LOG_MAX,
  normalizeSetupCommand,
  normalizeQuickActions,
  normalizeThreadDefaults,
  REPO_CONFIG_UNTRUSTED,
  SUBMODULE_COMMAND,
  kickWorktreeSetup,
  runOnSettle,
  waitForCommand,
  pendingSetup,
  runCommand,
  setRunCommandFn,
  formatDuration,
  eventText,
};
