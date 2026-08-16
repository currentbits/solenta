"use strict";

// Electron's patched fs treats .asar files as directories, so the updater's
// recursive rms (temp work dir, Solenta.app.old) die with ENOTDIR on the
// bundle's default_app.asar. We ship app code as a plain directory, so asar
// support buys nothing — turn it off for the whole main process.
process.noAsar = true;

const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { Store } = require("./store.js");
const { createRunner } = require("./runner.js");
const { registerIpc } = require("./ipc.js");
const { shouldNotify } = require("./notify.js");
const { windowOpenAction, navigateAction } = require("./links.js");
const {
  createMemorySupervisor,
  getMemoryStatus,
  syncUserMcpServers,
} = require("./memory-sup.js");
const { createOrchServer } = require("./orchServer.js");
const { createPrStateRefresher } = require("./worktrees.js");
const { killAll: killAllDevServers } = require("./devservers.js");
const { startScheduler } = require("./automations.js");
const { enrichProcessPath } = require("./pathEnv.js");
const {
  parseServeWebArgs,
  startWebServer,
  loadOrCreateToken,
  HOST_FLAG_HELP,
} = require("./webServer.js");
const { migrateLegacyUserData } = require("./legacy-migration.js");

const serveOpts = parseServeWebArgs(process.argv);

// GUI launches get a bare launchd PATH; rebuild the user's real PATH before
// any provider binary resolution (`which`) or agent spawn happens.
enrichProcessPath();

const isDev = !app.isPackaged && !process.env.CODER_PROD;

/** @type {ReturnType<typeof createMemorySupervisor> | null} */
let memorySupervisor = null;

/** @type {ReturnType<typeof createRunner> | null} */
let runner = null;

/** @type {ReturnType<typeof createOrchServer> | null} */
let orchServer = null;

/** @type {ReturnType<typeof createPrStateRefresher> | null} */
let prStateRefresher = null;

/** @type {ReturnType<typeof startScheduler> | null} */
let automationScheduler = null;

/** @type {Awaited<ReturnType<typeof startWebServer>> | null} */
let webServer = null;

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

  // A PR link is target=_blank. Without a policy Electron answers it with a
  // bare chrome-less window pointed at github.com. links.js owns the decision
  // so it can be tested; here we only wire it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (windowOpenAction(url).external) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    const decision = navigateAction(url, {
      currentUrl: win.webContents.getURL(),
      isDev,
      devServerUrl: process.env.VITE_DEV_SERVER_URL || "http://localhost:5173",
    });
    if (decision.allow) return;
    event.preventDefault();
    if (decision.external) void shell.openExternal(url);
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
  if (webServer) {
    webServer.broadcast(channel, payload);
  }
}

function isAnyWindowFocused() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.isFocused()) return true;
  }
  return false;
}

function focusMainWindow() {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return null;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

/**
 * Notification state of a thread: its status, or "waiting" when the run is
 * blocked on a permission prompt (same guard the sidebar badge uses).
 * @param {{ status?: string, awaitingInput?: boolean }} thread
 */
function threadNotifyState(thread) {
  return thread.status === "working" && thread.awaitingInput
    ? "waiting"
    : thread.status;
}

/**
 * Desktop notification when a run settles or blocks on a prompt while the
 * window is in the background. Click focuses the window and selects that
 * thread.
 * @param {{ id: string, title?: string, status: string }} thread
 */
function notifyThreadComplete(thread) {
  if (typeof Notification !== "function") return;
  if (Notification.isSupported && !Notification.isSupported()) return;
  const n = new Notification({
    title: thread.title || "Thread",
    body: threadNotifyState(thread) === "waiting"
      ? "needs permission"
      : thread.status === "failed"
        ? "failed"
        : "done",
  });
  n.on("click", () => {
    const win = focusMainWindow();
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send("thread:select", thread.id);
    }
  });
  n.show();
}

app.whenReady().then(async () => {
  // Which build is this? A stale packaged bundle missing recent fixes looks
  // exactly like a broken feature, so say it out loud once at boot.
  try {
    const pkg = require("../package.json");
    console.warn(
      `solenta: ${pkg.version || "?"} ${pkg.buildSha ? `build ${pkg.buildSha} (${pkg.buildTime})` : "(dev tree)"}`,
    );
  } catch {
    // non-fatal
  }

  // Remove the bundle the last auto-update swapped aside (Solenta.app.old).
  require("./updater.js").cleanupOldBundle();

  // Dev dock icon; the packaged app gets its icon from CFBundleIconFile.
  if (process.platform === "darwin" && app.dock) {
    try {
      const dockIcon = path.join(__dirname, "../assets/icon-512.png");
      if (fs.existsSync(dockIcon)) {
        app.dock.setIcon(dockIcon);
      }
    } catch {
      // cosmetic only
    }
  }

  const coreIndex = assertCoreBuilt();
  const core = await import(pathToFileURL(coreIndex).href);

  const userData = app.getPath("userData");
  // One-time rename Coder -> Solenta: pull the app's own files out of the
  // legacy directory so existing installs keep store, worktrees, and memory.
  // NEVER in throwaway boots: verify/smoke/acceptance probes run with a temp
  // userData, and migrating there would move the real data into a directory
  // that gets deleted. Only migrate when booting the default userData.
  const defaultUserData = path.join(app.getPath("appData"), app.getName());
  const canMigrate =
    path.resolve(userData) === path.resolve(defaultUserData) &&
    process.env.SOLENTA_SKIP_USERDATA_MIGRATION !== "1";
  try {
    if (
      canMigrate &&
      migrateLegacyUserData(app.getPath("appData"), userData)
    ) {
      console.warn("solenta: migrated userData from legacy coder directory");
    }
  } catch (err) {
    console.warn(
      "solenta: legacy userData migration failed; starting fresh:",
      err && err.message ? err.message : err,
    );
  }
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

  const lastStatus = new Map();
  for (const t of store.getThreads()) {
    lastStatus.set(t.id, threadNotifyState(t));
  }

  runner = createRunner({
    store,
    core,
    pushFn: (channel, payload) => {
      if (channel === "thread:updated" && payload && payload.thread) {
        const prev = lastStatus.get(payload.thread.id);
        const next = threadNotifyState(payload.thread);
        // Mute checks come after shouldNotify: this runs on every stream
        // chunk, and getSettings() re-normalizes the whole settings blob.
        if (
          shouldNotify(prev, next, isAnyWindowFocused()) &&
          !payload.thread.muted &&
          store.getSettings().notifications
        ) {
          notifyThreadComplete(payload.thread);
        }
        lastStatus.set(payload.thread.id, next);
      }
      broadcast(channel, payload);
    },
    tickMs: 700,
    userDataPath: userData,
  });

  const registered = registerIpc({
    ipcMain,
    dialog,
    store,
    runner,
    broadcast,
    worktreeBase: path.join(userData, "worktrees"),
    userDataPath: userData,
  });

  if (serveOpts.enabled) {
    const token = loadOrCreateToken(userData);
    // Contract: print the token to stdout when serve mode starts.
    process.stdout.write(`solenta-web: token ${token}\n`);
    if (serveOpts.host !== "127.0.0.1") {
      process.stdout.write(`solenta-web: ${HOST_FLAG_HELP}\n`);
    }
    const staticDir = path.join(__dirname, "../dist");
    // The port is fixed, so EADDRINUSE is routine (a previous instance still
    // holds it). Never let that reject out of whenReady: createWindow() below
    // would be skipped and the app would boot with no window and no error.
    try {
      webServer = await startWebServer({
        host: serveOpts.host,
        port: serveOpts.port,
        staticDir: fs.existsSync(staticDir) ? staticDir : null,
        token,
        ctx: registered.ctx,
        log: (msg) => console.warn(msg),
      });
    } catch (err) {
      // No listener means nothing to keep the process alive headless either.
      serveOpts.enabled = false;
      process.stdout.write(
        `solenta-web: cannot listen on ${serveOpts.host}:${serveOpts.port} (${err && err.message ? err.message : err}); continuing without web serve\n`,
      );
    }
  }

  // Round 47: lazy PR-state freshness. Async/serialized/latched so a slow gh
  // cannot freeze the main process (ISSUES.md prStatus hang) and non-GitHub
  // origins stay silent. Startup pass ~30s after boot; then every 5 min.
  // Zero qualifying threads → refreshPrStates spawns nothing.
  prStateRefresher = createPrStateRefresher({
    store,
    broadcast,
    intervalMs: 5 * 60 * 1000,
    startupDelayMs: 30_000,
  });
  prStateRefresher.start();

  // Boot-time worktree GC: reclaim clean worktree dirs no thread references
  // (crash/store-drift orphans). Conservative by design — dirty trees and
  // unmerged branches are never touched. Delayed + unref'd like the PR
  // refresher so startup stays fast and a short-lived process can exit.
  const sweepTimer = setTimeout(() => {
    const { sweepOrphanWorktrees } = require("./worktrees.js");
    void sweepOrphanWorktrees({
      store,
      worktreeBase: path.join(userData, "worktrees"),
    }).then((result) => {
      if (result.removed.length > 0) {
        console.warn(
          `worktree sweep: removed ${result.removed.length} orphan(s)`,
        );
      }
    });
  }, 15_000);
  sweepTimer.unref();

  automationScheduler = startScheduler({ store, runner, broadcast });

  // In-main orchestrator MCP server (coder-threads): lets any agent drive
  // other threads. Needs store + runner, so it starts after both exist.
  // Fails soft internally; never block app start on it.
  orchServer = createOrchServer({
    store,
    runner,
    userDataPath: userData,
    appPath,
    log: (msg) => console.warn(msg),
  });
  try {
    await orchServer.start();
  } catch (err) {
    console.warn(
      "orch-server: start error; continuing without thread tools:",
      err && err.message ? err.message : err,
    );
  }

  // User MCP servers from settings: fold every enabled entry into the four
  // provider injection hooks. Built-ins (coder-memory, coder-threads) are
  // untouched by the sync. Runs after the orch server so its registration
  // lands first; never block app start on it.
  try {
    syncUserMcpServers(store.getSettings().mcpServers, {
      userDataPath: userData,
      log: (msg) => console.warn(msg),
    });
  } catch (err) {
    console.warn(
      "memory-server: user MCP sync error at boot:",
      err && err.message ? err.message : err,
    );
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  if (webServer) {
    try {
      void webServer.close();
    } catch {
      // ignore
    }
    webServer = null;
  }
  // Stop active runs and drain session transcript queue before exit.
  if (runner) {
    try {
      runner.stopAll();
    } catch {
      // ignore
    }
    try {
      // Fire-and-forget flush; stopAll already kicked flush.
      void runner.flushTranscripts();
    } catch {
      // ignore
    }
  }
  if (prStateRefresher) {
    try {
      prStateRefresher.stop();
    } catch {
      // ignore
    }
    prStateRefresher = null;
  }
  if (automationScheduler) {
    try {
      automationScheduler.stop();
    } catch {
      // ignore
    }
    automationScheduler = null;
  }
  // Terminate only a memory-server child we spawned (adopted servers stay up).
  if (memorySupervisor) {
    try {
      memorySupervisor.stop();
    } catch {
      // ignore
    }
  }
  if (orchServer) {
    try {
      orchServer.stop();
    } catch {
      // ignore
    }
    orchServer = null;
  }
  try {
    killAllDevServers();
  } catch {
    // ignore
  }
});

app.on("window-all-closed", () => {
  // --serve-web keeps the process up after the last window so the HTTP+WS
  // listener does not die with the desktop chrome.
  if (serveOpts.enabled) return;
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Expose for future UI / tests without renderer work this round.
module.exports = {
  getMemoryStatus: () =>
    memorySupervisor ? memorySupervisor.getStatus() : getMemoryStatus(),
  getOrchStatus: () =>
    orchServer ? orchServer.getStatus() : { running: false, port: null },
};
