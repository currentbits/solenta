"use strict";

const { BrowserWindow, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const services = require("./services.js");
const {
  setupWorktree,
  diff,
  commit,
  revertFile,
  listFiles,
  mergeWorktree,
  removeWorktree,
  push,
  createPr,
  prStatus,
  prChecks,
  mergePr,
  maybeCleanupMergedWorktree,
  listPrs,
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
const { createMemoryProxy } = require("./memory-proxy.js");
const { readToolImage } = require("./tool-images.js");
const attachments = require("./attachments.js");
const { syncUserMcpServers } = require("./memory-sup.js");
const skills = require("./skills.js");
const cliCommands = require("./cliCommands.js");
const { fetchIssue, listIssues, setPlanStatus, createIssue } = require("./issues.js");
const automations = require("./automations.js");
const { buildActivity } = require("./activity.js");
const { collectDigest } = require("./digest.js");
const { collectFleet } = require("./fleet.js");
const { distillThread } = require("./distill.js");
const updater = require("./updater.js");
const vibeKanban = require("./vibeKanban.js");
const { browseFilesystem, expandUserPath } = require("./fsBrowse.js");
const { discoverSourceControl } = require("./sourceControl.js");

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
    broadcast: ctx.broadcast,
  });
}

/**
 * Bind store/runner/dialog into a ctx the shared handler map closes over
 * via its first argument. One ctx per process boot.
 *
 * @param {object} deps
 */
function makeCtx(deps) {
  const broadcast = deps.broadcast || defaultWindowBroadcast;
  const userDataPath = deps.userDataPath || "";
  return {
    dialog: deps.dialog,
    store: deps.store,
    runner: deps.runner,
    broadcast,
    worktreeBase: deps.worktreeBase || "",
    userDataPath,
    memory: createMemoryProxy({ userDataPath }),
  };
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
    services.removeProject(ctx.store, input, {
      isRunning: (id) => ctx.runner.isRunning(id),
    });
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
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
  "threads:setPermissionMode": async (ctx, input) => {
    const updated = services.setPermissionMode(ctx.store, input);
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    return updated;
  },
  "threads:setArchived": async (ctx, input) => {
    const updated = services.setArchived(ctx.store, input);
    if (updated && updated.archived) retireAgent(ctx, updated.id);
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
  "settings:get": async (ctx) => {
    return services.getSettings(ctx.store);
  },
  "settings:set": async (ctx, patch) => {
    const next = services.setSettings(ctx.store, patch);
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
    return next;
  },
  "skills:list": async (ctx, input) => {
    const projectPath =
      input && typeof input.projectPath === "string"
        ? input.projectPath
        : null;
    return skills.listSkills(projectPath);
  },
  "skills:add": async (ctx, input) => {
    return skills.addSkill(input || {});
  },
  "skills:remove": async (ctx, input) => {
    return skills.removeSkill(input || {});
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
  "git:status": async (ctx, projectId) => {
    const project = ctx.store.getProject(projectId);
    if (!project) {
      return { isRepo: false, branch: "", dirty: false };
    }
    return services.gitStatus(project);
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
    return {
      dataUrl: readToolImage(ctx.userDataPath, input && input.name),
    };
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
    return { dataUrl: attachments.readImage(input && input.path) };
  },
  "git:mergeWorktree": async (ctx, input) => {
    const merged = mergeWorktree({
      store: ctx.store,
      threadId: input.threadId,
      broadcast: ctx.broadcast,
    });
    await runRetention(ctx);
    return merged;
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
  "issues:fetch": async (_ctx, input) => {
    const projectPath = input && input.projectPath;
    const ref = input && input.ref;
    return fetchIssue(projectPath, ref);
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
};

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
 * @param {string} [deps.worktreeBase]
 * @param {string} [deps.userDataPath]
 */
function registerIpc(deps) {
  const { ipcMain } = deps;
  const ctx = makeCtx(deps);
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
