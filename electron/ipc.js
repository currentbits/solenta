"use strict";

const { BrowserWindow } = require("electron");
const path = require("node:path");
const { createMemoryProxy } = require("./memory-proxy.js");

const { SPEECH_NOT_IMPLEMENTED } = require("./speech.js");
// Tests re-require ipc.js after evicting services.js, worktrees.js or the
// electron stub. Reload the split-out ipc-*.js modules with it so their
// handlers bind those fresh copies instead of the first ones cached.
for (const id of Object.keys(require.cache)) {
  if (path.dirname(id) === __dirname && /^ipc-.+\.js$/.test(path.basename(id))) {
    delete require.cache[id];
  }
}
const projectsHandlers = require("./ipc-projects.js");
const threadsHandlers = require("./ipc-threads.js");
const insightsHandlers = require("./ipc-insights.js");
const appHandlers = require("./ipc-app.js");
const mcpHandlers = require("./ipc-mcp.js");
const skillsHandlers = require("./ipc-skills.js");
const runsHandlers = require("./ipc-runs.js");
const gitHandlers = require("./ipc-git.js");
const filesHandlers = require("./ipc-files.js");
const devserverHandlers = require("./ipc-devserver.js");

/**
 * Default window fan-out (desktop transport). main.js replaces this with a
 * tee that also reaches authed web sockets.
 */
function defaultWindowBroadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/**
 * Bind store/runner/dialog into a ctx the shared handler map closes over
 * via its first argument. One ctx per process boot. The web bridge clones
 * this ctx with `serveDataUrls: true` so image handlers reply with async
 * data URLs instead of solenta-media:// (issue #145).
 *
 * @param {object} deps
 */
function makeCtx(deps) {
  const broadcast = deps.broadcast || defaultWindowBroadcast;
  const userDataPath = deps.userDataPath || "";
  // Resolved per call, not captured: main builds the simulator service after
  // registerIpc and only publishes it once crash recovery has settled, so a
  // ctx made at boot must never freeze the null it saw then.
  const getIosSimulator =
    typeof deps.getIosSimulator === "function"
      ? deps.getIosSimulator
      : () => deps.iosSimulator || null;
  return {
    dialog: deps.dialog,
    store: deps.store,
    runner: deps.runner,
    broadcast,
    worktreeBase: deps.worktreeBase || "",
    userDataPath,
    memory: createMemoryProxy({ userDataPath }),
    stayAwake: deps.stayAwake || null,
    speech: deps.speech || null,
    cleanupRunArtifacts: deps.cleanupRunArtifacts,
    getIosSimulator,
    log: deps.log,
    confirmApplyUpdate: deps.confirmApplyUpdate,
    getOrchStatus:
      typeof deps.getOrchStatus === "function"
        ? deps.getOrchStatus
        : () => ({ running: false, port: null }),
    openRemoteConnection: deps.openRemoteConnection,
    forgetRemoteConnection: deps.forgetRemoteConnection,
    transport: "desktop",
  };
}

function requireDesktop(ctx) {
  if (!ctx || ctx.transport !== "desktop") {
    const err = new Error("iOS Simulator controls require the desktop app");
    err.code = "unsupported_platform";
    throw err;
  }
}

function requireSimulator(ctx) {
  requireDesktop(ctx);
  const sim = ctx.getIosSimulator && ctx.getIosSimulator();
  if (!sim) {
    const err = new Error("iOS Simulator controls require the desktop app");
    err.code = "unsupported_platform";
    throw err;
  }
  return sim;
}

function speechStatusMissing() {
  return { state: "missing", runtimeReady: false, modelReady: false };
}

function requireSpeech(ctx) {
  if (!ctx || !ctx.speech) {
    throw new Error(SPEECH_NOT_IMPLEMENTED);
  }
  return ctx.speech;
}

function viewerStreamInfo(info) {
  return {
    url: info && info.url,
    token: info && info.token,
    generation: info && info.generation,
    protocolVersion: 1,
    maxMessageBytes: 4194304,
  };
}

function activeRunIdFrom(ctx, threadId) {
  if (!ctx || !ctx.runner || typeof ctx.runner.activeRunId !== "function") {
    return null;
  }
  const runId = ctx.runner.activeRunId(threadId);
  return typeof runId === "string" ? runId : null;
}

/**
 * ONE channel → handler map. Both transports consume this object:
 *   ipcMain.handle(channel, (_, ...a) => IPC_HANDLERS[channel](ctx, ...a))
 *   webBridge dispatch: IPC_HANDLERS[channel](ctx, ...args)
 *
 * Thin clients (preload, wireClient) iterate src/shared/ipcChannels.ts
 * rather than restating these names. Adding a channel means: a row in
 * that table, a handler here, CoderApi JSDoc, and (if the renderer
 * needs a fixture) devCoder/fakeCoder. Run scripts/sync-ipc-preload.js.
 *
 * First argument is always ctx. Bodies match the previous ipcMain closures
 * so throw strings and return shapes stay byte-identical.
 *
 * @type {Record<string, (ctx: object, ...args: unknown[]) => Promise<unknown>>}
 */
const IPC_HANDLERS = {
  ...projectsHandlers,
  ...threadsHandlers,
  ...insightsHandlers,
  ...appHandlers,
  ...mcpHandlers,
  ...skillsHandlers,
  ...runsHandlers,
  ...gitHandlers,
  ...filesHandlers,
  ...devserverHandlers,
  "simulator:capabilities": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.getCapabilities({ threadId: input && input.threadId });
  },
  "simulator:selectDeveloperDir": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.selectDeveloperDirectory({
      threadId: input && input.threadId,
      developerDir: input && input.developerDir,
    });
  },
  "simulator:listDevices": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.listDevices({ threadId: input && input.threadId });
  },
  "simulator:status": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.getStatus({ threadId: input && input.threadId });
  },
  "simulator:attach": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.attach({
      threadId: input && input.threadId,
      deviceUdid: input && input.deviceUdid,
    });
  },
  "simulator:detach": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.detach({
      threadId: input && input.threadId,
      generation: input && input.generation,
    });
  },
  "simulator:takeControl": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.takeover({
      threadId: input && input.threadId,
      deviceUdid: input && input.deviceUdid,
      confirmed: input && input.confirmed,
    });
  },
  "simulator:streamInfo": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    const info = await sim.streamInfo({
      threadId: input && input.threadId,
      generation: input && input.generation,
    });
    return viewerStreamInfo(info);
  },
  "simulator:retryStream": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    const info = await sim.retryStream({
      threadId: input && input.threadId,
      generation: input && input.generation,
    });
    return viewerStreamInfo(info);
  },
  "simulator:sendInput": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.sendInput({
      threadId: input && input.threadId,
      generation: input && input.generation,
      input: input && input.input,
    });
  },
  "simulator:accessibility": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.accessibility({
      threadId: input && input.threadId,
      generation: input && input.generation,
      maxDepth: input && input.maxDepth,
    });
  },
  "simulator:scrollTo": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.scrollTo({
      threadId: input && input.threadId,
      generation: input && input.generation,
      x: input && input.x,
      y: input && input.y,
      dx: input && input.dx,
      dy: input && input.dy,
    });
  },
  "simulator:install": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.install({
      threadId: input && input.threadId,
      generation: input && input.generation,
      relativeAppPath: input && input.relativeAppPath,
    });
  },
  "simulator:launch": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.launch({
      threadId: input && input.threadId,
      generation: input && input.generation,
      bundleId: input && input.bundleId,
    });
  },
  "simulator:openUrl": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.openUrl({
      threadId: input && input.threadId,
      generation: input && input.generation,
      url: input && input.url,
    });
  },
  "simulator:screenshot": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    const threadId = input && input.threadId;
    return sim.captureScreenshot({
      threadId,
      generation: input && input.generation,
      runId: activeRunIdFrom(ctx, threadId),
    });
  },
  "simulator:startRecording": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    const threadId = input && input.threadId;
    return sim.startRecording({
      threadId,
      generation: input && input.generation,
      runId: activeRunIdFrom(ctx, threadId),
    });
  },
  "simulator:stopRecording": async (ctx, input) => {
    const sim = requireSimulator(ctx);
    return sim.stopRecording({
      threadId: input && input.threadId,
      generation: input && input.generation,
      recordingId: input && input.recordingId,
    });
  },
  "speech:status": async (ctx) => {
    if (!ctx || !ctx.speech) return speechStatusMissing();
    return ctx.speech.status();
  },
  "speech:download": async (ctx) => requireSpeech(ctx).download(),
  "speech:start": async (ctx) => requireSpeech(ctx).start(),
  "speech:write": async (ctx, input) => requireSpeech(ctx).write(input),
  "speech:stop": async (ctx, input) => requireSpeech(ctx).stop(input),
  "speech:cancel": async (ctx, input) => requireSpeech(ctx).cancel(input),
};

/**
 * Bound channel → (...args) map for callers that do not want to pass ctx.
 * Still the same IPC_HANDLERS functions underneath.
 *
 * @param {object} deps
 */
function createHandlers(deps) {
  const ctx = deps && deps.store && deps.memory ? deps : makeCtx(deps);
  const map = Object.create(null);
  for (const [channel, fn] of Object.entries(IPC_HANDLERS)) {
    map[channel] = (...args) => fn(ctx, ...args);
  }
  return map;
}

/**
 * Register all invoke handlers from the ipc contract.
 * Iterates the exported IPC_HANDLERS object (same object webBridge uses).
 *
 * @param {object} deps
 * @param {import('electron').IpcMain} deps.ipcMain
 * @param {import('electron').Dialog} deps.dialog
 * @param {import('./store').Store} deps.store
 * @param {ReturnType<import('./runner').createRunner>} deps.runner
 * @param {(channel: string, payload: unknown) => void} [deps.broadcast]
 * @param {ReturnType<import('./caffeinate').createStayAwake>} [deps.stayAwake]
 * @param {ReturnType<import('./speech').createSpeechManager>} [deps.speech]
 * @param {string} [deps.worktreeBase]
 * @param {string} [deps.userDataPath]
 */
function registerIpc(deps) {
  const { ipcMain } = deps;
  const ctx = makeCtx(deps);
  ctx.transport = "desktop";
  for (const [channel, fn] of Object.entries(IPC_HANDLERS)) {
    ipcMain.handle(channel, async (_event, ...args) => fn(ctx, ...args));
  }
  // Native Menu.popup needs the sender window. Keep this out of
  // IPC_HANDLERS so the web bridge never tries to pop a menu on the server.
  ipcMain.handle("contextMenu:show", async (event, items, position) => {
    const { BrowserWindow } = require("electron");
    const { showNativeContextMenu } = require("./contextMenu.js");
    const win = BrowserWindow.fromWebContents(event.sender);
    return showNativeContextMenu(win, items, position);
  });
  return { broadcast: ctx.broadcast, handlers: createHandlers(ctx), ctx };
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

module.exports = {
  IPC_HANDLERS,
  makeCtx,
  createHandlers,
  registerIpc,
  createPushFn,
};
