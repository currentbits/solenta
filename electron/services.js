"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  getProvider,
  knownProviderIds,
  listProviders,
} = require("./providers.js");
const { getMemoryStatus } = require("./memory-sup.js");
const { execCommandAsync } = require("./ssh.js");
const { normalizeCommand, runVerifyCommand } = require("./verify.js");

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

/**
 * Validate remotes (when set) or a local git work tree; add ProjectInfo.
 * Empty remotes keep today's local path behavior byte-for-byte.
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
    if (!remotePath.startsWith("/")) {
      throw new Error("Remote path must be an absolute path (start with /)");
    }
    const folderName = path.posix.basename(remotePath) || "remote";
    const localPath =
      typeof projectPath === "string" && projectPath.trim()
        ? path.resolve(projectPath.trim())
        : remotePath;
    const project = {
      id: randomUUID(),
      slug: folderName,
      name: folderName,
      path: localPath,
      remoteHost,
      remotePath,
    };
    const projects = store.getProjects().slice();
    projects.push(project);
    store.setProjects(projects);
    store.save();
    return project;
  }

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
    const inside = await gitOutAsync(resolved, ["rev-parse", "--is-inside-work-tree"]);
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
  };

  const projects = store.getProjects().slice();
  projects.push(project);
  store.setProjects(projects);
  store.save();
  return project;
}

/**
 * Create a brand-new project folder: mkdir + git init, then add it through
 * the normal addProject validation. The name must be a plain folder name
 * (no separators) and the parent directory must already exist.
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

  const parent = path.resolve(parentDir);
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
    await gitOutAsync(target, ["init", "-q"]);
  } catch (err) {
    fs.rmSync(target, { recursive: true, force: true });
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(`Could not initialize a git repository: ${msg}`);
  }

  return addProject(store, target);
}

/**
 * Patch an existing project. Today: display name, SSH remote fields,
 * space membership (issue #159), the autoDispatch opt-in (issue #165), and
 * worktree retention (#316). Remote validation mirrors addProject: a
 * non-empty host requires an absolute remotePath; an empty host clears both
 * keys, turning the project local again. The local checkout path is never
 * edited here.
 * @param {import('./store').Store} store
 * @param {string} projectId
 * @param {{ name?: string, remoteHost?: string, remotePath?: string, spaceId?: string, autoDispatch?: boolean, worktreeRetention?: number }} patch
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

  if (typeof input.spaceId === "string") {
    const spaceId = input.spaceId.trim();
    if (spaceId) {
      const known = store.getSpaces().some((s) => s && s.id === spaceId);
      if (!known) {
        throw new Error(`Unknown space: ${spaceId}`);
      }
      next.spaceId = spaceId;
    } else {
      delete next.spaceId;
    }
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
    if (v === 0) {
      delete next.worktreeRetention;
    } else if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      next.worktreeRetention = v;
    } else {
      throw new Error(
        "worktreeRetention must be a number greater than 0, or 0 to clear",
      );
    }
  }

  projects[idx] = next;
  store.setProjects(projects);
  store.save();
  return next;
}

/**
 * @param {import('./store').Store} store
 * @returns {{ id: string, name: string }[]}
 */
function listSpaces(store) {
  return store.getSpaces().slice();
}

/**
 * @param {import('./store').Store} store
 * @param {{ name?: string }} input
 */
function addSpace(store, input) {
  const name =
    input && typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    throw new Error("Name cannot be empty");
  }
  const space = { id: randomUUID(), name };
  const spaces = store.getSpaces().slice();
  spaces.push(space);
  store.setSpaces(spaces);
  store.save();
  return space;
}

/**
 * @param {import('./store').Store} store
 * @param {{ id?: string, name?: string }} input
 */
function updateSpace(store, input) {
  const id = input && input.id != null ? String(input.id) : "";
  const spaces = store.getSpaces().slice();
  const idx = spaces.findIndex((s) => s && s.id === id);
  if (idx === -1) {
    throw new Error(`Unknown space: ${id}`);
  }
  const name =
    input && typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    throw new Error("Name cannot be empty");
  }
  const next = { ...spaces[idx], name };
  spaces[idx] = next;
  store.setSpaces(spaces);
  store.save();
  return next;
}

/**
 * Drops the space and clears spaceId on every project that used it.
 * Threads and on-disk repos are never touched.
 * @param {import('./store').Store} store
 * @param {{ id?: string }} input
 */
function removeSpace(store, input) {
  const id = input && input.id != null ? String(input.id) : "";
  const spaces = store.getSpaces();
  if (!spaces.some((s) => s && s.id === id)) {
    throw new Error(`Unknown space: ${id}`);
  }
  store.setSpaces(spaces.filter((s) => !s || s.id !== id));
  store.setProjects(
    store.getProjects().map((p) => {
      if (!p || p.spaceId !== id) return p;
      const next = { ...p };
      delete next.spaceId;
      return next;
    }),
  );
  store.save();
}

/**
 * @param {import('./store').Store} store
 * @param {{ projectId: string, title: string, worktree?: boolean, automationId?: string | null }} input
 * `worktree` is only consumed by the IPC layer (threads:create), which calls
 * setupWorktree after this returns; the service itself stays fs-free.
 * `automationId` tags threads minted by an automation so runAutomation can
 * retain only the last N (issue #134). Absent / falsy on hand-made threads.
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
    notes: "",
    verifyCommand: null,
    verify: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    handoffFrom: null,
    automationId: input.automationId || null,
    queued: null,
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
/** Per-thread scratch pad cap (issue #194). */
const THREAD_NOTES_MAX = 2000;

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
 * One-time hand-off context prefix for the CLI (NOT stored in the transcript):
 * a digest of the tail of the source thread, newest-last, each message capped.
 * Returns "" when no prefix applies: no handoffFrom, session already exists,
 * source missing/deleted, or source has no assistant message.
 *
 * ponytail: tail digest, not a summary — a fork still needs a self-contained
 * prompt (the MCP tool description says so). Summarize here only if the tail
 * proves too thin in practice.
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
 * @param {{ threadId: string, provider?: string, worktree?: boolean }} input
 * @param {(store: any, input: any) => any} [forkImpl] seam for tests
 * @returns {any} the new worker thread
 */
function forkWorkerThread(store, input, forkImpl = forkThread) {
  /** @type {{ threadId: string, provider?: string }} */
  const forkInput = { threadId: input.threadId };
  if (input.provider != null) forkInput.provider = input.provider;
  const fork = forkImpl(store, forkInput);

  const patch = { orchWorker: true };
  const source = store.getThread(input.threadId);
  const projectId = fork.projectId ?? (source ? source.projectId : null);
  const project =
    typeof store.getProject === "function" && projectId != null
      ? store.getProject(projectId)
      : null;
  if (input.worktree !== false && canHostWorktree(project)) {
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
 * Persist or clear the type-ahead queue for a thread (issue #137).
 * prompt === null clears. A non-null prompt APPENDS to any existing queue
 * (same join as the old renderer startRun) so two mid-run sends cannot
 * race-replace each other across the async IPC hop. Never bumps updatedAt:
 * queueing is not activity, same rule as setPinned.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, prompt: string | null, attachments?: object[] }} input
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
    };
  }
  const updated = store.updateThread(threadId, { queued });
  store.save();
  return updated ? { ...updated } : { ...thread, queued };
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
  const ran = await runVerifyCommand({
    command: thread.verifyCommand,
    cwd,
  });

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
    command: thread.verifyCommand,
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
function setSettings(store, patch) {
  const next = store.setSettings(patch || {});
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
  createThread,
  forkThread,
  canHostWorktree,
  forkWorkerThread,
  setPermissionMode,
  setReasoningEffort,
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
  planStepsFrom,
  setArchived,
  setSettled,
  setPinned,
  setQueued,
  setSnoozed,
  setMuted,
  setNotes,
  setVerifyCommand,
  runVerifyNow,
  renameThread,
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
