"use strict";

const path = require("node:path");
const { scheduleRetention } = require("./worktrees.js");
const devservers = require("./devservers.js");

/**
 * A thread the user pushed out of attention (settled, archived, deleted,
 * ejected, or whose project was removed) has no next turn: kill its
 * kept-alive Claude CLI now instead of holding the process for the
 * 30-minute idle reaper (issue #48, #979, #1227).
 *
 * @param {object} ctx
 * @param {string} threadId
 */
function retireAgent(ctx, threadId) {
  // #1383: retire defers the kill while the thread's own turn is live.
  if (typeof ctx.runner.retireClaudeSession === "function") {
    ctx.runner.retireClaudeSession(threadId);
  } else if (typeof ctx.runner.disposeClaudeSession === "function") {
    ctx.runner.disposeClaudeSession(threadId);
  }
  // #315: leftover npm run dev is its own process group, not the CLI's.
  try {
    devservers.stop(threadId);
  } catch {
    // no sidecar
  }
}

/**
 * Reclaim settled worktrees past retention after a done-transition (#559).
 * No-op without a worktreeBase (tests that never configured one).
 * @param {object} ctx
 */
function runRetention(ctx) {
  if (!ctx || !ctx.worktreeBase) return Promise.resolve();
  return scheduleRetention({
    store: ctx.store,
    worktreeBase: ctx.worktreeBase,
    userDataPath: ctx.userDataPath,
    broadcast: ctx.broadcast,
  });
}

/**
 * Thread cwd: worktree when bound, else the project checkout.
 * @param {import('./store').Store} store
 * @param {string} threadId
 */
function resolveThreadRoot(store, threadId) {
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }
  const root = thread.worktreePath || project.path;
  if (!root) {
    throw new Error("Thread has no worktree or project path");
  }
  return { thread, project, root: path.resolve(root) };
}

module.exports = { retireAgent, runRetention, resolveThreadRoot };
