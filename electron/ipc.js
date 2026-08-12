"use strict";

const { BrowserWindow } = require("electron");
const services = require("./services.js");
const {
  setupWorktree,
  diff,
  commit,
  revertFile,
  listFiles,
  mergeWorktree,
  removeWorktree,
  push,
  createPr,
  prStatus,
  listCheckpoints,
  restoreCheckpoint,
} = require("./worktrees.js");
const { suggestCommitMessage } = require("./commitmsg.js");
const { createMemoryProxy } = require("./memory-proxy.js");

/**
 * Shared invoke table used by BOTH transports: Electron IPC and the Coder Web
 * WebSocket server. One function per channel, same args, same throw strings.
 *
 * @param {object} deps
 * @param {import('electron').Dialog} deps.dialog
 * @param {import('./store').Store} deps.store
 * @param {ReturnType<import('./runner').createRunner>} deps.runner
 * @param {(channel: string, payload: unknown) => void} [deps.broadcast]
 * @param {string} [deps.worktreeBase]
 * @param {string} [deps.userDataPath]
 * @returns {Record<string, (...args: unknown[]) => Promise<unknown>>}
 */
function createHandlers(deps) {
  const { dialog, store, runner } = deps;

  const broadcast =
    deps.broadcast ||
    ((channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      }
    });

  const worktreeBase = deps.worktreeBase || "";
  const userDataPath = deps.userDataPath || "";
  const memory = createMemoryProxy({ userDataPath });

  return {
    "projects:list": async () => {
      return services.listProjects(store);
    },
    "projects:add": async (projectPath) => {
      return services.addProject(store, projectPath);
    },
    "projects:addViaDialog": async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return null;
      }
      return services.addProject(store, result.filePaths[0]);
    },
    "projects:remove": async (input) => {
      services.removeProject(store, input, {
        isRunning: (id) => runner.isRunning(id),
      });
      broadcast("threads:changed", services.listThreads(store));
    },
    "threads:list": async () => {
      return services.listThreads(store);
    },
    "threads:search": async (input) => {
      return services.searchThreads(store, input || { query: "" });
    },
    "threads:create": async (input) => {
      const thread = services.createThread(store, input);
      broadcast("threads:changed", services.listThreads(store));
      return thread;
    },
    "threads:fork": async (input) => {
      const thread = services.forkThread(store, input);
      broadcast("threads:changed", services.listThreads(store));
      return thread;
    },
    "threads:get": async (id) => {
      const workflow = runner.getActiveWorkflow(id);
      let view = null;
      if (workflow && runner.toWorkflowView) {
        // Surface workflow for simulate (core) and orchestrated multi-phase runs.
        if (
          workflow.__orchestrated ||
          (!workflow.__real && !workflow.__claude && !workflow.__codex)
        ) {
          view = runner.toWorkflowView(workflow);
        }
      }
      return services.getThreadDetail(store, id, view);
    },
    "threads:setPermissionMode": async (input) => {
      const updated = services.setPermissionMode(store, input);
      broadcast("threads:changed", services.listThreads(store));
      return updated;
    },
    "threads:setArchived": async (input) => {
      const updated = services.setArchived(store, input);
      broadcast("threads:changed", services.listThreads(store));
      return updated;
    },
    "threads:setSettled": async (input) => {
      const updated = services.setSettled(store, input);
      broadcast("threads:changed", services.listThreads(store));
      return updated;
    },
    "threads:setPinned": async (input) => {
      const updated = services.setPinned(store, input);
      broadcast("threads:changed", services.listThreads(store));
      return updated;
    },
    "threads:setSnoozed": async (input) => {
      const updated = services.setSnoozed(store, input);
      broadcast("threads:changed", services.listThreads(store));
      return updated;
    },
    "threads:setProvider": async (input) => {
      const updated = services.setProvider(store, input);
      broadcast("threads:changed", services.listThreads(store));
      return updated;
    },
    "threads:setReasoningEffort": async (input) => {
      const updated = services.setReasoningEffort(store, input);
      broadcast("threads:changed", services.listThreads(store));
      return updated;
    },
    "app:status": async () => {
      return services.appStatus(store);
    },
    "memory:search": async (input) => {
      return memory.search(input || { query: "" });
    },
    "memory:recent": async (input) => {
      return memory.recent(input || {});
    },
    "memory:get": async (input) => {
      return memory.get(input || { id: "" });
    },
    "memory:store": async (input) => {
      return memory.store(input);
    },
    "memory:update": async (input) => {
      return memory.update(input);
    },
    "memory:remove": async (input) => {
      return memory.remove(input);
    },
    "settings:get": async () => {
      return services.getSettings(store);
    },
    "settings:set": async (patch) => {
      return services.setSettings(store, patch);
    },
    "providers:list": async () => {
      return services.listProvidersForApi(store);
    },
    "workflows:list": async () => {
      return services.listTemplates(store);
    },
    "workflows:save": async (template) => {
      return services.saveTemplate(store, template);
    },
    "workflows:remove": async (input) => {
      return services.removeTemplate(store, input);
    },
    "threads:delete": async (input) => {
      services.deleteThread(store, input, {
        isRunning: (id) => runner.isRunning(id),
      });
      broadcast("threads:changed", services.listThreads(store));
    },
    "runs:start": async (input) => {
      return runner.startRun(input);
    },
    "runs:startWorkflow": async (input) => {
      return runner.startWorkflowRun(input);
    },
    "runs:stop": async (input) => {
      return runner.stopRun(input);
    },
    "git:status": async (projectId) => {
      const project = store.getProject(projectId);
      if (!project) {
        return { isRepo: false, branch: "", dirty: false };
      }
      return services.gitStatus(project.path);
    },
    "git:setupWorktree": async (input) => {
      if (!worktreeBase) {
        throw new Error("worktreeBase is not configured");
      }
      return setupWorktree({
        store,
        threadId: input.threadId,
        worktreeBase,
        broadcast,
      });
    },
    "git:diff": async (input) => {
      return diff({ store, threadId: input.threadId });
    },
    "git:commit": async (input) => {
      return commit({
        store,
        threadId: input.threadId,
        message: input.message,
      });
    },
    "git:revertFile": async (input) => {
      return revertFile({
        store,
        threadId: input.threadId,
        path: input.path,
        status: input.status,
      });
    },
    "git:suggestCommitMessage": async (input) => {
      return suggestCommitMessage({ store, threadId: input.threadId });
    },
    "files:list": async (input) => {
      return listFiles({
        store,
        threadId: input.threadId,
        query: input.query,
      });
    },
    "git:mergeWorktree": async (input) => {
      return mergeWorktree({
        store,
        threadId: input.threadId,
        broadcast,
      });
    },
    "git:removeWorktree": async (input) => {
      return removeWorktree({
        store,
        threadId: input.threadId,
        force: Boolean(input && input.force),
        broadcast,
      });
    },
    "git:push": async (input) => {
      return push({
        store,
        threadId: input.threadId,
        broadcast,
      });
    },
    "git:createPr": async (input) => {
      return createPr({
        store,
        threadId: input.threadId,
        title: input.title,
        body: input.body,
        draft: input.draft,
        broadcast,
      });
    },
    "git:prStatus": async (input) => {
      return prStatus({
        store,
        threadId: input.threadId,
      });
    },
    "git:listCheckpoints": async (input) => {
      return listCheckpoints({
        store,
        threadId: input.threadId,
      });
    },
    "git:restoreCheckpoint": async (input) => {
      return restoreCheckpoint({
        store,
        threadId: input.threadId,
        sha: input.sha,
        isRunning: (id) => runner.isRunning(id),
      });
    },
  };
}

/**
 * Register all invoke handlers from the ipc contract.
 *
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {import('electron').Dialog} deps.dialog
 * @param {import('./store').Store} deps.store
 * @param {ReturnType<import('./runner').createRunner>} deps.runner
 * @param {(channel: string, payload: unknown) => void} [deps.broadcast]
 * @param {string} [deps.worktreeBase] - base dir for git worktrees
 * @param {string} [deps.userDataPath] - app userData for memory-server.json
 * @param {Record<string, (...args: unknown[]) => Promise<unknown>>} [deps.handlers]
 */
function registerIpc(deps) {
  const { ipcMain } = deps;
  const handlers = deps.handlers || createHandlers(deps);
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_event, ...args) => fn(...args));
  }
  const broadcast =
    deps.broadcast ||
    ((channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      }
    });
  return { broadcast, handlers };
}

/**
 * Create a pushFn that broadcasts to all BrowserWindows.
 * @param {(channel: string, payload: unknown) => void} [broadcast]
 */
function createPushFn(broadcast) {
  return (channel, payload) => {
    broadcast(channel, payload);
  };
}

module.exports = { registerIpc, createHandlers, createPushFn };
