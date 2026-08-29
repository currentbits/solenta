"use strict";

const { BrowserWindow, shell, nativeTheme } = require("electron");
const { windowBackgroundColor, nativeThemeSource } = require("./theme.js");
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
  conflictForecast,
  gcScan,
  gcClean,
  scheduleRetention,
} = require("./worktrees.js");
const { suggestCommitMessage } = require("./commitmsg.js");
const { listLocalServers } = require("./servers.js");
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
  redactSettings,
  upsertMcpServer,
  sanitizeMcpInput,
} = require("./mcp.js");
const mcpCatalog = require("./mcpCatalog.js");
const mcpImports = require("./mcpImports.js");
const skills = require("./skills.js");
const skillCatalog = require("./skillCatalog.js");
const skillImports = require("./skillImports.js");
const { createSafeCommandRunner } = require("./skillPluginAdapters.js");
const cliCommands = require("./cliCommands.js");
const { fetchIssue, listIssues, setPlanStatus, createIssue } = require("./issues.js");
const automations = require("./automations.js");
const { buildActivity } = require("./activity.js");
const { collectDigest } = require("./digest.js");
const { collectFleet } = require("./fleet.js");
const { distillThread } = require("./distill.js");
const updater = require("./updater.js");
const feedback = require("./feedback.js");

/** Version stamped in the embedded package.json; "dev" outside a build. */
function appVersion() {
  try {
    return String(require("../package.json").version || "") || "dev";
  } catch {
    return "dev";
  }
}
const vibeKanban = require("./vibeKanban.js");
const { browseFilesystem, expandUserPath } = require("./fsBrowse.js");
const { discoverSourceControl } = require("./sourceControl.js");
const { applyZoom } = require("./zoom.js");

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
 * A thread the user pushed out of attention (settled, archived, deleted) has
 * no next turn: kill its kept-alive Claude CLI now instead of holding the
 * process for the 30-minute idle reaper (issue #48).
 *
 * @param {object} ctx
 * @param {string} threadId
 */
function retireAgent(ctx, threadId) {
  if (typeof ctx.runner.disposeClaudeSession === "function") {
    ctx.runner.disposeClaudeSession(threadId);
  }
}

/**
 * Reclaim settled worktrees past retention after a done-transition (#559).
 * No-op without a worktreeBase (tests that never configured one).
 * @param {object} ctx
 */
function runRetention(ctx) {
  if (!ctx || !ctx.worktreeBase) return Promise.resolve();
  return scheduleRetention({
    store: ctx.store,
    worktreeBase: ctx.worktreeBase,
    userDataPath: ctx.userDataPath,
    broadcast: ctx.broadcast,
  });
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
    cleanupRunArtifacts: deps.cleanupRunArtifacts,
    getIosSimulator,
    log: deps.log,
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
 * Thread cwd: worktree when bound, else the project checkout.
 * @param {import('./store').Store} store
 * @param {string} threadId
 */
function resolveThreadRoot(store, threadId) {
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }
  const root = thread.worktreePath || project.path;
  if (!root) {
    throw new Error("Thread has no worktree or project path");
  }
  return { thread, project, root: path.resolve(root) };
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
 * Shared get/peek payload. Selecting a thread (get) stamps lastVisitedAt;
 * peeking a sibling for the divergence compare must not (issue #393).
 */
function threadDetailFor(ctx, id, markVisited) {
  const workflow =
    typeof ctx.runner.getActiveWorkflow === "function"
      ? ctx.runner.getActiveWorkflow(id)
      : null;
  let view = null;
  if (workflow && ctx.runner.toWorkflowView) {
    // Surface workflow for simulate (core) and orchestrated multi-phase runs.
    if (
      workflow.__orchestrated ||
      (!workflow.__real && !workflow.__claude && !workflow.__codex)
    ) {
      view = ctx.runner.toWorkflowView(workflow);
    }
  }
  return services.getThreadDetail(ctx.store, id, view, {
    markVisited,
    pendingPermission: ctx.runner.getPendingPermission
      ? ctx.runner.getPendingPermission(id)
      : null,
  });
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
  "projects:list": async (ctx) => {
    return services.listProjects(ctx.store);
  },
  "projects:add": async (ctx, projectPath, opts) => {
    return services.addProject(ctx.store, projectPath, opts);
  },
  "projects:create": async (ctx, input) => {
    return services.createProject(ctx.store, input || {});
  },
  "projects:pickDirectory": async (ctx) => {
    if (!ctx.dialog || typeof ctx.dialog.showOpenDialog !== "function") {
      throw new Error("Folder picker is not available in this mode");
    }
    const result = await ctx.dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  },
  "projects:update": async (ctx, input) => {
    return services.updateProject(
      ctx.store,
      input && input.projectId,
      input || {},
    );
  },
  "projects:pickIcon": async (ctx, input) => {
    return services.pickProjectIcon(
      ctx.store,
      input && input.projectId,
      ctx.dialog,
    );
  },
  "projects:resolveIcon": async (ctx, input) => {
    const payload = input && typeof input === "object" ? input : {};
    const hasPath = Object.prototype.hasOwnProperty.call(payload, "iconPath");
    return services.resolveProjectIcon(
      ctx.store,
      payload.projectId,
      hasPath ? payload.iconPath : undefined,
    );
  },
  "projects:addViaDialog": async (ctx) => {
    const result = await ctx.dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return services.addProject(ctx.store, result.filePaths[0]);
  },
  /**
   * Directory listing for the in-app add-project browser (#609).
   * `environment` is an SSH user@host; omit/empty = this machine.
   */
  "fs:browse": async (ctx, input) => {
    const payload = input && typeof input === "object" ? input : {};
    return browseFilesystem({
      store: ctx.store,
      path: payload.path,
      environment: payload.environment,
      cwd: payload.cwd,
    });
  },
  "projects:remove": async (ctx, input) => {
    await services.removeProject(ctx.store, input, {
      isRunning: (id) => ctx.runner.isRunning(id),
      getIosSimulator: ctx.getIosSimulator,
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
      log: ctx.log,
    });
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
  },
  "projects:codeMap": async (ctx, input) => {
    return services.readProjectCodeMap(ctx.store, input || {}, {
      userDataPath: ctx.userDataPath,
    });
  },
  "projects:lintAgentConfig": async (ctx, input) => {
    return services.lintAgentConfig(ctx.store, input || {}, {
      memory: ctx.memory,
    });
  },
  "projects:previewAgentConfig": async (ctx, input) => {
    return services.previewAgentConfig(ctx.store, input || {}, {
      memory: ctx.memory,
    });
  },
  "projects:writeAgentConfig": async (ctx, input) => {
    return services.writeAgentConfig(ctx.store, input || {}, {
      memory: ctx.memory,
    });
  },
  "spaces:list": async (ctx) => {
    return services.listSpaces(ctx.store);
  },
  "spaces:add": async (ctx, input) => {
    return services.addSpace(ctx.store, input || {});
  },
  "spaces:update": async (ctx, input) => {
    return services.updateSpace(ctx.store, input || {});
  },
  "spaces:remove": async (ctx, input) => {
    return services.removeSpace(ctx.store, input || {});
  },
  "threads:list": async (ctx) => {
    return services.listThreads(ctx.store);
  },
  "threads:summaries": async (ctx) => {
    return services.threadSummaries(ctx.store);
  },
  "threads:crewTasks": async (ctx, input) => {
    return services.listCrewTasks(ctx.store, input || {});
  },
  "activity:list": async (ctx) => {
    const threads = ctx.store.getThreads();
    return buildActivity(threads, ctx.store.data.workLogByThread, Date.now());
  },
  "usage:byDay": async (ctx) => {
    return {
      byDay: ctx.store.getUsageByDay(),
      threadsByDay: ctx.store.getUsageThreadsByDay(),
    };
  },
  "insights:failureModes": async (ctx) => {
    const { clusterFailureModes } = require("./failuremodes.js");
    return clusterFailureModes({
      threads: ctx.store.getThreads(),
      messagesByThread: ctx.store.data.messagesByThread,
    });
  },
  "fleet:evidence": async (ctx, input) => {
    return collectFleet({
      store: ctx.store,
      nowMs: Date.now(),
      days: input && input.days,
    });
  },
  "digest:list": async (ctx, input) => {
    return collectDigest({
      store: ctx.store,
      sinceMs: input && input.sinceMs,
      nowMs: Date.now(),
    });
  },
  "digest:markSeen": async (ctx, input) => {
    const at =
      input && Number.isFinite(input.atMs) ? input.atMs : Date.now();
    ctx.store.setDigestSeenAt(at);
    ctx.store.save();
    return { seenAt: at };
  },
  "threads:search": async (ctx, input) => {
    return services.searchThreads(ctx.store, input || { query: "" });
  },
  "threads:create": async (ctx, input) => {
    const thread = services.createThread(ctx.store, input);
    // Ask mode (issue #392): no worktree, no orchestrator fork. Wins over
    // both so a defaultWorktree setting cannot sneak a pending worktree
    // onto a read-only Q&A thread.
    if (input && input.ask === true) {
      services.startAsk(ctx.store, { threadId: thread.id });
      ctx.broadcast("threads:changed", services.listThreads(ctx.store));
      return ctx.store.getThread(thread.id);
    }
    // Orchestrator thread (issue #202): the first prompt is forked to a
    // worker, which is what gets the worktree — so this branch wins over
    // `worktree` and never touches the filesystem itself.
    if (input && input.orchestrate === true) {
      try {
        const project = ctx.store.getProject(thread.projectId);
        if (project && project.remoteHost) {
          throw new Error(
            "Orchestrator threads are not available for remote projects",
          );
        }
        ctx.store.updateThread(thread.id, { pendingFork: true });
        ctx.store.save();
      } catch (err) {
        // Atomic create, same as the worktree path below.
        // Rollback of a thread created this invoke: no run yet, no artifacts.
        try {
          services.deleteThread(ctx.store, { threadId: thread.id });
        } catch {
          /* best effort */
        }
        ctx.broadcast("threads:changed", services.listThreads(ctx.store));
        throw err;
      }
      if (input.teach === true) {
        services.startTeach(ctx.store, { threadId: thread.id });
      }
      ctx.broadcast("threads:changed", services.listThreads(ctx.store));
      return ctx.store.getThread(thread.id);
    }
    if (input && input.teach === true) {
      services.startTeach(ctx.store, { threadId: thread.id });
    }
    if (input && input.worktree === true) {
      try {
        if (!ctx.worktreeBase) {
          throw new Error("worktreeBase is not configured");
        }
        const project = ctx.store.getProject(thread.projectId);
        if (project && project.remoteHost) {
          throw new Error(
            "Worktree threads are not available for remote projects",
          );
        }
        // Lazy (t3-style): only mark intent here. The worktree + branch are
        // created by ensureWorktree at first run start, so a thread that
        // never runs leaves nothing on disk.
        ctx.store.updateThread(thread.id, { pendingWorktree: true });
        ctx.store.save();
      } catch (err) {
        // Atomic create: never leave a thread behind when its worktree
        // intent failed validation. worktreePath is still null here, so
        // deleteThread's guard does not fire.
        // Rollback of a thread created this invoke: no run yet, no artifacts.
        try {
          services.deleteThread(ctx.store, { threadId: thread.id });
        } catch {
          /* best effort */
        }
        ctx.broadcast("threads:changed", services.listThreads(ctx.store));
        throw err;
      }
    }
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return ctx.store.getThread(thread.id);
  },
  "threads:fork": async (ctx, input) => {
    const thread = services.forkThread(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return thread;
  },
  "threads:rewind": async (ctx, input) => {
    const result = await services.rewindThread(ctx.store, input, {
      isRunning: (id) => ctx.runner.isRunning(id),
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
      log: ctx.log,
    });
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return result;
  },
  "threads:get": async (ctx, id) => threadDetailFor(ctx, id, true),
  // Compare/sibling load (issue #393). Same payload as get, no visit stamp.
  "threads:peek": async (ctx, id) => threadDetailFor(ctx, id, false),
  "threads:respondPermission": async (ctx, input) => {
    // runner.respondPermission pushes the updated detail itself.
    ctx.runner.respondPermission(input);
  },
  "threads:clearQuestion": async (ctx, input) => {
    // Dismiss only (issue #647). Answering rides the normal send path, which
    // clears the card in startRun / setQueued. Pushes its own detail.
    ctx.runner.clearQuestion(input);
  },
  "threads:setPermissionMode": async (ctx, input) => {
    const updated = services.setPermissionMode(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    // Drop a synthesized plan card from the open thread (issue #707).
    if (ctx.runner.refreshDetail) ctx.runner.refreshDetail(input.threadId);
    return updated;
  },
  "threads:setArchived": async (ctx, input) => {
    const updated = services.setArchived(ctx.store, input, {
      getIosSimulator: ctx.getIosSimulator,
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
      log: ctx.log,
    });
    if (updated && updated.archived) {
      retireAgent(ctx, updated.id);
    }
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    if (updated && updated.archived) await runRetention(ctx);
    return updated;
  },
  "threads:setSettled": async (ctx, input) => {
    const updated = services.setSettled(ctx.store, input);
    if (updated && updated.settledOverride === "settled") {
      retireAgent(ctx, updated.id);
    }
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setPinned": async (ctx, input) => {
    const updated = services.setPinned(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setQueued": async (ctx, input) => {
    const updated = services.setQueued(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setSnoozed": async (ctx, input) => {
    const updated = services.setSnoozed(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setMuted": async (ctx, input) => {
    const updated = services.setMuted(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setCrossThreadInbound": async (ctx, input) => {
    const updated = services.setCrossThreadInbound(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setQuotaWaitAutoResume": async (ctx, input) => {
    const updated = services.setQuotaWaitAutoResume(ctx.store, input);
    if (ctx.runner && typeof ctx.runner.refreshQuotaWait === "function") {
      ctx.runner.refreshQuotaWait(input.threadId);
    }
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setNotes": async (ctx, input) => {
    const updated = services.setNotes(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setBaseBranch": async (ctx, input) => {
    const updated = services.setBaseBranch(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:resolveSuggestion": async (ctx, input) => {
    const updated = services.resolveSuggestion(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    if (ctx.runner && typeof ctx.runner.refreshDetail === "function") {
      try {
        ctx.runner.refreshDetail(input && input.threadId);
      } catch {
        /* chip already persisted; a missed push is a refresh away */
      }
    }
    return updated;
  },
  "threads:setFeltEstimate": async (ctx, input) => {
    const updated = services.setFeltEstimate(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:startSpec": async (ctx, input) => {
    const updated = services.startSpec(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:stopSpec": async (ctx, input) => {
    const updated = services.stopSpec(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:reviewSpec": async (ctx, input) => {
    const { thread, prompt } = services.reviewSpec(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    await ctx.runner.startRun({ threadId: input.threadId, prompt });
    return thread;
  },
  "threads:specArtifact": async (ctx, input) => {
    return services.readSpecArtifact(ctx.store, input);
  },
  "threads:dispatchSpec": async (ctx, input) => {
    const result = services.dispatchSpec(ctx.store, input);
    const workers = services.forkSpecWave(ctx.store, {
      threadId: input.threadId,
      wave: result.wave,
    });
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    for (const w of workers) {
      await ctx.runner.startRun({ threadId: w.thread.id, prompt: w.prompt });
    }
    return {
      thread: ctx.store.getThread(input.threadId),
      dispatched: workers.map((w) => ({
        threadId: w.thread.id,
        taskId: w.task.id,
        title: w.task.title,
      })),
      reason: result.reason,
    };
  },
  "threads:convergeSpec": async (ctx, input) => {
    const { thread, prompt } = services.convergeSpec(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    await ctx.runner.startRun({ threadId: input.threadId, prompt });
    return thread;
  },
  "threads:startTeach": async (ctx, input) => {
    const updated = services.startTeach(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:startAsk": async (ctx, input) => {
    const updated = services.startAsk(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:stopAsk": async (ctx, input) => {
    const updated = services.stopAsk(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:btw": async (ctx, input) => {
    const start =
      ctx.runner && typeof ctx.runner.startBtw === "function"
        ? ctx.runner.startBtw
        : async (body) => services.addBtw(ctx.store, body).thread;
    const updated = await start(input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:dismissBtw": async (ctx, input) => {
    const cancel =
      ctx.runner && typeof ctx.runner.cancelBtw === "function"
        ? ctx.runner.cancelBtw
        : (body) => services.dismissBtw(ctx.store, body);
    const updated = await cancel(input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:promoteBtw": async (ctx, input) => {
    const promote =
      ctx.runner && typeof ctx.runner.promoteBtw === "function"
        ? ctx.runner.promoteBtw
        : (body) => services.promoteBtw(ctx.store, body);
    const updated = await promote(input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:stopTeach": async (ctx, input) => {
    const updated = services.stopTeach(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:requestTeachReview": async (ctx, input) => {
    const { thread, prompt } = services.requestTeachReview(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    await ctx.runner.startRun({ threadId: input.threadId, prompt });
    return thread;
  },
  "threads:rename": async (ctx, input) => {
    const updated = services.renameThread(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setProvider": async (ctx, input) => {
    const updated = services.setProvider(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setReasoningEffort": async (ctx, input) => {
    const updated = services.setReasoningEffort(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setWebSearch": async (ctx, input) => {
    const updated = services.setWebSearch(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setVerifyCommand": async (ctx, input) => {
    const updated = services.setVerifyCommand(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:runVerify": async (ctx, input) => {
    const result = await services.runVerifyNow(ctx.store, input, {
      runner: ctx.runner,
    });
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return result;
  },
  "threads:runCommand": async (ctx, input) => {
    return services.runCommand(ctx.store, input, {
      runner: ctx.runner,
      broadcast: ctx.broadcast,
    });
  },
  "app:status": async (ctx) => {
    return services.appStatus(ctx.store);
  },
  "app:checkUpdate": async (ctx) => {
    return updater.checkUpdate({
      channelOverride: ctx.store.getSettings().updateChannel,
    });
  },
  "app:downloadUpdate": async (ctx) => {
    const { updateChannel } = ctx.store.getSettings();
    const status = await updater.downloadUpdate({ channelOverride: updateChannel });
    // The staged bundle carries its own channel stamp, so a nightly install
    // swapping in a prod build would silently leave the nightly channel.
    // Pin the channel we were on into settings before that happens.
    if (status.state === "staged" && !updateChannel && status.channel) {
      ctx.store.setSettings({ updateChannel: status.channel });
    }
    return status;
  },
  "app:applyUpdate": async () => {
    updater.applyUpdate();
  },
  "app:feedback": async (ctx, input) => {
    const text = feedback.normalizeFeedback(input && input.text);
    if (!text) throw new Error("Feedback is empty");
    // Send first: a failed send must not leave a "sent" line in the transcript.
    await feedback.sendFeedback({
      text,
      version: appVersion(),
      platform: `${process.platform} ${process.arch}`,
    });
    const threadId = input && input.threadId;
    if (threadId) {
      feedback.appendFeedbackEvent(
        ctx.store,
        threadId,
        "Feedback sent to the Solenta team. Thank you.",
      );
      try {
        ctx.broadcast(
          "thread:updated",
          services.getThreadDetail(ctx.store, threadId, null, {
            markVisited: false,
          }),
        );
        ctx.broadcast("threads:changed", services.listThreads(ctx.store));
      } catch {
        // Thread archived between the send and the confirmation.
      }
    }
  },
  "memory:search": async (ctx, input) => {
    return ctx.memory.search(input || { query: "" });
  },
  "memory:recent": async (ctx, input) => {
    return ctx.memory.recent(input || {});
  },
  "memory:get": async (ctx, input) => {
    return ctx.memory.get(input || { id: "" });
  },
  "memory:store": async (ctx, input) => {
    return ctx.memory.store(input);
  },
  "memory:update": async (ctx, input) => {
    return ctx.memory.update(input);
  },
  "memory:remove": async (ctx, input) => {
    return ctx.memory.remove(input);
  },
  "memory:maintenance": async (ctx, input) => {
    return ctx.memory.maintenance(input || {});
  },
  "memory:resolve": async (ctx, input) => {
    return ctx.memory.resolve(input);
  },
  "settings:get": async (ctx) => {
    return redactSettings(services.getSettings(ctx.store));
  },
  "settings:set": async (ctx, patch) => {
    const next = services.setSettings(ctx.store, patch);
    if (patch && Object.prototype.hasOwnProperty.call(patch, "theme") && nativeTheme) {
      nativeTheme.themeSource = nativeThemeSource(next.theme);
      const bg = windowBackgroundColor(
        next.theme,
        nativeTheme.shouldUseDarkColors,
      );
      const windows =
        typeof BrowserWindow.getAllWindows === "function"
          ? BrowserWindow.getAllWindows()
          : [];
      for (const w of windows) {
        if (w && typeof w.setBackgroundColor === "function") {
          w.setBackgroundColor(bg);
        }
      }
    }
    // Re-register user MCP servers so provider hooks pick the change up on
    // the next turn. Best-effort: never fail a settings save on it.
    try {
      syncUserMcpServers(next.mcpServers, { userDataPath: ctx.userDataPath });
    } catch {
      // ignore
    }
    if (ctx.runner && typeof ctx.runner.refreshAllQuotaWaits === "function") {
      ctx.runner.refreshAllQuotaWaits();
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, "uiScale")) {
      applyZoom(null, next.uiScale, ctx.store);
    }
    // stayAwake mode change (#364): re-derive the power blocker now, not on
    // the next thread tick. evaluate() is idempotent.
    if (ctx.stayAwake) {
      ctx.stayAwake.evaluate();
    }
    return redactSettings(next);
  },
  "stayAwake:status": async (ctx) => {
    if (ctx.stayAwake) {
      return ctx.stayAwake.getState();
    }
    // Web mode has no power APIs: report the configured mode, never blocking.
    const settings = services.getSettings(ctx.store);
    return {
      mode: settings.stayAwake,
      blocking: false,
      onBattery: false,
      anyWorking: false,
    };
  },
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
  // "Send test" in Settings (issue #167). The renderer cannot POST these
  // itself — Slack/Discord/ntfy answer no CORS preflight — and a typo'd or
  // revoked URL is otherwise only discoverable by finishing a real run.
  "settings:testWebhook": async (ctx) => {
    const { testWebhook } = require("./notify.js");
    const { recordSecretUse } = require("./secrets.js");
    return testWebhook({
      webhook: services.getSettings(ctx.store).webhook,
      recordSecretUse,
    });
  },
  "skills:list": async (ctx, input) => {
    const projectPath =
      input && typeof input.projectPath === "string"
        ? input.projectPath
        : null;
    return skills.listSkills(projectPath, process.env, ctx.userDataPath);
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
    return cliCommands.listPaletteCommands({ projectPath });
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
  "providers:list": async (ctx) => {
    return services.listProvidersForApi(ctx.store);
  },
  "sourceControl:discover": async (_ctx, input) => {
    return discoverSourceControl({
      rescan: Boolean(input && input.rescan),
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
  "threads:delete": async (ctx, input) => {
    services.deleteThread(ctx.store, input, {
      isRunning: (id) => ctx.runner.isRunning(id),
      getIosSimulator: ctx.getIosSimulator,
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
      log: ctx.log,
    });
    retireAgent(ctx, input.threadId);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
  },
  "runs:start": async (ctx, input) => {
    return ctx.runner.startRun(input);
  },
  "runs:startWorkflow": async (ctx, input) => {
    return ctx.runner.startWorkflowRun(input);
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
  "attachments:pick": async (ctx) => {
    if (!ctx.dialog || typeof ctx.dialog.showOpenDialog !== "function") {
      throw new Error("Attachment picker is not available in this mode");
    }
    return { attachments: await attachments.pickAttachments(ctx.dialog) };
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
    return prStatus({
      store: ctx.store,
      threadId: input.threadId,
    });
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
  "git:listPrs": async (_ctx, projectPath) => {
    return listPrs(projectPath);
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
    return restoreCheckpoint({
      store: ctx.store,
      threadId: input.threadId,
      sha: input.sha,
      isRunning: (id) => ctx.runner.isRunning(id),
    });
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
    const { root } = resolveDevServerRoot(ctx, threadId);
    const allowed = devservers.detectScripts(root);
    if (!script || !allowed.includes(script)) {
      throw new Error(script ? `Unknown script: ${script}` : "Unknown script");
    }
    return devservers.start(threadId, root, script);
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
