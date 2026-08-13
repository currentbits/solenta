"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const {
  getProvider,
  knownProviderIds,
  listProviders,
} = require("./providers.js");
const { getMemoryStatus } = require("./memory-sup.js");

const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function gitOut(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Derive owner/repo from a git remote URL, or null if unparseable.
 * @param {string} url
 * @returns {string | null}
 */
function slugFromRemoteUrl(url) {
  if (!url) return null;
  const cleaned = url.trim().replace(/\.git$/i, "");

  // git@host:owner/repo
  const ssh = cleaned.match(/^git@[^:]+:(.+)$/);
  if (ssh) {
    const parts = ssh[1].replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
  }

  // https://host/owner/repo or ssh://git@host/owner/repo
  try {
    const withProto = /^[a-z]+:\/\//i.test(cleaned)
      ? cleaned
      : `https://${cleaned}`;
    const u = new URL(withProto);
    const parts = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
  } catch {
    // fall through
  }

  return null;
}

/**
 * Validate path is a git work tree; add ProjectInfo to store.
 * @param {import('./store').Store} store
 * @param {string} projectPath
 */
function addProject(store, projectPath) {
  const resolved = path.resolve(projectPath);

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  try {
    const inside = gitOut(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") {
      throw new Error("not a git repository");
    }
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    if (/not a git repository/i.test(msg) || /not a git/i.test(msg)) {
      throw new Error(
        `Not a git repository: ${resolved}. Choose a directory inside a git work tree.`,
      );
    }
    throw new Error(
      `Not a git repository: ${resolved}. Choose a directory inside a git work tree.`,
    );
  }

  const folderName = path.basename(resolved);
  let slug = folderName;
  let name = folderName;

  try {
    const remote = gitOut(resolved, ["remote", "get-url", "origin"]);
    const derived = slugFromRemoteUrl(remote);
    if (derived) {
      slug = derived;
      name = derived.split("/").pop() || folderName;
    }
  } catch {
    // no origin remote
  }

  const project = {
    id: randomUUID(),
    slug,
    name,
    path: resolved,
  };

  const projects = store.getProjects().slice();
  projects.push(project);
  store.setProjects(projects);
  store.save();
  return project;
}

/**
 * @param {import('./store').Store} store
 * @param {{ projectId: string, title: string }} input
 */
function createThread(store, input) {
  const project = store.getProject(input.projectId);
  if (!project) {
    throw new Error(`Unknown project: ${input.projectId}`);
  }

  const now = Date.now();
  const thread = {
    id: randomUUID(),
    projectId: input.projectId,
    // Same title length convention as auto-rename from first prompt line.
    title: truncateThreadTitle(input.title || "New Thread"),
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: now,
    updatedAt: now,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    prState: null,
    // Just-created is not unread: visit time matches creation.
    lastVisitedAt: now,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    handoffFrom: null,
  };

  const threads = store.getThreads().slice();
  threads.push(thread);
  store.setThreads(threads);
  store.setMessages(thread.id, []);
  store.setWorkLog(thread.id, []);
  store.save();
  return thread;
}

/**
 * @param {import('./store').Store} store
 * @param {{ threadId: string, mode: string }} input
 */
function setPermissionMode(store, input) {
  const { threadId, mode } = input;
  if (!PERMISSION_MODES.has(mode)) {
    throw new Error(
      `Invalid permission mode: ${mode}. Expected one of: ${[...PERMISSION_MODES].join(", ")}`,
    );
  }
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const updated = store.updateThread(threadId, { permissionMode: mode });
  store.save();
  return updated ? { ...updated } : { ...thread, permissionMode: mode };
}

/**
 * Set reasoning effort for a thread. null always means "provider default".
 * Rejects levels the thread's provider does not honour so a setting that
 * would never reach the CLI cannot be stored.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, effort: string | null }} input
 */
function setReasoningEffort(store, input) {
  const { threadId, effort } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }

  if (effort === null || effort === undefined) {
    const updated = store.updateThread(threadId, { reasoningEffort: null });
    store.save();
    return updated ? { ...updated } : { ...thread, reasoningEffort: null };
  }

  const level = String(effort);
  const entry = getProvider(thread.provider);
  const allowed =
    entry && Array.isArray(entry.efforts) ? entry.efforts : [];
  if (!allowed.includes(level)) {
    const providerName =
      (entry && entry.name) || thread.provider || "provider";
    throw new Error(
      `${providerName} does not support reasoning effort "${level}"`,
    );
  }

  const updated = store.updateThread(threadId, { reasoningEffort: level });
  store.save();
  return updated ? { ...updated } : { ...thread, reasoningEffort: level };
}

/** Thread title cap — matches runner auto-rename from the first prompt line. */
const THREAD_TITLE_MAX = 60;

/**
 * @param {string} title
 * @returns {string}
 */
function truncateThreadTitle(title) {
  const s = String(title ?? "");
  if (s.length <= THREAD_TITLE_MAX) return s;
  return s.slice(0, THREAD_TITLE_MAX);
}

/**
 * Validate a model string for a provider entry.
 * Empty models list: any non-empty trimmed string up to 100 chars (custom ids).
 * Non-empty list: membership required.
 * Returns the normalized model string, or null when clearing.
 *
 * @param {import('./providers').ProviderEntry | null} entry
 * @param {string | null | undefined} rawModel
 * @returns {string | null}
 */
function normalizeModelForProvider(entry, rawModel) {
  if (rawModel == null || rawModel === "") return null;
  const trimmed = String(rawModel).trim();
  if (!trimmed) {
    throw new Error("Model must be a non-empty string");
  }
  // A provider's `models` list is a SUGGESTION, not an allowlist. It is a
  // snapshot of a CLI's catalogue taken when this file was written, and it goes
  // stale the moment a model ships. Rejecting an unlisted id would block a user
  // from a model their CLI already supports, and would make the picker's
  // "Custom..." affordance dead for every provider now that all of them
  // publish a list. A bad id fails loudly at the CLI, which is the right place.
  if (trimmed.length > 100) {
    throw new Error("Model must be at most 100 characters");
  }
  return trimmed;
}

/**
 * True when a provider id is accepted by setProvider / forkThread.
 * @param {string} id
 * @returns {boolean}
 */
function isKnownProviderId(id) {
  const s = String(id || "");
  return (
    knownProviderIds().includes(s) ||
    (s === "simulate" && process.env.CODER_SIMULATE === "1")
  );
}

/** Max chars of the source assistant message injected into a hand-off prefix. */
const HANDOFF_ASSISTANT_MAX = 2000;

/**
 * One-time hand-off context prefix for the CLI (NOT stored in the transcript).
 * Returns "" when no prefix applies: no handoffFrom, session already exists,
 * source missing/deleted, or source has no assistant message.
 *
 * Strings are mirrored in src/devCoder.ts (services-level helper + dev twin —
 * the established pattern for shared electron/dev logic).
 *
 * @param {{ handoffFrom?: string | null, sessionId?: string | null } | null} thread
 * @param {(sourceId: string) => Array<{ role?: string, text?: string }> | null | undefined} getMessages
 * @returns {string}
 */
function buildHandoffPrefix(thread, getMessages) {
  if (!thread || thread.handoffFrom == null || thread.handoffFrom === "") {
    return "";
  }
  if (thread.sessionId != null && thread.sessionId !== "") {
    return "";
  }
  let msgs;
  try {
    msgs = getMessages(String(thread.handoffFrom));
  } catch {
    return "";
  }
  if (!Array.isArray(msgs) || msgs.length === 0) return "";

  let lastAssistant = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "assistant" && m.text != null && String(m.text)) {
      lastAssistant = String(m.text);
      break;
    }
  }
  if (!lastAssistant) return "";

  const body =
    lastAssistant.length > HANDOFF_ASSISTANT_MAX
      ? lastAssistant.slice(0, HANDOFF_ASSISTANT_MAX)
      : lastAssistant;

  return (
    "[Hand-off context from a previous thread]\n" +
    body +
    "\n[End context]\n\n"
  );
}

/**
 * Fork / hand off: new thread in the source's project. Source is never modified.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, provider?: string, model?: string | null }} input
 * @returns {object}
 */
function forkThread(store, input) {
  const sourceId = input && input.threadId;
  const source = store.getThread(sourceId);
  if (!source) {
    throw new Error(`Unknown thread: ${sourceId}`);
  }

  const providerProvided = Object.prototype.hasOwnProperty.call(
    input,
    "provider",
  );
  const modelProvided = Object.prototype.hasOwnProperty.call(input, "model");

  let nextProvider = source.provider;
  if (providerProvided) {
    const id = String(input.provider || "");
    if (!isKnownProviderId(id)) {
      throw new Error(`Unknown provider: ${input.provider}`);
    }
    nextProvider = id;
  }

  const providerChanging =
    providerProvided && String(nextProvider) !== String(source.provider);

  let nextModel = source.model;
  const nextEntry = getProvider(nextProvider);
  if (providerChanging) {
    // Same rule as setProvider: do not carry the old provider's model across
    // unless this call supplies one valid for the NEW provider.
    if (modelProvided) {
      nextModel = normalizeModelForProvider(nextEntry, input.model);
    } else {
      nextModel = null;
    }
  } else if (modelProvided) {
    nextModel = normalizeModelForProvider(nextEntry, input.model);
  }

  const sourceTitle =
    source.title != null && String(source.title) !== ""
      ? String(source.title)
      : "New Thread";
  // createThread applies THREAD_TITLE_MAX; "Fork: " + title uses the same path.
  const created = createThread(store, {
    projectId: source.projectId,
    title: `Fork: ${sourceTitle}`,
  });

  // createThread stamps lastVisitedAt = createdAt and handoffFrom null;
  // patch config + provenance. sessionId stays null (fresh session).
  const updated = store.updateThread(created.id, {
    provider: nextProvider,
    model: nextModel,
    permissionMode: source.permissionMode,
    handoffFrom: source.id,
    sessionId: null,
  });
  store.save();
  return updated ? { ...updated } : { ...created, handoffFrom: source.id };
}

/**
 * Set thread provider and/or model. Does not bump updatedAt.
 *
 * Rejects unknown provider ids. Changing provider on a thread with a session
 * clears the session id (CLI sessions are not portable across harnesses), so
 * the next send starts a fresh session with the new CLI; the thread and its
 * transcript stay.
 * Model validation: when the provider's models list is non-empty the model must
 * come from it; when the list is empty any non-empty string is accepted and
 * passed to the CLI as-is (custom model ids, e.g. codex -m).
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, provider?: string, model?: string | null }} input
 */
function setProvider(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }

  const providerProvided = Object.prototype.hasOwnProperty.call(
    input,
    "provider",
  );
  const modelProvided = Object.prototype.hasOwnProperty.call(input, "model");

  if (!providerProvided && !modelProvided) {
    return { ...thread };
  }

  const nextProvider = providerProvided ? input.provider : thread.provider;
  if (providerProvided) {
    const id = String(input.provider || "");
    if (!isKnownProviderId(id)) {
      throw new Error(`Unknown provider: ${input.provider}`);
    }
  }

  const providerChanging =
    providerProvided && String(input.provider) !== String(thread.provider);

  /** @type {{ provider?: string, model?: string | null, sessionId?: null, reasoningEffort?: null }} */
  const patch = {};

  if (providerChanging && thread.status === "working") {
    // The runner writes sessionId back when the turn ends, which would
    // resurrect the old CLI's session onto the new provider. Same rule as
    // deleteThread: wait the run out.
    throw new Error("Cannot switch provider while a run is active");
  }

  if (providerChanging && thread.sessionId) {
    // The old CLI's session cannot be resumed by the new one, so drop it and
    // let the next send start fresh. The thread and its transcript stay.
    patch.sessionId = null;
  }
  if (providerProvided) patch.provider = String(input.provider);

  const nextEntry = getProvider(nextProvider);

  if (providerChanging) {
    // Do not carry the old provider's model into the new provider's argv.
    // Keep a model only when this call supplies one that is valid for the NEW provider.
    if (modelProvided) {
      patch.model = normalizeModelForProvider(nextEntry, input.model);
    } else {
      patch.model = null;
    }
    // Same for effort, and for the same reason. A level the new provider does
    // not list would never reach its CLI, while the picker kept displaying it:
    // a setting shown to the user that does nothing, which is the exact bug
    // this feature removed one control to the left.
    patch.reasoningEffort = null;
  } else if (modelProvided) {
    patch.model = normalizeModelForProvider(nextEntry, input.model);
  }

  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * @param {import('./store').Store} [_store]
 * @param {object} [opts] - forwarded to listProviders (which, env, …)
 */
function listProvidersForApi(_store, opts) {
  return listProviders(opts);
}

/**
 * Archive or unarchive a thread. Does not bump updatedAt (not real activity).
 * @param {import('./store').Store} store
 * @param {{ threadId: string, archived: boolean }} input
 */
function setArchived(store, input) {
  const { threadId, archived } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const updated = store.updateThread(threadId, {
    archived: Boolean(archived),
  });
  store.save();
  return updated ? { ...updated } : { ...thread, archived: Boolean(archived) };
}

const SETTLE_OVERRIDES = new Set(["settled", "active", null]);

/**
 * Patch fields that clear a stale settle override when real activity starts
 * (startRun or startWorkflow). A "settled" override is cleared so the
 * thread does not re-fold the moment the run ends; an "active" override is
 * left alone so the user can keep a thread out of auto-settle.
 *
 * Round 44: this patch must NOT clear pinnedAt or snooze fields.
 * - Pin survives activity (t3: pins block auto-settle and are sticky).
 * - Snooze is visibility only; server fields persist; wake is derived
 *   client-side (timer or raised-hand), never by wiping on run start.
 *
 * @param {{ settledOverride?: string | null } | null | undefined} thread
 * @returns {{ settledOverride: null, settledAt: null } | {}}
 */
function clearSettledOnActivity(thread) {
  if (thread && thread.settledOverride === "settled") {
    return { settledOverride: null, settledAt: null };
  }
  return {};
}

/**
 * Set or clear the settle override (t3-style). Does not bump updatedAt:
 * settling is bookkeeping, and bumping would push the thread to the top of
 * a list it is leaving.
 *
 * Mutual exclusion with pin (round 44): an explicit "settled" override also
 * clears pinnedAt; setPinned(true) clears a "settled" override. Both directions
 * live here and in setPinned so they cannot drift.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, override: "settled" | "active" | null }} input
 */
function setSettled(store, input) {
  const { threadId, override } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  // Accept only the three contract values. null is allowed (clear).
  if (!SETTLE_OVERRIDES.has(override)) {
    throw new Error(
      `Invalid settle override: ${JSON.stringify(override)}. Expected "settled", "active", or null`,
    );
  }
  if (override === "settled" && thread.status === "working") {
    throw new Error("Cannot settle a thread while a run is active");
  }
  const patch = {
    settledOverride: override,
    settledAt: override != null ? Date.now() : null,
  };
  // Mutual exclusion: settle clears pin (mirror of setPinned clearing settle).
  if (override === "settled") {
    patch.pinnedAt = null;
  }
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Pin or unpin. Never bumps updatedAt.
 * Mutual exclusion with settle: pinning clears a "settled" override (+settledAt);
 * setSettled("settled") clears the pin. See setSettled for the other direction.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, pinned: boolean }} input
 */
function setPinned(store, input) {
  const { threadId, pinned } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (pinned) {
    patch.pinnedAt = Date.now();
    // Mutual exclusion: pin clears an explicit settle (not an "active" override).
    if (thread.settledOverride === "settled") {
      patch.settledOverride = null;
      patch.settledAt = null;
    }
  } else {
    patch.pinnedAt = null;
  }
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Snooze until an epoch ms, or clear with null. Visibility only: no run-state
 * guards (a working thread is snoozable). Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, until: number | null }} input
 */
function setSnoozed(store, input) {
  const { threadId, until } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  /** @type {Record<string, unknown>} */
  let patch;
  if (until === null || until === undefined) {
    patch = { snoozedUntil: null, snoozedAt: null };
  } else {
    const t = Number(until);
    if (!Number.isFinite(t) || !(t > Date.now())) {
      throw new Error(`Snooze time ${until} is not in the future`);
    }
    patch = { snoozedUntil: t, snoozedAt: Date.now() };
  }
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Shared with deleteThread and removeProject — one string so the two cannot
 * drift. Renderer and Git tab copy depend on this exact wording.
 */
const THREAD_STILL_HAS_WORKTREE =
  "Thread still has a worktree. Merge or delete it in the Git tab first.";

/**
 * Drop a thread and every *ByThread map entry (messages, work log, usage).
 * Does not save; caller owns durability so bulk callers can save once.
 * @param {import('./store').Store} store
 * @param {string} threadId
 */
function purgeThread(store, threadId) {
  store.removeThread(threadId);
}

/**
 * Permanently delete a thread with its messages and work log.
 * Rejects while a run is active (when isRunning is provided) and when a
 * worktree is still attached.
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @param {{ isRunning?: (threadId: string) => boolean }} [opts]
 */
function deleteThread(store, input, opts) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (opts && typeof opts.isRunning === "function" && opts.isRunning(threadId)) {
    throw new Error("Cannot delete thread while a run is active");
  }
  if (thread.worktreePath) {
    throw new Error(THREAD_STILL_HAS_WORKTREE);
  }
  purgeThread(store, threadId);
  store.save();
}

/**
 * Remove the project ENTRY and delete its threads' conversation history
 * (t3-style). The repository on disk is never touched — no fs calls on the
 * project path. Same worktree guard string as deleteThread; active-run copy
 * is project-scoped. All guards run before any deletion so a reject cannot
 * leave a half-removed project.
 * @param {import('./store').Store} store
 * @param {{ projectId: string }} input
 * @param {{ isRunning?: (threadId: string) => boolean }} [opts]
 */
function removeProject(store, input, opts) {
  const projectId =
    input && input.projectId != null ? String(input.projectId) : "";
  const project = store.getProject(projectId);
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  const threads = store
    .getThreads()
    .filter((t) => t && t.projectId === projectId);

  // Guards first — every thread — before any purge.
  for (const thread of threads) {
    const activeRun =
      thread.status === "working" ||
      (opts &&
        typeof opts.isRunning === "function" &&
        opts.isRunning(thread.id));
    if (activeRun) {
      throw new Error("Cannot remove a project while a run is active");
    }
  }
  for (const thread of threads) {
    if (thread.worktreePath) {
      throw new Error(THREAD_STILL_HAS_WORKTREE);
    }
  }

  for (const thread of threads) {
    purgeThread(store, thread.id);
  }
  store.setProjects(store.getProjects().filter((p) => p.id !== projectId));
  store.save();
}

/**
 * @param {import('./store').Store} store
 */
function listThreads(store) {
  return store.getThreads().slice();
}

/**
 * Full-content search across titles and message text.
 * @param {import('./store').Store} store
 * @param {{ query?: string }} [input]
 */
function searchThreads(store, input) {
  const query =
    input && input.query != null ? String(input.query) : "";
  return store.searchThreads(query);
}

/**
 * Full thread detail for the renderer.
 *
 * Selecting a thread is visiting it: when markVisited is true (default), stamp
 * lastVisitedAt = Date.now() and persist WITHOUT bumping updatedAt (visiting is
 * not activity; bumping would re-unread the thread and re-sort the sidebar).
 *
 * Callers (audit before changing stamp rules):
 * - electron/ipc.js threads:get — user selection; markVisited true (default)
 * - electron/runner.js pushDetail — background stream refresh; MUST pass
 *   { markVisited: false } so a non-selected thread is never marked read
 * - electron tests — default or explicit depending on the case under test
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {object | null} [workflow]
 * @param {{ markVisited?: boolean }} [opts]
 */
function getThreadDetail(store, threadId, workflow = null, opts) {
  const markVisited = !opts || opts.markVisited !== false;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (markVisited) {
    // No touch: visiting must not bump updatedAt.
    store.updateThread(threadId, { lastVisitedAt: Date.now() });
    store.save();
  }
  const current = store.getThread(threadId) || thread;
  return {
    thread: { ...current },
    messages: store.getMessages(threadId).slice(),
    workLog: store.getWorkLog(threadId).slice(),
    workflow: workflow ?? null,
    usage: store.getUsage(threadId) ?? null,
  };
}

/**
 * @param {string} projectPath
 * @returns {{ isRepo: boolean, branch: string, dirty: boolean }}
 */
function gitStatus(projectPath) {
  const resolved = path.resolve(projectPath);
  try {
    const inside = gitOut(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") {
      return { isRepo: false, branch: "", dirty: false };
    }
  } catch {
    return { isRepo: false, branch: "", dirty: false };
  }

  let branch = "";
  try {
    branch = gitOut(resolved, ["branch", "--show-current"]);
  } catch {
    branch = "";
  }

  let dirty = false;
  try {
    const porcelain = gitOut(resolved, ["status", "--porcelain"]);
    dirty = porcelain.length > 0;
  } catch {
    dirty = false;
  }

  return { isRepo: true, branch, dirty };
}

/**
 * Parse `git rev-list --left-right --count @{upstream}...HEAD` stdout.
 * Format: "<behind>\\t<ahead>" (left = upstream-only, right = HEAD-only).
 *
 * @param {string} text
 * @returns {{ hasUpstream: false } | { hasUpstream: true, ahead: number, behind: number }}
 */
function parseRevListCount(text) {
  const line = String(text || "").trim().split(/\r?\n/)[0] || "";
  const m = line.match(/^(\d+)\s+(\d+)$/);
  if (!m) return { hasUpstream: false };
  return {
    hasUpstream: true,
    behind: Number(m[1]),
    ahead: Number(m[2]),
  };
}

/**
 * Ahead/behind vs upstream for a checkout. Never throws.
 *
 * @param {string} cwd
 * @returns {{ hasUpstream: false } | { hasUpstream: true, ahead: number, behind: number }}
 */
function gitSyncInfo(cwd) {
  if (!cwd) return { hasUpstream: false };
  const resolved = path.resolve(cwd);
  try {
    const inside = gitOut(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return { hasUpstream: false };
  } catch {
    return { hasUpstream: false };
  }
  try {
    const out = gitOut(resolved, [
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]);
    return parseRevListCount(out);
  } catch {
    return { hasUpstream: false };
  }
}

/**
 * `git fetch` in a checkout. Rejects with a short message on failure.
 *
 * @param {string} cwd
 */
function gitFetch(cwd) {
  const resolved = path.resolve(cwd);
  try {
    gitOut(resolved, ["fetch"]);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(`git fetch failed: ${msg.split("\n")[0]}`);
  }
}

/**
 * List all projects.
 * @param {import('./store').Store} store
 */
function listProjects(store) {
  return store.getProjects().slice();
}

/**
 * Validate a workflow template before save.
 * Availability of the provider binary is NOT required to save.
 *
 * @param {{ name?: string, phases?: unknown }} template
 */
function validateWorkflowTemplate(template) {
  if (!template || typeof template !== "object") {
    throw new Error("Template is required");
  }
  const name = template.name != null ? String(template.name).trim() : "";
  if (!name) {
    throw new Error("Template name is required");
  }

  const phases = template.phases;
  if (!Array.isArray(phases)) {
    throw new Error("Template phases must be an array");
  }
  if (phases.length < 1 || phases.length > 6) {
    throw new Error("Template must have between 1 and 6 phases");
  }

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    if (!phase || typeof phase !== "object") {
      throw new Error(`Phase ${i + 1}: invalid phase object`);
    }
    const phaseName =
      phase.name != null ? String(phase.name).trim() : "";
    if (!phaseName) {
      throw new Error(`Phase ${i + 1}: name is required`);
    }
    if (phaseName.length > 24) {
      throw new Error(
        `Phase "${phaseName}": name must be at most 24 characters`,
      );
    }

    const agentCount = phase.agentCount;
    if (
      typeof agentCount !== "number" ||
      !Number.isInteger(agentCount) ||
      agentCount < 1 ||
      agentCount > 4
    ) {
      throw new Error(
        `Phase "${phaseName}": agentCount must be an integer from 1 to 4`,
      );
    }

    const instruction =
      phase.instruction != null ? String(phase.instruction).trim() : "";
    if (!instruction) {
      throw new Error(`Phase "${phaseName}": instruction is required`);
    }
    if (String(phase.instruction).length > 2000) {
      throw new Error(
        `Phase "${phaseName}": instruction must be at most 2000 characters`,
      );
    }

    const providerId =
      phase.provider != null ? String(phase.provider).trim() : "";
    if (!providerId) {
      throw new Error(`Phase "${phaseName}": provider is required`);
    }
    const entry = getProvider(providerId);
    if (!entry || entry.kind === "simulate") {
      throw new Error(
        `Phase "${phaseName}": unknown provider "${providerId}"`,
      );
    }

    // ONE rule for accepting a model, shared with setProvider. This used to be
    // an inline membership check, which meant filling the previously-empty
    // model lists made template phases STRICTER than before while setProvider
    // got looser: a template saved with a custom id then threw on a no-op
    // re-save. Routing through the helper also gives phases the trim, empty and
    // length guards the inline block never had.
    try {
      normalizeModelForProvider(entry, phase.model);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Phase "${phaseName}": ${msg}`);
    }
  }
}

/**
 * @param {import('./store').Store} store
 */
function listTemplates(store) {
  return store.listTemplates();
}

/**
 * Validate and save a workflow template.
 * @param {import('./store').Store} store
 * @param {{ id?: string, name: string, phases: object[] }} template
 */
function saveTemplate(store, template) {
  validateWorkflowTemplate(template);
  const phases = (template.phases || []).map((p) => ({
    name: String(p.name).trim(),
    agentCount: p.agentCount,
    instruction: String(p.instruction),
    provider: String(p.provider).trim(),
    // Store the NORMALIZED value. Validating and then persisting the raw
    // string meant a padded id stored padded, and " " + 100 chars + " " passed
    // the length guard and then stored 102 characters.
    // The entry argument is unused by normalizeModelForProvider now that the
    // list is a suggestion; pass null rather than computing a lookup for show.
    model: normalizeModelForProvider(null, p.model),
  }));
  const saved = store.saveTemplate({
    id: template.id,
    name: String(template.name).trim(),
    phases,
  });
  store.save();
  return saved;
}

/**
 * @param {import('./store').Store} store
 * @param {{ id: string }} input
 */
function removeTemplate(store, input) {
  const id = input && input.id != null ? String(input.id) : "";
  if (!id) {
    throw new Error("Template id is required");
  }
  store.removeTemplate(id);
  store.save();
}

/**
 * @param {import('./store').Store} store
 * @returns {{ dailyBudgetUsd: number | null, autoSettleAfterDays: number | null }}
 */
function getSettings(store) {
  return store.getSettings();
}

/**
 * Validate and persist settings. Does not touch threads.
 * @param {import('./store').Store} store
 * @param {Partial<{ dailyBudgetUsd: number | null, autoSettleAfterDays: number | null }>} patch
 * @returns {{ dailyBudgetUsd: number | null, autoSettleAfterDays: number | null }}
 */
function setSettings(store, patch) {
  const next = store.setSettings(patch || {});
  store.save();
  return next;
}

/**
 * Live app status: today's spend, memory health (with counts), and which build
 * is running. A /health failure degrades to nulls; status must never throw.
 * @param {import('./store').Store} store
 * @param {{ health?: () => Promise<any>, status?: () => any, pkg?: any }} [deps] injectable for tests
 */
async function appStatus(store, deps = {}) {
  const spend = store.getSpendToday();
  const spendTodayUsd = Math.round(spend * 100) / 100;
  const base = deps.status ? deps.status() : getMemoryStatus();

  let entries = null;
  let vectors = null;
  let lastError = null;
  if (base.running) {
    try {
      const health = deps.health ? await deps.health() : await fetchMemoryHealth(base.port);
      if (health && typeof health === "object") {
        entries = Number.isFinite(health.entryCount) ? health.entryCount : null;
        vectors =
          health.vectors && Number.isFinite(health.vectors.count)
            ? health.vectors.count
            : null;
        const je = health.janitor && health.janitor.lastError;
        lastError = je ? `${je.step}: ${je.message}` : null;
      }
    } catch {
      // health unreachable: report nulls rather than failing status
    }
  }

  let version = "0.0.0";
  let sha = null;
  let time = null;
  try {
    const pkg = deps.pkg || require("../package.json");
    version = String(pkg.version || version);
    sha = pkg.buildSha ? String(pkg.buildSha) : null;
    time = pkg.buildTime ? String(pkg.buildTime) : null;
  } catch {
    // dev tree without a stamped package: leave nulls
  }

  return {
    spendTodayUsd,
    memory: { ...base, entries, vectors, lastError },
    build: { version, sha, time },
  };
}

/** GET /health on the local memory server; resolves null on any failure. */
function fetchMemoryHealth(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(null);
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline;
    /** @param {any} value */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        req.destroy();
      } catch {
        // already closed
      }
      resolve(value);
    };
    const req = require("node:http").get(
      { host: "127.0.0.1", port, path: "/health", timeout: 1500 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          // Health is a small JSON document; refuse to buffer a runaway body.
          if (body.length > 256 * 1024) return finish(null);
          body += c;
        });
        res.on("end", () => {
          // A 500 whose body happens to parse is not health.
          if (res.statusCode !== 200) return finish(null);
          try {
            finish(JSON.parse(body));
          } catch {
            finish(null);
          }
        });
      },
    );
    req.on("error", () => finish(null));
    req.on("timeout", () => finish(null));
    // `timeout` is socket INACTIVITY, so a server dribbling a byte at a time can
    // hold status open forever. This is the absolute deadline. It is armed AFTER
    // http.get: an invalid port makes get() throw synchronously, and a timer
    // armed first would outlive the rejection and then fire into a TDZ `req`.
    deadline = setTimeout(() => finish(null), 2000);
  });
}

/**
 * Reject when a daily budget is set and today's spend is already at/over it.
 * Start-time only; does not kill in-flight runs.
 * @param {import('./store').Store} store
 */
function assertUnderDailyBudget(store) {
  const settings = store.getSettings();
  const budget = settings.dailyBudgetUsd;
  if (budget == null) return;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return;
  }
  const spent = store.getSpendToday();
  if (spent >= budget) {
    throw new Error(
      `Daily budget reached ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Raise or clear the cap in Settings.`,
    );
  }
}

module.exports = {
  addProject,
  removeProject,
  createThread,
  forkThread,
  setPermissionMode,
  setReasoningEffort,
  setProvider,
  // normalizeModelForProvider / isKnownProviderId / truncateThreadTitle stay
  // module-private (round-49 review A-n2: dead exports). Tests use
  // THREAD_TITLE_MAX / HANDOFF_ASSISTANT_MAX / buildHandoffPrefix.
  buildHandoffPrefix,
  THREAD_TITLE_MAX,
  HANDOFF_ASSISTANT_MAX,
  setArchived,
  setSettled,
  setPinned,
  setSnoozed,
  clearSettledOnActivity,
  deleteThread,
  purgeThread,
  THREAD_STILL_HAS_WORKTREE,
  listThreads,
  searchThreads,
  getThreadDetail,
  gitStatus,
  parseRevListCount,
  gitSyncInfo,
  gitFetch,
  listProjects,
  listProvidersForApi,
  listTemplates,
  saveTemplate,
  removeTemplate,
  validateWorkflowTemplate,
  slugFromRemoteUrl,
  getSettings,
  setSettings,
  appStatus,
  assertUnderDailyBudget,
  PERMISSION_MODES,
};
