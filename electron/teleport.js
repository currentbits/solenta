"use strict";

/**
 * Teleport (#1702): move an idle Claude thread to another Solenta host and
 * back. One JSON payload carries everything, both directions:
 *
 *   bundle  - `git bundle` of the branch commits origin lacks (base64)
 *   patch   - binary diff of uncommitted + untracked non-ignored files
 *   session - the Claude jsonl, relocated on arrival
 *   messages, model, effort, permission mode
 *
 * Nothing is pushed to origin. Gitignored files stay where they are.
 * See docs/superpowers/specs/2026-10-24-teleport-design.md.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitTry } = require("./worktrees-git.js");
const {
  encodeClaudeProjectDir,
  resolveClaudeHome,
  findClaudeSessionFile,
} = require("./cli-sessions-claude.js");
const { isPathSafeSessionId } = require("./cli-sessions-shared.js");

const PAYLOAD_VERSION = 1;
// ponytail: whole payload in one WS frame; stream it if real branches hit this.
const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;
const MAX_IGNORED_LISTED = 50;

function git(cwd, args, env) {
  const r = gitTry(cwd, args, { raw: true, env, timeout: 120_000 });
  if (!r.ok) {
    const why = String(r.stderr || r.combined || "").trim().split("\n").slice(-3).join("\n");
    throw new Error(`git ${args[0]} failed: ${why}`);
  }
  return r.stdout.trim();
}

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-teleport-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** owner/repo of `origin`, lowercased; null without one. */
function originSlug(cwd) {
  const r = gitTry(cwd, ["remote", "get-url", "origin"]);
  if (!r.ok) return null;
  const { slugFromRemoteUrl } = require("./services-projects.js");
  const slug = slugFromRemoteUrl(r.stdout);
  return slug ? slug.toLowerCase() : null;
}

/**
 * Tree of the worktree as it stands (tracked edits + untracked non-ignored
 * files) and the binary patch from HEAD to it. A temp index leaves the
 * real one alone.
 */
function snapshotWorktree(cwd) {
  return withTemp((dir) => {
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    git(cwd, ["read-tree", "HEAD"], env);
    git(cwd, ["add", "-A"], env);
    const tree = git(cwd, ["write-tree"], env);
    const out = path.join(dir, "patch");
    git(cwd, ["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", `--output=${out}`, "HEAD"], env);
    return { tree, patch: fs.readFileSync(out) };
  });
}

/**
 * Where Claude reads/writes this thread's session (#453 instance-aware,
 * #1808 isolated-home-aware: `userDataPath` resolves an isolated instance's
 * own CLAUDE_CONFIG_DIR instead of falling through to the default home).
 * @param {import('./store').Store} store
 * @param {object} thread
 * @param {string} [userDataPath]
 */
function claudeHomeFor(store, thread, userDataPath) {
  const { threadInstanceEnv } = require("./providerInstances.js");
  let env = null;
  try {
    env = threadInstanceEnv(store.getSettings(), thread, { userDataPath });
  } catch {
    // unknown instance: the default home
  }
  return resolveClaudeHome(env && env.CLAUDE_CONFIG_DIR);
}

/**
 * Why this thread cannot leave its host right now, or null.
 * @param {object | null} thread
 * @param {{ isRunning?: (id: string) => boolean }} [opts]
 */
function refuseToPack(thread, opts) {
  if (!thread) return "Unknown thread.";
  if (thread.provider !== "claude") return "Teleport supports Claude threads only for now.";
  if (!thread.worktreePath) return "Teleport needs a thread with its own worktree.";
  if (thread.teleportedTo) return `This thread is already on ${thread.teleportedTo.label || thread.teleportedTo.host}.`;
  if (thread.ejected === true) return "Reclaim this thread from the terminal first.";
  const running = opts && typeof opts.isRunning === "function" && opts.isRunning(thread.id);
  if (running || thread.status === "working" || thread.status === "quota-wait") {
    return "Wait for the run to finish, or stop it, before teleporting.";
  }
  if (Array.isArray(thread.queued) ? thread.queued.length : thread.queued) {
    return "This thread has queued prompts. Send or clear them before teleporting.";
  }
  return null;
}

/**
 * Build the payload for one idle thread. Read-only on this host.
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {{ isRunning?: (id: string) => boolean, userDataPath?: string }} [opts]
 */
function packThread(store, threadId, opts) {
  const thread = store.getThread(threadId);
  const refusal = refuseToPack(thread, opts);
  if (refusal) throw new Error(refusal);
  const cwd = thread.worktreePath;
  if (!fs.existsSync(cwd)) throw new Error("This thread's worktree folder is missing.");
  const slug = originSlug(cwd);
  if (!slug) throw new Error("Teleport needs the repo to have an origin remote.");
  const branchRes = gitTry(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = branchRes.ok ? branchRes.stdout.trim() : "";
  if (!branch) throw new Error("The worktree is on a detached HEAD; check out the thread's branch first.");
  const head = git(cwd, ["rev-parse", "HEAD"]);

  const bundle = withTemp((dir) => {
    const file = path.join(dir, "branch.bundle");
    const r = gitTry(cwd, ["bundle", "create", file, `refs/heads/${branch}`, "--not", "--remotes=origin"]);
    if (!r.ok) {
      // Origin already has every commit: nothing to carry.
      if (/empty bundle/i.test(r.combined)) return "";
      throw new Error(`git bundle failed: ${String(r.stderr || r.combined).trim()}`);
    }
    return fs.readFileSync(file).toString("base64");
  });

  const { tree, patch } = snapshotWorktree(cwd);
  const ignored = gitTry(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"])
    .stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  let session = "";
  if (thread.sessionId) {
    const file = findClaudeSessionFile(claudeHomeFor(store, thread, opts && opts.userDataPath), cwd, thread.sessionId);
    if (!file) throw new Error("This thread's Claude session file was not found, so the conversation cannot move.");
    session = fs.readFileSync(file, "utf8");
  }

  const payload = {
    version: PAYLOAD_VERSION,
    provider: "claude",
    originSlug: slug,
    branch,
    head,
    bundle,
    patch: patch.toString("base64"),
    sessionId: thread.sessionId || null,
    session,
    thread: {
      title: thread.title,
      model: thread.model ?? null,
      reasoningEffort: thread.reasoningEffort ?? null,
      permissionMode: thread.permissionMode || "default",
      baseBranch: thread.baseBranch ?? null,
    },
    messages: store.getMessages(threadId) || [],
    ignored: ignored.slice(0, MAX_IGNORED_LISTED),
  };
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
    throw new Error("This thread is too large to teleport (over 50 MB of commits, changes and conversation).");
  }
  return { payload, tree };
}

/** Shape check before anything touches git or the store. */
function validatePayload(p) {
  if (!p || typeof p !== "object" || p.version !== PAYLOAD_VERSION) {
    throw new Error("This Solenta cannot read that teleport. Update both computers to the same version.");
  }
  if (p.provider !== "claude") throw new Error("Teleport supports Claude threads only for now.");
  if (!/^[0-9a-f]{40,64}$/.test(String(p.head))) throw new Error("Teleport payload has no valid head commit.");
  if (typeof p.branch !== "string" || !p.branch || p.branch.startsWith("-")) {
    throw new Error("Teleport payload has no valid branch.");
  }
  if (p.sessionId != null && !isPathSafeSessionId(p.sessionId)) throw new Error("Teleport payload has an invalid session id.");
  if (typeof p.bundle !== "string" || typeof p.patch !== "string" || typeof p.session !== "string") {
    throw new Error("Teleport payload is incomplete.");
  }
  if (!Array.isArray(p.messages) || !p.thread || typeof p.thread !== "object") {
    throw new Error("Teleport payload is incomplete.");
  }
}

/**
 * Land the payload's commits in `repo` without touching any ref, then make
 * sure `head` resolves. Fetches origin first so the bundle's prerequisites
 * (commits origin has) are present.
 */
function importCommits(repo, p) {
  git(repo, ["check-ref-format", "--branch", p.branch]);
  gitTry(repo, ["fetch", "--quiet", "origin"], { timeout: 120_000 });
  if (p.bundle) {
    withTemp((dir) => {
      const file = path.join(dir, "branch.bundle");
      fs.writeFileSync(file, Buffer.from(p.bundle, "base64"));
      const verify = gitTry(repo, ["bundle", "verify", file]);
      if (!verify.ok) {
        throw new Error(`The branch builds on commits this computer does not have, even after fetching origin.\n${String(verify.stderr || verify.combined).trim()}`);
      }
      git(repo, ["bundle", "unbundle", file]);
    });
  }
  if (!gitTry(repo, ["cat-file", "-e", `${p.head}^{commit}`]).ok) {
    throw new Error(`Commit ${p.head.slice(0, 8)} is missing here. Fetch origin on this computer and try again.`);
  }
}

/** Fails before any thread exists when the patch would not apply. */
function checkPatchApplies(repo, p) {
  if (!p.patch) return;
  withTemp((dir) => {
    const env = { GIT_INDEX_FILE: path.join(dir, "index") };
    const file = path.join(dir, "patch");
    fs.writeFileSync(file, Buffer.from(p.patch, "base64"));
    git(repo, ["read-tree", p.head], env);
    git(repo, ["apply", "--cached", "--check", "--binary", file], env);
  });
}

function applyPatch(worktree, p) {
  if (!p.patch) return;
  withTemp((dir) => {
    const file = path.join(dir, "patch");
    fs.writeFileSync(file, Buffer.from(p.patch, "base64"));
    git(worktree, ["apply", "--binary", "--whitespace=nowarn", file]);
  });
}

/** Worktree path that has `branch` checked out, or null. */
function checkedOutAt(repo, branch) {
  const out = gitTry(repo, ["worktree", "list", "--porcelain"]).stdout;
  let wt = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) wt = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return wt;
  }
  return null;
}

function isAncestor(repo, a, b) {
  return gitTry(repo, ["merge-base", "--is-ancestor", a, b]).ok;
}

/**
 * Write the Claude jsonl where Claude Code looks for it from `cwd`
 * (realpath, dash-encoded) with every line's cwd pointing here.
 */
function relocateClaudeSession(home, cwd, sessionId, text) {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd).normalize("NFC");
  } catch {
    // keep the input
  }
  const dir = path.join(home, "projects", encodeClaudeProjectDir(real));
  fs.mkdirSync(dir, { recursive: true });
  const lines = String(text).split("\n").map((line) => {
    if (!line.trim()) return line;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.cwd === "string") {
        obj.cwd = real;
        return JSON.stringify(obj);
      }
    } catch {
      // not JSON: keep verbatim
    }
    return line;
  });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

/** Project on this host whose origin is the payload's origin. */
function findProjectByOrigin(store, slug) {
  for (const project of store.getProjects() || []) {
    if (!project || project.remoteHost || project.scratch === true || !project.path) continue;
    if (originSlug(project.path) === slug) return project;
  }
  return null;
}

/**
 * Receiving host: create a thread from the payload (#1702).
 * @param {import('./store').Store} store
 * @param {object} payload
 * @param {{
 *   worktreeBase: string,
 *   broadcast?: (channel: string, data: unknown) => void,
 *   claudeAvailable: boolean,
 *   claudeHome?: string,
 *   from?: { threadId?: string, host?: string },
 * }} opts
 * @returns {{ threadId: string, title: string }}
 */
function receiveThread(store, payload, opts) {
  validatePayload(payload);
  if (!opts.claudeAvailable) throw new Error("Claude Code is not installed or not signed in on this computer.");
  const { getProvider, honouredEfforts } = require("./providers.js");
  const { model, reasoningEffort } = payload.thread;
  if (reasoningEffort && !honouredEfforts(getProvider("claude"), model).includes(reasoningEffort)) {
    throw new Error(`Effort "${reasoningEffort}" is not available for ${model || "the default model"} here.`);
  }
  const project = findProjectByOrigin(store, payload.originSlug);
  if (!project) {
    throw new Error(`No project for ${payload.originSlug} on this computer. Add that repo here first, then teleport again.`);
  }
  const repo = project.path;
  importCommits(repo, payload);
  const existing = gitTry(repo, ["rev-parse", "-q", "--verify", `refs/heads/${payload.branch}`]);
  if (existing.ok) {
    if (checkedOutAt(repo, payload.branch)) {
      throw new Error(`Branch ${payload.branch} is checked out in another worktree here. Archive that thread first.`);
    }
    if (!isAncestor(repo, existing.stdout.trim(), payload.head)) {
      throw new Error(`Branch ${payload.branch} already exists here with different commits.`);
    }
  }
  checkPatchApplies(repo, payload);
  git(repo, ["branch", "-f", payload.branch, payload.head]);

  const services = require("./services.js");
  const { setupWorktree } = require("./worktrees.js");
  const thread = services.createThread(store, {
    projectId: project.id,
    title: payload.thread.title,
    provider: "claude",
    model,
    projectDefaults: false,
  });
  try {
    store.updateThread(thread.id, {
      reasoningEffort: reasoningEffort || null,
      permissionMode: payload.thread.permissionMode || "default",
      baseBranch: payload.thread.baseBranch || null,
      retainedBranch: payload.branch,
      teleportedFrom: { threadId: String((opts.from && opts.from.threadId) || ""), at: Date.now() },
    });
    const ready = setupWorktree({ store, threadId: thread.id, worktreeBase: opts.worktreeBase, broadcast: opts.broadcast });
    applyPatch(ready.worktreePath, payload);
    if (payload.sessionId && payload.session) {
      relocateClaudeSession(opts.claudeHome || resolveClaudeHome(), ready.worktreePath, payload.sessionId, payload.session);
    }
    store.setMessages(thread.id, payload.messages);
    store.updateThread(thread.id, { sessionId: payload.sessionId || null });
    store.save();
  } catch (err) {
    rollbackThread(store, thread.id);
    throw err;
  }
  return { threadId: thread.id, title: thread.title };
}

function rollbackThread(store, threadId) {
  const t = store.getThread(threadId);
  try {
    if (t && t.worktreePath) {
      const project = store.getProject(t.projectId);
      gitTry(project.path, ["worktree", "remove", "--force", t.worktreePath]);
      store.updateThread(threadId, { worktreePath: null });
    }
    require("./services.js").deleteThread(store, { threadId });
  } catch {
    // best effort: the error that got us here is the one to report
  }
}

/**
 * Original host: put a returning payload back onto the thread it left
 * from. Refuses when the worktree changed since it left, so nothing
 * typed here in the meantime is overwritten.
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {object} payload
 * @param {{ userDataPath?: string }} [opts]
 */
function returnThread(store, threadId, payload, opts) {
  validatePayload(payload);
  const thread = store.getThread(threadId);
  if (!thread || !thread.teleportedTo) throw new Error("This thread is not teleported.");
  const cwd = thread.worktreePath;
  if (!cwd || !fs.existsSync(cwd)) throw new Error("This thread's worktree folder is missing here.");
  const project = store.getProject(thread.projectId);
  if (originSlug(project.path) !== payload.originSlug) throw new Error("The returning thread belongs to a different repo.");
  if (snapshotWorktree(cwd).tree !== thread.teleportedTo.tree) {
    throw new Error("This thread's worktree changed here since it was teleported, and Teleport back would overwrite those changes. Move them aside first.");
  }
  importCommits(project.path, payload);
  const branch = git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== payload.branch) throw new Error(`The worktree is on ${branch}, not ${payload.branch}.`);
  if (!isAncestor(cwd, "HEAD", payload.head)) {
    throw new Error(`Branch ${branch} moved here since it was teleported, so the remote commits do not fast-forward it.`);
  }
  checkPatchApplies(project.path, payload);
  // Untracked non-ignored files were part of the snapshot that left, so the
  // remote copy supersedes them. Ignored files stay.
  git(cwd, ["reset", "--hard", "-q", payload.head]);
  git(cwd, ["clean", "-fdq"]);
  applyPatch(cwd, payload);
  if (payload.sessionId && payload.session) {
    relocateClaudeSession(claudeHomeFor(store, thread, opts && opts.userDataPath), cwd, payload.sessionId, payload.session);
  }
  store.setMessages(threadId, payload.messages);
  store.updateThread(threadId, {
    sessionId: payload.sessionId || null,
    model: payload.thread.model ?? null,
    reasoningEffort: payload.thread.reasoningEffort ?? null,
    permissionMode: payload.thread.permissionMode || "default",
    teleportedTo: null,
  }, { touch: true });
  store.save();
  return store.getThread(threadId);
}

/** Boot: a send cut off by a quit never got a remote thread id. */
function clearPendingTeleports(store) {
  let n = 0;
  for (const t of store.getThreads() || []) {
    if (t.teleportedTo && t.teleportedTo.pending) {
      store.updateThread(t.id, { teleportedTo: null });
      n++;
    }
  }
  if (n) store.save();
  return n;
}

module.exports = {
  clearPendingTeleports,
  MAX_PAYLOAD_BYTES,
  refuseToPack,
  packThread,
  receiveThread,
  returnThread,
  relocateClaudeSession,
  snapshotWorktree,
  validatePayload,
};
