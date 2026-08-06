"use strict";

const { BrowserWindow } = require("electron");
const services = require("./services.js");

/**
 * Register all invoke handlers from the ipc contract.
 *
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {import('electron').Dialog} deps.dialog
 * @param {import('./store').Store} deps.store
 * @param {ReturnType<import('./runner').createRunner>} deps.runner
 * @param {(channel: string, payload: unknown) => void} [deps.broadcast]
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

  // Wrap runner push so threads:changed also goes to all windows
  // (runner already calls pushFn; ipc registration wires that)

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
    const view =
      workflow && runner.toWorkflowView
        ? runner.toWorkflowView(workflow)
        : null;
    return services.getThreadDetail(store, id, view);
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
