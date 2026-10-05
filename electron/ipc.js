"use strict";

const { BrowserWindow, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { listFiles, searchFiles } = require("./worktrees.js");
const { listLocalServers } = require("./servers.js");
const { spotlightEnv, spotlightLane } = require("./mergeQueue.js");
const { spawnEnvForDevServer, laneEnvExtra } = require("./worktreeEnv.js");
const devservers = require("./devservers.js");
const terminal = require("./terminal.js");
const preview = require("./preview.js");
const { createMemoryProxy } = require("./memory-proxy.js");
const {
  readToolImage,
  toolImageExists,
} = require("./tool-images.js");
const attachments = require("./attachments.js");
const appsnap = require("./appsnap.js");
const mediaProtocol = require("./media-protocol.js");

const { expandUserPath } = require("./fsBrowse.js");
const { SPEECH_NOT_IMPLEMENTED } = require("./speech.js");
// Tests re-require ipc.js after evicting services.js, worktrees.js or the
// electron stub. Reload the split-out ipc-*.js modules with it so their
// handlers bind those fresh copies instead of the first ones cached.
for (const id of Object.keys(require.cache)) {
  if (path.dirname(id) === __dirname && /^ipc-.+\.js$/.test(path.basename(id))) {
    delete require.cache[id];
  }
}
const { resolveThreadRoot } = require("./ipc-shared.js");
const projectsHandlers = require("./ipc-projects.js");
const threadsHandlers = require("./ipc-threads.js");
const insightsHandlers = require("./ipc-insights.js");
const appHandlers = require("./ipc-app.js");
const mcpHandlers = require("./ipc-mcp.js");
const skillsHandlers = require("./ipc-skills.js");
const runsHandlers = require("./ipc-runs.js");
const gitHandlers = require("./ipc-git.js");

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
 * Drop a trailing `:line` / `:line:col` without eating a Windows drive.
 * @param {string} raw
 */
function stripLineSuffix(raw) {
  const m = String(raw).match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!m) return raw;
  if (/^[A-Za-z]$/.test(m[1])) return raw;
  return m[1];
}

/**
 * Validate a path exists and is the thread root or inside it.
 * Relative paths join against the thread worktree (or project checkout).
 * @param {import('./store').Store} store
 * @param {{ threadId?: string, path?: string }} input
 * @returns {string}
 */
function resolveAllowedShellPath(store, input) {
  if (!input || typeof input !== "object") {
    throw new Error("threadId is required");
  }
  const { root } = resolveThreadRoot(store, input.threadId);
  const raw = input.path != null ? String(input.path) : root;
  if (!raw) throw new Error("Path is required");
  const expanded = expandUserPath(stripLineSuffix(raw));
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(root, expanded);
  if (!fs.existsSync(resolved)) {
    throw new Error("Path does not exist");
  }
  if (resolved === root) return resolved;
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path is outside the thread workspace");
  }
  return resolved;
}

/**
 * Same as resolveAllowedShellPath, but missing / outside paths are null.
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {string} rawPath
 * @returns {string | null}
 */
function tryResolveWorkspaceFile(store, threadId, rawPath) {
  try {
    return resolveAllowedShellPath(store, { threadId, path: rawPath });
  } catch {
    return null;
  }
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
  "files:list": async (ctx, input) => {
    return listFiles({
      store: ctx.store,
      threadId: input.threadId,
      query: input.query,
      limit: input.limit,
    });
  },
  "files:search": async (ctx, input) => {
    return searchFiles({
      store: ctx.store,
      threadId: input.threadId,
      query: input.query,
    });
  },
  "files:resolve": async (ctx, input) => {
    const threadId = input && input.threadId;
    if (!threadId) throw new Error("threadId is required");
    const raws = Array.isArray(input.paths) ? input.paths.slice(0, 80) : [];
    return {
      resolved: raws.map((raw) => {
        const p = String(raw ?? "");
        return { path: p, abs: tryResolveWorkspaceFile(ctx.store, threadId, p) };
      }),
    };
  },
  "files:image": async (ctx, input) => {
    const name = input && input.name;
    if (!(await toolImageExists(ctx.userDataPath, name))) {
      return { dataUrl: null };
    }
    if (ctx.serveDataUrls) {
      return { dataUrl: await readToolImage(ctx.userDataPath, name) };
    }
    return { dataUrl: mediaProtocol.toolImageUrl(name) };
  },
  "attachments:pick": async (ctx, input) => {
    if (!ctx.dialog || typeof ctx.dialog.showOpenDialog !== "function") {
      throw new Error("Attachment picker is not available in this mode");
    }
    return {
      attachments: await attachments.pickAttachments(ctx.dialog, {
        includeImages: !input || input.includeImages !== false,
      }),
    };
  },
  "attachments:fromPaths": async (ctx, input) => {
    return {
      attachments: attachments.classifyPaths(input && input.paths),
    };
  },
  "attachments:saveImage": async (ctx, input) => {
    return {
      attachment: attachments.saveImage(
        ctx.userDataPath,
        input && input.threadId,
        input && input.dataUrl,
      ),
    };
  },
  "attachments:saveFile": async (ctx, input) => {
    return {
      attachment: attachments.saveFile(
        ctx.userDataPath,
        input && input.threadId,
        input && input.name,
        input && input.dataUrl,
      ),
    };
  },
  "attachments:saveFolder": async (ctx, input) => {
    return {
      attachment: attachments.saveFolder(
        ctx.userDataPath,
        input && input.threadId,
        input && input.name,
        input && input.files,
      ),
    };
  },
  "attachments:readImage": async (ctx, input) => {
    const filePath = input && input.path;
    const resolved = await attachments.resolveImageFile(filePath);
    if (!resolved) return { dataUrl: null };
    if (ctx.serveDataUrls) {
      return { dataUrl: await attachments.readImage(filePath) };
    }
    return { dataUrl: mediaProtocol.localImageUrl(resolved.path) };
  },
  "attachments:listWindows": async () => {
    try {
      return await appsnap.listWindows();
    } catch {
      return { windows: [] };
    }
  },
  "attachments:captureWindow": async (ctx, input) => {
    const threadId = input && input.threadId;
    const sourceId = input && input.sourceId;
    const png = await appsnap.captureWindowPng(sourceId);
    return {
      attachment: attachments.savePng(ctx.userDataPath, threadId, png),
    };
  },
  "shell:reveal": async (ctx, input) => {
    const target = resolveAllowedShellPath(ctx.store, input);
    shell.showItemInFolder(target);
  },
  "shell:openPath": async (ctx, input) => {
    const target = resolveAllowedShellPath(ctx.store, input);
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  },
  "shell:editors": async () => {
    return require("./openIn.js").listEditors();
  },
  "shell:openIn": async (ctx, input) => {
    const target = resolveAllowedShellPath(ctx.store, input);
    await require("./openIn.js").openIn(target, input && input.editor, {
      openPath: (p) => shell.openPath(p),
    });
  },
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
    return terminal.open(threadId, root, { project });
  },
  "terminal:write": async (ctx, input) => {
    const threadId = input && input.threadId;
    resolveDevServerRoot(ctx, threadId);
    return terminal.write(threadId, input && input.data, sinceOf(input));
  },
  "terminal:read": async (ctx, input) => {
    const threadId = input && input.threadId;
    resolveDevServerRoot(ctx, threadId);
    return terminal.read(threadId, sinceOf(input));
  },
  "terminal:close": async (ctx, input) => {
    const threadId = input && input.threadId;
    resolveDevServerRoot(ctx, threadId);
    return terminal.close(threadId);
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
