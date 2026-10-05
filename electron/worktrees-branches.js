"use strict";

// Default/base branch resolution, worktree start points, lead snapshots and branch naming.

const fs = require("node:fs");
const { detectScm, JJ_DETACHED_HEAD_ERROR } = require("./scm.js");
const { gitOut, gitTry, gitOutAsync, splitLines, gitTryAsync } = require("./worktrees-git.js");

/**
 * When `--show-current` is empty, name the repo default branch.
 * origin/HEAD first, then a local main/master ref. Empty string = none.
 *
 * @param {string} projectPath
 * @returns {string}
 */
function fallbackDefaultBranchName(projectPath) {
  const remote = gitTry(projectPath, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (remote.ok) {
    const name = remote.stdout.trim().replace(/^refs\/remotes\/origin\//, "");
    if (name && name !== "HEAD") return name;
  }
  for (const name of ["main", "master"]) {
    const probe = gitTry(projectPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${name}`,
    ]);
    if (probe.ok) return name;
  }
  return "";
}

/**
 * @param {string} projectPath
 * @returns {Promise<string>}
 */
async function fallbackDefaultBranchNameAsync(projectPath) {
  const remote = await gitTryAsync(projectPath, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (remote.ok) {
    const name = remote.stdout.trim().replace(/^refs\/remotes\/origin\//, "");
    if (name && name !== "HEAD") return name;
  }
  for (const name of ["main", "master"]) {
    const probe = await gitTryAsync(projectPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${name}`,
    ]);
    if (probe.ok) return name;
  }
  return "";
}

/**
 * Repo default branch name (`origin/HEAD` → local main/master). Used by
 * Git-tab Merge and createPr when the thread has no recorded base (#187).
 *
 * @param {string} projectPath
 * @returns {string}
 */
function repoDefaultBranch(projectPath) {
  const name = fallbackDefaultBranchName(projectPath);
  if (name) return name;
  throw new Error("Could not resolve the repository default branch");
}

/**
 * @param {string} projectPath
 * @returns {Promise<string>}
 */
async function repoDefaultBranchAsync(projectPath) {
  const name = await fallbackDefaultBranchNameAsync(projectPath);
  if (name) return name;
  throw new Error("Could not resolve the repository default branch");
}

/**
 * Recorded stacked base, or null when the thread should use the repo default.
 *
 * @param {{ baseBranch?: string | null } | null | undefined} thread
 * @returns {string | null}
 */
function recordedBaseBranch(thread) {
  if (!thread || typeof thread.baseBranch !== "string") return null;
  const name = thread.baseBranch.trim();
  return name || null;
}

/**
 * Merge/PR/setup start-point: recorded base, else repo default.
 *
 * @param {{ baseBranch?: string | null } | null | undefined} thread
 * @param {string} projectPath
 * @returns {string}
 */
function mergeBaseName(thread, projectPath) {
  return recordedBaseBranch(thread) || repoDefaultBranch(projectPath);
}

/**
 * A revision `git` can resolve for `name` (local branch, then origin/).
 *
 * @param {string} repoPath
 * @param {string} name
 * @returns {string}
 */
function resolveStartPoint(repoPath, name) {
  const want = String(name || "").trim();
  if (!want) {
    throw new Error("Could not resolve the repository default branch");
  }
  const candidates = [
    want,
    `refs/heads/${want}`,
    `origin/${want}`,
    `refs/remotes/origin/${want}`,
  ];
  for (const ref of candidates) {
    const probe = gitTry(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (probe.ok && probe.stdout) return ref;
  }
  throw new Error(`Unknown base branch: ${want}`);
}

const MISSING_LEAD_SNAPSHOT =
  "Could not record the lead's committed snapshot. The worker will not start from main.";
const MISSING_START_SNAPSHOT =
  "This orchestration worker has no recorded lead snapshot. Refusing to fall back to main.";

/**
 * Lead committed HEAD at worker-fork time (#948). Dirty edits are noted,
 * never copied, stashed, or committed.
 *
 * @param {import('./store').Store} store
 * @param {object | null | undefined} lead
 * @returns {{ sha: string, branch: string | null, dirty: boolean }}
 */
function captureLeadSnapshot(store, lead) {
  if (!lead) {
    throw new Error(`${MISSING_LEAD_SNAPSHOT} Unknown lead thread.`);
  }
  const project =
    typeof store.getProject === "function"
      ? store.getProject(lead.projectId)
      : null;
  if (!project || !project.path) {
    throw new Error(`${MISSING_LEAD_SNAPSHOT} Unknown project for the lead.`);
  }

  let cwd = project.path;
  if (lead.worktreePath && fs.existsSync(lead.worktreePath)) {
    const inside = gitTry(lead.worktreePath, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    if (inside.ok && String(inside.stdout || "").trim() === "true") {
      cwd = lead.worktreePath;
    }
  } else if (typeof lead.branch === "string" && lead.branch.trim()) {
    const named = gitTry(project.path, [
      "rev-parse",
      "--verify",
      `${lead.branch.trim()}^{commit}`,
    ]);
    if (named.ok && String(named.stdout || "").trim()) {
      return {
        sha: String(named.stdout).trim(),
        branch: lead.branch.trim(),
        dirty: false,
      };
    }
  }

  const head = gitTry(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok || !String(head.stdout || "").trim()) {
    throw new Error(
      `${MISSING_LEAD_SNAPSHOT} The lead has no committed HEAD.`,
    );
  }
  const sha = String(head.stdout).trim();
  const named =
    (typeof lead.branch === "string" && lead.branch.trim()) ||
    String(gitTry(cwd, ["branch", "--show-current"]).stdout || "").trim() ||
    null;
  const porcelain = gitTry(cwd, ["status", "--porcelain", "-uall"]);
  const dirty = Boolean(
    porcelain.ok && String(porcelain.stdout || "").trim(),
  );
  return { sha, branch: named, dirty };
}

/**
 * Worktree start-point (#948). A recorded lead snapshot is exclusive:
 * missing or unresolvable SHAs fail instead of falling back to main.
 * Independent threads still use the stacked base / repo default.
 *
 * @param {{ orchWorker?: boolean, leadSnapshotSha?: string | null } | null | undefined} thread
 * @param {string} projectPath
 * @returns {string}
 */
function resolveWorktreeStart(thread, projectPath) {
  const snap =
    thread && typeof thread.leadSnapshotSha === "string"
      ? thread.leadSnapshotSha.trim()
      : "";
  if (snap) {
    const probe = gitTry(projectPath, [
      "rev-parse",
      "--verify",
      `${snap}^{commit}`,
    ]);
    if (!probe.ok || !String(probe.stdout || "").trim()) {
      throw new Error(
        `Worker start snapshot ${snap} is missing from the repository. Refusing to fall back to main.`,
      );
    }
    return String(probe.stdout).trim();
  }
  if (thread && thread.orchWorker) {
    throw new Error(MISSING_START_SNAPSHOT);
  }
  const base = mergeBaseName(thread, projectPath);
  // "Start from origin" (draft strip, #1411): fetch the base and start from
  // origin's copy. Bounded and prompt-free; no remote copy (offline, local
  // stacked branch) falls back to the local branch below.
  if (thread && thread.worktreeFromOrigin === true && base) {
    gitTry(projectPath, ["fetch", "origin", base], {
      timeout: 10_000,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    const remote = gitTry(projectPath, [
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${base}^{commit}`,
    ]);
    if (remote.ok && remote.stdout) return `origin/${base}`;
  }
  return resolveStartPoint(projectPath, base);
}

/**
 * Colocated jj detaches git HEAD on every command. Git-tab Merge must
 * not silently switch that checkout onto main (#521 / #770).
 *
 * @param {string} projectPath
 */
function refuseJjDetached(projectPath) {
  const current = gitOut(projectPath, ["branch", "--show-current"]);
  if (current) return;
  const scm = detectScm(projectPath);
  if (scm && scm.kind === "jj") {
    throw new Error(JJ_DETACHED_HEAD_ERROR);
  }
}

/**
 * Local branch names for the create-thread picker. Repo default first.
 *
 * @param {string} projectPath
 * @returns {{ defaultBranch: string, branches: string[] }}
 */
function listBranches(projectPath) {
  return branchList(
    fallbackDefaultBranchName(projectPath) || "",
    gitOut(projectPath, FOR_EACH_HEAD),
  );
}

/**
 * listBranches off the event loop: the `git:listBranches` IPC fires on
 * boot and every picker open, 2–4 git spawns at ~37 ms each (#1475).
 *
 * @param {string} projectPath
 * @returns {Promise<{ defaultBranch: string, branches: string[] }>}
 */
async function listBranchesAsync(projectPath) {
  const [defaultName, raw] = await Promise.all([
    fallbackDefaultBranchNameAsync(projectPath),
    gitOutAsync(projectPath, FOR_EACH_HEAD),
  ]);
  return branchList(defaultName || "", raw);
}

const FOR_EACH_HEAD = ["for-each-ref", "--format=%(refname:short)", "refs/heads"];

/**
 * @param {string} defaultName
 * @param {string} raw
 */
function branchList(defaultName, raw) {
  const branches = splitLines(raw)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => {
      if (a === defaultName) return -1;
      if (b === defaultName) return 1;
      return a.localeCompare(b);
    });
  return {
    defaultBranch: defaultName || branches[0] || "main",
    branches,
  };
}

/**
 * Branch currently checked out in `projectPath`, or the repo default when
 * that checkout is detached (main held in another worktree, a SHA review,
 * jj). Used by setup / PR / conflict paths that want "where this checkout
 * is." Git-tab Merge does not use this — see repoDefaultBranch.
 *
 * @param {string} projectPath
 * @returns {string}
 */
function defaultBranch(projectPath) {
  const branch = gitOut(projectPath, ["branch", "--show-current"]);
  if (branch) return branch;
  const fallback = fallbackDefaultBranchName(projectPath);
  if (fallback) return fallback;
  const scm = detectScm(projectPath);
  if (scm && scm.kind === "jj") {
    throw new Error(JJ_DETACHED_HEAD_ERROR);
  }
  throw new Error(
    "Project checkout is detached HEAD; check out a branch before merging",
  );
}

/**
 * Async defaultBranch, for the PR paths. The sync one stays: the worktree
 * write flows (setupWorktree / mergeWorktree / sweep) still call it.
 * @param {string} projectPath
 * @returns {Promise<string>}
 */
async function defaultBranchAsync(projectPath) {
  const branch = await gitOutAsync(projectPath, ["branch", "--show-current"]);
  if (branch) return branch;
  const fallback = await fallbackDefaultBranchNameAsync(projectPath);
  if (fallback) return fallback;
  const scm = detectScm(projectPath);
  if (scm && scm.kind === "jj") {
    throw new Error(JJ_DETACHED_HEAD_ERROR);
  }
  throw new Error(
    "Project checkout is detached HEAD; check out a branch before merging",
  );
}

/**
 * Worktree directory that currently has `branch` checked out, or null.
 *
 * @param {string} repoPath
 * @param {string} branch
 * @returns {string | null}
 */
function worktreePathForBranch(repoPath, branch) {
  const listed = gitTry(repoPath, ["worktree", "list", "--porcelain"], {
    raw: true,
  });
  if (!listed.ok) return null;
  const want = `refs/heads/${branch}`;
  let dir = null;
  for (const line of String(listed.stdout || "").split("\n")) {
    if (line.startsWith("worktree ")) {
      dir = line.slice("worktree ".length);
    } else if (line.startsWith("branch ") && dir) {
      if (line.slice("branch ".length) === want) return dir;
    } else if (line === "") {
      dir = null;
    }
  }
  return null;
}

/**
 * Slugify a thread title for branch names.
 * @param {string} title
 */
function slugify(title) {
  const s = String(title || "thread")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "thread";
}

/**
 * True when `name` already exists as a local or remote branch ref.
 * Remote check covers every remote (`refs/remotes/<remote>/<name>`), not
 * just origin — colliding with a fetched PR branch is what #316 is for.
 * @param {string} repoPath
 * @param {string} name
 */
function branchRefExists(repoPath, name) {
  const local = gitTry(repoPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${name}`,
  ]);
  if (local.ok) return true;
  const listed = gitTry(repoPath, ["show-ref"]);
  if (!listed.ok || !listed.stdout) return false;
  for (const line of listed.stdout.split("\n")) {
    const ref = line.replace(/^[0-9a-f]+\s+/i, "").trim();
    if (!ref.startsWith("refs/remotes/")) continue;
    const after = ref.slice("refs/remotes/".length);
    const slash = after.indexOf("/");
    if (slash !== -1 && after.slice(slash + 1) === name) return true;
  }
  return false;
}

/**
 * Pick a free `coder/...` name: `base`, then `base-2`, `base-3`, …
 * Returns null when 2..99 are all taken so a best-effort rename can bail.
 * @param {string} repoPath
 * @param {string} base
 * @returns {string | null}
 */
function uniqueCoderBranch(repoPath, base) {
  if (!branchRefExists(repoPath, base)) return base;
  for (let n = 2; n <= 99; n++) {
    const candidate = `${base}-${n}`;
    if (!branchRefExists(repoPath, candidate)) return candidate;
  }
  return null;
}

/**
 * Retarget a bound worktree onto `baseName` (or the repo default when
 * null). Refuses a dirty tree so uncommitted work is never discarded.
 * Unique commits on the thread branch (`oldStart..HEAD`) are rebased
 * with `git rebase --onto <newBase> <oldStart>`; a conflict aborts and
 * names the conflicted paths (#776). A clean tree with no unique commits
 * is reset onto the new start-point. Callers must persist
 * ThreadInfo.baseBranch only after this succeeds (#775).
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {object} opts.thread
 * @param {string | null} [opts.baseName]
 * @param {string} [opts.fromRef] previous start (lead snapshot SHA on refresh)
 * @param {string} [opts.ontoRef] new start SHA; never falls back to main
 */
function resolveCommitOrThrow(repoPath, ref) {
  const want = String(ref || "").trim();
  if (!want) {
    throw new Error(MISSING_START_SNAPSHOT);
  }
  const probe = gitTry(repoPath, [
    "rev-parse",
    "--verify",
    `${want}^{commit}`,
  ]);
  if (!probe.ok || !String(probe.stdout || "").trim()) {
    throw new Error(
      `Worker start snapshot ${want} is missing from the repository. Refusing to fall back to main.`,
    );
  }
  return String(probe.stdout).trim();
}

module.exports = {
  repoDefaultBranch,
  repoDefaultBranchAsync,
  recordedBaseBranch,
  mergeBaseName,
  resolveStartPoint,
  captureLeadSnapshot,
  resolveWorktreeStart,
  refuseJjDetached,
  listBranches,
  listBranchesAsync,
  defaultBranch,
  defaultBranchAsync,
  worktreePathForBranch,
  slugify,
  uniqueCoderBranch,
  resolveCommitOrThrow,
};
