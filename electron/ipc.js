"use strict";

const { BrowserWindow, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const services = require("./services.js");
const {
  setupWorktree,
  listBranches,
  diff,
  commit,
  revertFile,
  listFiles,
  searchFiles,
  mergeWorktree,
  conflictContext,
  removeWorktree,
  push,
  createPr,
  prStatus,
  prChecks,
  mergePr,
  maybeCleanupMergedWorktree,
  listPrs,
  checkoutPr,
  listCheckpoints,
  restoreCheckpoint,
  runStats,
  turnDiff,
  conflictForecast,
  gcScan,
  gcClean,
} = require("./worktrees.js");
const { suggestCommitMessage } = require("./commitmsg.js");
const { listLocalServers } = require("./servers.js");
const {
  claimLane,
  listLanes,
  previewLane,
  restorePreview,
  recycleWedgedLanes,
  spotlightEnv,
  setSpotlight,
  spotlightLane,
  heartbeatLane,
} = require("./mergeQueue.js");
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
const { syncUserMcpServers } = require("./memory-sup.js");
const {
  redactMcpServer,
  redactMcpServers,
  upsertMcpServer,
  sanitizeMcpInput,
} = require("./mcp.js");
const mcpCatalog = require("./mcpCatalog.js");
const mcpImports = require("./mcpImports.js");
const pairing = require("./pairing.js");
const skills = require("./skills.js");
const skillCatalog = require("./skillCatalog.js");
const skillImports = require("./skillImports.js");
const harnessImports = require("./harnessImports.js");
const { createSafeCommandRunner } = require("./skillPluginAdapters.js");
const cliCommands = require("./cliCommands.js");
const { fetchIssue, listIssues, setPlanStatus, createIssue } = require("./issues.js");
const {
  readPrTemplate,
  viewPrDetail,
  editPr,
  commentPr,
  closePr,
  readyPr,
  mergePrAt,
} = require("./prWorkspace.js");
const automations = require("./automations.js");
const { distillThread } = require("./distill.js");
const { integrateWorker } = require("./crewIntegration.js");

const vibeKanban = require("./vibeKanban.js");
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
const { runRetention, resolveThreadRoot } = require("./ipc-shared.js");
const projectsHandlers = require("./ipc-projects.js");
const threadsHandlers = require("./ipc-threads.js");
const insightsHandlers = require("./ipc-insights.js");
const appHandlers = require("./ipc-app.js");

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
  "mcp:list": async (ctx) => {
    const settings = services.getSettings(ctx.store);
    return redactMcpServers(settings.mcpServers);
  },
  // No await/yield between get/upsert/set: this async handler runs
  // synchronously until return, so concurrent IPC cannot interleave the
  // in-memory store write. store.save() only debounces disk I/O.
  "mcp:save": async (ctx, input) => {
    const clean = sanitizeMcpInput(input);
    const current = services.getSettings(ctx.store).mcpServers;
    const nextList = upsertMcpServer(current, clean);
    const next = services.setSettings(
      ctx.store,
      { mcpServers: nextList },
      { replaceMcpServers: true },
    );
    try {
      syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
    } catch {
      // ignore
    }
    const saved = next.mcpServers.find((s) => s.name === clean.name);
    return redactMcpServer(saved);
  },
  "mcp:remove": async (ctx, input) => {
    const name =
      input && typeof input.name === "string" ? input.name.trim() : "";
    const current = services.getSettings(ctx.store).mcpServers;
    const nextList = current.filter((s) => s.name !== name);
    const next = services.setSettings(ctx.store, { mcpServers: nextList });
    try {
      syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
    } catch {
      // ignore
    }
  },
  "mcp:setEnabled": async (ctx, input) => {
    const name =
      input && typeof input.name === "string" ? input.name.trim() : "";
    const enabled = Boolean(input && input.enabled);
    const current = services.getSettings(ctx.store).mcpServers;
    const existing = current.find((s) => s.name === name);
    if (!existing) throw new Error(`Unknown MCP server: ${name}`);
    if (
      existing.transport === "stdio" &&
      enabled &&
      existing.trusted !== true
    ) {
      throw new Error("Local MCP server must be trusted to enable");
    }
    const nextList = current.map((s) =>
      s.name === name ? { ...s, enabled } : s,
    );
    const next = services.setSettings(ctx.store, { mcpServers: nextList });
    try {
      syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
    } catch {
      // ignore
    }
    const saved = next.mcpServers.find((s) => s.name === name);
    return redactMcpServer(saved);
  },
  "mcp:catalog": async (ctx) => {
    const settings = services.getSettings(ctx.store);
    return mcpCatalog.listCatalog({ servers: settings.mcpServers });
  },
  "mcp:pickImport": async (ctx) => {
    const current = services.getSettings(ctx.store).mcpServers;
    return mcpImports.pickImport({
      userDataPath: ctx.userDataPath,
      dialog: ctx.dialog,
      current,
    });
  },
  "mcp:previewImport": async (ctx, input) => {
    const request = input && typeof input === "object" ? input : {};
    let source = {};
    if (request.kind === "json") {
      source = { kind: "json", text: request.text };
    } else if (request.kind === "catalog") {
      source = { kind: "catalog", id: request.id };
    } else if (request.kind === "github") {
      source = { kind: "github", url: request.url };
    }
    const current = services.getSettings(ctx.store).mcpServers;
    return mcpImports.previewImport({
      userDataPath: ctx.userDataPath,
      input: source,
      current,
    });
  },
  "mcp:installImport": async (ctx, input) => {
    const request = input && typeof input === "object" ? input : {};
    const current = services.getSettings(ctx.store).mcpServers;
    const result = await mcpImports.installImport({
      userDataPath: ctx.userDataPath,
      current,
      request: {
        previewId: request.previewId,
        selected: request.selected,
        replace: request.replace,
        trustLocal: request.trustLocal === true,
        trustLocalCommands: request.trustLocalCommands === true,
        secrets: request.secrets,
      },
      save: (nextList) => {
        const next = services.setSettings(
          ctx.store,
          { mcpServers: nextList },
          { replaceMcpServers: true },
        );
        try {
          syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
        } catch {
          // ignore
        }
        return next.mcpServers;
      },
    });
    return { installed: result.installed };
  },
  "mcp:discardImport": async (ctx, input) => {
    return mcpImports.discardImport({
      userDataPath: ctx.userDataPath,
      previewId: input && input.previewId,
    });
  },
  "pairing:list": async (ctx) => {
    return pairing.listPairings(ctx.userDataPath, {
      getOrchStatus: ctx.getOrchStatus,
    });
  },
  "pairing:create": async (ctx, input) => {
    return pairing.createPairing(ctx.userDataPath, input || {}, {
      getOrchStatus: ctx.getOrchStatus,
    });
  },
  "pairing:revoke": async (ctx, input) => {
    const id = input && typeof input.id === "string" ? input.id : "";
    return pairing.revokePairing(ctx.userDataPath, id);
  },
  "pairing:approve": async (ctx, input) => {
    const threadId =
      input && typeof input.threadId === "string" ? input.threadId : "";
    return pairing.approveExternalRun(
      {
        store: ctx.store,
        runner: ctx.runner,
        broadcast: ctx.broadcast,
      },
      threadId,
    );
  },
  "pairing:reject": async (ctx, input) => {
    const threadId =
      input && typeof input.threadId === "string" ? input.threadId : "";
    return pairing.rejectExternalRun(
      {
        store: ctx.store,
        broadcast: ctx.broadcast,
      },
      threadId,
    );
  },
  "skills:list": async (ctx, input) => {
    const projectPath =
      input && typeof input.projectPath === "string"
        ? input.projectPath
        : null;
    return skills.listSkillsAsync(projectPath, process.env, ctx.userDataPath);
  },
  "skills:add": async (ctx, input) => {
    return skills.addSkill(input || {});
  },
  "skills:remove": async (ctx, input) => {
    return skills.removeSkill(input || {}, process.env, ctx.userDataPath);
  },
  "skills:sync": async (ctx) => {
    return skills.syncSkills();
  },
  "skills:commands": async (ctx, input) => {
    const projectPath =
      input && typeof input.projectPath === "string"
        ? input.projectPath
        : null;
    return cliCommands.listPaletteCommands({ projectPath, provider: input?.provider });
  },
  "skills:catalog": async (ctx) => {
    return skillCatalog.listCatalog({ userDataPath: ctx.userDataPath });
  },
  "skills:pickImport": async (ctx) => {
    return skillImports.pickImport({
      userDataPath: ctx.userDataPath,
      dialog: ctx.dialog,
    });
  },
  "skills:previewImport": async (ctx, input) => {
    return skillImports.previewImport({
      userDataPath: ctx.userDataPath,
      input,
    });
  },
  "skills:installImport": async (ctx, input) => {
    const request = input && typeof input === "object" ? input : {};
    return skillImports.installImport({
      userDataPath: ctx.userDataPath,
      request: {
        previewId: request.previewId,
        selected: request.selected,
        replace: request.replace,
        trustPluginCode: request.trustPluginCode === true,
      },
      runFile: createSafeCommandRunner(),
    });
  },
  "skills:discardImport": async (ctx, input) => {
    return skillImports.discardImport({
      userDataPath: ctx.userDataPath,
      previewId: input && input.previewId,
    });
  },
  "harness:detectSources": async () => {
    return harnessImports.detectSources({ env: process.env });
  },
  "harness:previewImport": async (ctx, input) => {
    const request = input && typeof input === "object" ? input : {};
    const current = services.getSettings(ctx.store).mcpServers;
    const projectPath =
      typeof request.projectPath === "string" ? request.projectPath : undefined;
    return harnessImports.previewImport({
      userDataPath: ctx.userDataPath,
      source: request.source,
      projectPath,
      current,
      memory: ctx.memory,
      env: process.env,
    });
  },
  "harness:installImport": async (ctx, input) => {
    const request = input && typeof input === "object" ? input : {};
    const current = services.getSettings(ctx.store).mcpServers;
    const projectPath =
      typeof request.projectPath === "string" ? request.projectPath : undefined;
    return harnessImports.installImport({
      userDataPath: ctx.userDataPath,
      current,
      memory: ctx.memory,
      env: process.env,
      projectPath,
      request: {
        previewId: request.previewId,
        selected: request.selected,
        replace: request.replace === true,
        trustLocal: request.trustLocal === true,
        trustPluginCode: request.trustPluginCode === true,
      },
      runFile: createSafeCommandRunner(),
      saveMcp: (nextList) => {
        const next = services.setSettings(
          ctx.store,
          { mcpServers: nextList },
          { replaceMcpServers: true },
        );
        try {
          syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
        } catch {
          // ignore
        }
        return next.mcpServers;
      },
    });
  },
  "harness:discardImport": async (ctx, input) => {
    return harnessImports.discardImport({
      userDataPath: ctx.userDataPath,
      previewId: input && input.previewId,
    });
  },
  "workflows:list": async (ctx) => {
    return services.listTemplates(ctx.store);
  },
  "workflows:save": async (ctx, template) => {
    return services.saveTemplate(ctx.store, template);
  },
  "runs:distill": async (ctx, input) => {
    return distillThread(ctx.store, input && input.threadId);
  },
  "workflows:remove": async (ctx, input) => {
    return services.removeTemplate(ctx.store, input);
  },
  "automations:list": async (ctx) => {
    return services.listAutomations(ctx.store);
  },
  "automations:add": async (ctx, input) => {
    return services.addAutomation(ctx.store, input);
  },
  "automations:update": async (ctx, input) => {
    return services.updateAutomation(ctx.store, input);
  },
  "automations:remove": async (ctx, input) => {
    services.removeAutomation(ctx.store, input);
  },
  "automations:runNow": async (ctx, input) => {
    const id = input && input.id != null ? String(input.id) : "";
    return automations.runNow(ctx, id);
  },
  "automations:listRuns": async (ctx, input) => {
    const id = input && input.id != null ? String(input.id) : "";
    return automations.listAutomationRuns(ctx.store, id);
  },
  "runs:start": async (ctx, input) => {
    return ctx.runner.startRun(input);
  },
  "runs:steer": async (ctx, input) => {
    return ctx.runner.steerRun(input);
  },
  "runs:startWorkflow": async (ctx, input) => {
    return ctx.runner.startWorkflowRun(input);
  },
  "runs:retryWorkflowAgent": async (ctx, input) => {
    return ctx.runner.retryWorkflowAgent(input);
  },
  "runs:stop": async (ctx, input) => {
    return ctx.runner.stopRun(input);
  },
  "runs:resumeQuotaWait": async (ctx, input) => {
    return ctx.runner.resumeQuotaWait(input);
  },
  "git:listBranches": async (ctx, input) => {
    const projectId =
      input && typeof input === "object" ? input.projectId : input;
    const project = ctx.store.getProject(projectId);
    if (!project || !project.path) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return listBranches(project.path);
  },
  "git:status": async (ctx, projectId) => {
    const project = ctx.store.getProject(projectId);
    if (!project) {
      return { isRepo: false, branch: "", dirty: false };
    }
    return services.gitStatus(project);
  },
  "git:listBranches": async (ctx, input) => {
    const projectId = input && input.projectId;
    const project = projectId ? ctx.store.getProject(projectId) : null;
    if (!project || !project.path) {
      return { defaultBranch: "main", branches: [] };
    }
    return listBranches(project.path);
  },
  "git:setupWorktree": async (ctx, input) => {
    if (!ctx.worktreeBase) {
      throw new Error("worktreeBase is not configured");
    }
    return setupWorktree({
      store: ctx.store,
      threadId: input.threadId,
      worktreeBase: ctx.worktreeBase,
      broadcast: ctx.broadcast,
    });
  },
  "git:diff": async (ctx, input) => {
    return diff({ store: ctx.store, threadId: input.threadId });
  },
  "git:reviewContext": async (ctx, input) => {
    const { loadReviewContext } = require("./reviewItinerary.js");
    return loadReviewContext({
      store: ctx.store,
      threadId: input.threadId,
      userDataPath: ctx.userDataPath,
    });
  },
  "git:setReviewAccepted": async (ctx, input) => {
    const { setReviewAccepted } = require("./reviewItinerary.js");
    return setReviewAccepted(ctx.store, input.threadId, input.hashes);
  },
  "git:commit": async (ctx, input) => {
    return commit({
      store: ctx.store,
      threadId: input.threadId,
      message: input.message,
      paths: Array.isArray(input.paths) ? input.paths : undefined,
    });
  },
  "git:revertFile": async (ctx, input) => {
    return revertFile({
      store: ctx.store,
      threadId: input.threadId,
      path: input.path,
      status: input.status,
    });
  },
  "git:suggestCommitMessage": async (ctx, input) => {
    return suggestCommitMessage({ store: ctx.store, threadId: input.threadId });
  },
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
  "git:mergeWorktree": async (ctx, input) => {
    const merged = mergeWorktree({
      store: ctx.store,
      threadId: input.threadId,
      ciWorkflowApproved: Boolean(input && input.ciWorkflowApproved),
      paths: Array.isArray(input && input.paths) ? input.paths : undefined,
      broadcast: ctx.broadcast,
    });
    await runRetention(ctx);
    return merged;
  },
  "git:integrateWorker": async (ctx, input) => {
    const result = integrateWorker({
      store: ctx.store,
      leadThreadId: input && input.leadThreadId,
      workerThreadId: input && input.workerThreadId,
      ciWorkflowApproved: Boolean(input && input.ciWorkflowApproved),
      broadcast: ctx.broadcast,
      isRunning: (id) =>
        typeof ctx.runner.isRunning === "function" && ctx.runner.isRunning(id),
    });
    await runRetention(ctx);
    return result;
  },
  "git:conflictContext": async (ctx, input) => {
    return conflictContext({
      store: ctx.store,
      threadId: input && input.threadId,
    });
  },
  "git:removeWorktree": async (ctx, input) => {
    return removeWorktree({
      store: ctx.store,
      threadId: input.threadId,
      force: Boolean(input && input.force),
      broadcast: ctx.broadcast,
    });
  },
  "git:push": async (ctx, input) => {
    return push({
      store: ctx.store,
      threadId: input.threadId,
      broadcast: ctx.broadcast,
    });
  },
  "git:createPr": async (ctx, input) => {
    return createPr({
      store: ctx.store,
      threadId: input.threadId,
      title: input.title,
      body: input.body,
      draft: input.draft,
      allowOversize: Boolean(input && input.allowOversize),
      broadcast: ctx.broadcast,
    });
  },
  "git:prStatus": async (ctx, input) => {
    const info = await prStatus({
      store: ctx.store,
      threadId: input.threadId,
    });
    // The sidebar #N link reads the stored thread, not this return value.
    if (info) ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return info;
  },
  "git:prChecks": async (ctx, input) => {
    return prChecks({
      store: ctx.store,
      threadId: input.threadId,
    });
  },
  "git:prMerge": async (ctx, input) => {
    const info = await mergePr({
      store: ctx.store,
      threadId: input.threadId,
      ciWorkflowApproved: Boolean(input && input.ciWorkflowApproved),
      broadcast: ctx.broadcast,
    });
    // Merged in-app: reclaim the worktree + branch right away (same rules
    // as the background refresher — dirty/unpushed trees are left alone).
    const cleaned = await maybeCleanupMergedWorktree(ctx.store, input.threadId);
    if (cleaned.cleaned) {
      ctx.store.save();
      ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    }
    await runRetention(ctx);
    return info;
  },
  "git:listPrs": async (_ctx, projectPath, opts) => {
    return listPrs(projectPath, opts);
  },
  "git:checkoutPr": async (ctx, input) => {
    return checkoutPr({
      store: ctx.store,
      projectId: input && input.projectId,
      prNumber: input && input.prNumber,
      worktreeBase: ctx.worktreeBase,
      broadcast: ctx.broadcast,
    });
  },
  "git:prTemplate": async (_ctx, input) => {
    return readPrTemplate(input && input.projectPath);
  },
  "git:prDetail": async (_ctx, input) => {
    return viewPrDetail(input && input.projectPath, input && input.prNumber);
  },
  "git:prEdit": async (ctx, input) => {
    return editPr(
      input && input.projectPath,
      {
        prNumber: input && input.prNumber,
        title: input && input.title,
        body: input && input.body,
      },
      { store: ctx.store, broadcast: ctx.broadcast },
    );
  },
  "git:prComment": async (_ctx, input) => {
    return commentPr(input && input.projectPath, {
      prNumber: input && input.prNumber,
      body: input && input.body,
    });
  },
  "git:prClose": async (ctx, input) => {
    return closePr(
      input && input.projectPath,
      { prNumber: input && input.prNumber },
      { store: ctx.store, broadcast: ctx.broadcast },
    );
  },
  "git:prReady": async (ctx, input) => {
    return readyPr(
      input && input.projectPath,
      {
        prNumber: input && input.prNumber,
        undo: Boolean(input && input.undo),
      },
      { store: ctx.store, broadcast: ctx.broadcast },
    );
  },
  "git:prMergeAt": async (ctx, input) => {
    return mergePrAt(
      input && input.projectPath,
      { prNumber: input && input.prNumber },
      { store: ctx.store, broadcast: ctx.broadcast },
    );
  },
  "issues:fetch": async (ctx, input) => {
    const projectPath = input && input.projectPath;
    const ref = input && input.ref;
    const settings =
      ctx.store && typeof ctx.store.getSettings === "function"
        ? ctx.store.getSettings()
        : null;
    return fetchIssue(projectPath, ref, {
      linearApiKey: settings && settings.linearApiKey,
    });
  },
  "issues:list": async (_ctx, projectPath) => {
    return listIssues(projectPath);
  },
  "issues:setPlanStatus": async (_ctx, input) => {
    return setPlanStatus(
      input && input.projectPath,
      input && input.number,
      input && input.status,
    );
  },
  "issues:create": async (_ctx, input) => {
    return createIssue(input && input.projectPath, {
      title: input && input.title,
      body: input && input.body,
    });
  },
  "git:listCheckpoints": async (ctx, input) => {
    return listCheckpoints({
      store: ctx.store,
      threadId: input.threadId,
    });
  },
  "git:restoreCheckpoint": async (ctx, input) => {
    const result = await restoreCheckpoint({
      store: ctx.store,
      threadId: input.threadId,
      sha: input.sha,
      isRunning: (id) => ctx.runner.isRunning(id),
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
    });
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    if (ctx.runner && typeof ctx.runner.refreshDetail === "function") {
      try {
        ctx.runner.refreshDetail(input.threadId);
      } catch {
        // Open detail catches up on the next threads.get.
      }
    }
    return result;
  },
  "git:syncInfo": async (ctx, input) => {
    try {
      const threadId = input && input.threadId;
      if (!threadId) return { hasUpstream: false };
      const thread = ctx.store.getThread(threadId);
      if (!thread) return { hasUpstream: false };
      const project = ctx.store.getProject(thread.projectId);
      if (!project) return { hasUpstream: false };
      const root = thread.worktreePath || project.path;
      if (!root) return { hasUpstream: false };
      // await, not a bare return: gitSyncInfo is async, and a returned
      // promise would settle outside this try — the catch below would never
      // see a rejection.
      return await services.gitSyncInfo(root);
    } catch {
      return { hasUpstream: false };
    }
  },
  "git:fetch": async (ctx, input) => {
    const threadId = input && input.threadId;
    if (!threadId) throw new Error("threadId is required");
    const { root } = resolveThreadRoot(ctx.store, threadId);
    await services.gitFetch(root);
  },
  "git:repoInfo": async (ctx, input) => {
    // Never throws: anything missing or unparseable is { ok: false }.
    try {
      const threadId = input && input.threadId;
      if (!threadId) return { ok: false };
      const thread = ctx.store.getThread(threadId);
      if (!thread) return { ok: false };
      const project = ctx.store.getProject(thread.projectId);
      if (!project || project.remoteHost) return { ok: false };
      const root = thread.worktreePath || project.path;
      if (!root) return { ok: false };
      return await services.gitRepoInfo(root);
    } catch {
      return { ok: false };
    }
  },
  "git:pull": async (ctx, input) => {
    // Never throws: failure modes come back in-band as { ok: false, reason }.
    try {
      const threadId = input && input.threadId;
      if (!threadId) return { ok: false, reason: "No thread selected" };
      const thread = ctx.store.getThread(threadId);
      if (!thread) return { ok: false, reason: "Unknown thread" };
      const project = ctx.store.getProject(thread.projectId);
      if (!project || project.remoteHost) {
        return { ok: false, reason: "Not available on remote projects" };
      }
      const root = thread.worktreePath || project.path;
      return await services.gitPull(root);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      return { ok: false, reason: msg.split("\n")[0] || "Pull failed" };
    }
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
  "git:gcScan": async (ctx) => {
    return gcScan({ store: ctx.store, worktreeBase: ctx.worktreeBase });
  },
  "git:gcClean": async (ctx, input) => {
    return gcClean({
      store: ctx.store,
      worktreeBase: ctx.worktreeBase,
      paths: (input && input.paths) || [],
      broadcast: ctx.broadcast,
    });
  },
  "mergeQueue:claimLane": async (ctx, input) => {
    if (!ctx.worktreeBase) {
      throw new Error("worktreeBase is not configured");
    }
    return claimLane({
      store: ctx.store,
      threadId: input && input.threadId,
      worktreeBase: ctx.worktreeBase,
    });
  },
  "mergeQueue:listLanes": async (ctx, input) => {
    return listLanes(ctx.store, input && input.projectId);
  },
  "mergeQueue:previewLane": async (ctx, input) => {
    return previewLane({
      store: ctx.store,
      projectId: input && input.projectId,
      lane: input && input.lane,
    });
  },
  "mergeQueue:restorePreview": async (ctx, input) => {
    return restorePreview({
      store: ctx.store,
      projectId: input && input.projectId,
    });
  },
  "mergeQueue:recycleWedgedLanes": async (ctx, input) => {
    return recycleWedgedLanes({
      store: ctx.store,
      projectId: input && input.projectId,
    });
  },
  "mergeQueue:heartbeatLane": async (ctx, input) => {
    return heartbeatLane({
      store: ctx.store,
      threadId: input && input.threadId,
      now: input && input.now,
    });
  },
  "mergeQueue:setSpotlight": async (ctx, input) => {
    return setSpotlight({
      store: ctx.store,
      projectId: input && input.projectId,
      enabled: input && input.enabled,
    });
  },
  "mergeQueue:spotlightLane": async (ctx, input) => {
    return spotlightLane({
      store: ctx.store,
      projectId: input && input.projectId,
      lane: input && input.lane,
    });
  },
  "vibeKanban:preview": async (ctx, input) => {
    return vibeKanban.preview(ctx.store, input || {});
  },
  "vibeKanban:import": async (ctx, input) => {
    const result = await vibeKanban.importFrom(ctx.store, input || {});
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return result;
  },
  "vibeKanban:pickDataDir": async (ctx) => {
    if (!ctx.dialog || typeof ctx.dialog.showOpenDialog !== "function") {
      throw new Error("Folder picker is not available in this mode");
    }
    const result = await ctx.dialog.showOpenDialog({
      title: "Choose the Vibe Kanban data folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  },
  "vibeKanban:export": async (ctx) => {
    if (!ctx.dialog || typeof ctx.dialog.showSaveDialog !== "function") {
      throw new Error("Save dialog is not available in this mode");
    }
    const result = await ctx.dialog.showSaveDialog({
      title: "Export Solenta data",
      defaultPath: "solenta-export.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const dump = vibeKanban.buildExport(ctx.store);
    fs.writeFileSync(result.filePath, JSON.stringify(dump, null, 2));
    return result.filePath;
  },
  "git:runStats": async (ctx, input) => {
    return runStats({
      store: ctx.store,
      threadId: input && input.threadId,
    });
  },
  "git:turnDiff": async (ctx, input) => {
    return turnDiff({
      store: ctx.store,
      threadId: input && input.threadId,
      sha: input && input.sha,
    });
  },
  "git:conflictForecast": async (ctx, input) => {
    return conflictForecast({
      store: ctx.store,
      projectId: input && input.projectId,
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
