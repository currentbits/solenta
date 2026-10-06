"use strict";

const services = require("./services.js");
const { browseFilesystem } = require("./fsBrowse.js");
const { retireAgent } = require("./ipc-shared.js");
const { cloneProject, cancelClone } = require("./projectClone.js");
const { discoverRecentRepos } = require("./recentRepos.js");

/** IPC_HANDLERS rows for projects:*, fs:*, spaces:*; ipc.js spreads them in. */
module.exports = {
  "projects:list": async (ctx) => {
    return services.listProjects(ctx.store);
  },
  "projects:add": async (ctx, projectPath, opts) => {
    return services.addProject(ctx.store, projectPath, opts);
  },
  // First-run discovery (#1501): read-only scan of the provider CLIs' sessions.
  "projects:discoverRecent": async (ctx) => {
    return discoverRecentRepos({
      existingPaths: services.listProjects(ctx.store).map((p) => p.path),
    });
  },
  "projects:ensureScratch": async (ctx) => {
    return services.ensureScratchProject(ctx.store, ctx.userDataPath);
  },
  "projects:create": async (ctx, input) => {
    return services.createProject(ctx.store, input || {});
  },
  "projects:clone": async (ctx, input) => {
    return cloneProject(input && typeof input === "object" ? input : {}, {
      addProject: (target) => services.addProject(ctx.store, target),
      broadcast: ctx.broadcast,
    });
  },
  "projects:cancelClone": async (_ctx, input) => {
    cancelClone(input);
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
    const result = await services.removeProject(ctx.store, input, {
      isRunning: (id) => ctx.runner.isRunning(id),
      getIosSimulator: ctx.getIosSimulator,
      cleanupRunArtifacts: ctx.cleanupRunArtifacts,
      log: ctx.log,
    });
    // #1227: idle Claude keep-alives live in the runner Map, not the Store.
    // Same retire as threads:delete, after a successful purge so a rejected
    // active-run guard cannot stop a session that still belongs to the project.
    const threadIds = (result && result.removedThreadIds) || [];
    for (const threadId of threadIds) {
      try {
        retireAgent(ctx, threadId);
      } catch {
        // already exited or missing handle
      }
    }
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
};
