"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { expandUserPath } = require("./fsBrowse.js");
const {
  getProvider,
  knownProviderIds,
  listProviders,
  honouredPermissionModes,
  snapPermissionMode,
} = require("./providers.js");
const { getMemoryStatus } = require("./memory-sup.js");
const { execCommandAsync } = require("./ssh.js");
const { runWindowsDoctor } = require("./doctor.js");
const configDoctor = require("./configDoctor.js");
const { normalizeCommand, runVerifyCommand } = require("./verify.js");
const { prepareVerifyRun } = require("./verifyEfficiency.js");
const {
  normalizeSetupCommand,
  normalizeQuickActions,
  runCommand,
} = require("./projectCommands.js");
const { resolveSandbox } = require("./sandbox.js");
const btw = require("./btw.js");
const { DEFAULT_WORKTREE_RETENTION } = require("./store.js");
const { scheduleImagePruneFromStore } = require("./image-store.js");
const { detectScm, JJ_NON_COLOCATED_ADD_ERROR } = require("./scm.js");
const {
  presentProject,
  normalizeIconPath,
  relativeIconPath,
  iconDataUrlFor,
  ICON_FILTERS,
  mainWorkTree,
} = require("./projectIcon.js");

const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

/** Network git (fetch/pull) is legitimately slower than execCommand's local default. */
const GIT_NETWORK_TIMEOUT_MS = 60_000;

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null} [project]
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<string>}
 */
async function gitOutAsync(cwd, args, project, opts) {
  return String(
    await execCommandAsync(project && project.remoteHost ? project : null, "git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts || {}),
    }),
  ).trim();
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

function normalizePathKey(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isWindowsAbsolutePath(value) {
  return (
    value.startsWith("\\\\") || /^[a-zA-Z]:([/\\]|$)/.test(String(value || ""))
  );
}

/**
 * Already-added project for this environment: same remote host+path, or the
 * same local path. Trailing slashes and `~` do not create a second entry.
 * @param {import('./store').Store} store
 * @param {{ path?: string, remoteHost?: string, remotePath?: string }} input
 */
function findExistingProject(store, input) {
  const host = input && input.remoteHost ? String(input.remoteHost).trim() : "";
  const projects = store.getProjects();
  if (host) {
    const rpath = normalizePathKey(input && input.remotePath);
    if (!rpath) return null;
    return (
      projects.find(
        (p) =>
          String(p.remoteHost || "").trim() === host &&
          normalizePathKey(p.remotePath || p.path) === rpath,
      ) || null
    );
  }
  const raw = input && input.path ? String(input.path).trim() : "";
  if (!raw) return null;
  const resolved = path.resolve(expandUserPath(raw));
  const key = normalizePathKey(resolved);
  return (
    projects.find(
      (p) => !p.remoteHost && normalizePathKey(p.path) === key,
    ) || null
  );
}

/**
 * True when cwd is a git work tree. A missing git binary, a non-repo, or a
 * bare repo all return false — callers then decide whether to init.
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
async function isInsideWorkTree(cwd) {
  try {
    const inside = await gitOutAsync(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return inside === "true";
  } catch {
    return false;
  }
}

/**
 * `git init -q` a local directory that is not already a work tree. Existing
 * repos are left untouched. Init failure is a real error, not "not a repo".
 * @param {string} resolved
 */
async function ensureGitWorkTree(resolved) {
  if (await isInsideWorkTree(resolved)) return;
  // Non-colocated jj has no Git work tree. `git init` next to `.jj` would
  // create a second, empty git repo and look colocated (#521).
  const scm = detectScm(resolved);
  if (scm && scm.kind === "jj" && scm.colocated === false) {
    throw new Error(JJ_NON_COLOCATED_ADD_ERROR);
  }
  try {
    await gitOutAsync(resolved, ["init", "-q"]);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(`Could not initialize a git repository: ${msg}`);
  }
  if (!(await isInsideWorkTree(resolved))) {
    throw new Error(
      `Not a git repository: ${resolved}. Choose a directory inside a git work tree.`,
    );
  }
}

/**
 * Validate remotes (when set) or a local directory; add ProjectInfo.
 * A local folder that is not yet a git work tree is initialized with
 * `git init -q` (same as createProject). SSH remotes skip the local check.
 * Local paths also get `~` expansion, create-if-missing, and return the
 * existing project instead of duplicating it (#609).
 * @param {import('./store').Store} store
 * @param {string} projectPath
 * @param {{ remoteHost?: string, remotePath?: string } | null} [opts]
 */
async function addProject(store, projectPath, opts) {
  const remoteHost =
    opts && typeof opts.remoteHost === "string" ? opts.remoteHost.trim() : "";
  const remotePath =
    opts && typeof opts.remotePath === "string" ? opts.remotePath.trim() : "";

  if (remoteHost) {
    if (!remotePath) {
      throw new Error("Remote path is required when remote host is set");
    }
    if (!remotePath.startsWith("/") && !remotePath.startsWith("~")) {
      throw new Error("Remote path must be an absolute path (start with / or ~)");
    }
    const existingRemote = findExistingProject(store, {
      remoteHost,
      remotePath,
    });
    if (existingRemote) return presentAdded(existingRemote);
    const folderName = path.posix.basename(remotePath) || "remote";
    const localPath =
      typeof projectPath === "string" && projectPath.trim()
        ? path.resolve(expandUserPath(projectPath.trim()))
        : remotePath;
    const project = {
      id: randomUUID(),
      slug: folderName,
      name: folderName,
      path: localPath,
      remoteHost,
      remotePath,
      worktreeRetention: DEFAULT_WORKTREE_RETENTION,
    };
    const projects = store.getProjects().slice();
    projects.push(project);
    store.setProjects(projects);
    store.save();
    return presentAdded(project);
  }

  const raw = typeof projectPath === "string" ? projectPath.trim() : "";
  if (!raw) {
    throw new Error("Path is required");
  }
  if (isWindowsAbsolutePath(raw) && process.platform !== "win32") {
    throw new Error(
      "Windows-style paths are only supported on Windows environments.",
    );
  }
  const resolved = path.resolve(expandUserPath(raw));
  const existing = findExistingProject(store, { path: resolved });
  if (existing) return presentAdded(existing);

  let stat;
  let created = false;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fs.mkdirSync(resolved, { recursive: true });
    created = true;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`Could not create directory: ${resolved}`);
    }
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  try {
    await ensureGitWorkTree(resolved);
  } catch (err) {
    // Roll back only a directory this call created; never an existing one.
    if (created) fs.rmSync(resolved, { recursive: true, force: true });
    throw err;
  }

  const folderName = path.basename(resolved);
  let slug = folderName;
  let name = folderName;

  try {
    const remote = await gitOutAsync(resolved, ["remote", "get-url", "origin"]);
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
    worktreeRetention: DEFAULT_WORKTREE_RETENTION,
  };

  const projects = store.getProjects().slice();
  projects.push(project);
  store.setProjects(projects);
  store.save();
  return presentAdded(project);
}

/**
 * Attach the win32 doctor to the add return value only. The stored
 * object is left untouched so a later save cannot persist the report.
 * Off win32 this is a no-op (same object, no extra field).
 * @param {object} project
 */
async function attachWindowsDoctor(project) {
  const report = await runWindowsDoctor(project);
  return report ? { ...project, windowsDoctor: report } : project;
}

async function presentAdded(project) {
  return presentProject(await attachWindowsDoctor(project));
}

/**
 * Create a brand-new project folder: mkdir, then addProject (which git-inits).
 * The name must be a plain folder name (no separators) and the parent
 * directory must already exist. A failed add rolls the new folder back.
 * @param {import('./store').Store} store
 * @param {{ name?: string, parentDir?: string }} input
 */
async function createProject(store, input) {
  const name =
    input && typeof input.name === "string" ? input.name.trim() : "";
  const parentDir =
    input && typeof input.parentDir === "string" ? input.parentDir.trim() : "";

  if (!name) {
    throw new Error("Project name is required");
  }
  if (name === "." || name === ".." || /[/\\\0]/.test(name)) {
    throw new Error("Project name must be a plain folder name (no slashes)");
  }
  if (!parentDir) {
    throw new Error("Location is required");
  }

  const parent = path.resolve(expandUserPath(parentDir));
  let stat;
  try {
    stat = fs.statSync(parent);
  } catch {
    throw new Error(`Path does not exist: ${parent}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${parent}`);
  }

  const target = path.join(parent, name);
  if (fs.existsSync(target)) {
    throw new Error(`Already exists: ${target}`);
  }

  fs.mkdirSync(target);
  try {
    return await addProject(store, target);
  } catch (err) {
    fs.rmSync(target, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Patch an existing project. Today: display name, SSH remote fields,
 * space membership (issue #159), the autoDispatch opt-in (issue #165),
 * worktree retention (#316), a per-project iconPath override (#610), and
 * setupCommand / quickActions (issue #153).
 * Remote validation mirrors addProject: a non-empty host requires an
 * absolute remotePath; an empty host clears both keys, turning the
 * project local again. The local checkout path is never edited here.
 * @param {import('./store').Store} store
 * @param {string} projectId
 * @param {{ name?: string, remoteHost?: string, remotePath?: string, spaceId?: string, autoDispatch?: boolean, worktreeRetention?: number, iconPath?: string | null, setupCommand?: string | null, quickActions?: Array<{ id?: string, name?: string, command?: string }> }} patch
 */
function updateProject(store, projectId, patch) {
  const projects = store.getProjects().slice();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx === -1) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  const next = { ...projects[idx] };
  const input = patch && typeof patch === "object" ? patch : {};

  if (typeof input.name === "string") {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Name cannot be empty");
    }
    next.name = name;
  }

  if (
    typeof input.remoteHost === "string" ||
    typeof input.remotePath === "string"
  ) {
    const host =
      typeof input.remoteHost === "string" ? input.remoteHost.trim() : "";
    const rpath =
      typeof input.remotePath === "string" ? input.remotePath.trim() : "";
    if (host) {
      if (!rpath) {
        throw new Error("Remote path is required when remote host is set");
      }
      if (!rpath.startsWith("/")) {
        throw new Error("Remote path must be an absolute path (start with /)");
      }
      next.remoteHost = host;
      next.remotePath = rpath;
    } else {
      delete next.remoteHost;
      delete next.remotePath;
    }
  }

  // #568: Spaces retired. Ignore leftover spaceId patches; never persist the key.
  if (typeof input.spaceId === "string") {
    delete next.spaceId;
  }

  // true persists the key; false deletes it so old stores stay clean.
  // Non-boolean input is ignored, not an error.
  if (input.autoDispatch === true) {
    next.autoDispatch = true;
  } else if (input.autoDispatch === false) {
    delete next.autoDispatch;
  }

  if (Object.prototype.hasOwnProperty.call(input, "worktreeRetention")) {
    const v = input.worktreeRetention;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      next.worktreeRetention = Math.floor(v);
    } else {
      throw new Error(
        "worktreeRetention must be a number greater than 0, or 0 to keep everything",
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "iconPath")) {
    const normalized = normalizeIconPath(input.iconPath);
    if (normalized) next.iconPath = normalized;
    else delete next.iconPath;
  }

  if (Object.prototype.hasOwnProperty.call(input, "setupCommand")) {
    const setupCommand = normalizeSetupCommand(input.setupCommand);
    if (setupCommand) next.setupCommand = setupCommand;
    else delete next.setupCommand;
  }

  if (Object.prototype.hasOwnProperty.call(input, "quickActions")) {
    const quickActions = normalizeQuickActions(input.quickActions);
    if (quickActions) next.quickActions = quickActions;
    else delete next.quickActions;
  }

  projects[idx] = next;
  store.setProjects(projects);
  store.save();
  return presentProject(next);
}

/**
 * @param {import('./store').Store} store
 * @returns {{ id: string, name: string }[]}
 */
function listSpaces() {
  return [];
}

/**
 * @param {import('./store').Store} _store
 * @param {{ name?: string }} _input
 */
function addSpace(_store, _input) {
  throw new Error("Spaces have been removed");
}

/**
 * @param {import('./store').Store} _store
 * @param {{ id?: string, name?: string }} _input
 */
function updateSpace(_store, _input) {
  throw new Error("Spaces have been removed");
}

/**
 * Idempotent: Spaces are already gone after the #568 store migration.
 * @param {import('./store').Store} _store
 * @param {{ id?: string }} _input
 */
function removeSpace(_store, _input) {
}

/**
 * @param {import('./store').Store} store
 * @param {{ projectId: string, title: string, worktree?: boolean, automationId?: string | null, issueNumber?: number | null }} input
 * `worktree` is only consumed by the IPC layer (threads:create), which calls
 * setupWorktree after this returns; the service itself stays fs-free.
 * `automationId` tags threads minted by an automation so runAutomation can
 * retain only the last N (issue #134). Absent / falsy on hand-made threads.
 * `issueNumber` is the planboard issue this thread was started from (#420).
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
    prMergeable: null,
    // Just-created is not unread: visit time matches creation.
    lastVisitedAt: now,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    notes: "",
    verifyCommand: null,
    verify: null,
    issueNumber: require("./postmerge.js").normalizeIssueNumber(input.issueNumber),
    postMergeVerify: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    webSearch: false,
    worktreePath: null,
    handoffFrom: null,
    automationId: input.automationId || null,
    queued: null,
    ask: input.ask === true,
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
  if (!teachPermissionAllowed(mode, thread.teach)) {
    const level = (thread.teach && thread.teach.autonomy) || "hint";
    throw new Error(
      `Teach mode (${level}) does not allow permission mode ${mode}`,
    );
  }
  const entry = getProvider(thread.provider);
  const allowed = honouredPermissionModes(entry);
  if (!allowed.includes(mode)) {
    const providerName =
      (entry && entry.name) || thread.provider || "provider";
    throw new Error(
      `${providerName} does not support permission mode "${mode}"`,
    );
  }
  /** @type {Record<string, unknown>} */
  const patch = { permissionMode: mode };
  // Leaving plan mode dismisses a persisted approval card (issue #707).
  // Switching the picker is "I don't want plan mode", not "approve this".
  if (mode !== "plan" && thread.pendingPlan) {
    patch.pendingPlan = null;
    if (!thread.pendingQuestion) patch.awaitingInput = false;
  }
  const updated = store.updateThread(threadId, patch);
  store.save();
  const row = updated || { ...thread, ...patch };
  return decorateThread(store, row);
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

/**
 * Enable or disable Codex live web search (`codex exec --search`) for a
 * thread. `webSearch: false` is always allowed. `true` is rejected unless
 * the thread's provider advertises supportsSearch, so a setting that would
 * never reach the CLI cannot be stored.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, webSearch: boolean }} input
 */
function setWebSearch(store, input) {
  const { threadId } = input;
  const enabled = input.webSearch === true;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }

  if (enabled) {
    const entry = getProvider(thread.provider);
    if (!entry || entry.supportsSearch !== true) {
      const providerName =
        (entry && entry.name) || thread.provider || "provider";
      throw new Error(`${providerName} does not support web search`);
    }
  }

  const updated = store.updateThread(threadId, { webSearch: enabled });
  store.save();
  return updated ? { ...updated } : { ...thread, webSearch: enabled };
}

/** Thread title cap — matches runner auto-rename from the first prompt line. */
const THREAD_TITLE_MAX = 60;
/** Per-thread scratch pad cap (issue #194). */
const THREAD_NOTES_MAX = 2000;
/** Felt-estimate cap (issue #401). Mirror src/shared/ipc.ts FELT_ESTIMATE_MAX_MS. */
const FELT_ESTIMATE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-thread hypothesis ledger caps (issue #303). Mirror src/shared/ipc.ts. */
const HYPOTHESES_MAX = 50;
const HYPOTHESIS_CLAIM_MAX = 200;
const HYPOTHESIS_REASON_MAX = 500;
const HYPOTHESIS_STATUSES = ["validated", "invalidated", "inconclusive"];
/** Ruled-out note: walk this many handoffFrom hops, emit at most this many lines. */
const HYPOTHESIS_NOTE_HOPS = 5;
const HYPOTHESIS_NOTE_MAX = 10;
/** Per-thread suggested-work chip caps (issue #550). Mirror src/shared/ipc.ts. */
const SUGGESTIONS_MAX = 20;
const SUGGESTION_TITLE_MAX = 120;
const SUGGESTION_PROMPT_MAX = 4000;
const SUGGESTION_RESOLVE_STATUSES = ["started", "filed", "dismissed"];

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

/** Hand-off digest limits: chars per message, messages kept, chars total. */
const HANDOFF_MESSAGE_MAX = 2000;
const HANDOFF_MESSAGE_COUNT = 12;
const HANDOFF_TOTAL_MAX = 12000;

/**
 * Standing note appended to every dispatched prompt (CLI-only, never stored
 * in the transcript) so every provider's agent knows the Planboard
 * convention. The Planboard view reads these labels back via
 * `gh issue list`.
 */
const PLANBOARD_NOTE =
  "\n\n[Planboard] This workspace tracks project plans as GitHub issues. " +
  "For multi-step work, record and maintain your plan/roadmap/issues as " +
  "GitHub issues in this repo's origin using `gh`, with status labels " +
  "plan:todo, plan:doing, plan:done (create the labels if missing, move " +
  "them as you progress, close finished issues). Skip this for trivial " +
  "tasks. Your own todo list is mirrored onto the board as live steps, so " +
  "keep it current instead of filing issues for individual steps.";

/**
 * PLANBOARD_NOTE when the project checkout has a GitHub origin, else "".
 * Keeps the note out of prompts where it isn't actionable.
 *
 * ponytail: checks the LOCAL path only, so remote-host projects never get
 * the note; route the check over ssh if remote planboards matter.
 *
 * @param {string | null | undefined} projectPath
 * @returns {string}
 */
function planboardNoteFor(projectPath) {
  try {
    const { gitTry, isGitHubRemote } = require("./worktrees.js");
    const cwd = String(projectPath || "");
    if (!cwd) return "";
    const remote = gitTry(cwd, ["remote", "get-url", "origin"]);
    if (!remote.ok) return "";
    if (!isGitHubRemote(String(remote.stdout || "").trim())) return "";
    return PLANBOARD_NOTE;
  } catch {
    return "";
  }
}

/**
 * Standing note appended to every dispatched prompt (CLI-only, never stored
 * in the transcript) telling the agent WHICH thread and project it is, so the
 * coder-threads tools can be called with real ids instead of a guess.
 *
 * The orchestrator server has no caller identity (one workspace-wide token,
 * stateless HTTP), so this note is the only channel by which an agent learns
 * its own id. Without it an agent picked thread ids off threads_list by title
 * and spawned workers on another project's repo (issue #109).
 *
 * Rides every dispatch rather than only the first turn: context compaction
 * and resumed sessions would otherwise lose it.
 *
 * Emitted only when the coder-threads server is actually registered: with no
 * thread tools in the run there is nothing to pass these ids to, and the note
 * would just be noise. Same rule as planboardNoteFor's GitHub-origin gate.
 *
 * @param {{ id?: string, projectId?: string } | null | undefined} thread
 * @param {{ name?: string } | null | undefined} project
 * @param {string | null | undefined} cwd - worktree path, else project path
 * @returns {string}
 */
function selfIdNoteFor(thread, project, cwd) {
  if (!thread || !thread.id || !thread.projectId) return "";
  try {
    const { activeServers } = require("./memory-sup.js");
    if (!activeServers().some((s) => s.name === "coder-threads")) return "";
  } catch {
    return "";
  }
  const name = project && project.name ? String(project.name) : "this project";
  const where = cwd ? `, checked out at ${cwd}` : "";
  return (
    `\n\n[Thread] You are thread ${thread.id} in project "${name}" ` +
    `(projectId ${thread.projectId})${where}. Pass these ids to the ` +
    `coder-threads tools; never guess another thread's id from its title. ` +
    `Threads in other projects are off limits.`
  );
}

/**
 * Standing note appended to every dispatched prompt (CLI-only, never stored
 * in the transcript) telling the agent it can offer out-of-scope work as a
 * one-click chip via work_suggest (issue #550). Gated exactly like
 * selfIdNoteFor: silent unless the coder-threads server is registered.
 *
 * @returns {string}
 */
function suggestedWorkNoteFor() {
  try {
    const { activeServers } = require("./memory-sup.js");
    if (!activeServers().some((s) => s.name === "coder-threads")) return "";
  } catch {
    return "";
  }
  return (
    "\n\n[Suggested work] When you notice work worth doing that is OUT OF SCOPE for the current task, call the coder-threads tool work_suggest (with your own threadId/projectId) — a short title plus a self-contained prompt for a fresh agent with none of your context. It renders as a chip the user can start as a new thread with one click. Never start or do that work yourself, never derail the current task for it, and suggest at most a few per run. Skip anything already suggested on this thread."
  );
}

/**
 * Standing note appended to every dispatched prompt (CLI-only, never stored
 * in the transcript) listing approaches earlier agents on this thread already
 * tried and rejected. The whole point of the ledger: it stops the next agent
 * (and the next best-of-N fork) from re-treading a dead end.
 *
 * Only invalidated entries speak; validated / inconclusive stay in the store
 * for the UI. Walks `handoffFrom` so a fork sees its ancestor's ruled-out
 * list. Returns "" when there is nothing to say, same rule as
 * planboardNoteFor / selfIdNoteFor.
 *
 * ponytail: 5 hops / 10 lines — enough to stop a sibling re-treading a
 * parent's dead end; walk the whole crew if a long chain starts to matter.
 *
 * @param {{ hypotheses?: Array<{ claim?: string, status?: string, reason?: string }>, handoffFrom?: string | null, id?: string } | null | undefined} thread
 * @param {(id: string) => { hypotheses?: unknown, handoffFrom?: string | null, id?: string } | null | undefined} [getThread]
 * @returns {string}
 */
function hypothesisNoteFor(thread, getThread) {
  if (!thread) return "";
  const lines = [];
  const seenClaims = new Set();
  const seenIds = new Set();
  let current = thread;
  for (let hop = 0; current && hop <= HYPOTHESIS_NOTE_HOPS; hop++) {
    if (current.id) {
      if (seenIds.has(current.id)) break;
      seenIds.add(current.id);
    }
    const hyps = Array.isArray(current.hypotheses) ? current.hypotheses : [];
    for (let i = hyps.length - 1; i >= 0; i--) {
      const h = hyps[i];
      if (!h || h.status !== "invalidated") continue;
      const claim = String(h.claim || "").trim();
      if (!claim || seenClaims.has(claim)) continue;
      seenClaims.add(claim);
      const reason = String(h.reason || "").trim();
      lines.push(reason ? `- ${claim} — ${reason}` : `- ${claim}`);
      if (lines.length >= HYPOTHESIS_NOTE_MAX) break;
    }
    if (lines.length >= HYPOTHESIS_NOTE_MAX) break;
    const parentId = current.handoffFrom;
    if (!parentId || typeof getThread !== "function") break;
    try {
      current = getThread(String(parentId));
    } catch {
      break;
    }
  }
  if (lines.length === 0) return "";
  return (
    "\n\n[Ruled out] Earlier agents on this thread already tried and rejected these. " +
    "Do not re-tread them; if you must revisit one, record why with hypothesis_record.\n" +
    lines.join("\n")
  );
}

/** Keep a persisted plan bounded: it rides every threads:changed push. */
const PLAN_STEP_MAX = 200;
const PLAN_STEPS_MAX = 50;

/**
 * A TodoWrite input's `todos` -> planboard steps, or null when there is
 * nothing usable (caller then keeps the thread's previous plan). The agent's
 * live plan is already its todo list, so the board costs the agent nothing.
 *
 * ponytail: TodoWrite (claude) only — codex/opencode carry their own plan
 * shapes; map them onto this same {step,status} list when one matters.
 *
 * @param {unknown} todos
 * @returns {{ step: string, status: "todo" | "doing" | "done" }[] | null}
 */
function planStepsFrom(todos) {
  if (!Array.isArray(todos)) return null;
  const steps = [];
  for (const t of todos) {
    if (!t || typeof t !== "object") continue;
    const step = typeof t.content === "string" ? t.content.trim() : "";
    if (!step) continue;
    const status = String(t.status || "");
    steps.push({
      step: step.slice(0, PLAN_STEP_MAX),
      status:
        status === "completed"
          ? "done"
          : status === "in_progress"
            ? "doing"
            : "todo",
    });
  }
  return steps.length > 0 ? steps.slice(0, PLAN_STEPS_MAX) : null;
}

/**
 * One-time context prefix for the CLI (NOT stored in the transcript): a
 * digest of a transcript tail, newest-last, each message capped.
 * Source is the handoffFrom thread, or this thread itself when
 * replayContext is set (issue #254 rewind — do NOT set handoffFrom to
 * self; that field drives crew sweeps and the OTel ancestor walk).
 * Returns "" when no prefix applies: no source, session already exists,
 * source missing/deleted, or source has no assistant message.
 *
 * ponytail: tail digest, not a summary — a fork still needs a self-contained
 * prompt (the MCP tool description says so). Summarize here only if the tail
 * proves too thin in practice.
 *
 * Strings are mirrored in src/devCoder.ts (services-level helper + dev twin —
 * the established pattern for shared electron/dev logic).
 *
 * @param {{ id?: string, handoffFrom?: string | null, sessionId?: string | null, replayContext?: boolean } | null} thread
 * @param {(sourceId: string) => Array<{ role?: string, text?: string }> | null | undefined} getMessages
 * @returns {string}
 */
function buildHandoffPrefix(thread, getMessages) {
  if (!thread) return "";
  if (thread.sessionId != null && thread.sessionId !== "") {
    return "";
  }
  // replayContext wins: a rewound fork must digest ITS OWN retained tail,
  // not walk handoffFrom again (and never a self-handoffFrom).
  const sourceId =
    thread.replayContext === true ? thread.id : thread.handoffFrom;
  if (sourceId == null || sourceId === "") {
    return "";
  }
  let msgs;
  try {
    msgs = getMessages(String(sourceId));
  } catch {
    return "";
  }
  if (!Array.isArray(msgs) || msgs.length === 0) return "";

  if (
    !msgs.some(
      (m) => m && m.role === "assistant" && m.text != null && String(m.text),
    )
  ) {
    return "";
  }

  const picked = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (picked.length >= HANDOFF_MESSAGE_COUNT) break;
    const m = msgs[i];
    if (!m || (m.role !== "assistant" && m.role !== "user")) continue;
    const text = m.text == null ? "" : String(m.text);
    if (!text) continue;
    const body =
      text.length > HANDOFF_MESSAGE_MAX
        ? text.slice(0, HANDOFF_MESSAGE_MAX) + "\n[…truncated]"
        : text;
    if (picked.length && total + body.length > HANDOFF_TOTAL_MAX) break;
    picked.push(`${m.role}: ${body}`);
    total += body.length;
  }
  picked.reverse();

  return (
    "[Hand-off context: the last messages of the source thread, truncated — " +
    "not the full transcript]\n" +
    picked.join("\n\n") +
    "\n[End context]\n\n"
  );
}

/**
 * Can this project host a git worktree? Remote projects are excluded (same
 * rule as threads:create) and so are non-repos, where `git worktree add`
 * would just fail the worker's run.
 * @param {{ path?: string, remoteHost?: string | null } | null | undefined} project
 * @returns {boolean}
 */
function canHostWorktree(project) {
  return Boolean(
    project &&
      !project.remoteHost &&
      project.path &&
      fs.existsSync(path.join(project.path, ".git")),
  );
}

/**
 * Fork / hand off: new thread in the source's project. Source is never modified.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, provider?: string, model?: string | null, worktree?: boolean }} input
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
  const forkPatch = {
    provider: nextProvider,
    model: nextModel,
    permissionMode: source.permissionMode,
    handoffFrom: source.id,
    sessionId: null,
  };
  // Teach mode is a thread persona, not a session: forks (including
  // orchestrator workers on another provider) stay in teach mode.
  if (source.teach && source.teach.autonomy) {
    const reviewsPassed = Number(source.teach.reviewsPassed) || 0;
    forkPatch.teach = {
      autonomy: teachAutonomyFor(reviewsPassed),
      reviewsPassed,
    };
  }
  // Same rule as setProvider (issue #177): a mode the new provider cannot
  // honour must not be copied onto the fork. Teach-mode caps still win.
  forkPatch.permissionMode = snapPermissionModeForThread(
    nextEntry,
    source.permissionMode,
    forkPatch.teach,
  );
  // Ask mode is the same: a fork of a read-only Q&A thread stays read-only
  // and must not grow a worktree (issue #392).
  if (source.ask === true) {
    forkPatch.ask = true;
  }
  // Opt-in worktree for user-facing forks (issue #550 chips). Same guards
  // as forkWorkerThread: not an Ask thread, project can host a worktree.
  if (input.worktree === true) {
    const projectId = created.projectId ?? source.projectId;
    const project =
      typeof store.getProject === "function" && projectId != null
        ? store.getProject(projectId)
        : null;
    const sourceAsk = Boolean(source.ask) || Boolean(forkPatch.ask);
    if (!sourceAsk && canHostWorktree(project)) {
      forkPatch.pendingWorktree = true;
    }
  }
  const updated = store.updateThread(created.id, forkPatch);
  store.save();
  return updated ? { ...updated } : { ...created, ...forkPatch };
}

/**
 * Fork a thread into an orchestration WORKER: flagged orchWorker (the runner
 * auto-archives it when its run lands, issue #14) and isolated in its own
 * worktree so N parallel workers never edit the same checkout (issue #30).
 * Lazy like threads:create — startRun materializes the worktree.
 *
 * Shared by orchServer's thread_fork tool and the runner's pendingFork
 * dispatch so the two definitions of "a worker" cannot drift apart. Starting
 * the run is the caller's job: services must not depend on the runner.
 *
 * @param {any} store
 * @param {{ threadId: string, provider?: string, model?: string | null, pool?: string, worktree?: boolean }} input
 * @param {(store: any, input: any) => any} [forkImpl] seam for tests
 * @returns {any} the new worker thread
 */
function forkWorkerThread(store, input, forkImpl = forkThread) {
  const {
    resolveSubagentPool,
    poolFromStore,
  } = require("./subagentPool");
  const resolved = resolveSubagentPool(poolFromStore(store), {
    pool: input.pool,
    provider: input.provider,
  });

  /** @type {{ threadId: string, provider?: string, model?: string | null }} */
  const forkInput = { threadId: input.threadId };
  if (resolved) {
    forkInput.provider = resolved.provider;
    if (resolved.fromPool) {
      forkInput.model = resolved.model;
    } else if (Object.prototype.hasOwnProperty.call(input, "model")) {
      forkInput.model = input.model;
    }
  } else if (input.provider != null) {
    forkInput.provider = input.provider;
    if (Object.prototype.hasOwnProperty.call(input, "model")) {
      forkInput.model = input.model;
    }
  } else if (Object.prototype.hasOwnProperty.call(input, "model")) {
    forkInput.model = input.model;
  }
  const fork = forkImpl(store, forkInput);

  const patch = { orchWorker: true };
  const source = store.getThread(input.threadId);
  const projectId = fork.projectId ?? (source ? source.projectId : null);
  const project =
    typeof store.getProject === "function" && projectId != null
      ? store.getProject(projectId)
      : null;
  // Ask workers stay in the checkout — a worktree would burn the isolation
  // Ask exists to avoid (issue #392).
  const sourceAsk = Boolean(source && source.ask) || Boolean(fork.ask);
  if (input.worktree !== false && !sourceAsk && canHostWorktree(project)) {
    patch.pendingWorktree = true;
  }
  store.updateThread(fork.id, patch);
  store.save();
  return fork;
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
    return decorateThread(store, thread);
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

  /** @type {{ provider?: string, model?: string | null, sessionId?: null, reasoningEffort?: null, webSearch?: boolean }} */
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
    // Effort is a preference, not a model detail, so it survives the switch
    // when the new provider lists that level. It cannot survive onto a
    // provider that does not list it: that level would never reach the CLI
    // while the picker kept displaying it (same rule as setReasoningEffort).
    const nextEfforts =
      nextEntry && Array.isArray(nextEntry.efforts) ? nextEntry.efforts : [];
    patch.reasoningEffort = nextEfforts.includes(thread.reasoningEffort)
      ? thread.reasoningEffort
      : null;
    // Same rule as effort: a search toggle that the new provider cannot
    // honour must not survive the switch (issue #174).
    patch.webSearch =
      nextEntry && nextEntry.supportsSearch === true
        ? thread.webSearch === true
        : false;
    // Same rule as effort: a permission mode the new provider cannot honour
    // must not survive the switch (issue #177). Teach-mode caps still win.
    patch.permissionMode = snapPermissionModeForThread(
      nextEntry,
      thread.permissionMode,
      thread.teach,
    );
  } else if (modelProvided) {
    patch.model = normalizeModelForProvider(nextEntry, input.model);
  }

  const updated = store.updateThread(threadId, patch);
  store.save();
  const row = updated || { ...thread, ...patch };
  return decorateThread(store, row);
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
  if (Boolean(archived)) {
    void scheduleImagePruneFromStore(store);
  }
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
  if (
    override === "settled" &&
    (thread.status === "working" || thread.status === "quota-wait")
  ) {
    throw new Error("Cannot settle a thread while a run is active");
  }
  const patch = {
    settledOverride: override,
    settledAt: override != null ? Date.now() : null,
  };
  // Mutual exclusion: settle clears pin (mirror of setPinned clearing settle).
  // Explicit settle also unsnoozes immediately (t3: companion unsnooze) so
  // the row leaves the snoozed shelf instead of staying hidden until wake.
  if (override === "settled") {
    patch.pinnedAt = null;
    patch.snoozedUntil = null;
    patch.snoozedAt = null;
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
 * Persist or clear the type-ahead queue for a thread (issue #137).
 * prompt === null clears. A non-null prompt APPENDS to any existing queue
 * (same join as the old renderer startRun) so two mid-run sends cannot
 * race-replace each other across the async IPC hop. Never bumps updatedAt:
 * queueing is not activity, same rule as setPinned.
 *
 * @param {import('./store').Store} store
 * @param {{
 *   threadId: string,
 *   prompt: string | null,
 *   attachments?: object[],
 *   fromThread?: { id: string, title: string } | null,
 *   inbound?: boolean,
 *   posted?: boolean,
 * }} input
 */
function setQueued(store, input) {
  const { threadId, prompt, attachments } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  let queued = null;
  if (prompt !== null) {
    const prev = thread.queued;
    const files = [...(prev?.attachments ?? []), ...(attachments ?? [])];
    queued = {
      prompt: prev ? `${prev.prompt}\n\n${prompt}` : prompt,
      attachments: files.length ? files : undefined,
      // A new/appended prompt drops any previous delivery error (#314).
    };
    const fromThread = input.fromThread || (prev && prev.fromThread);
    if (fromThread && fromThread.id) {
      queued.fromThread = {
        id: String(fromThread.id),
        title: fromThread.title != null ? String(fromThread.title) : "",
      };
    }
    // inbound stays true only when every line in the blob is inbound
    // (a user follow-up mixed in must still drain at idle).
    if (prev ? prev.inbound === true && input.inbound === true : input.inbound === true) {
      queued.inbound = true;
    }
    if (prev ? prev.posted === true && input.posted === true : input.posted === true) {
      queued.posted = true;
    }
  }
  // Queueing a follow-up mid-run is still the user speaking, so it supersedes
  // an open question card the same way startRun does (issue #647). Clearing
  // the queue (prompt === null) is not: the card outlives a cancelled draft.
  // An inbound cross-thread send is another agent, not the user: it queues
  // behind the card instead of deleting it.
  const patch =
    queued && input.inbound !== true
      ? { queued, pendingQuestion: null }
      : { queued };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, queued };
}

/**
 * Atomically read-and-clear the type-ahead queue (issue #314). Returns the
 * queued payload or null when empty. Never bumps updatedAt: taking is
 * delivery, not activity.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{ prompt: string, attachments?: object[], error?: string | null } | null}
 */
function takeQueued(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const queued = thread.queued || null;
  if (!queued) return null;
  store.updateThread(threadId, { queued: null });
  store.save();
  return queued;
}

/**
 * Open a `/btw` side-question card (issue #471). Returns `{ thread, card }`.
 * Never bumps updatedAt: a side question is not thread activity, same rule
 * as setQueued. Caps in-flight cards at BTW_RUNNING_MAX.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, question: unknown }} input
 * @returns {{ thread: object, card: object }}
 */
function addBtw(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const question = btw.normalizeBtwQuestion(input.question);
  if (!question) {
    throw new Error("Side question is empty");
  }
  const cards = Array.isArray(thread.btw) ? thread.btw.slice() : [];
  const running = cards.filter((c) => c && c.status === "running").length;
  if (running >= btw.BTW_RUNNING_MAX) {
    throw new Error(
      `Already ${btw.BTW_RUNNING_MAX} side questions in flight`,
    );
  }
  const card = {
    id: randomUUID(),
    question,
    status: "running",
    createdAt: Date.now(),
  };
  cards.push(card);
  if (cards.length > btw.BTW_MAX) {
    cards.splice(0, cards.length - btw.BTW_MAX);
  }
  const updated = store.updateThread(threadId, { btw: cards });
  store.save();
  const next = updated ? { ...updated } : { ...thread, btw: cards };
  return { thread: next, card };
}

/**
 * Write the answer (or error) onto an existing card. No-op when the card
 * is gone (dismissed). Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, id: string, answer?: unknown, error?: unknown, source?: unknown }} input
 * @returns {object | null}
 */
function finishBtw(store, input) {
  const { threadId, id } = input;
  const thread = store.getThread(threadId);
  if (!thread) return null;
  const cards = Array.isArray(thread.btw) ? thread.btw.slice() : [];
  const idx = cards.findIndex((c) => c && c.id === id);
  if (idx === -1) return null;
  const prev = cards[idx];
  const errText =
    input.error != null && String(input.error).trim()
      ? String(input.error).trim()
      : "";
  const answer =
    input.answer != null ? String(input.answer).slice(0, btw.BTW_ANSWER_MAX) : "";
  const source =
    input.source === "fm" ||
    input.source === "print" ||
    input.source === "retrieval"
      ? input.source
      : undefined;
  const nextCard = {
    ...prev,
    status: errText && !answer ? "error" : "done",
    answer: answer || prev.answer,
  };
  if (errText) nextCard.error = errText;
  else delete nextCard.error;
  if (source) nextCard.source = source;
  cards[idx] = nextCard;
  const updated = store.updateThread(threadId, { btw: cards });
  store.save();
  return updated ? { ...updated } : { ...thread, btw: cards };
}

/**
 * Drop a side-question card. Unknown id is a no-op (already gone).
 * Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, id: string }} input
 * @returns {object}
 */
function dismissBtw(store, input) {
  const { threadId, id } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const cards = Array.isArray(thread.btw) ? thread.btw : [];
  const next = cards.filter((c) => c && c.id !== id);
  if (next.length === cards.length) {
    return { ...thread };
  }
  const patch = { btw: next.length ? next : undefined };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, btw: patch.btw };
}

/**
 * Queue the side question as a follow-up and drop the card. The answer
 * (when present) rides along so the main agent does not redo the lookup.
 * Unknown id is an error so a double-click cannot silently no-op.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, id: string }} input
 * @returns {object}
 */
function promoteBtw(store, input) {
  const { threadId, id } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const cards = Array.isArray(thread.btw) ? thread.btw : [];
  const card = cards.find((c) => c && c.id === id);
  if (!card) {
    throw new Error(`Unknown side question: ${id}`);
  }
  const answer = typeof card.answer === "string" ? card.answer.trim() : "";
  const prompt = answer
    ? `Follow-up from a side question:\n${card.question}\n\n(Already answered off-thread; use or ignore:)\n${answer}`
    : card.question;
  const remaining = cards.filter((c) => c && c.id !== id);
  store.updateThread(threadId, {
    btw: remaining.length ? remaining : undefined,
  });
  return setQueued(store, { threadId, prompt });
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
 * Mute/unmute desktop notifications for one thread (issue #87). Notification
 * only: no run-state or visibility effect, and never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, muted: boolean }} input
 */
function setMuted(store, input) {
  const { threadId, muted } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const patch = { muted: muted === true };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Per-thread inbound policy for cross-thread messages (issue #551).
 * accept (default, stored as absent) / queue-only / refuse.
 * Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, policy: unknown }} input
 */
function setCrossThreadInbound(store, input) {
  const { INBOUND_POLICIES } = require("./crossThread.js");
  const raw = String(input.policy || "")
    .trim()
    .toLowerCase();
  if (!INBOUND_POLICIES.includes(raw)) {
    throw new Error(
      `Invalid inbound policy: ${input.policy}. Expected one of: ${INBOUND_POLICIES.join(", ")}`,
    );
  }
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const patch = { crossThreadInbound: raw === "accept" ? null : raw };
  const updated = store.updateThread(threadId, patch);
  store.save();
  const row = updated ? { ...updated } : { ...thread, ...patch };
  if (raw === "accept") delete row.crossThreadInbound;
  return row;
}

/**
 * Per-thread quota-wait auto-resume override (#462). true/false pins the
 * thread; null inherits the global setting. Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, enabled: boolean | null }} input
 */
function setQuotaWaitAutoResume(store, input) {
  const { threadId, enabled } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (enabled !== true && enabled !== false && enabled !== null) {
    throw new Error("quotaWaitAutoResume must be true, false, or null");
  }
  const patch = { quotaWaitAutoResume: enabled };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return decorateThread(store, updated || { ...thread, ...patch });
}

/**
 * Set or clear the per-thread scratch pad (issue #194). User-facing only:
 * the agent never reads it. Trims, caps at THREAD_NOTES_MAX, empty string
 * clears. Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, notes: string }} input
 */
function setNotes(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const notes = String(input.notes ?? "").trim().slice(0, THREAD_NOTES_MAX);
  const patch = { notes };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Record the one-tap felt estimate for a thread (issue #401). savedMs is a
 * non-negative duration clamped to FELT_ESTIMATE_MAX_MS; null records a
 * decline so the transcript card never asks again. User-facing bookkeeping,
 * never bumps updatedAt — same rule as setNotes.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, savedMs: number | null }} input
 */
function setFeltEstimate(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const at = Date.now();
  let feltEstimate;
  if (input.savedMs == null) {
    feltEstimate = { kind: "declined", at };
  } else {
    const savedMs = Number(input.savedMs);
    if (!Number.isFinite(savedMs) || savedMs < 0) {
      throw new Error(
        `Invalid felt estimate: ${JSON.stringify(input.savedMs)}. Expected a non-negative number of ms, or null to decline`,
      );
    }
    feltEstimate = {
      kind: "saved",
      savedMs: Math.min(savedMs, FELT_ESTIMATE_MAX_MS),
      at,
    };
  }
  const patch = { feltEstimate };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Append one hypothesis to a thread's ledger (issue #303). Agent-written
 * only — never inferred. Trims and caps claim/reason, rejects a blank claim
 * and an unknown status. Newest-last, capped at HYPOTHESES_MAX (oldest
 * dropped). Never bumps updatedAt: the ledger is not sidebar activity,
 * same rule as setNotes.
 *
 * ponytail: same-ms uniqueness is Date.now() plus a scan of this thread's
 * existing ids (max 50). A process-global counter if that ever collides.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, claim: unknown, status: unknown, reason?: unknown }} input
 * @returns {{ id: string, claim: string, status: string, reason: string, at: number }}
 */
function recordHypothesis(store, input) {
  const { threadId, status } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!HYPOTHESIS_STATUSES.includes(status)) {
    throw new Error(
      `Invalid hypothesis status: ${status}. Must be one of: ${HYPOTHESIS_STATUSES.join(", ")}`,
    );
  }
  const claim = String(input.claim ?? "").trim().slice(0, HYPOTHESIS_CLAIM_MAX);
  if (!claim) {
    throw new Error("Hypothesis claim must not be empty");
  }
  const reason = String(input.reason ?? "").trim().slice(0, HYPOTHESIS_REASON_MAX);
  const existing = Array.isArray(thread.hypotheses) ? thread.hypotheses : [];
  const now = Date.now();
  let seq = 0;
  for (const h of existing) {
    if (h && typeof h.id === "string" && h.id.startsWith(`${now}-`)) seq += 1;
  }
  const entry = {
    id: `${now}-${seq}`,
    claim,
    status,
    reason,
    at: now,
  };
  const hypotheses = existing.concat(entry);
  if (hypotheses.length > HYPOTHESES_MAX) {
    hypotheses.splice(0, hypotheses.length - HYPOTHESES_MAX);
  }
  store.updateThread(threadId, { hypotheses });
  store.save();
  return entry;
}

/**
 * Append one suggested-work chip to a thread (issue #550). Agent-written
 * only — never parsed out of the transcript. Trims and caps title/prompt,
 * rejects a blank of either. Newest-last, capped at SUGGESTIONS_MAX (oldest
 * dropped). An open chip with the same lower-cased title is returned as-is
 * instead of appending a duplicate. Never bumps updatedAt: same rule as
 * recordHypothesis / setNotes.
 *
 * ponytail: same-ms uniqueness is Date.now() plus a scan of this thread's
 * existing ids (max 20).
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, title: unknown, prompt: unknown }} input
 * @returns {{ id: string, title: string, prompt: string, status: string, at: number }}
 */
function recordSuggestion(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const title = String(input.title ?? "").trim().slice(0, SUGGESTION_TITLE_MAX);
  if (!title) {
    throw new Error("Suggestion title must not be empty");
  }
  const prompt = String(input.prompt ?? "")
    .trim()
    .slice(0, SUGGESTION_PROMPT_MAX);
  if (!prompt) {
    throw new Error("Suggestion prompt must not be empty");
  }
  const existing = Array.isArray(thread.suggestions) ? thread.suggestions : [];
  const titleKey = title.toLowerCase();
  for (const s of existing) {
    if (
      s &&
      s.status === "open" &&
      String(s.title || "").toLowerCase() === titleKey
    ) {
      return s;
    }
  }
  const now = Date.now();
  let seq = 0;
  for (const s of existing) {
    if (s && typeof s.id === "string" && s.id.startsWith(`${now}-`)) seq += 1;
  }
  const entry = {
    id: `${now}-${seq}`,
    title,
    prompt,
    status: "open",
    at: now,
  };
  const suggestions = existing.concat(entry);
  if (suggestions.length > SUGGESTIONS_MAX) {
    suggestions.splice(0, suggestions.length - SUGGESTIONS_MAX);
  }
  store.updateThread(threadId, { suggestions });
  store.save();
  return entry;
}

/**
 * Resolve a suggested-work chip (issue #550): flip its status to
 * "started" / "filed" / "dismissed" and optionally stamp startedThreadId
 * / issueNumber. Rejects an unknown thread or suggestion id, and a
 * status of "open" (chips never reopen). Returns the updated thread,
 * same convention as setNotes.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, suggestionId: string, status: unknown, startedThreadId?: unknown, issueNumber?: unknown }} input
 * @returns {object}
 */
function resolveSuggestion(store, input) {
  const { threadId, suggestionId, status } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!SUGGESTION_RESOLVE_STATUSES.includes(status)) {
    throw new Error(
      `Invalid suggestion status: ${status}. Must be one of: ${SUGGESTION_RESOLVE_STATUSES.join(", ")}`,
    );
  }
  const existing = Array.isArray(thread.suggestions) ? thread.suggestions : [];
  const idx = existing.findIndex((s) => s && s.id === suggestionId);
  if (idx < 0) {
    throw new Error(`Unknown suggestion: ${suggestionId}`);
  }
  const patched = { ...existing[idx], status };
  if (input.startedThreadId != null) {
    patched.startedThreadId = String(input.startedThreadId);
  }
  if (input.issueNumber != null) {
    patched.issueNumber = Number(input.issueNumber);
  }
  const suggestions = existing.slice();
  suggestions[idx] = patched;
  const updated = store.updateThread(threadId, { suggestions });
  store.save();
  return updated ? { ...updated } : { ...thread, suggestions };
}

/* --------------------------------------------------------- crew task list */

/** Caps for the shared task list (issue #277). Mirrors src/shared/ipc.ts. */
const CREW_TASK_TITLE_MAX = 200;
const CREW_TASK_NOTE_MAX = 2000;
const CREW_TASKS_MAX = 100;
const CREW_TASK_ATTEMPT_CAP = 3;
const CREW_AUTO_TURN_CAP = 25;
/** Walk at most this many handoffFrom hops looking for the crew root. */
const CREW_ROOT_HOPS = 20;

/**
 * The crew root of a thread: walk `handoffFrom` up while the thread is an
 * orchWorker, so every worker of one orchestration resolves to the SAME id
 * and therefore to the same shared task list. A plain thread is its own root.
 *
 * Cycle- and depth-guarded; a missing parent stops the walk (the deepest
 * thread we could still resolve wins, never a dangling id).
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @returns {string}
 */
function crewRootOf(store, threadId) {
  let current = store.getThread(threadId);
  if (!current) return String(threadId);
  const seen = new Set([current.id]);
  for (let hop = 0; hop < CREW_ROOT_HOPS; hop++) {
    if (!current.orchWorker || !current.handoffFrom) break;
    const parentId = String(current.handoffFrom);
    if (seen.has(parentId)) break;
    const parent = store.getThread(parentId);
    if (!parent) break;
    seen.add(parentId);
    current = parent;
  }
  return String(current.id);
}

/**
 * A task is claimable only once every id in `needs` is done. Blocked-ness is
 * DERIVED here rather than stored, so completing a task unblocks its
 * dependents with no second write that could go stale (issue #277).
 * An unknown id in `needs` blocks forever — a typo must not silently open.
 *
 * @param {{ needs?: string[] }} task
 * @param {Map<string, { status?: string }>} byId
 * @returns {boolean}
 */
function isBlocked(task, byId) {
  const needs = Array.isArray(task.needs) ? task.needs : [];
  return needs.some((id) => {
    const dep = byId.get(String(id));
    return !dep || dep.status !== "done";
  });
}

/** @param {Array<object>} tasks */
function taskIndex(tasks) {
  return new Map(tasks.map((t) => [String(t.id), t]));
}

/** Tasks with the derived `blocked` flag the UI and the tools both want. */
function withBlocked(tasks) {
  const byId = taskIndex(tasks);
  return tasks.map((t) => ({ ...t, blocked: isBlocked(t, byId) }));
}

/**
 * The crew's shared task list, newest-last, each entry carrying the derived
 * `blocked` flag.
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{ rootThreadId: string, tasks: Array<object> }}
 */
function listCrewTasks(store, input) {
  const rootThreadId = crewRootOf(store, input.threadId);
  return { rootThreadId, tasks: withBlocked(store.getCrewTasks(rootThreadId)) };
}

/**
 * Append tasks to the crew's shared list. Ids are assigned here ("t1", "t2",
 * …) and are what agents quote; `needs` may name tasks added in the same
 * call, but an id that matches nothing in the list is rejected — a dependency
 * typo would otherwise block a task forever.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, tasks: Array<{ title?: unknown, needs?: unknown }> }} input
 * @returns {{ rootThreadId: string, tasks: Array<object>, added: string[] }}
 */
function addCrewTasks(store, input) {
  const thread = store.getThread(input.threadId);
  if (!thread) throw new Error(`Unknown thread: ${input.threadId}`);
  const rootThreadId = crewRootOf(store, input.threadId);
  const list = store.getCrewTasks(rootThreadId);
  const incoming = Array.isArray(input.tasks) ? input.tasks : [];
  if (incoming.length === 0) throw new Error("tasks must not be empty");
  if (list.length + incoming.length > CREW_TASKS_MAX) {
    throw new Error(
      `Crew task list is capped at ${CREW_TASKS_MAX} tasks (has ${list.length}). ` +
        `Complete or drop tasks before adding more.`,
    );
  }

  const now = Date.now();
  let next = 1;
  for (const t of list) {
    const n = Number(String(t.id).replace(/^t/, ""));
    if (Number.isInteger(n) && n >= next) next = n + 1;
  }
  const added = [];
  for (const raw of incoming) {
    const title = String((raw && raw.title) ?? "")
      .trim()
      .slice(0, CREW_TASK_TITLE_MAX);
    if (!title) throw new Error("Task title must not be empty");
    const needs = Array.isArray(raw && raw.needs)
      ? raw.needs.map((n) => String(n).trim()).filter(Boolean)
      : [];
    const id = `t${next++}`;
    list.push({
      id,
      title,
      needs,
      status: "open",
      owner: null,
      note: "",
      attempts: [],
      createdAt: now,
      updatedAt: now,
    });
    added.push(id);
  }

  const byId = taskIndex(list);
  for (const t of list) {
    for (const need of t.needs) {
      if (!byId.has(String(need))) {
        throw new Error(
          `Task ${t.id} needs unknown task "${need}". Known ids: ` +
            `${list.map((x) => x.id).join(", ")}.`,
        );
      }
      if (String(need) === t.id) {
        throw new Error(`Task ${t.id} cannot need itself`);
      }
    }
  }

  store.setCrewTasks(rootThreadId, list);
  store.save();
  return { rootThreadId, tasks: withBlocked(list), added };
}

/**
 * Claim a task for a thread. With no taskId, takes the first open task whose
 * dependencies are all done (self-claim); with one, claims exactly that task.
 *
 * Loop guardrail (issue #277): a task already attempted CREW_TASK_ATTEMPT_CAP
 * times is refused — the crew must escalate instead of grinding. A re-claim
 * below the cap returns `attempts`, which the caller turns into the forced
 * "what failed / am I repeating myself" reflection.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, taskId?: string | null }} input
 * @returns {{ rootThreadId: string, task: object | null, reason?: string, attempts: Array<object> }}
 */
function claimCrewTask(store, input) {
  const thread = store.getThread(input.threadId);
  if (!thread) throw new Error(`Unknown thread: ${input.threadId}`);
  const rootThreadId = crewRootOf(store, input.threadId);
  const list = store.getCrewTasks(rootThreadId);
  const byId = taskIndex(list);
  const wanted = input.taskId == null ? null : String(input.taskId);

  let task = null;
  if (wanted == null) {
    task =
      list.find(
        (t) => t.status === "open" && !isBlocked(t, byId),
      ) || null;
    if (!task) {
      const blocked = list.filter(
        (t) => t.status === "open" && isBlocked(t, byId),
      ).length;
      return {
        rootThreadId,
        task: null,
        attempts: [],
        reason: blocked
          ? `No claimable task: ${blocked} still waiting on dependencies. ` +
            `Wait for a peer to finish, or work on something else.`
          : "No open tasks left.",
      };
    }
  } else {
    task = byId.get(wanted) || null;
    if (!task) throw new Error(`Unknown task: ${wanted}`);
    if (task.status === "done") {
      return {
        rootThreadId,
        task: null,
        attempts: task.attempts || [],
        reason: `Task ${task.id} is already done: ${task.note || "no note"}`,
      };
    }
    if (task.status === "claimed" && task.owner !== input.threadId) {
      return {
        rootThreadId,
        task: null,
        attempts: task.attempts || [],
        reason: `Task ${task.id} is already claimed by thread ${task.owner}.`,
      };
    }
    if (isBlocked(task, byId)) {
      const pending = task.needs.filter((n) => {
        const dep = byId.get(String(n));
        return !dep || dep.status !== "done";
      });
      return {
        rootThreadId,
        task: null,
        attempts: task.attempts || [],
        reason: `Task ${task.id} is blocked on ${pending.join(", ")}.`,
      };
    }
  }

  const attempts = Array.isArray(task.attempts) ? task.attempts : [];
  if (attempts.length >= CREW_TASK_ATTEMPT_CAP) {
    return {
      rootThreadId,
      task: null,
      attempts,
      reason:
        `Task ${task.id} hit the attempt cap (${CREW_TASK_ATTEMPT_CAP} claims). ` +
        `Stop retrying: report what failed each time to the orchestrator and ` +
        `let a human or a different approach take it.`,
    };
  }

  const now = Date.now();
  task.status = "claimed";
  task.owner = String(input.threadId);
  task.attempts = attempts.concat({ threadId: String(input.threadId), at: now });
  task.updatedAt = now;
  store.setCrewTasks(rootThreadId, list);
  store.save();
  // The attempts BEFORE this claim are what a reflection is owed for.
  return { rootThreadId, task: { ...task }, attempts };
}

/**
 * Complete a claimed task and report which tasks that unblocked. `note` is
 * the hand-off: a summary, or a `branch:path` ref a peer reads with
 * `git show` (worktrees share one object store, so no push is needed).
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, taskId: string, note?: unknown }} input
 * @returns {{ rootThreadId: string, task: object, unblocked: Array<object> }}
 */
function completeCrewTask(store, input) {
  const thread = store.getThread(input.threadId);
  if (!thread) throw new Error(`Unknown thread: ${input.threadId}`);
  const rootThreadId = crewRootOf(store, input.threadId);
  const list = store.getCrewTasks(rootThreadId);
  const byId = taskIndex(list);
  const task = byId.get(String(input.taskId));
  if (!task) throw new Error(`Unknown task: ${input.taskId}`);
  if (task.status === "done") {
    throw new Error(`Task ${task.id} is already done`);
  }
  // The root orchestrator may close anything; a worker only what it holds.
  const isRoot = String(input.threadId) === rootThreadId;
  if (!isRoot && task.owner && task.owner !== String(input.threadId)) {
    throw new Error(
      `Task ${task.id} is claimed by thread ${task.owner}, not by you. ` +
        `Claim it first, or pick another task.`,
    );
  }

  const before = new Set(
    list.filter((t) => t.status === "open" && !isBlocked(t, byId)).map((t) => t.id),
  );
  const now = Date.now();
  task.status = "done";
  task.owner = null;
  task.note = String(input.note ?? "").trim().slice(0, CREW_TASK_NOTE_MAX);
  task.updatedAt = now;

  const after = taskIndex(list);
  const unblocked = list.filter(
    (t) => t.status === "open" && !isBlocked(t, after) && !before.has(t.id),
  );

  store.setCrewTasks(rootThreadId, list);
  store.save();
  return {
    rootThreadId,
    task: { ...task },
    unblocked: unblocked.map((t) => ({ ...t })),
  };
}

/**
 * Give a claimed task back (a worker that gave up, or a failed run). Records
 * the outcome on the attempt so the next claimer sees what already failed.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, taskId?: string | null, outcome?: unknown }} input
 * @returns {Array<object>} the tasks released
 */
function releaseCrewTasks(store, input) {
  const rootThreadId = crewRootOf(store, input.threadId);
  const list = store.getCrewTasks(rootThreadId);
  const owner = String(input.threadId);
  const wanted = input.taskId == null ? null : String(input.taskId);
  const outcome = String(input.outcome ?? "").trim().slice(0, CREW_TASK_NOTE_MAX);
  const released = [];
  for (const task of list) {
    if (task.status !== "claimed" || task.owner !== owner) continue;
    if (wanted != null && task.id !== wanted) continue;
    task.status = "open";
    task.owner = null;
    task.updatedAt = Date.now();
    const attempts = Array.isArray(task.attempts) ? task.attempts : [];
    const last = attempts[attempts.length - 1];
    if (last && last.threadId === owner && outcome) last.outcome = outcome;
    released.push({ ...task });
  }
  if (released.length === 0) return [];
  store.setCrewTasks(rootThreadId, list);
  store.save();
  return released;
}

/**
 * Standing note appended to every dispatched prompt of a thread that holds a
 * crew task (CLI-only, never stored in the transcript). Two jobs:
 *
 * 1. tell the agent what it is holding, so a resumed / compacted session does
 *    not forget its claim;
 * 2. the loop guardrail (issue #277) — when the task was attempted before, or
 *    the thread's last run failed, force the "what failed / am I repeating
 *    myself" reflection BEFORE the retry rather than after the third one.
 *
 * Returns "" when there is nothing to say, same rule as planboardNoteFor /
 * hypothesisNoteFor / specNoteFor.
 *
 * @param {import('./store').Store} store
 * @param {{ id?: string, lastError?: string | null } | null | undefined} thread
 * @returns {string}
 */
function crewTaskNoteFor(store, thread) {
  if (!thread || !thread.id) return "";
  let held;
  try {
    const { tasks } = listCrewTasks(store, { threadId: thread.id });
    held = tasks.filter((t) => t.status === "claimed" && t.owner === thread.id);
  } catch {
    return "";
  }
  if (held.length === 0) return "";
  const lines = held.map((t) => {
    const needs = t.needs.length ? ` (needed ${t.needs.join(", ")})` : "";
    return `- ${t.id}: ${t.title}${needs}`;
  });
  let note =
    "\n\n[Crew task] You hold these tasks from the shared list. " +
    "Call task_complete with a note (a summary, or a `branch:path` another " +
    "worker can read with git show) the moment one lands.\n" +
    lines.join("\n");

  // Prior attempts on a held task, plus this thread's own last failure, are
  // exactly the "am I repeating myself" evidence.
  const priorLines = [];
  for (const t of held) {
    const attempts = Array.isArray(t.attempts) ? t.attempts : [];
    // The current claim is the last attempt; everything before it is history.
    for (const a of attempts.slice(0, -1)) {
      priorLines.push(
        `- ${t.id} was already attempted by thread ${a.threadId}` +
          (a.outcome ? `: ${a.outcome}` : " (no outcome recorded)"),
      );
    }
  }
  const lastError = thread.lastError ? String(thread.lastError).trim() : "";
  if (lastError) priorLines.push(`- your own last run failed: ${lastError}`);
  if (priorLines.length > 0) {
    note +=
      "\n\n[Reflect first] This is a retry, not a fresh start:\n" +
      priorLines.join("\n") +
      "\nBefore you touch anything, say in one or two lines WHAT FAILED and " +
      "whether you are about to repeat it. If the answer is yes, change " +
      "approach or hand the task back with task_release. Record the verdict " +
      `with hypothesis_record. A task is refused after ${CREW_TASK_ATTEMPT_CAP} ` +
      "claims, so this is a limited budget.";
  }
  return note;
}

/* --------------------------------------------------------------- spec mode */

/** The three gated artifacts, in approval order (issue #269). */
const SPEC_ARTIFACTS = ["requirements", "design", "tasks"];
/** Spec folder inside the worktree, so artifacts review and diff like code. */
const SPEC_DIR = ".solenta/specs";

/** What the agent must produce at each stage. */
const SPEC_GOAL = {
  requirements:
    "requirements.md — numbered acceptance criteria, each one testable " +
    '("WHEN <trigger> THE SYSTEM SHALL <behavior>"), plus what is out of scope',
  design:
    "design.md — the technical approach: files touched, data shapes, and " +
    "the alternatives you rejected and why",
  tasks:
    "tasks.md — an ordered checkbox list of implementation tasks, each " +
    "naming the files it touches and the requirement numbers it satisfies. " +
    "Independent tasks may run in parallel; express a dependency as " +
    "`needs: <id>` on the same line (ids are a leading `1.` / `T1:` or " +
    "1-based order)",
};

/** The stage after `stage`, or null when `stage` is unknown / already build. */
function nextSpecStage(stage) {
  const i = SPEC_ARTIFACTS.indexOf(stage);
  if (i < 0) return null;
  return SPEC_ARTIFACTS[i + 1] || "build";
}

/**
 * Absolute path of one artifact. `cwd` is the thread's worktree (or the
 * project path when it has none) — the same folder the CLI runs in.
 * @param {{ spec?: { slug?: string } } | null | undefined} thread
 * @param {string} cwd
 * @param {string} stage
 */
function specArtifactPath(thread, cwd, stage) {
  const slug = (thread && thread.spec && thread.spec.slug) || "spec";
  return path.join(String(cwd || ""), SPEC_DIR, slug, `${stage}.md`);
}

/**
 * Turn spec mode on: the thread starts at requirements with nothing submitted.
 * Idempotent — a thread already in spec mode is returned untouched, so a
 * second click cannot rewind an approved stage. Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function startSpec(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.spec) return { ...thread };
  const { slugify } = require("./worktrees.js");
  const spec = {
    slug: slugify(thread.title),
    stage: "requirements",
    awaitingApproval: false,
  };
  /** @type {{ spec: object, ask?: boolean }} */
  const specPatch = { spec };
  if (thread.ask === true) specPatch.ask = false;
  const updated = store.updateThread(threadId, specPatch);
  store.save();
  return updated ? { ...updated } : { ...thread, spec };
}

/**
 * Turn spec mode off (issue #500): drop thread.spec so the thread is a
 * normal thread again. Artifacts on disk are left alone. Idempotent —
 * a thread that is not in spec mode is returned untouched. Never bumps
 * updatedAt. Does not start or stop a run.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function stopSpec(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.spec) return { ...thread };
  const updated = store.updateThread(threadId, { spec: undefined });
  if (updated) delete updated.spec;
  store.save();
  const next = { ...(updated || thread) };
  delete next.spec;
  return next;
}

/**
 * The agent has written the current stage's artifact and wants a human.
 * Flips the gate; the run itself stops on the agent's side. Called by the
 * coder-threads MCP tool `spec_submit`, never inferred from the transcript.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{ stage: string, awaitingApproval: true }}
 */
function submitSpec(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.spec) {
    throw new Error("Thread is not in spec mode");
  }
  if (thread.spec.stage === "build") {
    throw new Error("Spec is already approved; nothing left to submit");
  }
  const spec = { ...thread.spec, awaitingApproval: true };
  store.updateThread(threadId, { spec });
  store.save();
  return { stage: spec.stage, awaitingApproval: true };
}

/** The prompt that opens a stage (or re-opens it after a revise). */
function specStagePrompt(stage, feedback) {
  const note = String(feedback || "").trim();
  if (stage === "build") {
    return (
      "tasks.md is approved. Independent tasks dispatch as parallel workers " +
      "from the spec card (Dispatch). Stay on this thread as the " +
      "orchestrator — do not implement the checklist yourself unless asked. " +
      "Converge compares the repo to the spec and appends any missing " +
      "tasks to tasks.md."
    );
  }
  const goal = SPEC_GOAL[stage] || stage;
  if (note) {
    return (
      `Not approved yet. The human's feedback on ${stage}.md:\n\n${note}\n\n` +
      "Update the artifact accordingly, then call spec_submit and stop."
    );
  }
  return (
    `Write ${goal}. Then call spec_submit and stop — a human approves this ` +
    "stage before the next one opens."
  );
}

/**
 * Answer the stage gate (issue #269). Approve advances one stage; revise
 * keeps it and hands the feedback back. Returns the updated thread plus the
 * prompt the caller must dispatch — services never start runs itself.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, decision: "approve" | "revise", feedback?: string }} input
 * @returns {{ thread: object, prompt: string }}
 */
function reviewSpec(store, input) {
  const { threadId, decision, feedback } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.spec) {
    throw new Error("Thread is not in spec mode");
  }
  if (!thread.spec.awaitingApproval) {
    throw new Error("No spec artifact is awaiting approval");
  }
  if (decision !== "approve" && decision !== "revise") {
    throw new Error(`Invalid spec decision: ${decision}`);
  }
  const stage =
    decision === "approve"
      ? nextSpecStage(thread.spec.stage) || "build"
      : thread.spec.stage;
  const spec = { ...thread.spec, stage, awaitingApproval: false };
  const updated = store.updateThread(threadId, { spec });
  store.save();
  return {
    thread: updated ? { ...updated } : { ...thread, spec },
    prompt: specStagePrompt(stage, decision === "revise" ? feedback : ""),
  };
}

/**
 * Worktree (or project checkout) the spec artifacts live in — same folder
 * readSpecArtifact / the CLI use.
 * @param {import('./store').Store} store
 * @param {{ projectId?: string, worktreePath?: string | null }} thread
 */
function specCwd(store, thread) {
  const project =
    thread && thread.projectId != null && typeof store.getProject === "function"
      ? store.getProject(thread.projectId)
      : null;
  return (thread && thread.worktreePath) || (project && project.path) || "";
}

/**
 * @param {object} task
 * @returns {string}
 */
function specDispatchPrompt(task) {
  const id = task && task.id ? String(task.id) : "?";
  const title = task && task.title ? String(task.title) : "";
  return (
    "[Spec dispatch] You are a worker forked from a spec thread. Your task:\n\n" +
    `${id}: ${title}\n\n` +
    "Implement this task and only this task. Tick it off in tasks.md " +
    "(`- [x]`) when it lands. Then call task_complete with a short note " +
    "(a summary, or a `branch:path` another worker can read with git show) " +
    "and stop. Do not pick up another task."
  );
}

/**
 * @param {{ spec?: { slug?: string } } | null | undefined} thread
 * @param {string} cwd
 */
function specConvergePrompt(thread, cwd) {
  const req = specArtifactPath(thread, cwd, "requirements");
  const design = specArtifactPath(thread, cwd, "design");
  const tasks = specArtifactPath(thread, cwd, "tasks");
  return (
    "[Spec converge] Compare the codebase against the approved spec and " +
    "append any missing work to tasks.md.\n\n" +
    "Read:\n" +
    `- ${req}\n- ${design}\n- ${tasks}\n\n` +
    "Then inspect the repo. For each requirement or design decision that " +
    "is not already covered by a checkbox (done or open), append a new " +
    "checkbox to tasks.md using the same format:\n\n" +
    "- [ ] N. Title (`files`) — req X\n" +
    "- [ ] N. Title (`files`) — req X — needs: A, B\n\n" +
    "Do not implement anything. Do not rewrite or reorder existing tasks. " +
    "Only append. When you are done, stop — do not call spec_submit."
  );
}

/**
 * Fold a freshly parsed tasks.md into the crew list: add any checkbox the
 * crew does not already have (matched by title), then close tasks whose
 * box is already ticked. Services never start runs — the caller forks
 * workers for the current wave.
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {Array<{ id: string, title: string, needs: string[], done: boolean }>} parsed
 */
function syncSpecCrewFromParsed(store, threadId, parsed) {
  const { tasks: existing } = listCrewTasks(store, { threadId });
  const titleKey = (s) => String(s || "").trim().replace(/\s+/g, " ");
  const byTitle = new Map(existing.map((t) => [titleKey(t.title), t]));
  /** @type {Map<string, string>} */
  const sourceToCrew = new Map();
  for (const p of parsed) {
    const hit = byTitle.get(titleKey(p.title));
    if (hit) sourceToCrew.set(p.id, hit.id);
  }

  const toAdd = parsed.filter((p) => !sourceToCrew.has(p.id));
  if (toAdd.length > 0) {
    let next = 1;
    for (const t of existing) {
      const n = Number(String(t.id).replace(/^t/, ""));
      if (Number.isInteger(n) && n >= next) next = n + 1;
    }
    for (const p of toAdd) {
      sourceToCrew.set(p.id, `t${next++}`);
    }
    addCrewTasks(store, {
      threadId,
      tasks: toAdd.map((p) => ({
        title: p.title,
        needs: p.needs
          .map((n) => sourceToCrew.get(n))
          .filter(Boolean),
      })),
    });
  }

  const { tasks: after } = listCrewTasks(store, { threadId });
  const afterByTitle = new Map(after.map((t) => [titleKey(t.title), t]));
  for (const p of parsed) {
    if (!p.done) continue;
    const hit = afterByTitle.get(titleKey(p.title));
    if (hit && hit.status !== "done") {
      completeCrewTask(store, {
        threadId,
        taskId: hit.id,
        note: "already done in tasks.md",
      });
    }
  }
}

/**
 * Parse the spec thread's tasks.md, load it into the crew-task list, and
 * describe the current wave of claimable tasks. The caller (IPC) forks a
 * worker per wave entry and starts the run — services never start runs.
 *
 * Available only at the build stage (tasks.md is approved). A second click
 * does not re-add existing titles; it only forks workers for tasks that
 * are still open and unblocked.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{
 *   thread: object,
 *   path: string,
 *   tasks: Array<object>,
 *   waves: string[][],
 *   wave: Array<object>,
 *   reason?: string,
 * }}
 */
function dispatchSpec(store, input) {
  const { parseTasksMd } = require("./specTasks.js");
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.spec) {
    throw new Error("Thread is not in spec mode");
  }
  if (thread.spec.stage !== "build") {
    throw new Error("Dispatch is available after tasks.md is approved");
  }

  const cwd = specCwd(store, thread);
  const file = specArtifactPath(thread, cwd, "tasks");
  let text = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = null;
  }
  if (text == null) {
    throw new Error(`tasks.md is not written yet (${file})`);
  }

  const parsed = parseTasksMd(text);
  if (parsed.errors.length > 0) {
    throw new Error(`tasks.md is not a valid DAG: ${parsed.errors.join("; ")}`);
  }
  if (parsed.tasks.length === 0) {
    throw new Error("tasks.md has no checkbox tasks");
  }

  syncSpecCrewFromParsed(store, threadId, parsed.tasks);
  const { tasks } = listCrewTasks(store, { threadId });
  const wave = tasks.filter((t) => t.status === "open" && !t.blocked);
  const reason =
    wave.length === 0
      ? tasks.some((t) => t.status === "open")
        ? "No claimable tasks: remaining work is still blocked on dependencies."
        : "No open tasks left."
      : undefined;
  return {
    thread: { ...thread },
    path: file,
    tasks,
    waves: parsed.waves,
    wave,
    reason,
  };
}

/**
 * Fork one orchWorker per claimable wave task, claim it, and return the
 * prompts the caller must dispatch. Does not start runs.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, wave: Array<{ id: string, title?: string }> }} input
 * @param {(store: any, input: any) => any} [forkImpl]
 * @returns {Array<{ thread: object, task: object, prompt: string }>}
 */
function forkSpecWave(store, input, forkImpl) {
  const threadId = input && input.threadId;
  const wave = Array.isArray(input && input.wave) ? input.wave : [];
  const dispatched = [];
  for (const task of wave) {
    const worker = forkWorkerThread(
      store,
      { threadId },
      forkImpl || forkThread,
    );
    const claimed = claimCrewTask(store, {
      threadId: worker.id,
      taskId: task.id,
    });
    if (!claimed.task) continue;
    const title = String(task.title || claimed.task.title || "")
      .trim()
      .slice(0, THREAD_TITLE_MAX);
    if (title) store.updateThread(worker.id, { title });
    const fresh = store.getThread(worker.id) || worker;
    dispatched.push({
      thread: { ...fresh, ...(title ? { title } : {}) },
      task: claimed.task,
      prompt: specDispatchPrompt(claimed.task),
    });
  }
  if (dispatched.length > 0) store.save();
  return dispatched;
}

/**
 * Start a converge pass: the spec thread reads the three artifacts plus
 * the repo and appends missing checkboxes to tasks.md. Available only at
 * build. Services never start the run — the caller dispatches the prompt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{ thread: object, prompt: string }}
 */
function convergeSpec(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.spec) {
    throw new Error("Thread is not in spec mode");
  }
  if (thread.spec.stage !== "build") {
    throw new Error("Converge is available after tasks.md is approved");
  }
  const cwd = specCwd(store, thread);
  return {
    thread: { ...thread },
    prompt: specConvergePrompt(thread, cwd),
  };
}

/**
 * Standing note appended to every dispatched prompt while a spec thread is
 * still behind the gate. Same rule as planboardNoteFor / hypothesisNoteFor:
 * returns "" when there is nothing to say (no spec, or stage build).
 *
 * ponytail: the gate is procedural — the note plus the human's Approve click.
 * Nothing stops a determined agent editing source early; add a can_use_tool
 * deny in runner.js if that turns out to happen in practice.
 *
 * @param {{ spec?: { slug?: string, stage?: string, awaitingApproval?: boolean } } | null | undefined} thread
 * @param {string} cwd Worktree (or project) folder the CLI runs in.
 * @returns {string}
 */
function specNoteFor(thread, cwd) {
  const spec = thread && thread.spec;
  if (!spec || !spec.stage || spec.stage === "build") return "";
  const file = specArtifactPath(thread, cwd, spec.stage);
  return (
    `\n\n[Spec mode] This thread is spec-driven: ${SPEC_ARTIFACTS.join(" → ")} ` +
    "are written and approved one at a time before any code changes. " +
    `Current stage: ${spec.stage}. Write ${file} and change NO other file. ` +
    "When it is ready call the coder-threads tool spec_submit and stop — " +
    "a human approves each stage."
  );
}

/* --------------------------------------------------------------- teach mode */

/** Passed-review counts that promote autonomy (issue #373). Mirror src/shared/ipc.ts. */
const TEACH_REVIEW_THRESHOLDS = { review: 3, pair: 8 };

/** What the standing note says at each autonomy rung. */
const TEACH_AUTONOMY_COPY = {
  hint:
    "leave TODO(human) for every interesting piece of logic; scaffold only",
  review:
    "you may fill more scaffolding; still leave the core logic as TODO(human)",
  pair:
    "you may implement more of the glue, still explain, and leave at least " +
    "one meaningful TODO(human) per turn unless the human asked for the solution",
};

const TEACH_REVIEW_PROMPT =
  "The human filled the TODO(human) markers. Review their code now. " +
  "Praise what is right, point at what is wrong, and do not rewrite the " +
  "solution unless they asked. Then call the coder-threads tool teach_review " +
  "with passed true or false and a short note.";

/** Passed-review count → autonomy rung. */
function teachAutonomyFor(reviewsPassed) {
  const n = Number(reviewsPassed) || 0;
  if (n >= TEACH_REVIEW_THRESHOLDS.pair) return "pair";
  if (n >= TEACH_REVIEW_THRESHOLDS.review) return "review";
  return "hint";
}

/**
 * Permission modes allowed at this autonomy rung.
 * hint: ask / plan. review: + accept edits. pair: full access too.
 * @param {string} autonomy
 * @returns {string[]}
 */
function teachAllowedModes(autonomy) {
  if (autonomy === "pair") {
    return ["default", "acceptEdits", "plan", "bypassPermissions"];
  }
  if (autonomy === "review") return ["default", "acceptEdits", "plan"];
  return ["default", "plan"];
}

/**
 * @param {string} mode
 * @param {{ autonomy?: string } | null | undefined} teach
 */
function teachPermissionAllowed(mode, teach) {
  if (!teach || !teach.autonomy) return true;
  return teachAllowedModes(teach.autonomy).includes(String(mode));
}

/**
 * Nearest mode this provider actually honours, still inside the teach cap.
 * Prefer default then plan so claude Full access still drops to Ask first.
 * Empty intersection (kimi at hint) keeps the honoured mode rather than
 * storing Ask first, which the CLI cannot send (issue #177).
 *
 * @param {object | null | undefined} entry
 * @param {string | null | undefined} mode
 * @param {{ autonomy?: string } | null | undefined} teach
 */
function snapPermissionModeForThread(entry, mode, teach) {
  const snapped = snapPermissionMode(entry, mode);
  if (teachPermissionAllowed(snapped, teach)) return snapped;
  const teachOk = honouredPermissionModes(entry).filter((m) =>
    teachPermissionAllowed(m, teach),
  );
  for (const preferred of [
    "default",
    "plan",
    "acceptEdits",
    "bypassPermissions",
  ]) {
    if (teachOk.includes(preferred)) return preferred;
  }
  return snapped;
}

/**
 * Standing note appended to every dispatched prompt while Teach mode is on.
 * Same rule as specNoteFor: returns "" when there is nothing to say.
 *
 * @param {{ teach?: { autonomy?: string, reviewsPassed?: number } | null } | null | undefined} thread
 * @returns {string}
 */
function teachNoteFor(thread) {
  const teach = thread && thread.teach;
  if (!teach || !teach.autonomy) return "";
  const reviewsPassed = Number(teach.reviewsPassed) || 0;
  const level = teachAutonomyFor(reviewsPassed);
  const how = TEACH_AUTONOMY_COPY[level] || TEACH_AUTONOMY_COPY.hint;
  return (
    "\n\n[Teach mode] You are a teacher, not a solution engine. " +
    "Socratic: ask questions and give hints; do not dump a complete implementation. " +
    "Scaffold structure and types, then leave TODO(human) markers on the " +
    "interesting logic for the human to write. After they fill a marker, review " +
    "their code: say what is right, point at what is wrong, and do not rewrite " +
    "it unless they explicitly ask for the answer. Never replace a TODO(human) " +
    "with the solution on your own. " +
    `Autonomy: ${level} (${how}). ` +
    "When you have reviewed a fill, call the coder-threads tool teach_review " +
    "with passed true or false."
  );
}

/**
 * Turn Teach mode on at the hint rung. Idempotent. Downgrades permission
 * mode when the current one is above the hint cap. Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function startTeach(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.teach && thread.teach.autonomy) return { ...thread };
  const teach = { autonomy: "hint", reviewsPassed: 0 };
  /** @type {{ teach: { autonomy: string, reviewsPassed: number }, permissionMode?: string, ask?: boolean }} */
  const patch = { teach };
  if (thread.ask === true) patch.ask = false;
  // Always snap: leftover grok/cursor Ask first is teach-allowed as a label
  // but the CLI cannot send it, so it would keep remapping to Full access.
  patch.permissionMode = snapPermissionModeForThread(
    getProvider(thread.provider),
    thread.permissionMode,
    teach,
  );
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Turn Teach mode off. Leaves permission mode where it is. Idempotent.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function stopTeach(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.teach) return { ...thread };
  const updated = store.updateThread(threadId, { teach: null });
  store.save();
  return updated ? { ...updated } : { ...thread, teach: null };
}

/**
 * Standing note while Ask mode is on. Delegates to electron/ask.js so the
 * wording lives next to the completion prompt (issue #392).
 *
 * @param {{ ask?: boolean } | null | undefined} thread
 * @returns {string}
 */
function askNoteFor(thread) {
  return require("./ask.js").askNoteFor(thread);
}

/**
 * Turn Ask mode on (issue #392). Idempotent. Clears teach (the personas
 * conflict), drops pendingWorktree so the first send cannot materialize
 * one, and leaves an already-created worktree on disk unused. Never bumps
 * updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function startAsk(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.ask === true && !thread.pendingWorktree && !thread.teach) {
    return { ...thread };
  }
  /** @type {{ ask: boolean, pendingWorktree?: boolean, teach?: null }} */
  const patch = { ask: true };
  if (thread.pendingWorktree) patch.pendingWorktree = false;
  if (thread.teach) patch.teach = null;
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Turn Ask mode off. With `worktree: true` (Start work + defaultWorktree)
 * the thread becomes a regular isolated thread: pendingWorktree is armed
 * only when the project can host one and none exists yet. Idempotent.
 * Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, worktree?: boolean }} input
 */
function stopAsk(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.ask !== true && !input?.worktree) return { ...thread };
  /** @type {{ ask: boolean, pendingWorktree?: boolean }} */
  const patch = { ask: false };
  if (
    input &&
    input.worktree === true &&
    !thread.worktreePath &&
    !thread.pendingWorktree
  ) {
    const project = store.getProject(thread.projectId);
    if (canHostWorktree(project)) patch.pendingWorktree = true;
  }
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Record a review of the human's TODO(human) fill. A pass increments
 * reviewsPassed and may promote autonomy. Called by the coder-threads
 * MCP tool `teach_review`, never inferred from the transcript.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, passed?: boolean, note?: string }} input
 * @returns {{ reviewsPassed: number, autonomy: string, promoted: boolean, passed: boolean }}
 */
function recordTeachReview(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.teach || !thread.teach.autonomy) {
    throw new Error("Thread is not in teach mode");
  }
  const passed = input && input.passed === true;
  const prev = Number(thread.teach.reviewsPassed) || 0;
  const reviewsPassed = passed ? prev + 1 : prev;
  const autonomy = teachAutonomyFor(reviewsPassed);
  const promoted = autonomy !== thread.teach.autonomy;
  const teach = { autonomy, reviewsPassed };
  store.updateThread(threadId, { teach });
  store.save();
  return { reviewsPassed, autonomy, promoted, passed };
}

/**
 * The prompt that asks the agent to review the human's fills.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{ thread: object, prompt: string }}
 */
function requestTeachReview(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.teach || !thread.teach.autonomy) {
    throw new Error("Thread is not in teach mode");
  }
  return { thread: { ...thread }, prompt: TEACH_REVIEW_PROMPT };
}

/** Whole-note cap so a 400K-LOC repo yields the same size prompt as a small one. */
const CODEINDEX_NOTE_MAX = 3500;

/** Symbols listed per file before "+N more". */
const CODEINDEX_SYMBOLS_PER_FILE = 8;

/**
 * Standing note appended to every dispatched prompt (CLI-only, never stored
 * in the transcript) with the shared per-repo symbol map. Agents reach for
 * grep first (CodeScaleBench: 7,993 keyword vs 57 deep-search), so the
 * value is injecting the map plus when-to-use-which-tool, not adding a tool.
 *
 * Returns "" when there is nothing to say: no index, a tiny repo, or
 * CODER_CODEINDEX_DISABLE=1. Same rule as planboardNoteFor / selfIdNoteFor.
 *
 * @param {import('./codeindex.js').CodeIndex | null | undefined} index
 * @returns {string}
 */
function codeIndexNoteFor(index) {
  if (!index) return "";
  if (process.env.CODER_CODEINDEX_DISABLE === "1") return "";
  const { MIN_FILES_FOR_NOTE } = require("./codeindex.js");
  if (index.fileCount < MIN_FILES_FOR_NOTE) return "";

  const age = ageOf(index.updatedAt);
  const header =
    `\n\n[Code map] Shared symbol index of this repo: ${index.fileCount} files, ` +
    `${index.symbolCount} symbols, built ${age}. It maps the project's MAIN ` +
    `checkout and is shared by every thread and worktree, so files created ` +
    `on a branch may be missing.`;
  const steering =
    "Use the map to jump straight to the file that owns a symbol instead of " +
    "grepping to orient yourself. Grep is still right for literal strings, " +
    "call sites, and anything not listed. Read the file before editing it.";

  const parts = [header];
  const files = Array.isArray(index.files) ? index.files : [];
  for (const file of files) {
    if (!file || !file.path) continue;
    // A path with no extracted symbols says nothing the agent can act on, and
    // the note's char budget is the scarce thing here.
    if (!Array.isArray(file.symbols) || file.symbols.length === 0) continue;
    const line = formatIndexFileLine(file);
    const candidate = parts.concat(line, steering).join("\n");
    if (candidate.length > CODEINDEX_NOTE_MAX) break;
    parts.push(line);
  }
  parts.push(steering);
  return parts.join("\n");
}

/**
 * @param {unknown} updatedAt
 * @returns {string}
 */
function ageOf(updatedAt) {
  const ms = Date.now() - Number(updatedAt);
  if (!Number.isFinite(ms) || ms < 45_000) return "just now";
  const min = Math.round(ms / 60_000);
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return hr === 1 ? "1 hour ago" : `${hr} hours ago`;
  const day = Math.round(hr / 24);
  return day === 1 ? "1 day ago" : `${day} days ago`;
}

/**
 * @param {{ path?: string, symbols?: string[] }} file
 * @returns {string}
 */
function formatIndexFileLine(file) {
  const symbols = Array.isArray(file.symbols) ? file.symbols : [];
  const shown = symbols.slice(0, CODEINDEX_SYMBOLS_PER_FILE);
  const extra = symbols.length - shown.length;
  let names = shown.join(", ");
  if (extra > 0) names = names ? `${names}, +${extra} more` : `+${extra} more`;
  return names ? `${file.path} - ${names}` : String(file.path);
}

/**
 * Read one artifact off disk for the UI. `text` is null when the agent has
 * not written it yet; the path is returned either way so the card can say
 * where it will land.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, stage: string }} input
 * @returns {{ path: string, text: string | null }}
 */
function readSpecArtifact(store, input) {
  const { threadId, stage } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!SPEC_ARTIFACTS.includes(stage)) {
    throw new Error(`Invalid spec stage: ${stage}`);
  }
  const project = store.getProject(thread.projectId);
  const cwd = thread.worktreePath || (project && project.path) || "";
  const file = specArtifactPath(thread, cwd, stage);
  let text = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = null;
  }
  return { path: file, text };
}

/**
 * Set or clear the thread's verification command (issue #296). A non-empty
 * command arms the gate; empty / null / whitespace disarms it. Trimmed and
 * capped by normalizeCommand. Never bumps updatedAt: a setting is not
 * activity, same rule as setNotes / setPinned.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, command: unknown }} input
 */
function setVerifyCommand(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const verifyCommand = normalizeCommand(input.command);
  const updated = store.updateThread(threadId, { verifyCommand });
  store.save();
  return updated ? { ...updated } : { ...thread, verifyCommand };
}

/**
 * Run the thread's verify command now and persist the evidence (issue #296).
 * Manual counterpart to the runner's automatic gate. Rejects when no
 * command is set or a run is already active.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @param {{ runner: { isRunning: (id: string) => boolean } }} deps
 * @returns {Promise<import('../src/shared/ipc').VerifyResult>}
 */
async function runVerifyNow(store, input, deps) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.verifyCommand == null) {
    throw new Error("No verify command set for this thread");
  }
  if (deps.runner.isRunning(threadId)) {
    throw new Error("A run is already active on this thread");
  }

  const project = store.getProject(thread.projectId);
  const cwd = thread.worktreePath || (project && project.path) || process.cwd();
  const prepared = prepareVerifyRun({
    command: thread.verifyCommand,
    cwd,
    project,
  });
  const ran = await runVerifyCommand({
    command: prepared.command,
    cwd,
    project,
    env: prepared.env,
  });
  if (prepared.reason && ran && ran.log != null) {
    ran.log = `[verify] ${prepared.reason}\n${ran.log}`;
  }

  // Worktree HEAD only; a project checkout is not a checkpoint. Best-effort:
  // a git failure yields null and never throws.
  let sha = null;
  if (thread.worktreePath) {
    try {
      const { gitTryAsync } = require("./worktrees.js");
      const rev = await gitTryAsync(thread.worktreePath, ["rev-parse", "HEAD"]);
      if (rev.ok && rev.stdout) {
        const trimmed = String(rev.stdout).trim();
        sha = trimmed || null;
      }
    } catch {
      sha = null;
    }
  }

  /** @type {import('../src/shared/ipc').VerifyResult} */
  const result = {
    runId: "manual",
    command: prepared.command,
    ok: ran.ok,
    exitCode: ran.exitCode,
    timedOut: ran.timedOut,
    log: ran.log,
    sha,
    durationMs: ran.durationMs,
    at: Date.now(),
    attempt: (thread.verify?.attempt ?? 0) + 1,
  };
  store.updateThread(threadId, { verify: result });
  store.save();
  return result;
}

/**
 * Rename a thread. Metadata only: never bumps updatedAt (issue #139), so
 * the sidebar sort is unchanged.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, title: string }} input
 */
function renameThread(store, input) {
  const { threadId, title: raw } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new Error("Thread title cannot be empty");
  }
  const title = truncateThreadTitle(trimmed);
  const updated = store.updateThread(threadId, { title });
  store.save();
  return updated ? { ...updated } : { ...thread, title };
}

/**
 * Edit-and-resubmit (issue #254): truncate the thread to just before a past
 * USER message so the renderer can re-send an edited prompt via runs.start.
 * Starts no run. Usage / spend is never rewritten.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, messageId: string, prompt: string, restoreFiles?: boolean }} input
 * @param {{ isRunning?: (threadId: string) => boolean }} [opts]
 * @returns {Promise<{ thread: object, droppedMessages: number, restoredSha: string | null }>}
 */
async function rewindThread(store, input, opts) {
  const threadId = input && input.threadId;
  const messageId = input && input.messageId;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (
    (opts && typeof opts.isRunning === "function" && opts.isRunning(threadId)) ||
    thread.status === "working"
  ) {
    throw new Error("Cannot rewind while a run is active");
  }
  if (!String((input && input.prompt) ?? "").trim()) {
    throw new Error("Prompt cannot be empty");
  }

  const msgs = store.getMessages(threadId);
  const at = msgs.findIndex((m) => m && m.id === messageId);
  if (at < 0) {
    throw new Error(`Unknown message: ${messageId}`);
  }
  if (msgs[at].role !== "user") {
    throw new Error(`Not a user message: ${messageId}`);
  }

  // Capture before truncate: restoreFiles picks the newest checkpoint at or
  // before this message, not "turn N" (clean turns skip a number).
  const targetAt = Number(msgs[at].createdAt);

  const droppedMessages = store.truncateFromMessage(threadId, messageId);
  const updated = store.updateThread(threadId, {
    sessionId: null,
    replayContext: true,
  });

  let restoredSha = null;
  if (input.restoreFiles && thread.worktreePath) {
    const { listCheckpoints, restoreCheckpoint } = require("./worktrees.js");
    const list = await listCheckpoints({ store, threadId });
    // Newest-first. Newest checkpoint whose commit time is at or before the
    // edited message is the files just before the user sent it.
    // ponytail: git %ct is 1s granularity, so a checkpoint written in the
    // same second the message was sent could sort on the wrong side of the
    // boundary. A real turn takes seconds; worst case is restoring one turn
    // later than intended.
    const match = Number.isFinite(targetAt)
      ? list.find((c) => c.at <= targetAt)
      : null;
    if (match) {
      await restoreCheckpoint({
        store,
        threadId,
        sha: match.sha,
        isRunning: opts && opts.isRunning,
      });
      restoredSha = match.sha;
    }
  }

  // Worktree reset is already on disk. Debounced save() would leave a crash
  // in the 250ms window with files rewound and the old transcript resurrected.
  store.saveNow();
  const next = updated || store.getThread(threadId) || thread;
  return { thread: { ...next }, droppedMessages, restoredSha };
}

/**
 * deleteThread's worktree guard. Renderer and Git tab copy depend on this
 * exact wording. removeProject no longer shares it — it reclaims worktrees
 * instead of refusing.
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
  void scheduleImagePruneFromStore(store);
}

/**
 * Remove the project ENTRY and delete its threads' conversation history
 * (t3-style). The repository on disk is never touched — no fs calls on the
 * project path. Active-run copy is project-scoped. The guard runs before any
 * deletion so a reject cannot leave a half-removed project.
 *
 * Worktrees are reclaimed here rather than blocking the removal: refusing on
 * any attached worktree made removal impossible in practice (every real
 * project accumulates archived threads that still carry a worktreePath, plus
 * stale paths whose directory is long gone). Reclaim uses the GC primitive,
 * so BRANCHES ARE NEVER DELETED and a tree with uncommitted work fails the
 * non-force `worktree remove` and is left on disk for the GC panel instead of
 * being force-deleted under the user.
 * @param {import('./store').Store} store
 * @param {{ projectId: string }} input
 * @param {{ isRunning?: (threadId: string) => boolean }} [opts]
 */
async function removeProject(store, input, opts) {
  const projectId =
    input && input.projectId != null ? String(input.projectId) : "";
  const project = store.getProject(projectId);
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  const threads = store
    .getThreads()
    .filter((t) => t && t.projectId === projectId);

  // Guard first — every thread — before any purge.
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

  const { removeGcWorktree } = require("./worktrees.js");
  for (const thread of threads) {
    if (!thread.worktreePath) continue;
    const res = await removeGcWorktree(store, {
      path: thread.worktreePath,
      threadId: thread.id,
    });
    if (!res.ok) {
      // Dirty or wedged tree: keep it on disk (nothing is lost) and carry on
      // with the removal the user just confirmed.
      console.warn(
        `removeProject: left ${thread.worktreePath} in place: ${res.error}`,
      );
    }
  }

  for (const thread of threads) {
    purgeThread(store, thread.id);
  }
  store.setProjects(store.getProjects().filter((p) => p.id !== projectId));
  store.save();
  void scheduleImagePruneFromStore(store);
}

/**
 * @param {import('./store').Store} store
 */
/**
 * Attach the computed sandbox badge. Always a new object so a store row
 * never grows a persisted `sandbox` field.
 * @param {import('./store').Store} store
 * @param {object} thread
 */
function decorateThread(store, thread) {
  if (!thread) return thread;
  const project = store.getProject(thread.projectId);
  return {
    ...thread,
    sandbox: resolveSandbox({
      provider: thread.provider,
      permissionMode: thread.permissionMode,
      project,
    }),
  };
}

/**
 * listThreads cache, keyed per store (WeakMap so a discarded store — tests
 * create plenty — never leaks). See listThreads for the invariants.
 * @type {WeakMap<import('./store').Store, { threads: object[], projects: object[], value: object[], rows: Map<object, object> }>}
 */
const listThreadsCache = new WeakMap();

function listThreads(store) {
  const threads = store.getThreads();
  const projects = store.getProjects();
  // pushThreadsChanged fires on every work-log step during a run, but
  // work-log appends never touch the threads/projects arrays — both are
  // replaced (never mutated in place) on any real change. Key the cache on
  // those identities so no-op ticks skip the whole decorate+serialize, and
  // reuse decorated rows keyed on the thread object so an updateThread that
  // only patched one row skips re-decorating the rest. Row identity does
  // not survive IPC; the renderer restores it in reconcileThreadList.
  const cache = listThreadsCache.get(store);
  if (cache && cache.threads === threads && cache.projects === projects) {
    return cache.value;
  }
  const prevRows = cache ? cache.rows : null;
  /** @type {Map<object, object>} */
  const rows = new Map();
  const value = threads.map((t) => {
    const prev = prevRows && prevRows.get(t);
    if (prev) {
      rows.set(t, prev);
      return prev;
    }
    const decorated = decorateThread(store, t);
    rows.set(t, decorated);
    return decorated;
  });
  listThreadsCache.set(store, { threads, projects, value, rows });
  return value;
}

/**
 * Per-thread summaries for the Agents tab team view (threads:summaries).
 * lastActivity is the first line of the thread's last assistant message
 * (null when the thread has none). Cheap: reads the store only.
 * @param {import('./store').Store} store
 */
function threadSummaries(store) {
  return store.getThreads().map((t) => {
    const last = store.getLastAssistantMessage(t.id);
    return {
      id: t.id,
      title: t.title,
      provider: t.provider,
      status: t.status,
      handoffFrom: t.handoffFrom ?? null,
      runStartedAt: t.runStartedAt ?? null,
      awaitingInput: t.awaitingInput === true,
      stalledAt: t.stalledAt ?? null,
      lastActivity: last
        ? {
            text: String(last.text).split(/\r?\n/, 1)[0].trim(),
            at: Number(last.createdAt) || t.updatedAt,
          }
        : null,
    };
  });
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
 * lastVisitedAt = Date.now() WITHOUT bumping updatedAt (visiting is not
 * activity; bumping would re-unread the thread and re-sort the sidebar).
 * Do not store.save() here: a visit stamp must not schedule a whole-store
 * rewrite (#636). markDirty lets the field ride the next real flush; the
 * exit hook covers quit. Hard crash: unread-dot is a click stale.
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
    // No updatedAt bump: visiting must not re-unread or re-sort the thread.
    store.updateThread(threadId, { lastVisitedAt: Date.now() });
    store.markDirty();
  }
  const current = store.getThread(threadId) || thread;
  return {
    thread: decorateThread(store, current),
    messages: store.getMessages(threadId).slice(),
    workLog: store.getWorkLog(threadId).slice(),
    workflow: workflow ?? null,
    usage: store.getUsage(threadId) ?? null,
    // Live permission prompt (runner-ephemeral, never persisted).
    pendingPermission: (opts && opts.pendingPermission) || null,
  };
}

/**
 * @param {string | { path?: string, remoteHost?: string, remotePath?: string }} projectOrPath
 * @returns {{ isRepo: boolean, branch: string, dirty: boolean }}
 */
async function gitStatus(projectOrPath) {
  const project =
    projectOrPath && typeof projectOrPath === "object"
      ? projectOrPath
      : { path: projectOrPath };
  const resolved = project.remoteHost
    ? project.remotePath || project.path || ""
    : path.resolve(project.path || "");
  try {
    const inside = await gitOutAsync(
      resolved,
      ["rev-parse", "--is-inside-work-tree"],
      project,
    );
    if (inside !== "true") {
      return { isRepo: false, branch: "", dirty: false };
    }
  } catch {
    return { isRepo: false, branch: "", dirty: false };
  }

  let branch = "";
  try {
    branch = await gitOutAsync(resolved, ["branch", "--show-current"], project);
  } catch {
    branch = "";
  }

  let dirty = false;
  try {
    const porcelain = await gitOutAsync(resolved, ["status", "--porcelain"], project);
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
async function gitSyncInfo(cwd) {
  if (!cwd) return { hasUpstream: false };
  const resolved = path.resolve(cwd);
  try {
    const inside = await gitOutAsync(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return { hasUpstream: false };
  } catch {
    return { hasUpstream: false };
  }
  try {
    const out = await gitOutAsync(resolved, [
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
async function gitFetch(cwd) {
  const resolved = path.resolve(cwd);
  try {
    await gitOutAsync(resolved, ["fetch"], null, { timeout: GIT_NETWORK_TIMEOUT_MS });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(`git fetch failed: ${msg.split("\n")[0]}`);
  }
}

/**
 * owner/repo plus an https web URL from a git remote URL, or null.
 * Handles scp-style ssh (git@host:owner/repo), ssh:// and http(s) URLs.
 * For nested groups (gitlab group/sub/repo) the last two segments win,
 * matching slugFromRemoteUrl.
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string, webUrl: string } | null}
 */
function repoInfoFromRemote(url) {
  const cleaned = String(url || "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!cleaned) return null;

  const fromParts = (host, pathPart) => {
    const parts = String(pathPart || "")
      .split("/")
      .filter(Boolean);
    if (!host || parts.length < 2) return null;
    const owner = parts[parts.length - 2];
    const repo = parts[parts.length - 1];
    return { owner, repo, webUrl: `https://${host}/${owner}/${repo}` };
  };

  // scp-style ssh: git@host:owner/repo
  const scp = cleaned.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) return fromParts(scp[1], scp[2]);

  try {
    const u = new URL(cleaned);
    const proto = u.protocol.replace(/:$/, "").toLowerCase();
    if (proto !== "http" && proto !== "https" && proto !== "ssh") return null;
    return fromParts(u.hostname, u.pathname);
  } catch {
    return null;
  }
}

/**
 * Origin owner/repo + web URL for a checkout. Never throws: no repo, no
 * origin, or an unparseable remote all come back as { ok: false }.
 *
 * @param {string} cwd
 * @returns {{ ok: true, owner: string, repo: string, webUrl: string } | { ok: false }}
 */
async function gitRepoInfo(cwd) {
  if (!cwd) return { ok: false };
  const resolved = path.resolve(cwd);
  try {
    const inside = await gitOutAsync(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return { ok: false };
  } catch {
    return { ok: false };
  }
  let remote = "";
  try {
    remote = await gitOutAsync(resolved, ["remote", "get-url", "origin"]);
  } catch {
    return { ok: false };
  }
  const info = repoInfoFromRemote(remote);
  if (!info) return { ok: false };
  return { ok: true, ...info };
}

/**
 * Map `git pull --ff-only` stdout to a one-line UI summary.
 *
 * @param {string} output
 * @returns {string}
 */
function summarizePullOutput(output) {
  const text = String(output || "").trim();
  if (/already up[ -]to[ -]date/i.test(text)) return "Already up to date";
  if (/fast-forward/i.test(text)) return "Fast-forwarded";
  const first = text.split(/\r?\n/, 1)[0].trim();
  return first || "Already up to date";
}

/**
 * Map a failed `git pull --ff-only` error message to a short reason.
 * execFileSync folds stderr into err.message, so fixtures here are the
 * combined output.
 *
 * @param {string} message
 * @returns {string}
 */
function pullFailureReason(message) {
  const text = String(message || "");
  if (/not a git repository/i.test(text)) return "Not a git repository";
  if (/no tracking information|no upstream configured/i.test(text)) {
    return "No upstream configured for this branch";
  }
  if (/divergent branches|not possible to fast-forward/i.test(text)) {
    return "Branch has diverged from upstream";
  }
  if (/local changes|please commit your changes|uncommitted changes/i.test(text)) {
    return "Working tree has uncommitted changes";
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^command failed:/i.test(l));
  const fatal = lines.find((l) => /^(fatal|error):/i.test(l));
  return fatal || lines[0] || "Pull failed";
}

/**
 * `git pull --ff-only` in a checkout. Never throws: every failure mode
 * (dirty tree, no upstream, diverged, not a repo) comes back in-band.
 *
 * @param {string} cwd
 * @returns {{ ok: true, summary: string } | { ok: false, reason: string }}
 */
async function gitPull(cwd) {
  if (!cwd) return { ok: false, reason: "Not a git repository" };
  const resolved = path.resolve(cwd);
  try {
    const inside = await gitOutAsync(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return { ok: false, reason: "Not a git repository" };
  } catch {
    return { ok: false, reason: "Not a git repository" };
  }
  let out;
  try {
    out = await gitOutAsync(resolved, ["pull", "--ff-only"], null, {
      timeout: GIT_NETWORK_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    return { ok: false, reason: pullFailureReason(msg) };
  }
  return { ok: true, summary: summarizePullOutput(out) };
}

/**
 * List all projects, attaching a derived iconUrl (#610). The store row
 * is never mutated — iconUrl is computed from iconPath / auto-detect.
 * @param {import('./store').Store} store
 */
function listProjects(store) {
  return store.getProjects().map(presentProject);
}

function requireProject(store, projectId) {
  const project = store.getProjects().find((p) => p.id === projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return project;
}

/**
 * Native file picker for a project icon override. The chosen file must
 * sit inside the project's checkout (or the repo's main work tree).
 * @param {import('./store').Store} store
 * @param {string} projectId
 * @param {{ showOpenDialog: (opts: object) => Promise<{ canceled: boolean, filePaths?: string[] }> }} dialog
 * @returns {Promise<{ iconPath: string, iconUrl: string | null } | null>}
 */
async function pickProjectIcon(store, projectId, dialog) {
  const project = requireProject(store, projectId);
  if (!dialog || typeof dialog.showOpenDialog !== "function") {
    throw new Error("File picker is not available in this mode");
  }
  const defaultPath =
    typeof project.path === "string" && project.path ? project.path : undefined;
  const result = await dialog.showOpenDialog({
    title: "Choose a project icon",
    defaultPath,
    properties: ["openFile"],
    filters: ICON_FILTERS,
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  const chosen = result.filePaths[0];
  const scanRoot = (() => {
    try {
      return mainWorkTree(project.path);
    } catch {
      return project.path;
    }
  })();
  const rel =
    relativeIconPath(scanRoot, chosen) ||
    relativeIconPath(project.path, chosen);
  if (!rel) {
    throw new Error("Choose a file inside the project folder.");
  }
  return { iconPath: rel, iconUrl: iconDataUrlFor(project.path, rel) };
}

/**
 * Preview an icon without saving. `iconPath: null` is Automatic (ignore
 * a stored override). Omit iconPath to use whatever is stored.
 * @param {import('./store').Store} store
 * @param {string} projectId
 * @param {string | null} [iconPath]
 */
function resolveProjectIcon(store, projectId, iconPath) {
  const project = requireProject(store, projectId);
  const override =
    iconPath === undefined ? project.iconPath : iconPath;
  return { iconUrl: iconDataUrlFor(project.path, override) };
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
 * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null }}
 */
function getSettings(store) {
  return store.getSettings();
}

/**
 * Validate and persist settings. Does not touch threads.
 * @param {import('./store').Store} store
 * @param {Partial<{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null }>} patch
 * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null }}
 */
function setSettings(store, patch, opts) {
  const next = store.setSettings(patch || {}, opts);
  store.save();
  return next;
}

const AUTOMATION_PRESETS = new Set(["hourly", "daily", "weekly"]);

/**
 * @param {unknown} hour
 * @param {"hourly" | "daily" | "weekly"} preset
 * @returns {number | null}
 */
function normalizeAutomationHour(preset, hour) {
  if (preset === "hourly") return null;
  if (hour == null || hour === "") {
    throw new Error("Hour is required for daily and weekly automations");
  }
  const n = Number(hour);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    throw new Error("Hour must be an integer from 0 to 23");
  }
  return n;
}

/**
 * @param {import('./store').Store} store
 * @param {object} input
 * @returns {object}
 */
function normalizeAutomationInput(store, input, existing) {
  const src = input && typeof input === "object" ? input : {};
  const base = existing || {};

  const nameRaw = Object.prototype.hasOwnProperty.call(src, "name")
    ? src.name
    : base.name;
  const name = nameRaw != null ? String(nameRaw).trim() : "";
  if (!name) {
    throw new Error("Automation name is required");
  }

  const projectId = Object.prototype.hasOwnProperty.call(src, "projectId")
    ? String(src.projectId || "")
    : String(base.projectId || "");
  if (!projectId) {
    throw new Error("Project is required");
  }
  if (!store.getProject(projectId)) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  const promptRaw = Object.prototype.hasOwnProperty.call(src, "prompt")
    ? src.prompt
    : base.prompt;
  const prompt = promptRaw != null ? String(promptRaw) : "";
  if (!String(prompt).trim()) {
    throw new Error("Prompt is required");
  }

  const provider = Object.prototype.hasOwnProperty.call(src, "provider")
    ? String(src.provider || "")
    : String(base.provider || "");
  if (!provider || !isKnownProviderId(provider)) {
    throw new Error(`Unknown provider: ${src.provider ?? base.provider}`);
  }

  const modelRaw = Object.prototype.hasOwnProperty.call(src, "model")
    ? src.model
    : base.model;
  const model = normalizeModelForProvider(getProvider(provider), modelRaw);

  const preset = Object.prototype.hasOwnProperty.call(src, "preset")
    ? String(src.preset || "")
    : String(base.preset || "");
  if (!AUTOMATION_PRESETS.has(preset)) {
    throw new Error(
      `Invalid preset: ${preset || "(empty)"}. Expected hourly, daily, or weekly`,
    );
  }

  const hourRaw = Object.prototype.hasOwnProperty.call(src, "hour")
    ? src.hour
    : base.hour;
  const hour = normalizeAutomationHour(preset, hourRaw);

  let enabled = base.enabled !== undefined ? Boolean(base.enabled) : true;
  if (Object.prototype.hasOwnProperty.call(src, "enabled")) {
    enabled = Boolean(src.enabled);
  }

  return { name, projectId, prompt, provider, model, preset, hour, enabled };
}

/**
 * @param {import('./store').Store} store
 */
function listAutomations(store) {
  return store.getAutomations().map((a) => ({ ...a }));
}

/**
 * @param {import('./store').Store} store
 * @param {object} input
 */
function addAutomation(store, input) {
  const { nextFire } = require("./automations.js");
  const fields = normalizeAutomationInput(store, input, null);
  const now = Date.now();
  const created = {
    id: randomUUID(),
    ...fields,
    lastRunAt: null,
    nextRunAt: nextFire(fields.preset, fields.hour, now),
    lastError: null,
  };
  const list = store.getAutomations().slice();
  list.push(created);
  store.setAutomations(list);
  store.save();
  return { ...created };
}

/**
 * @param {import('./store').Store} store
 * @param {{ id: string } & object} input
 */
function updateAutomation(store, input) {
  const { nextFire } = require("./automations.js");
  const id = input && input.id != null ? String(input.id) : "";
  const existing = store.getAutomation(id);
  if (!existing) {
    throw new Error(`Unknown automation: ${id}`);
  }
  const fields = normalizeAutomationInput(store, input, existing);
  const scheduleChanged =
    fields.preset !== existing.preset || fields.hour !== existing.hour;
  const updated = {
    ...existing,
    ...fields,
    nextRunAt: scheduleChanged
      ? nextFire(fields.preset, fields.hour, Date.now())
      : existing.nextRunAt,
  };
  store.setAutomations(
    store.getAutomations().map((a) => (a && a.id === id ? updated : a)),
  );
  store.save();
  return { ...updated };
}

/**
 * @param {import('./store').Store} store
 * @param {{ id: string }} input
 */
function removeAutomation(store, input) {
  const id = input && input.id != null ? String(input.id) : "";
  if (!id) {
    throw new Error("Automation id is required");
  }
  const existing = store.getAutomation(id);
  if (!existing) {
    throw new Error(`Unknown automation: ${id}`);
  }
  store.setAutomations(store.getAutomations().filter((a) => !a || a.id !== id));
  store.save();
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
  let channel = null;
  try {
    const pkg = deps.pkg || require("../package.json");
    version = String(pkg.version || version);
    sha = pkg.buildSha ? String(pkg.buildSha) : null;
    time = pkg.buildTime ? String(pkg.buildTime) : null;
    channel = pkg.channel ? String(pkg.channel) : null;
  } catch {
    // dev tree without a stamped package: leave nulls
  }

  return {
    spendTodayUsd,
    memory: { ...base, entries, vectors, lastError },
    build: { version, sha, time, channel },
  };
}

/**
 * Agent-config doctor (#412). Resolve a local checkout or throw.
 * @param {import('./store').Store} store
 * @param {{ projectId?: string }} input
 */
function requireLocalProject(store, input) {
  const projectId =
    input && input.projectId != null ? String(input.projectId) : "";
  const project = store.getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const root = project.path;
  if (!root) throw new Error("Config doctor needs a local checkout");
  try {
    if (!fs.statSync(root).isDirectory()) {
      throw new Error("Config doctor needs a local checkout");
    }
  } catch (err) {
    if (err && err.message === "Config doctor needs a local checkout") throw err;
    throw new Error("Config doctor needs a local checkout");
  }
  return { project, root };
}

/**
 * Pull convention / strategy / knowledge rows (full bodies) for generate + coverage.
 * Memory being down returns [] for lint; generate rethrows.
 *
 * @param {{ recent?: Function, get?: Function } | null | undefined} memory
 * @param {string} projectPath
 * @param {{ required?: boolean }} [opts]
 */
async function loadConfigSourceEntries(memory, projectPath, opts) {
  const required = Boolean(opts && opts.required);
  if (!memory || typeof memory.recent !== "function") {
    if (required) throw new Error("Memory server is not running.");
    return [];
  }
  const types = ["convention", "strategy", "knowledge"];
  const seen = new Set();
  const rows = [];
  try {
    for (const type of types) {
      const list = await memory.recent({
        limit: 50,
        project: projectPath,
        type,
      });
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        if (!row || !row.id || seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
  } catch (err) {
    if (required) throw err;
    return [];
  }

  const full = [];
  for (const row of rows) {
    if (typeof memory.get !== "function") {
      full.push(row);
      continue;
    }
    try {
      full.push(await memory.get({ id: row.id }));
    } catch {
      full.push(row);
    }
  }
  return full;
}

/**
 * @param {import('./store').Store} store
 * @param {{ projectId: string }} input
 * @param {{ memory?: object }} [deps]
 */
async function lintAgentConfig(store, input, deps) {
  const { project, root } = requireLocalProject(store, input);
  const files = configDoctor.discoverAgentConfigFiles(root);
  const memoryEntries = await loadConfigSourceEntries(
    deps && deps.memory,
    root,
  );
  const report = configDoctor.lintAgentConfigFiles(files, {
    root,
    packageScripts: configDoctor.loadPackageScripts(root),
    memoryEntries,
  });
  return {
    projectId: project.id,
    ...report,
  };
}

/**
 * @param {import('./store').Store} store
 * @param {{ projectId: string, targets?: string[] }} input
 * @param {{ memory?: object }} [deps]
 */
async function previewAgentConfig(store, input, deps) {
  const { project, root } = requireLocalProject(store, input);
  const memoryEntries = await loadConfigSourceEntries(
    deps && deps.memory,
    root,
    { required: true },
  );
  const files = configDoctor.previewGeneratedFiles({
    root,
    name: project.name || project.slug || "Project",
    memoryEntries,
    targets: input && input.targets,
  });
  return { projectId: project.id, files };
}

/**
 * @param {import('./store').Store} store
 * @param {{ projectId: string, targets?: string[] }} input
 * @param {{ memory?: object }} [deps]
 */
async function writeAgentConfig(store, input, deps) {
  const preview = await previewAgentConfig(store, input, deps);
  const { root } = requireLocalProject(store, input);
  const written = configDoctor.writeAgentConfigFiles(root, preview.files);
  return { projectId: preview.projectId, written };
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

/**
 * Total lifetime cost (USD) of an orchestration: the orchestrator thread's own
 * usage plus every direct orchWorker forked from it. Nested crews are NOT
 * rolled up — each worker that fans out is its own orchestrator with its own
 * ceiling check.
 * @param {import('./store').Store} store
 * @param {string} threadId orchestrator thread id
 * @returns {number}
 */
function orchestrationSpend(store, threadId) {
  let total = 0;
  const own = store.getUsage(threadId);
  if (own && Number.isFinite(own.costUsd)) total += own.costUsd;
  for (const t of store.getThreads()) {
    if (!t || !t.orchWorker || t.handoffFrom !== threadId) continue;
    const u = store.getUsage(t.id);
    if (u && Number.isFinite(u.costUsd)) total += u.costUsd;
  }
  return total;
}

/**
 * Reject when a per-orchestration ceiling is set and this orchestrator's crew
 * (its own turns plus its workers') has already reached it. Checked at
 * orchestration wake-up time only (issue #67); never kills in-flight runs and
 * never blocks a user-sent turn, so the thread stays resumable via Retry.
 * @param {import('./store').Store} store
 * @param {string} threadId orchestrator thread id
 */
function assertUnderOrchestrationBudget(store, threadId) {
  const settings = store.getSettings();
  const ceiling = settings.orchestrationBudgetUsd;
  if (ceiling == null) return;
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling <= 0) {
    return;
  }
  const spent = orchestrationSpend(store, threadId);
  if (spent >= ceiling) {
    throw new Error(
      `Orchestration budget reached ($${spent.toFixed(2)} of $${ceiling.toFixed(2)} for this thread's crew). Raise or clear the per-orchestration cap in Settings.`,
    );
  }
}

module.exports = {
  addProject,
  createProject,
  removeProject,
  updateProject,
  pickProjectIcon,
  resolveProjectIcon,
  lintAgentConfig,
  previewAgentConfig,
  writeAgentConfig,
  createThread,
  forkThread,
  canHostWorktree,
  forkWorkerThread,
  setPermissionMode,
  setReasoningEffort,
  setWebSearch,
  setProvider,
  // normalizeModelForProvider / isKnownProviderId / truncateThreadTitle stay
  // module-private (round-49 review A-n2: dead exports). Tests use
  // THREAD_TITLE_MAX / HANDOFF_MESSAGE_MAX / buildHandoffPrefix.
  buildHandoffPrefix,
  THREAD_TITLE_MAX,
  THREAD_NOTES_MAX,
  HANDOFF_MESSAGE_MAX,
  HANDOFF_MESSAGE_COUNT,
  PLANBOARD_NOTE,
  planboardNoteFor,
  selfIdNoteFor,
  suggestedWorkNoteFor,
  subagentPoolNoteFor: require("./subagentPool").subagentPoolNoteFor,
  resolveSubagentPool: require("./subagentPool").resolveSubagentPool,
  hypothesisNoteFor,
  HYPOTHESES_MAX,
  HYPOTHESIS_CLAIM_MAX,
  HYPOTHESIS_REASON_MAX,
  recordHypothesis,
  SUGGESTIONS_MAX,
  SUGGESTION_TITLE_MAX,
  SUGGESTION_PROMPT_MAX,
  recordSuggestion,
  resolveSuggestion,
  CREW_TASK_TITLE_MAX,
  CREW_TASK_NOTE_MAX,
  CREW_TASKS_MAX,
  CREW_TASK_ATTEMPT_CAP,
  CREW_AUTO_TURN_CAP,
  crewRootOf,
  listCrewTasks,
  addCrewTasks,
  claimCrewTask,
  completeCrewTask,
  releaseCrewTasks,
  crewTaskNoteFor,
  SPEC_ARTIFACTS,
  SPEC_DIR,
  nextSpecStage,
  specArtifactPath,
  specNoteFor,
  reviewItineraryNoteFor: require("./reviewItinerary").reviewItineraryNoteFor,
  REVIEW_ITINERARY_NOTE: require("./reviewItinerary").REVIEW_ITINERARY_NOTE,
  teachNoteFor,
  askNoteFor,
  startAsk,
  stopAsk,
  teachAutonomyFor,
  teachAllowedModes,
  teachPermissionAllowed,
  TEACH_REVIEW_THRESHOLDS,
  TEACH_REVIEW_PROMPT,
  startTeach,
  stopTeach,
  recordTeachReview,
  requestTeachReview,
  codeIndexNoteFor,
  specStagePrompt,
  startSpec,
  stopSpec,
  submitSpec,
  reviewSpec,
  dispatchSpec,
  forkSpecWave,
  convergeSpec,
  specDispatchPrompt,
  specConvergePrompt,
  readSpecArtifact,
  planStepsFrom,
  setArchived,
  setSettled,
  setPinned,
  setQueued,
  takeQueued,
  addBtw,
  finishBtw,
  dismissBtw,
  promoteBtw,
  setSnoozed,
  setMuted,
  setCrossThreadInbound,
  setQuotaWaitAutoResume,
  setNotes,
  setFeltEstimate,
  setVerifyCommand,
  runVerifyNow,
  runCommand,
  renameThread,
  rewindThread,
  clearSettledOnActivity,
  deleteThread,
  purgeThread,
  THREAD_STILL_HAS_WORKTREE,
  listThreads,
  threadSummaries,
  searchThreads,
  getThreadDetail,
  gitStatus,
  parseRevListCount,
  gitSyncInfo,
  gitFetch,
  repoInfoFromRemote,
  gitRepoInfo,
  summarizePullOutput,
  pullFailureReason,
  gitPull,
  listProjects,
  listSpaces,
  addSpace,
  updateSpace,
  removeSpace,
  listProvidersForApi,
  listTemplates,
  saveTemplate,
  removeTemplate,
  validateWorkflowTemplate,
  slugFromRemoteUrl,
  getSettings,
  setSettings,
  listAutomations,
  addAutomation,
  updateAutomation,
  removeAutomation,
  appStatus,
  assertUnderDailyBudget,
  assertUnderOrchestrationBudget,
  orchestrationSpend,
  PERMISSION_MODES,
};
