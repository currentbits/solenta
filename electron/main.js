"use strict";

// Electron's patched fs treats .asar files as directories, so the updater's
// recursive rms (temp work dir, Solenta.app.old) die with ENOTDIR on the
// bundle's default_app.asar. We ship app code as a plain directory, so asar
// support buys nothing — turn it off for the whole main process.
process.noAsar = true;

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, nativeTheme, protocol, net } = require("electron");
const { windowBackgroundColor, nativeThemeSource } = require("./theme.js");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { Store } = require("./store.js");
const { createRunner } = require("./runner.js");
const { registerIpc } = require("./ipc.js");
const {
  shouldNotify,
  isNotifyTransition,
  isEffectivelySnoozed,
  notifyEvent,
  notifyBody,
  dispatchWebhook,
} = require("./notify.js");
const { recordSecretUse } = require("./secrets.js");
const { windowOpenAction, navigateAction } = require("./links.js");
const { guestWebviewPolicy, attachGuestPolicy } = require("./preview.js");
const {
  createMemorySupervisor,
  getMemoryStatus,
  syncUserMcpServers,
} = require("./memory-sup.js");
const { createOrchServer } = require("./orchServer.js");
const { createPrStateRefresher, createRetentionSweeper } = require("./worktrees.js");
const { killAll: killAllDevServers } = require("./devservers.js");
const { killAll: killAllTerminals } = require("./terminal.js");
const { startScheduler } = require("./automations.js");
const { startAutoDispatch } = require("./autodispatch.js");
const { startPostMergeScheduler } = require("./postmerge.js");
const { enrichProcessPath } = require("./pathEnv.js");
const {
  parseServeWebArgs,
  startWebServer,
  loadOrCreateToken,
  HOST_FLAG_HELP,
} = require("./webServer.js");
const { migrateLegacyUserData } = require("./legacy-migration.js");
const { configureDefaultSecrets } = require("./secrets.js");
const { installCrashGuard } = require("./crash-guard.js");
const { start: startLoopLag } = require("./looplag.js");
const { installShutdown } = require("./shutdown.js");
const { installAppMenu } = require("./menu.js");
const { bootFirstPaint } = require("./boot.js");
const { applyZoom, clampUiScale } = require("./zoom.js");
const mediaProtocol = require("./media-protocol.js");

// Custom img protocol (issue #145): registerSchemesAsPrivileged MUST run
// before app.ready or Electron ignores it.
mediaProtocol.registerPrivileged(protocol);

// Before anything else can throw: the app is full of fire-and-forget `void`
// calls, and one unhandled rejection would otherwise kill the process with
// every in-flight run inside it (issue #129).
installCrashGuard({
  userDataPath: app.getPath("userData"),
  notify: (message, logPath) => {
    if (typeof Notification !== "function" || !app.isReady()) return;
    if (Notification.isSupported && !Notification.isSupported()) return;
    const n = new Notification({
      title: "Solenta hit an internal error",
      body: message,
    });
    if (logPath) n.on("click", () => shell.showItemInFolder(logPath));
    n.show();
  },
});

// Off unless CODER_LOOP_LAG=1. Histogram is not created when unset.
startLoopLag();

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

/** @type {ReturnType<typeof createRetentionSweeper> | null} */
let retentionSweeper = null;

/** @type {ReturnType<typeof startScheduler> | null} */
let automationScheduler = null;

/** @type {ReturnType<typeof startAutoDispatch> | null} */
let autoDispatch = null;

/** @type {ReturnType<typeof startPostMergeScheduler> | null} */
let postMergeScheduler = null;

/** @type {Awaited<ReturnType<typeof startWebServer>> | null} */
let webServer = null;

/** @type {InstanceType<typeof Store> | null} */
let store = null;

function currentUiScale() {
  return store ? store.getSettings().uiScale : 1;
}

function applyUiScale(win, factor) {
  if (!store) {
    const next = clampUiScale(factor);
    if (win && !win.isDestroyed()) win.webContents.setZoomFactor(next);
    return next;
  }
  return applyZoom(win, factor, store);
}

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

function currentThemePreference() {
  return store ? store.getSettings().theme : "dark";
}

function applyNativeAndWindowTheme(win) {
  const theme = currentThemePreference();
  nativeTheme.themeSource = nativeThemeSource(theme);
  const backgroundColor = windowBackgroundColor(
    theme,
    nativeTheme.shouldUseDarkColors,
  );
  if (win) win.setBackgroundColor(backgroundColor);
  return backgroundColor;
}

function createWindow() {
  const backgroundColor = applyNativeAndWindowTheme(null);
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
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

  // Zoom before this is reset on load; persist settings.uiScale (#652).
  win.webContents.on("did-finish-load", () => {
    try {
      win.webContents.setZoomFactor(clampUiScale(currentUiScale()));
    } catch {
      // contents may already be gone
    }
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
    body: notifyBody(notifyEvent(threadNotifyState(thread))),
  });
  n.on("click", () => {
    const win = focusMainWindow();
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send("thread:select", thread.id);
    }
  });
  n.show();
}

// Guest <webview> for the Browser pane (issue #155). Strip node/preload
// and refuse any partition that is not solenta-preview:<threadId>. The app
// window itself still never navigates to the web (links.js above).
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    const decision = guestWebviewPolicy(webPreferences, params);
    if (!decision.allow) event.preventDefault();
  });
  contents.on("did-attach-webview", (_e, guest) => {
    attachGuestPolicy(guest);
  });
});

app.whenReady().then(async () => {
  // Before any window: without an installed menu a packaged build has no
  // Edit menu and Cmd+C/X/V/A silently die in inputs (issue #353).
  installAppMenu({
    applyZoom: applyUiScale,
    getUiScale: currentUiScale,
  });

  const userData = app.getPath("userData");
  mediaProtocol.installHandler({ protocol, net, userDataPath: userData });
  // App root: packaged app path, or repo root in dev (parent of electron/).
  const appPath = app.isPackaged
    ? app.getAppPath()
    : path.join(__dirname, "..");
  // One-time rename Coder -> Solenta: pull the app's own files out of the
  // legacy directory so existing installs keep store, worktrees, and memory.
  // NEVER in throwaway boots: verify/smoke/acceptance probes run with a temp
  // userData, and migrating there would move the real data into a directory
  // that gets deleted. Only migrate when booting the default userData.
  const defaultUserData = path.join(app.getPath("appData"), app.getName());
  const canMigrate =
    path.resolve(userData) === path.resolve(defaultUserData) &&
    process.env.SOLENTA_SKIP_USERDATA_MIGRATION !== "1";

  /** @type {object | null} */
  let core = null;

  // #618: paint the empty window before store load / memory supervision.
  // Assigns the module-level `store` (not a new binding): applyUiScale and
  // currentUiScale read it from outside this function.
  store = await bootFirstPaint({
    createWindow,
    async beforeStore() {
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
      core = await import(pathToFileURL(coreIndex).href);

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

      memorySupervisor = createMemorySupervisor({
        userDataPath: userData,
        appPath,
        log: (msg) => console.warn(msg),
      });
    },
    // Never block or fail app start on memory supervision.
    startMemory: () =>
      memorySupervisor ? memorySupervisor.start() : undefined,
    onMemoryError: (err) => {
      console.warn(
        "memory-server: supervisor start error; continuing without memory:",
        err && err.message ? err.message : err,
      );
    },
    loadStore: () => {
      // Before the store reads: decryption needs the audit sink armed (#649).
      configureDefaultSecrets({
        auditPath: path.join(userData, "secrets-audit.jsonl"),
      });
      return new Store(path.join(userData, "coder-store.json"));
    },
  });

  // Follow the OS when settings.theme is "system".
  nativeTheme.on("updated", () => {
    for (const w of BrowserWindow.getAllWindows()) {
      applyNativeAndWindowTheme(w);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

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
        // Mute checks come after the transition test: this runs on every
        // stream chunk, and getSettings() re-normalizes the whole blob.
        if (
          isNotifyTransition(prev, next) &&
          !payload.thread.muted &&
          !isEffectivelySnoozed(payload.thread, Date.now())
        ) {
          const settings = store.getSettings();
          if (
            shouldNotify(prev, next, isAnyWindowFocused()) &&
            settings.notifications
          ) {
            notifyThreadComplete(payload.thread);
          }
          void dispatchWebhook({
            thread: payload.thread,
            prevStatus: prev,
            nextStatus: next,
            webhook: settings.webhook,
            recordSecretUse,
            log: (err) =>
              console.warn(
                "solenta: webhook POST failed:",
                err && err.message ? err.message : err,
              ),
          });
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
  // Renderer may already have mounted against empty state; this is the
  // signal that invoke channels will answer (#618).
  broadcast("boot:ready");

  if (serveOpts.enabled) {
    const token = loadOrCreateToken(userData);
    // Contract: print the token to stdout when serve mode starts.
    process.stdout.write(`solenta-web: token ${token}\n`);
    if (serveOpts.host !== "127.0.0.1") {
      process.stdout.write(`solenta-web: ${HOST_FLAG_HELP}\n`);
    }
    const staticDir = path.join(__dirname, "../dist");
    // The port is fixed, so EADDRINUSE is routine (a previous instance still
    // holds it). Never let that reject out of whenReady: the rest of boot
    // (IPC ready push, schedulers) would be skipped even though the window
    // is already up.
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
  // Retention is owned by the periodic sweeper below (#641), not this timer.
  const worktreeBase = path.join(userData, "worktrees");
  const sweepTimer = setTimeout(() => {
    const { sweepOrphanWorktrees } = require("./worktrees.js");
    void sweepOrphanWorktrees({ store, worktreeBase })
      .then((result) => {
        if (result.removed.length > 0) {
          console.warn(
            `worktree sweep: removed ${result.removed.length} orphan(s)`,
          );
        }
        const { scheduleImagePrune } = require("./image-store.js");
        return scheduleImagePrune({ store, userDataPath: userData });
      })
      .then((result) => {
        if (result && result.removed > 0) {
          console.warn(`image prune: removed ${result.removed} item(s)`);
        }
      });
  }, 15_000);
  sweepTimer.unref();

  // Periodic retention (#641): grace-period crossings during a multi-day
  // uptime used to wait until the next launch or archive. Startup pass at
  // 15s (same delay as the orphan sweep); then every 6h. Cheap no-op when
  // no project sets a limit. Unref'd so a short-lived process can exit.
  retentionSweeper = createRetentionSweeper({
    store,
    worktreeBase,
    userDataPath: userData,
    broadcast,
    intervalMs: 6 * 60 * 60 * 1000,
    startupDelayMs: 15_000,
  });
  retentionSweeper.start();

  automationScheduler = startScheduler({ store, runner, broadcast });
  autoDispatch = startAutoDispatch({ store, runner, broadcast });
  postMergeScheduler = startPostMergeScheduler({ store, runner, broadcast });

  // In-main orchestrator MCP server (coder-threads): lets any agent drive
  // other threads. Needs store + runner, so it starts after both exist.
  // Fails soft internally; never block app start on it.
  orchServer = createOrchServer({
    store,
    runner,
    userDataPath: userData,
    appPath,
    broadcast,
    log: (msg) => console.warn(msg),
    broadcast,
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
});

installShutdown({
  app,
  cleanup() {
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
    if (retentionSweeper) {
      try {
        retentionSweeper.stop();
      } catch {
        // ignore
      }
      retentionSweeper = null;
    }
    if (automationScheduler) {
      try {
        automationScheduler.stop();
      } catch {
        // ignore
      }
      automationScheduler = null;
    }
    if (autoDispatch) {
      try {
        autoDispatch.stop();
      } catch {
        // ignore
      }
      autoDispatch = null;
    }
    if (postMergeScheduler) {
      try {
        postMergeScheduler.stop();
      } catch {
        // ignore
      }
      postMergeScheduler = null;
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
    try {
      killAllTerminals();
    } catch {
      // ignore
    }
  },
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
