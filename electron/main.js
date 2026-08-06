"use strict";

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { Store } = require("./store.js");
const { createRunner } = require("./runner.js");
const { registerIpc } = require("./ipc.js");
const {
  createMemorySupervisor,
  getMemoryStatus,
} = require("./memory-sup.js");

const isDev = !app.isPackaged && !process.env.CODER_PROD;

/** @type {ReturnType<typeof createMemorySupervisor> | null} */
let memorySupervisor = null;

/**
 * Ensure @coder/core is built; throw a helpful error if missing.
 */
function assertCoreBuilt() {
  const coreIndex = path.join(__dirname, "../core/dist/index.js");
  if (!fs.existsSync(coreIndex)) {
    throw new Error(
      "Missing core/dist. Build the workflow engine first:\n" +
        "  cd core && npm install && npm run build",
    );
  }
  return coreIndex;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0b0e14",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL || "http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

app.whenReady().then(async () => {
  const coreIndex = assertCoreBuilt();
  const core = await import(pathToFileURL(coreIndex).href);

  const userData = app.getPath("userData");
  // App root: packaged app path, or repo root in dev (parent of electron/).
  const appPath = app.isPackaged
    ? app.getAppPath()
    : path.join(__dirname, "..");

  memorySupervisor = createMemorySupervisor({
    userDataPath: userData,
    appPath,
    log: (msg) => console.warn(msg),
  });
  // Never block or fail app start on memory supervision.
  try {
    await memorySupervisor.start();
  } catch (err) {
    console.warn(
      "memory-server: supervisor start error; continuing without memory:",
      err && err.message ? err.message : err,
    );
  }

  const storePath = path.join(userData, "coder-store.json");
  const store = new Store(storePath);

  const runner = createRunner({
    store,
    core,
    pushFn: (channel, payload) => broadcast(channel, payload),
    tickMs: 700,
  });

  registerIpc({
    ipcMain,
    dialog,
    store,
    runner,
    broadcast,
    worktreeBase: path.join(userData, "worktrees"),
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  // Terminate only a memory-server child we spawned (adopted servers stay up).
  if (memorySupervisor) {
    try {
      memorySupervisor.stop();
    } catch {
      // ignore
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Expose for future UI / tests without renderer work this round.
module.exports = {
  getMemoryStatus: () =>
    memorySupervisor ? memorySupervisor.getStatus() : getMemoryStatus(),
};
