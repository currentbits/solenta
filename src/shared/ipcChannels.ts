/**
 * One invoke-channel table for the two thin CoderApi clients.
 *
 * Channel name is always `${ns}:${method}`. Both `wireClient.ts` (runtime
 * bind) and `electron/preload.js` (inlined copy — sandbox cannot require
 * this file) iterate the table instead of restating each method. Handler
 * bodies stay in `electron/ipc.js`. CoderApi in ipc.ts stays the documented
 * type; IPC_CHANNEL_LOCK fails tsc when a name exists on one side only.
 *
 * Desktop-only extras that are NOT in this table:
 *   attachments.droppedFilePath  (webUtils.getPathForFile, not IPC)
 *   contextMenu.show             (needs event.sender; registerIpc wires it)
 *
 * After editing: `node --experimental-strip-types scripts/sync-ipc-preload.js`
 * (`--check` is part of `npm run typecheck`).
 *
 * Do not generate devCoder.ts or fakeCoder.ts from this table (#623).
 */
import type { CoderApi } from "./ipc";

export const PUSH_CHANNELS = [
  "threads:changed",
  "thread:updated",
  "thread:select",
  "boot:ready",
] as const;

export type PushChannel = (typeof PUSH_CHANNELS)[number];

export const IPC_CHANNELS = [
  { ns: "app", method: "status" },
  { ns: "app", method: "checkUpdate" },
  { ns: "app", method: "downloadUpdate" },
  { ns: "app", method: "applyUpdate" },
  { ns: "app", method: "feedback" },
  { ns: "memory", method: "search" },
  { ns: "memory", method: "recent" },
  { ns: "memory", method: "get" },
  { ns: "memory", method: "store" },
  { ns: "memory", method: "update" },
  { ns: "memory", method: "remove" },
  { ns: "settings", method: "get" },
  { ns: "settings", method: "set" },
  { ns: "settings", method: "testWebhook" },
  { ns: "mcp", method: "list" },
  { ns: "mcp", method: "save" },
  { ns: "mcp", method: "remove" },
  { ns: "mcp", method: "setEnabled" },
  { ns: "mcp", method: "catalog" },
  { ns: "mcp", method: "pickImport" },
  { ns: "mcp", method: "previewImport" },
  { ns: "mcp", method: "installImport" },
  { ns: "mcp", method: "discardImport" },
  { ns: "skills", method: "list" },
  { ns: "skills", method: "add" },
  { ns: "skills", method: "remove" },
  { ns: "skills", method: "sync" },
  { ns: "skills", method: "commands" },
  { ns: "skills", method: "catalog" },
  { ns: "skills", method: "pickImport" },
  { ns: "skills", method: "previewImport" },
  { ns: "skills", method: "installImport" },
  { ns: "skills", method: "discardImport" },
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
  { ns: "threads", method: "setWebSearch" },
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
] as const;

export type IpcChannelRow = (typeof IPC_CHANNELS)[number];
export type IpcChannelName = `${IpcChannelRow["ns"]}:${IpcChannelRow["method"]}`;

export function ipcChannelName(row: {
  ns: string;
  method: string;
}): string {
  return `${row.ns}:${row.method}`;
}

/** Namespaces on CoderApi that are not invoke-channel tables. */
type ApiExtra = "on" | "contextMenu";
/** Methods on CoderApi that are not invoke channels. */
type ExtraMethod = { attachments: "droppedFilePath" };

type InvokeNs = Exclude<keyof CoderApi, ApiExtra>;
type TableNs = IpcChannelRow["ns"];
type TableMethod<N extends string> = Extract<
  IpcChannelRow,
  { ns: N }
>["method"];

type ApiMethods<N extends InvokeNs> = N extends keyof ExtraMethod
  ? Exclude<keyof CoderApi[N], ExtraMethod[N]>
  : keyof CoderApi[N];

type NsDrift = Exclude<InvokeNs, TableNs> | Exclude<TableNs, InvokeNs>;
type MethodDrift = {
  [N in InvokeNs & TableNs]:
    | Exclude<TableMethod<N>, ApiMethods<N>>
    | Exclude<ApiMethods<N>, TableMethod<N>>;
}[InvokeNs & TableNs];

/**
 * Compile-time lock: every CoderApi invoke method is in IPC_CHANNELS and
 * every table row exists on CoderApi. A missing name becomes a type
 * error on this export instead of a shipped hole like #622.
 */
export const IPC_CHANNEL_LOCK: [NsDrift, MethodDrift] extends [never, never]
  ? true
  : { ns: NsDrift; method: MethodDrift } = true;

export type BoundCoderApi = Omit<CoderApi, ApiExtra>;

/**
 * Build the invoke half of CoderApi from the table. Callers add `on`
 * (and, in preload, the desktop-only extras) themselves.
 */
export function bindCoderApi(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): BoundCoderApi {
  const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> =
    Object.create(null);
  for (const { ns, method } of IPC_CHANNELS) {
    if (!api[ns]) api[ns] = Object.create(null);
    api[ns][method] = (...args: unknown[]) =>
      invoke(`${ns}:${method}`, ...args);
  }
  return api as unknown as BoundCoderApi;
}
