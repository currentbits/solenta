"use strict";

// Helpers shared by several services-* domain modules.

const fs = require("node:fs");
const path = require("node:path");

const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
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
 * Drop a thread and every *ByThread map entry (messages, work log, usage).
 * Does not save; caller owns durability so bulk callers can save once.
 * @param {import('./store').Store} store
 * @param {string} threadId
 */
function purgeThread(store, threadId) {
  store.removeThread(threadId);
}

module.exports = {
  PERMISSION_MODES,
  scheduleArtifactCleanup,
  scheduleSimulatorRelease,
  canHostWorktree,
  specCwd,
  purgeThread,
};
