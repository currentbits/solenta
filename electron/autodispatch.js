"use strict";

const AUTO_DISPATCH_INTERVAL_MS = 5 * 60_000;
const MAX_AUTO_DISPATCH_RUNNING = 3;

/**
 * Start a thread from one plan:todo issue. Same sequence as the renderer's
 * "Start task" button (fetch → createThread → startRun → plan:doing).
 *
 * @param {{ store: import("./store").Store, runner: { startRun: Function }, broadcast?: Function }} ctx
 * @param {object} project
 * @param {object} issue
 * @returns {Promise<boolean>} true if a run was started
 */
async function dispatchIssue(ctx, project, issue) {
  const issues = require("./issues.js");
  const services = require("./services.js");
  const fetched = await issues.fetchIssue(project.path, String(issue.number));
  if (!fetched || !fetched.ok) return false;

  const thread = services.createThread(ctx.store, {
    projectId: project.id,
    title: fetched.issue.title,
  });
  // Concurrent auto-dispatched agents each need their own worktree; it is
  // materialized lazily at run start, same as threads:create worktree:true.
  ctx.store.updateThread(thread.id, { pendingWorktree: true });
  ctx.store.save();
  // Before startRun: the run can last minutes and the sidebar should show
  // the thread as soon as it exists, not when it finishes.
  if (typeof ctx.broadcast === "function") {
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
  }
  const n = fetched.issue.number;
  const title = fetched.issue.title;
  const url = fetched.issue.url;
  const body = fetched.issue.body || "";
  await ctx.runner.startRun({
    threadId: thread.id,
    prompt: `GitHub issue #${n}: ${title}\n${url}\n\n${body}`,
  });
  // Run is already live: a failed label move is not a failed dispatch.
  try {
    await issues.setPlanStatus(project.path, issue.number, "doing");
  } catch {
    // ignore
  }
  return true;
}

/**
 * Interval ticker. Polls opt-in local projects for OPEN plan:todo issues
 * and starts a thread for each, up to MAX_AUTO_DISPATCH_RUNNING working
 * threads across all projects.
 *
 * @param {{ store: import("./store").Store, runner: { startRun: Function }, broadcast?: Function, intervalMs?: number, now?: () => number }} ctx
 */
function startAutoDispatch(ctx) {
  const intervalMs =
    ctx.intervalMs == null ? AUTO_DISPATCH_INTERVAL_MS : ctx.intervalMs;
  // ponytail: in-memory Set only covers the window where the plan:doing
  // label move fails, so a failed move costs at most one duplicate per
  // app restart. Durable dedup is the label move itself. Never cleared.
  const dispatched = new Set();
  let stopped = false;

  async function tick() {
    if (stopped) return;
    let running = ctx.store
      .getThreads()
      .filter((t) => t && t.status === "working").length;
    const projects = ctx.store.getProjects() || [];
    for (const project of projects) {
      if (running >= MAX_AUTO_DISPATCH_RUNNING) break;
      if (!project || project.autoDispatch !== true || project.remoteHost) {
        continue;
      }
      let listed;
      try {
        listed = await require("./issues.js").listIssues(project.path);
      } catch {
        continue;
      }
      if (!listed || !listed.ok) continue;
      const candidates = (listed.issues || [])
        .filter(
          (issue) =>
            issue &&
            issue.state === "OPEN" &&
            Array.isArray(issue.labels) &&
            issue.labels.includes("plan:todo"),
        )
        .sort((a, b) => a.number - b.number);
      for (const issue of candidates) {
        if (running >= MAX_AUTO_DISPATCH_RUNNING) break;
        const key = `${project.id}#${issue.number}`;
        if (dispatched.has(key)) continue;
        dispatched.add(key);
        try {
          const started = await dispatchIssue(ctx, project, issue);
          if (started) running += 1;
        } catch {
          // never kill the ticker
        }
      }
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  function stop() {
    stopped = true;
    clearInterval(timer);
  }

  return { stop, tick };
}

module.exports = {
  AUTO_DISPATCH_INTERVAL_MS,
  MAX_AUTO_DISPATCH_RUNNING,
  startAutoDispatch,
};
