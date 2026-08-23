"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

/* <ipc-push> */
const PUSH_CHANNELS = new Set([
  "threads:changed",
  "thread:updated",
  "thread:select",
  "boot:ready",
]);
/* </ipc-push> */

/**
 * Electron wraps every invoke rejection as
 * "Error invoking remote method 'chan': Error: <message>", which the UI then
 * shows verbatim — a main-process sentence reads like an internal crash
 * (issue #198). Markers (WORKTREE_DIRTY:, MERGE_CONFLICT:) sit after the
 * prefix, so stripping it leaves them intact.
 *
 * ponytail: inline and untested on purpose — this preload runs with
 * sandbox: true (main.js), which cannot require a local module to share or
 * unit-test the regex.
 */
const INVOKE_WRAP = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/;

/**
 * @param {string} channel
 * @param  {...unknown} args
 */
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.replace(INVOKE_WRAP, "") || message);
  });
}

/**
 * @param {string} channel
 * @param {(payload: unknown) => void} cb
 * @returns {() => void}
 */
function on(channel, cb) {
  if (!PUSH_CHANNELS.has(channel)) {
    throw new Error(`Push channel not allowed: ${channel}`);
  }
  const listener = (_event, payload) => {
    cb(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * Inlined from src/shared/ipcChannels.ts (issue #623). Sandbox preload
 * cannot require that file; scripts/sync-ipc-preload.js copies it.
 * bindChannels is the JS twin of bindCoderApi — keep the loop body the same.
 */
/* <ipc-channels> */
const IPC_CHANNELS = Object.freeze([
  { ns: "app", method: "status" },
  { ns: "app", method: "checkUpdate" },
  { ns: "app", method: "downloadUpdate" },
  { ns: "app", method: "applyUpdate" },
  { ns: "memory", method: "search" },
  { ns: "memory", method: "recent" },
  { ns: "memory", method: "get" },
  { ns: "memory", method: "store" },
  { ns: "memory", method: "update" },
  { ns: "memory", method: "remove" },
  { ns: "settings", method: "get" },
  { ns: "settings", method: "set" },
  { ns: "settings", method: "testWebhook" },
  { ns: "skills", method: "list" },
  { ns: "skills", method: "add" },
  { ns: "skills", method: "remove" },
  { ns: "skills", method: "sync" },
  { ns: "skills", method: "commands" },
  { ns: "providers", method: "list" },
  { ns: "sourceControl", method: "discover" },
  { ns: "workflows", method: "list" },
  { ns: "workflows", method: "save" },
  { ns: "workflows", method: "remove" },
  { ns: "automations", method: "list" },
  { ns: "automations", method: "add" },
  { ns: "automations", method: "update" },
  { ns: "automations", method: "remove" },
  { ns: "automations", method: "runNow" },
  { ns: "projects", method: "list" },
  { ns: "projects", method: "add" },
  { ns: "projects", method: "create" },
  { ns: "projects", method: "update" },
  { ns: "projects", method: "pickIcon" },
  { ns: "projects", method: "resolveIcon" },
  { ns: "projects", method: "addViaDialog" },
  { ns: "projects", method: "pickDirectory" },
  { ns: "projects", method: "remove" },
  { ns: "projects", method: "lintAgentConfig" },
  { ns: "projects", method: "previewAgentConfig" },
  { ns: "projects", method: "writeAgentConfig" },
  { ns: "spaces", method: "list" },
  { ns: "spaces", method: "add" },
  { ns: "spaces", method: "update" },
  { ns: "spaces", method: "remove" },
  { ns: "threads", method: "list" },
  { ns: "threads", method: "summaries" },
  { ns: "threads", method: "crewTasks" },
  { ns: "threads", method: "search" },
  { ns: "threads", method: "create" },
  { ns: "threads", method: "get" },
  { ns: "threads", method: "peek" },
  { ns: "threads", method: "setPermissionMode" },
  { ns: "threads", method: "respondPermission" },
  { ns: "threads", method: "clearQuestion" },
  { ns: "threads", method: "setArchived" },
  { ns: "threads", method: "setSettled" },
  { ns: "threads", method: "setPinned" },
  { ns: "threads", method: "setQueued" },
  { ns: "threads", method: "setSnoozed" },
  { ns: "threads", method: "setMuted" },
  { ns: "threads", method: "setCrossThreadInbound" },
  { ns: "threads", method: "setQuotaWaitAutoResume" },
  { ns: "threads", method: "setNotes" },
  { ns: "threads", method: "setFeltEstimate" },
  { ns: "threads", method: "startSpec" },
  { ns: "threads", method: "stopSpec" },
  { ns: "threads", method: "reviewSpec" },
  { ns: "threads", method: "specArtifact" },
  { ns: "threads", method: "dispatchSpec" },
  { ns: "threads", method: "convergeSpec" },
  { ns: "threads", method: "startTeach" },
  { ns: "threads", method: "stopTeach" },
  { ns: "threads", method: "requestTeachReview" },
  { ns: "threads", method: "startAsk" },
  { ns: "threads", method: "stopAsk" },
  { ns: "threads", method: "btw" },
  { ns: "threads", method: "dismissBtw" },
  { ns: "threads", method: "promoteBtw" },
  { ns: "threads", method: "rename" },
  { ns: "threads", method: "fork" },
  { ns: "threads", method: "resolveSuggestion" },
  { ns: "threads", method: "rewind" },
  { ns: "threads", method: "setProvider" },
  { ns: "threads", method: "setReasoningEffort" },
  { ns: "threads", method: "setVerifyCommand" },
  { ns: "threads", method: "runVerify" },
  { ns: "threads", method: "runCommand" },
  { ns: "threads", method: "delete" },
  { ns: "activity", method: "list" },
  { ns: "usage", method: "byDay" },
  { ns: "insights", method: "failureModes" },
  { ns: "fleet", method: "evidence" },
  { ns: "digest", method: "list" },
  { ns: "digest", method: "markSeen" },
  { ns: "runs", method: "start" },
  { ns: "runs", method: "startWorkflow" },
  { ns: "runs", method: "distill" },
  { ns: "runs", method: "stop" },
  { ns: "runs", method: "resumeQuotaWait" },
  { ns: "git", method: "status" },
  { ns: "git", method: "setupWorktree" },
  { ns: "git", method: "diff" },
  { ns: "git", method: "reviewContext" },
  { ns: "git", method: "setReviewAccepted" },
  { ns: "git", method: "commit" },
  { ns: "git", method: "revertFile" },
  { ns: "git", method: "suggestCommitMessage" },
  { ns: "git", method: "mergeWorktree" },
  { ns: "git", method: "conflictContext" },
  { ns: "git", method: "removeWorktree" },
  { ns: "git", method: "push" },
  { ns: "git", method: "createPr" },
  { ns: "git", method: "prStatus" },
  { ns: "git", method: "prChecks" },
  { ns: "git", method: "prMerge" },
  { ns: "git", method: "listPrs" },
  { ns: "git", method: "checkoutPr" },
  { ns: "git", method: "listCheckpoints" },
  { ns: "git", method: "restoreCheckpoint" },
  { ns: "git", method: "syncInfo" },
  { ns: "git", method: "fetch" },
  { ns: "git", method: "repoInfo" },
  { ns: "git", method: "pull" },
  { ns: "git", method: "runStats" },
  { ns: "git", method: "conflictForecast" },
  { ns: "git", method: "gcScan" },
  { ns: "git", method: "gcClean" },
  { ns: "issues", method: "fetch" },
  { ns: "issues", method: "list" },
  { ns: "issues", method: "setPlanStatus" },
  { ns: "issues", method: "create" },
  { ns: "files", method: "list" },
  { ns: "files", method: "image" },
  { ns: "files", method: "resolve" },
  { ns: "fs", method: "browse" },
  { ns: "attachments", method: "pick" },
  { ns: "attachments", method: "fromPaths" },
  { ns: "attachments", method: "saveImage" },
  { ns: "attachments", method: "readImage" },
  { ns: "servers", method: "list" },
  { ns: "shell", method: "reveal" },
  { ns: "shell", method: "openPath" },
  { ns: "devserver", method: "scripts" },
  { ns: "devserver", method: "start" },
  { ns: "devserver", method: "stop" },
  { ns: "devserver", method: "status" },
  { ns: "terminal", method: "open" },
  { ns: "terminal", method: "write" },
  { ns: "terminal", method: "read" },
  { ns: "terminal", method: "close" },
  { ns: "preview", method: "bind" },
  { ns: "preview", method: "unbind" },
  { ns: "preview", method: "navigate" },
  { ns: "preview", method: "reload" },
  { ns: "preview", method: "goBack" },
  { ns: "preview", method: "goForward" },
  { ns: "preview", method: "info" },
  { ns: "preview", method: "screenshot" },
  { ns: "preview", method: "click" },
  { ns: "preview", method: "type" },
  { ns: "vibeKanban", method: "preview" },
  { ns: "vibeKanban", method: "import" },
  { ns: "vibeKanban", method: "pickDataDir" },
  { ns: "vibeKanban", method: "export" },
]);
/* </ipc-channels> */

/**
 * @param {(channel: string, ...args: unknown[]) => Promise<unknown>} invokeFn
 * @param {ReadonlyArray<{ ns: string, method: string }>} channels
 */
function bindChannels(invokeFn, channels) {
  const api = Object.create(null);
  for (const { ns, method } of channels) {
    if (!api[ns]) api[ns] = Object.create(null);
    api[ns][method] = (...args) => invokeFn(`${ns}:${method}`, ...args);
  }
  return api;
}

/** @type {import('../src/shared/ipc').CoderApi} */
const coder = bindChannels(invoke, IPC_CHANNELS);
coder.attachments.droppedFilePath = (file) => webUtils.getPathForFile(file);
coder.contextMenu = {
  show: (items, position) => invoke("contextMenu:show", items, position),
};
coder.on = on;

contextBridge.exposeInMainWorld("coder", coder);
