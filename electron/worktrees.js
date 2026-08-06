"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PATCH_TRUNCATE = 100_000;

const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ raw?: boolean }} [opts] - raw skips trimming (porcelain output
 *   carries a significant leading space in its XY status column)
 * @returns {string}
 */
function gitOut(cwd, args, opts) {
  const out = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });
  return opts && opts.raw ? out : out.trim();
}

/** True when the error means the repo has no HEAD yet (no commits). */
function isNoHeadError(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return /ambiguous argument 'HEAD'|bad revision|unknown revision/i.test(msg);
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
 * Create a git worktree + branch for the thread.
 * Idempotent when worktreePath is already set.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.worktreeBase - base directory for worktrees
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {object} updated ThreadInfo
 */
function setupWorktree(opts) {
  const { store, threadId, worktreeBase, broadcast } = opts;

  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }

  if (thread.worktreePath) {
    return { ...thread };
  }

  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }

  const shortId = String(thread.id).slice(0, 6);
  const branch = `coder/${slugify(thread.title)}-${shortId}`;
  const dir = path.join(worktreeBase, thread.id);

  fs.mkdirSync(worktreeBase, { recursive: true });

  try {
    gitOut(project.path, ["worktree", "add", "-b", branch, dir]);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    // Surface a clean error (clear of Error.prototype noise where possible)
    throw new Error(`Failed to create worktree: ${msg.split("\n")[0]}`);
  }

  const updated = store.updateThread(threadId, {
    worktreePath: dir,
    branch,
  });
  store.save();

  if (typeof broadcast === "function") {
    const { listThreads } = require("./services.js");
    broadcast("threads:changed", listThreads(store));
  }

  return updated ? { ...updated } : { ...thread, worktreePath: dir, branch };
}

/**
 * Working-tree changes in the thread's cwd (worktree if set, else project).
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @returns {{ files: Array<{path: string, status: string, additions: number, deletions: number}>, patch: string, truncated: boolean }}
 */
function diff(opts) {
  const { store, threadId } = opts;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }

  const cwd = thread.worktreePath || project.path;

  /** @type {Map<string, { path: string, status: string, additions: number, deletions: number }>} */
  const byPath = new Map();

  // Porcelain status for all entries; -uall lists untracked files
  // individually instead of collapsing whole directories into "?? dir/".
  // raw: the 2-char XY column starts with a significant space.
  const porcelain = gitOut(cwd, ["status", "--porcelain", "-uall"], { raw: true });

  if (porcelain) {
    for (const line of porcelain.split("\n")) {
      if (!line) continue;
      // XY PATH or XY ORIG -> PATH for renames
      const status = line.slice(0, 2).trim() || line.slice(0, 1);
      let filePath = line.slice(3);
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ").pop() || filePath;
      }
      filePath = filePath.replace(/^"|"$/g, "");
      const letter =
        status === "??"
          ? "??"
          : (status.replace(/\s/g, "").slice(-1) || status[0] || "M");
      byPath.set(filePath, {
        path: filePath,
        status: letter === "?" ? "??" : letter,
        additions: 0,
        deletions: 0,
      });
    }
  }

  // numstat for tracked diffs vs HEAD
  let numstat = "";
  try {
    numstat = gitOut(cwd, ["diff", "HEAD", "--numstat"]);
  } catch (err) {
    if (!isNoHeadError(err)) {
      throw new Error(`git diff --numstat failed: ${String(err.message || err).split("\n")[0]}`);
    }
    numstat = "";
  }
  if (numstat) {
    for (const line of numstat.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const addStr = parts[0];
      const delStr = parts[1];
      const filePath = parts.slice(2).join("\t");
      const additions = addStr === "-" ? 0 : parseInt(addStr, 10) || 0;
      const deletions = delStr === "-" ? 0 : parseInt(delStr, 10) || 0;
      const existing = byPath.get(filePath);
      if (existing) {
        existing.additions = additions;
        existing.deletions = deletions;
      } else {
        byPath.set(filePath, {
          path: filePath,
          status: "M",
          additions,
          deletions,
        });
      }
    }
  }

  // Untracked: additions = line count
  for (const entry of byPath.values()) {
    if (entry.status === "??") {
      try {
        const full = path.join(cwd, entry.path);
        const text = fs.readFileSync(full, "utf8");
        entry.additions = text.length === 0 ? 0 : text.split(/\r?\n/).length;
        // If file ends with newline, split overcounts by 1 trailing empty — keep simple line count
        if (text.endsWith("\n") && entry.additions > 0) {
          entry.additions -= 1;
        }
        // Actually for "line1\nline2\nline3\n" split gives 4 parts with trailing empty → 3 after adjust. Good.
        // For "line1\nline2\nline3" (no trailing nl) split gives 3 → no adjust needed... endsWith false → 3. Good.
        entry.deletions = 0;
      } catch {
        entry.additions = 0;
        entry.deletions = 0;
      }
    }
  }

  let patch = "";
  try {
    patch = gitOut(cwd, ["diff", "HEAD"]);
  } catch (err) {
    if (!isNoHeadError(err)) {
      throw new Error(`git diff failed: ${String(err.message || err).split("\n")[0]}`);
    }
    patch = "";
  }

  let truncated = false;
  if (patch.length > PATCH_TRUNCATE) {
    patch = patch.slice(0, PATCH_TRUNCATE);
    truncated = true;
  }

  return {
    files: [...byPath.values()],
    patch,
    truncated,
  };
}

module.exports = {
  setupWorktree,
  diff,
  slugify,
  PATCH_TRUNCATE,
};
