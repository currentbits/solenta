"use strict";

const fs = require("node:fs");
const services = require("./services.js");
const {
  setupWorktree,
  listBranchesAsync,
  diff,
  commit,
  revertFile,
  revertHunk,
  mergeWorktree,
  worktreeLanded,
  conflictContext,
  removeWorktree,
  push,
  createPr,
  prStatus,
  prChecks,
  mergePr,
  mergeOptions,
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
const { suggestCommitMessage, suggestPrText } = require("./commitmsg.js");
const {
  claimLane,
  listLanes,
  previewLane,
  restorePreview,
  recycleWedgedLanes,
  setSpotlight,
  spotlightLane,
  heartbeatLane,
} = require("./mergeQueue.js");
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
const { integrateWorker } = require("./crewIntegration.js");
const vibeKanban = require("./vibeKanban.js");
const { runRetention, resolveThreadRoot } = require("./ipc-shared.js");

/** IPC_HANDLERS rows for git:*, issues:*, mergeQueue:*, vibeKanban:*; ipc.js spreads them in. */
module.exports = {
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
    return listBranchesAsync(project.path);
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
    return diff({
      store: ctx.store,
      threadId: input.threadId,
      scope: input.scope,
      ignoreWhitespace: input.ignoreWhitespace,
      path: input.path,
      full: input.full,
    });
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
      patches: Array.isArray(input.patches) ? input.patches : undefined,
    });
  },
  "git:revertHunk": async (ctx, input) => {
    return revertHunk({
      store: ctx.store,
      threadId: input.threadId,
      path: input.path,
      patch: input.patch,
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
  "git:suggestPrText": async (ctx, input) => {
    return suggestPrText({ store: ctx.store, threadId: input.threadId });
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
      method: input && input.method,
      auto: Boolean(input && input.auto),
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
  "git:mergeOptions": async (ctx, input) => {
    return mergeOptions({
      store: ctx.store,
      threadId: input && input.threadId,
      projectPath: input && input.projectPath,
    });
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
      {
        prNumber: input && input.prNumber,
        method: input && input.method,
        auto: Boolean(input && input.auto),
      },
      { store: ctx.store, broadcast: ctx.broadcast },
    );
  },
  "git:prRevert": async (ctx, input) => {
    const { openRevertPr } = require("./revertPr.js");
    return openRevertPr({ store: ctx.store, threadId: input && input.threadId });
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
      const info = await services.gitSyncInfo(root);
      // #1556: every commit already on the base (local or origin) — the
      // details card offers Clean up instead of Merge. Uncommitted files
      // count as not landed.
      if (thread.worktreePath && thread.branch && !project.remoteHost) {
        info.landed = worktreeLanded(project, thread);
      }
      return info;
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
};
