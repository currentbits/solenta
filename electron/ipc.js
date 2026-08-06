"use strict";

const { BrowserWindow } = require("electron");
const services = require("./services.js");
const {
  setupWorktree,
  diff,
  mergeWorktree,
  removeWorktree,
} = require("./worktrees.js");

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

  ipcMain.handle("threads:list", async () => {
    return services.listThreads(store);
  });

  ipcMain.handle("threads:create", async (_event, input) => {
    const thread = services.createThread(store, input);
    broadcast("threads:changed", services.listThreads(store));
    return thread;
  });

  ipcMain.handle("threads:get", async (_event, id) => {
    const workflow = runner.getActiveWorkflow(id);
    let view = null;
    if (workflow && runner.toWorkflowView) {
      // Only surface workflow for simulate (core) runs, not real providers.
      if (!workflow.__real && !workflow.__claude && !workflow.__codex) {
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

  ipcMain.handle("threads:setProvider", async (_event, input) => {
    const updated = services.setProvider(store, input);
    broadcast("threads:changed", services.listThreads(store));
    return updated;
  });

  ipcMain.handle("providers:list", async () => {
    return services.listProvidersForApi(store);
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
