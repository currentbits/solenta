"use strict";

const path = require("node:path");
const { listLocalServers } = require("./servers.js");
const { spotlightEnv, spotlightLane } = require("./mergeQueue.js");
const { spawnEnvForDevServer, laneEnvExtra } = require("./worktreeEnv.js");
const devservers = require("./devservers.js");
const terminal = require("./terminal.js");
const preview = require("./preview.js");

/**
 * Terminal read cursor. Anything that is not a finite number means "replay
 * the whole scrollback", which is what a freshly mounted pane wants.
 *
 * @param {{ since?: unknown } | null | undefined} input
 * @returns {number | null}
 */
function sinceOf(input) {
  const since = input && input.since;
  return typeof since === "number" && Number.isFinite(since) ? since : null;
}

/**
 * Where Terminal scrollback is flushed so it replays after a restart.
 *
 * @param {{ userDataPath?: string }} ctx
 * @returns {string | undefined}
 */
function terminalLogDir(ctx) {
  return ctx.userDataPath ? path.join(ctx.userDataPath, "terminals") : undefined;
}

/**
 * Thread cwd for the dev-server runner: worktree when bound, else the
 * project path. Same resolution as servers:list / git:diff. Throws a
 * named Error so the renderer gets an error result instead of a crash.
 *
 * @param {object} ctx
 * @param {unknown} threadId
 */
function resolveDevServerRoot(ctx, threadId) {
  if (!threadId || typeof threadId !== "string") {
    throw new Error("Unknown thread");
  }
  const thread = ctx.store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const project = ctx.store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }
  const root = thread.worktreePath || project.path;
  if (!root) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }
  return { thread, project, root };
}

/** IPC_HANDLERS rows for servers:*, devserver:*, terminal:*, preview:*; ipc.js spreads them in. */
module.exports = {
  "servers:list": async (ctx, input) => {
    try {
      const threadId = input && input.threadId;
      if (!threadId) return [];
      const thread = ctx.store.getThread(threadId);
      if (!thread) return [];
      const project = ctx.store.getProject(thread.projectId);
      if (!project) return [];
      const root = thread.worktreePath || project.path;
      if (!root) return [];
      return await listLocalServers(root);
    } catch {
      return [];
    }
  },
  "devserver:scripts": async (ctx, input) => {
    const { root } = resolveDevServerRoot(ctx, input && input.threadId);
    return devservers.detectScripts(root);
  },
  "devserver:start": async (ctx, input) => {
    const threadId = input && input.threadId;
    const script = input && input.script;
    const { root, project, thread } = resolveDevServerRoot(ctx, threadId);
    const spotlightOn = Boolean(project && project.spotlight === true);
    const startRoot = spotlightOn && project.path ? project.path : root;
    const allowed = devservers.detectScripts(startRoot);
    if (!script || !allowed.includes(script)) {
      throw new Error(script ? `Unknown script: ${script}` : "Unknown script");
    }
    const n = thread && thread.lane && Number(thread.lane.n);
    const port = thread && thread.lane && Number(thread.lane.port);
    const portBase =
      Number.isInteger(n) && Number.isInteger(port) && port > n
        ? port - n
        : undefined;
    if (spotlightOn && Number.isInteger(n) && n > 0) {
      spotlightLane({
        store: ctx.store,
        projectId: project.id,
        lane: n,
      });
    }
    return devservers.start(threadId, startRoot, script, {
      project,
      env: spawnEnvForDevServer({
        project,
        thread,
        userDataPath: ctx.userDataPath,
        extra: spotlightOn ? spotlightEnv(portBase) : laneEnvExtra(thread),
      }),
    });
  },
  "devserver:stop": async (ctx, input) => {
    const threadId = input && input.threadId;
    resolveDevServerRoot(ctx, threadId);
    return devservers.stop(threadId);
  },
  "devserver:status": async (ctx, input) => {
    const threadId = input && input.threadId;
    resolveDevServerRoot(ctx, threadId);
    return devservers.status(threadId);
  },
  "terminal:open": async (ctx, input) => {
    const threadId = input && input.threadId;
    const { root, project } = resolveDevServerRoot(ctx, threadId);
    return terminal.open(threadId, root, {
      project,
      termId: input && input.termId,
      cols: input && input.cols,
      rows: input && input.rows,
      logDir: terminalLogDir(ctx),
      broadcast: ctx.broadcast,
    });
  },
  "terminal:write": async (ctx, input) => {
    const threadId = input && input.threadId;
    resolveDevServerRoot(ctx, threadId);
    return terminal.write(threadId, input && input.data, input && input.termId);
  },
  "terminal:resize": async (ctx, input) => {
    const threadId = input && input.threadId;
    resolveDevServerRoot(ctx, threadId);
    return terminal.resize(threadId, input && input.cols, input && input.rows, input && input.termId);
  },
  "terminal:read": async (ctx, input) => {
    const threadId = input && input.threadId;
    resolveDevServerRoot(ctx, threadId);
    return terminal.read(threadId, sinceOf(input), input && input.termId);
  },
  "terminal:list": async (ctx, input) => {
    const threadId = input && input.threadId;
    resolveDevServerRoot(ctx, threadId);
    return terminal.list(threadId, terminalLogDir(ctx));
  },
  "terminal:close": async (ctx, input) => {
    const threadId = input && input.threadId;
    resolveDevServerRoot(ctx, threadId);
    return terminal.close(threadId, input && input.termId, terminalLogDir(ctx));
  },
  "preview:bind": async (ctx, input) => {
    resolveDevServerRoot(ctx, input && input.threadId);
    return preview.bind(input);
  },
  "preview:unbind": async (ctx, input) => {
    resolveDevServerRoot(ctx, input && input.threadId);
    return preview.unbind(input);
  },
  "preview:navigate": async (ctx, input) => {
    resolveDevServerRoot(ctx, input && input.threadId);
    return preview.navigate(input);
  },
  "preview:reload": async (ctx, input) => {
    resolveDevServerRoot(ctx, input && input.threadId);
    return preview.reload(input);
  },
  "preview:goBack": async (ctx, input) => {
    resolveDevServerRoot(ctx, input && input.threadId);
    return preview.goBack(input);
  },
  "preview:goForward": async (ctx, input) => {
    resolveDevServerRoot(ctx, input && input.threadId);
    return preview.goForward(input);
  },
  "preview:info": async (ctx, input) => {
    resolveDevServerRoot(ctx, input && input.threadId);
    return preview.info(input);
  },
  "preview:screenshot": async (ctx, input) => {
    resolveDevServerRoot(ctx, input && input.threadId);
    return preview.screenshot(input);
  },
  "preview:click": async (ctx, input) => {
    resolveDevServerRoot(ctx, input && input.threadId);
    return preview.click(input);
  },
  "preview:type": async (ctx, input) => {
    resolveDevServerRoot(ctx, input && input.threadId);
    return preview.type(input);
  },
};
