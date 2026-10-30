"use strict";

// Helpers shared by several services-* domain modules.

const fs = require("node:fs");
const path = require("node:path");
const terminal = require("./terminal.js");

const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
]);

/**
 * Best-effort orphan cleanup after durable lifecycle metadata changes.
 * @param {{ cleanupRunArtifacts?: () => unknown, log?: (msg: string) => void } | null | undefined} ctx
 */
function scheduleArtifactCleanup(ctx) {
  if (!ctx || typeof ctx.cleanupRunArtifacts !== "function") return;
  Promise.resolve()
    .then(() => ctx.cleanupRunArtifacts())
    .catch((err) => ctx.log?.(`run-artifacts: cleanup failed: ${err.message}`));
}

/**
 * Best-effort simulator ownership release after a durable archive/delete.
 * Injected via opts.getIosSimulator (never require ios-simulator.js here).
 * @param {{ getIosSimulator?: () => object | null, log?: (msg: string) => void } | null | undefined} opts
 * @param {"releaseThread" | "releaseProject"} method
 * @param {object} input
 * @returns {Promise<void>}
 */
function scheduleSimulatorRelease(opts, method, input) {
  const get =
    opts && typeof opts.getIosSimulator === "function"
      ? opts.getIosSimulator
      : null;
  const simulator = get ? get() : null;
  if (!simulator || typeof simulator[method] !== "function") return Promise.resolve();
  return Promise.resolve()
    .then(() => simulator[method](input))
    .catch(() => {
      opts.log?.(`ios-simulator: ${method} cleanup failed`);
    });
}

/**
 * Can this project host a git worktree? Remote projects are excluded (same
 * rule as threads:create) and so are non-repos, where `git worktree add`
 * would just fail the worker's run.
 * @param {{ path?: string, remoteHost?: string | null } | null | undefined} project
 * @returns {boolean}
 */
function canHostWorktree(project) {
  return Boolean(
    project &&
      !project.remoteHost &&
      project.path &&
      fs.existsSync(path.join(project.path, ".git")),
  );
}

/**
 * Per-project default-worktree override (#1775): a project's own
 * `defaultWorktree` wins over settings.defaultWorktree when it is set;
 * null/absent falls through to the global setting. This only resolves the
 * stored preference — callers still apply their own can-host-a-worktree
 * guard (canHostWorktree, scratch, remoteHost) at the call site.
 * @param {{ defaultWorktree?: boolean | null } | null | undefined} project
 * @param {{ defaultWorktree?: boolean } | null | undefined} settings
 * @returns {boolean}
 */
function resolveDefaultWorktree(project, settings) {
  const override = project && project.defaultWorktree;
  if (override === true || override === false) return override;
  return Boolean(settings && settings.defaultWorktree === true);
}

/**
 * Worktree (or project checkout) the spec artifacts live in — same folder
 * readSpecArtifact / the CLI use.
 * @param {import('./store').Store} store
 * @param {{ projectId?: string, worktreePath?: string | null }} thread
 */
function specCwd(store, thread) {
  const project =
    thread && thread.projectId != null && typeof store.getProject === "function"
      ? store.getProject(thread.projectId)
      : null;
  return (thread && thread.worktreePath) || (project && project.path) || "";
}

/**
 * Is another thread currently running (runner active) in the SAME effective
 * checkout as `threadId` (its own worktree, or the project path for
 * non-worktree threads)? Crew/orchestrator workers can share a worktree, and
 * two threads with no worktree of their own both run directly in the
 * project checkout (issue #1788). A hard reset (rewind/restoreCheckpoint)
 * there while that other run is writing files would race it.
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {{ listActiveThreadIds?: () => string[] } | null | undefined} opts
 * @returns {boolean}
 */
function siblingRunningSameCheckout(store, threadId, opts) {
  const listActive =
    opts && typeof opts.listActiveThreadIds === "function"
      ? opts.listActiveThreadIds
      : null;
  if (!listActive) return false;
  const thread = store.getThread(threadId);
  const cwd = thread ? specCwd(store, thread) : "";
  if (!cwd) return false;
  const ids = listActive() || [];
  for (const id of ids) {
    if (!id || id === threadId) continue;
    const other = store.getThread(id);
    if (!other) continue;
    if (specCwd(store, other) === cwd) return true;
  }
  return false;
}

/**
 * Drop a thread and every *ByThread map entry (messages, work log, usage).
 * Does not save; caller owns durability so bulk callers can save once.
 * @param {import('./store').Store} store
 * @param {string} threadId
 */
function purgeThread(store, threadId) {
  store.removeThread(threadId);
  // #1183: every permanent removal (delete, trash expiry, project removal,
  // retention) ends the thread's shells and drops their saved scrollback.
  // The store lives in userData, next to terminals/.
  terminal.purgeThread(
    threadId,
    store.filePath ? terminal.logDirIn(path.dirname(store.filePath)) : undefined,
  );
}

module.exports = {
  PERMISSION_MODES,
  scheduleArtifactCleanup,
  scheduleSimulatorRelease,
  canHostWorktree,
  resolveDefaultWorktree,
  specCwd,
  siblingRunningSameCheckout,
  purgeThread,
};
