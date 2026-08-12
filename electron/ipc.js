"use strict";

const { BrowserWindow } = require("electron");
const services = require("./services.js");
const {
  setupWorktree,
  diff,
  mergeWorktree,
  removeWorktree,
  push,
  createPr,
  prStatus,
  listCheckpoints,
  restoreCheckpoint,
} = require("./worktrees.js");
const { createMemoryProxy } = require("./memory-proxy.js");

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
 */
function registerIpc(deps) {
  const { ipcMain, dialog, store, runner } = deps;

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

  ipcMain.handle("projects:list", async () => {
    return services.listProjects(store);
  });

  ipcMain.handle("projects:add", async (_event, projectPath) => {
    return services.addProject(store, projectPath);
  });

  ipcMain.handle("projects:addViaDialog", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return services.addProject(store, result.filePaths[0]);
  });

  ipcMain.handle("projects:remove", async (_event, input) => {
    services.removeProject(store, input, {
      isRunning: (id) => runner.isRunning(id),
    });
    broadcast("threads:changed", services.listThreads(store));
  });

  ipcMain.handle("threads:list", async () => {
    return services.listThreads(store);
  });

  ipcMain.handle("threads:search", async (_event, input) => {
    return services.searchThreads(store, input || { query: "" });
  });

  ipcMain.handle("threads:create", async (_event, input) => {
    const thread = services.createThread(store, input);
    broadcast("threads:changed", services.listThreads(store));
    return thread;
  });

  ipcMain.handle("threads:fork", async (_event, input) => {
    const thread = services.forkThread(store, input);
    broadcast("threads:changed", services.listThreads(store));
    return thread;
  });

  ipcMain.handle("threads:get", async (_event, id) => {
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
  });

  ipcMain.handle("threads:setPermissionMode", async (_event, input) => {
    const updated = services.setPermissionMode(store, input);
    broadcast("threads:changed", services.listThreads(store));
    return updated;
  });

  ipcMain.handle("threads:setArchived", async (_event, input) => {
    const updated = services.setArchived(store, input);
    broadcast("threads:changed", services.listThreads(store));
    return updated;
  });

  ipcMain.handle("threads:setSettled", async (_event, input) => {
    const updated = services.setSettled(store, input);
    broadcast("threads:changed", services.listThreads(store));
    return updated;
  });

  ipcMain.handle("threads:setPinned", async (_event, input) => {
    const updated = services.setPinned(store, input);
    broadcast("threads:changed", services.listThreads(store));
    return updated;
  });

  ipcMain.handle("threads:setSnoozed", async (_event, input) => {
    const updated = services.setSnoozed(store, input);
    broadcast("threads:changed", services.listThreads(store));
    return updated;
  });

  ipcMain.handle("threads:setProvider", async (_event, input) => {
    const updated = services.setProvider(store, input);
    broadcast("threads:changed", services.listThreads(store));
    return updated;
  });

  ipcMain.handle("threads:setReasoningEffort", async (_event, input) => {
    const updated = services.setReasoningEffort(store, input);
    broadcast("threads:changed", services.listThreads(store));
    return updated;
  });

  ipcMain.handle("app:status", async () => {
    return services.appStatus(store);
  });

  ipcMain.handle("memory:search", async (_event, input) => {
    return memory.search(input || { query: "" });
  });

  ipcMain.handle("memory:recent", async (_event, input) => {
    return memory.recent(input || {});
  });

  ipcMain.handle("memory:get", async (_event, input) => {
    return memory.get(input || { id: "" });
  });

  ipcMain.handle("memory:store", async (_event, input) => {
    return memory.store(input);
  });

  ipcMain.handle("memory:update", async (_event, input) => {
    return memory.update(input);
  });

  ipcMain.handle("memory:remove", async (_event, input) => {
    return memory.remove(input);
  });

  ipcMain.handle("settings:get", async () => {
    return services.getSettings(store);
  });

  ipcMain.handle("settings:set", async (_event, patch) => {
    return services.setSettings(store, patch);
  });

  ipcMain.handle("providers:list", async () => {
    return services.listProvidersForApi(store);
  });

  ipcMain.handle("workflows:list", async () => {
    return services.listTemplates(store);
  });

  ipcMain.handle("workflows:save", async (_event, template) => {
    return services.saveTemplate(store, template);
  });

  ipcMain.handle("workflows:remove", async (_event, input) => {
    return services.removeTemplate(store, input);
  });

  ipcMain.handle("threads:delete", async (_event, input) => {
    services.deleteThread(store, input, {
      isRunning: (id) => runner.isRunning(id),
    });
    broadcast("threads:changed", services.listThreads(store));
  });

  ipcMain.handle("runs:start", async (_event, input) => {
    return runner.startRun(input);
  });

  ipcMain.handle("runs:startWorkflow", async (_event, input) => {
    return runner.startWorkflowRun(input);
  });

  ipcMain.handle("runs:stop", async (_event, input) => {
    return runner.stopRun(input);
  });

  ipcMain.handle("git:status", async (_event, projectId) => {
    const project = store.getProject(projectId);
    if (!project) {
      return { isRepo: false, branch: "", dirty: false };
    }
    return services.gitStatus(project.path);
  });

  ipcMain.handle("git:setupWorktree", async (_event, input) => {
    if (!worktreeBase) {
      throw new Error("worktreeBase is not configured");
    }
    return setupWorktree({
      store,
      threadId: input.threadId,
      worktreeBase,
      broadcast,
    });
  });

  ipcMain.handle("git:diff", async (_event, input) => {
    return diff({ store, threadId: input.threadId });
  });

  ipcMain.handle("git:mergeWorktree", async (_event, input) => {
    return mergeWorktree({
      store,
      threadId: input.threadId,
      broadcast,
    });
  });

  ipcMain.handle("git:removeWorktree", async (_event, input) => {
    return removeWorktree({
      store,
      threadId: input.threadId,
      force: Boolean(input && input.force),
      broadcast,
    });
  });

  ipcMain.handle("git:push", async (_event, input) => {
    return push({
      store,
      threadId: input.threadId,
      broadcast,
    });
  });

  ipcMain.handle("git:createPr", async (_event, input) => {
    return createPr({
      store,
      threadId: input.threadId,
      title: input.title,
      body: input.body,
      draft: input.draft,
      broadcast,
    });
  });

  ipcMain.handle("git:prStatus", async (_event, input) => {
    return prStatus({
      store,
      threadId: input.threadId,
    });
  });

  ipcMain.handle("git:listCheckpoints", async (_event, input) => {
    return listCheckpoints({
      store,
      threadId: input.threadId,
    });
  });

  ipcMain.handle("git:restoreCheckpoint", async (_event, input) => {
    return restoreCheckpoint({
      store,
      threadId: input.threadId,
      sha: input.sha,
      isRunning: (id) => runner.isRunning(id),
    });
  });

  return { broadcast };
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

module.exports = { registerIpc, createPushFn };
