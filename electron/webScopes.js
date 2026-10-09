"use strict";

/**
 * Solenta Web device scopes (#1530). Every IPC channel a paired device can
 * invoke needs one scope; the bridge checks it on the host before dispatch.
 *
 * Presets: Read only = [read]; Steer threads = [read, steer]; Full = [full].
 * Grants (files, git, terminal:observe, terminal:type, preview, settings)
 * stack on top of a preset. "full" satisfies everything; terminal:type
 * implies terminal:observe. A channel missing from this table needs "full",
 * so a new handler fails closed until someone classifies it.
 */

const fs = require("node:fs");
const path = require("node:path");

const SCOPES = Object.freeze([
  "read",
  "steer",
  "files",
  "git",
  "terminal:observe",
  "terminal:type",
  "preview",
  "settings",
  "full",
]);

const PRESETS = Object.freeze({
  read: Object.freeze(["read"]),
  steer: Object.freeze(["read", "steer"]),
  full: Object.freeze(["full"]),
});

const BY_SCOPE = {
  read: [
    "app:status",
    "stayAwake:status",
    "settings:get",
    "providers:list",
    "sourceControl:discover",
    "memory:search",
    "memory:recent",
    "memory:get",
    "memory:maintenance",
    "mcp:list",
    "mcp:catalog",
    "skills:list",
    "skills:commands",
    "skills:catalog",
    "harness:detectSources",
    "workflows:list",
    "automations:list",
    "automations:listRuns",
    "projects:list",
    "projects:discoverRecent",
    "projects:resolveIcon",
    "projects:codeMap",
    "projects:lintAgentConfig",
    "projects:previewAgentConfig",
    "spaces:list",
    "threads:list",
    "threads:summaries",
    "threads:crewTasks",
    "threads:crewIntegration",
    "threads:search",
    "threads:listCliSessions",
    "threads:get",
    "threads:peek",
    "threads:specArtifact",
    "threads:listTrashed",
    "activity:list",
    "usage:byDay",
    "usage:providerLimits",
    "insights:failureModes",
    "fleet:evidence",
    "digest:list",
    "git:status",
    "git:listBranches",
    "git:diff",
    "git:reviewContext",
    "git:conflictContext",
    "git:prStatus",
    "git:prChecks",
    "git:mergeOptions",
    "git:listPrs",
    "git:prTemplate",
    "git:prDetail",
    "git:listCheckpoints",
    "git:syncInfo",
    "git:repoInfo",
    "git:gcScan",
    "git:runStats",
    "git:turnDiff",
    "git:conflictForecast",
    "mergeQueue:listLanes",
    "issues:fetch",
    "issues:list",
    "files:list",
    "files:search",
    "files:resolve",
    "files:tree",
    "files:read",
    "files:image",
    "attachments:readImage",
    "servers:list",
    "shell:editors",
    "devserver:scripts",
    "devserver:status",
    "preview:info",
    "preview:screenshot",
    "speech:status",
  ],
  steer: [
    "app:feedback",
    "projects:ensureScratch",
    "threads:importCliSession",
    "threads:create",
    "threads:savePlan",
    "threads:fork",
    "threads:rewind",
    "threads:respondPermission",
    "threads:clearQuestion",
    "threads:setArchived",
    "threads:setSettled",
    "threads:setPinned",
    "threads:setQueued",
    "threads:setSnoozed",
    "threads:setTags",
    "threads:setThreadProject",
    "threads:setMuted",
    "threads:setEjected",
    "threads:setCrossThreadInbound",
    "threads:setQuotaWaitAutoResume",
    "threads:setPrWatch",
    "threads:setNotes",
    "threads:setMessagePins",
    "threads:setBaseBranch",
    "threads:setPendingWorktree",
    "threads:refreshWorkerSnapshot",
    "threads:resolveSuggestion",
    "threads:setFeltEstimate",
    "threads:startSpec",
    "threads:stopSpec",
    "threads:reviewSpec",
    "threads:dispatchSpec",
    "threads:convergeSpec",
    "threads:startTeach",
    "threads:stopTeach",
    "threads:requestTeachReview",
    "threads:startAsk",
    "threads:stopAsk",
    "threads:btw",
    "threads:dismissBtw",
    "threads:promoteBtw",
    "threads:rename",
    "threads:setGoal",
    "threads:setProvider",
    "threads:setReasoningEffort",
    "threads:setFast",
    "threads:setWebSearch",
    "threads:runVerify",
    "threads:delete",
    "threads:restore",
    "digest:markSeen",
    "runs:distill",
    "runs:start",
    "runs:steer",
    "runs:sendQueued",
    "runs:startWorkflow",
    "runs:retryWorkflowAgent",
    "runs:stop",
    "runs:resumeQuotaWait",
    "git:setReviewAccepted",
    "git:suggestCommitMessage",
    "git:suggestPrText",
    "attachments:saveImage",
    "attachments:saveFile",
    "attachments:saveFolder",
    "speech:start",
    "speech:write",
    "speech:stop",
    "speech:cancel",
  ],
  files: ["projects:writeAgentConfig"],
  git: [
    "git:setupWorktree",
    "git:commit",
    "git:revertFile",
    "git:mergeWorktree",
    "git:integrateWorker",
    "git:removeWorktree",
    "git:push",
    "git:createPr",
    "git:prMerge",
    "git:checkoutPr",
    "git:prEdit",
    "git:prComment",
    "git:prClose",
    "git:prReady",
    "git:prMergeAt",
    "git:prRevert",
    "git:restoreCheckpoint",
    "git:fetch",
    "git:pull",
    "git:gcClean",
    "mergeQueue:claimLane",
    "mergeQueue:previewLane",
    "mergeQueue:restorePreview",
    "mergeQueue:recycleWedgedLanes",
    "mergeQueue:heartbeatLane",
    "mergeQueue:setSpotlight",
    "mergeQueue:spotlightLane",
    "issues:setPlanStatus",
    "issues:create",
  ],
  "terminal:observe": ["terminal:read", "terminal:list"],
  "terminal:type": [
    "terminal:open",
    "terminal:write",
    "terminal:resize",
    "terminal:close",
    "terminal:signIn",
    // Both run an arbitrary shell command, same as typing one.
    "threads:runCommand",
    "threads:setVerifyCommand",
  ],
  preview: [
    "preview:bind",
    "preview:unbind",
    "preview:navigate",
    "preview:reload",
    "preview:goBack",
    "preview:goForward",
    "preview:click",
    "preview:type",
    "devserver:start",
    "devserver:stop",
  ],
  settings: [
    "settings:set",
    "settings:testWebhook",
    "memory:store",
    "memory:update",
    "memory:remove",
    "memory:resolve",
    "mcp:remove",
    "mcp:setEnabled",
    "mcp:previewImport",
    "mcp:discardImport",
    "pairing:list",
    "skills:add",
    "skills:remove",
    "skills:sync",
    "skills:previewImport",
    "skills:installImport",
    "skills:discardImport",
    "harness:previewImport",
    "harness:installImport",
    "harness:discardImport",
    "workflows:save",
    "workflows:remove",
    "automations:add",
    "automations:update",
    "automations:remove",
    "automations:runNow",
    "projects:add",
    "projects:create",
    "projects:clone",
    "projects:cancelClone",
    "projects:update",
    "projects:remove",
    "spaces:add",
    "spaces:update",
    "spaces:remove",
    "fs:browse",
    "vibeKanban:preview",
    "vibeKanban:import",
    "vibeKanban:export",
    "speech:download",
  ],
  // Listed so the coverage test sees them classified; unlisted means full too.
  full: [
    // mcp:save registers a command to spawn; pairing:* mints or approves tokens.
    "mcp:save",
    "mcp:installImport",
    "pairing:create",
    "pairing:revoke",
    "pairing:approve",
    "pairing:reject",
    // Desktop-only already (ipc-web.js); a device must not mint or revoke devices.
    "web:status",
    "web:setEnabled",
    "web:addDevice",
    "web:revokeDevice",
    "web:setTailscale",
    "threads:purge",
    // Bypass mode would let a steer device skip the terminal/files/git grants.
    "threads:setPermissionMode",
    // A secret lands in the agent's run env (#1531); host or full devices only.
    "threads:answerSecret",
    "app:checkUpdate",
    "app:downloadUpdate",
    "app:applyUpdate",
    "app:openRemoteConnection",
    "app:forgetRemoteConnection",
    // Host-side effects: open apps, read arbitrary host paths, capture windows.
    "shell:reveal",
    "shell:openPath",
    "shell:openIn",
    "attachments:fromPaths",
    "attachments:listWindows",
    "attachments:captureWindow",
    "attachments:captureWindowText",
    // Native dialogs on the host.
    "projects:pickDirectory",
    "projects:pickIcon",
    "projects:addViaDialog",
    "attachments:pick",
    "mcp:pickImport",
    "skills:pickImport",
    "vibeKanban:pickDataDir",
  ],
};

/** @type {Map<string, string>} */
const CHANNEL_SCOPE = new Map();
for (const [scope, channels] of Object.entries(BY_SCOPE)) {
  for (const ch of channels) CHANNEL_SCOPE.set(ch, scope);
}

/** Push channels that are not plain read. Everything else needs read. */
const PUSH_SCOPE = new Map([["terminal:data", "terminal:observe"]]);

function scopeForChannel(channel) {
  return CHANNEL_SCOPE.get(channel) || "full";
}

/** Unknown names drop out; read is always on. Empty/non-array → read only. */
function sanitizeScopes(input) {
  const set = new Set(["read"]);
  if (Array.isArray(input)) {
    for (const s of input) if (SCOPES.includes(s)) set.add(s);
  }
  if (set.has("full")) return ["full"];
  return SCOPES.filter((s) => set.has(s));
}

/**
 * @param {readonly string[] | null | undefined} scopes
 * @param {string} need
 */
function allows(scopes, need) {
  if (need === "read") return true;
  if (!Array.isArray(scopes)) return false;
  if (scopes.includes("full")) return true;
  if (need === "terminal:observe" && scopes.includes("terminal:type")) return true;
  return scopes.includes(need);
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function within(file, root) {
  return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * readImage takes any absolute path. Short of full, only serve images under
 * Solenta's attachments, its worktrees, or a known project checkout.
 */
function imagePathAllowed(ctx, input) {
  const file = realOrNull(String((input && input.path) || ""));
  if (!file) return false;
  const roots = [];
  if (ctx && ctx.userDataPath) {
    roots.push(path.join(ctx.userDataPath, "attachments"), path.join(ctx.userDataPath, "worktrees"));
  }
  if (ctx && ctx.worktreeBase) roots.push(ctx.worktreeBase);
  const projects = ctx && ctx.store && typeof ctx.store.getProjects === "function" ? ctx.store.getProjects() || [] : [];
  for (const p of projects) if (p && p.path) roots.push(p.path);
  return roots.some((r) => {
    const real = realOrNull(r);
    return real != null && within(file, real);
  });
}

/** Per-channel argument checks for devices without full access. */
const ARG_GUARDS = new Map([["attachments:readImage", imagePathAllowed]]);

/** @returns {boolean} false → refuse the call */
function argsAllowed(scopes, channel, ctx, args) {
  const guard = ARG_GUARDS.get(channel);
  if (!guard || allows(scopes, "full")) return true;
  return guard(ctx, args[0]);
}

module.exports = {
  argsAllowed,
  SCOPES,
  PRESETS,
  BY_SCOPE,
  PUSH_SCOPE,
  scopeForChannel,
  sanitizeScopes,
  allows,
};
