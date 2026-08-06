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

/**
 * Run git without throwing. Returns { ok, stdout, stderr, combined }.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ raw?: boolean }} [opts]
 */
function gitTry(cwd, args, opts) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_MAX_BUFFER,
    });
    const stdout = opts && opts.raw ? out : out.trim();
    return { ok: true, stdout, stderr: "", combined: stdout };
  } catch (err) {
    const stdout = err && err.stdout != null ? String(err.stdout) : "";
    const stderr = err && err.stderr != null ? String(err.stderr) : "";
    const msg = err && err.message ? String(err.message) : String(err);
    const combined = [stdout, stderr, msg].filter(Boolean).join("\n");
    return { ok: false, stdout, stderr, combined, error: err };
  }
}

/**
 * Default branch currently checked out in the project path.
 * @param {string} projectPath
 * @returns {string}
 */
function defaultBranch(projectPath) {
  const branch = gitOut(projectPath, ["branch", "--show-current"]);
  if (!branch) {
    throw new Error(
      "Project checkout is detached HEAD; check out a branch before merging",
    );
  }
  return branch;
}

/**
 * Clear thread worktree fields, remove worktree dir + branch, save, broadcast.
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {object} opts.thread
 * @param {object} opts.project
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @param {boolean} [opts.forceRemove] - true for removeWorktree; false for merge
 * @returns {object} updated ThreadInfo
 */
function cleanupWorktree(opts) {
  const { store, thread, project, broadcast, forceRemove } = opts;
  const wtPath = thread.worktreePath;
  const branch = thread.branch;

  if (wtPath) {
    const args = forceRemove
      ? ["worktree", "remove", "--force", wtPath]
      : ["worktree", "remove", wtPath];
    const rem = gitTry(project.path, args);
    if (!rem.ok) {
      throw new Error(
        `Failed to remove worktree: ${rem.combined.split("\n")[0]}`,
      );
    }
  }

  if (branch) {
    const del = gitTry(project.path, ["branch", "-D", branch]);
    // Branch may already be gone; ignore "not found"
    if (
      !del.ok &&
      !/not found|doesn't exist|unknown branch|no such branch/i.test(
        del.combined,
      )
    ) {
      throw new Error(
        `Failed to delete branch ${branch}: ${del.combined.split("\n")[0]}`,
      );
    }
  }

  const updated = store.updateThread(thread.id, {
    worktreePath: null,
    branch: null,
  });
  store.save();

  if (typeof broadcast === "function") {
    const { listThreads } = require("./services.js");
    broadcast("threads:changed", listThreads(store));
  }

  return updated
    ? { ...updated }
    : { ...thread, worktreePath: null, branch: null };
}

/**
 * Squash-merge the thread worktree into the project default branch, then remove
 * the worktree and branch. Commits any uncommitted worktree changes first.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {object} updated ThreadInfo
 */
function mergeWorktree(opts) {
  const { store, threadId, broadcast } = opts;

  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.worktreePath) {
    throw new Error(
      `Thread ${threadId} has no worktree; call setupWorktree first`,
    );
  }
  if (!thread.branch) {
    throw new Error(`Thread ${threadId} has no worktree branch`);
  }

  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }

  const wtPath = thread.worktreePath;
  const branch = thread.branch;

  // (a) Commit any uncommitted worktree changes
  const wtStatus = gitOut(wtPath, ["status", "--porcelain", "-uall"], {
    raw: true,
  }).trim();
  if (wtStatus) {
    gitOut(wtPath, ["add", "-A"]);
    const commitMsg = `coder: session changes for ${thread.title}`;
    const committed = gitTry(wtPath, ["commit", "-m", commitMsg]);
    if (!committed.ok) {
      throw new Error(
        `Failed to commit worktree changes: ${committed.combined.split("\n")[0]}`,
      );
    }
  }

  // (b) Project default branch (must not be detached)
  const baseBranch = defaultBranch(project.path);

  // (c) Refuse dirty project checkout; squash-merge then commit
  const mainStatus = gitOut(project.path, ["status", "--porcelain"], {
    raw: true,
  }).trim();
  if (mainStatus) {
    throw new Error(
      "Project checkout has uncommitted changes; commit or stash before merging",
    );
  }

  const mergeResult = gitTry(project.path, ["merge", "--squash", branch]);
  if (!mergeResult.ok) {
    // Restore clean checkout after conflict / failed squash
    gitTry(project.path, ["merge", "--abort"]);
    gitTry(project.path, ["reset", "--hard", "HEAD"]);
    throw new Error(
      `Merge conflict while squash-merging ${branch}:\n${mergeResult.combined}`,
    );
  }

  const commitMsg = `Merge worktree ${branch}: ${thread.title}`;
  const commitResult = gitTry(project.path, ["commit", "-m", commitMsg]);
  if (!commitResult.ok) {
    const nothing =
      /nothing to commit|no changes added to commit/i.test(
        commitResult.combined,
      );
    if (!nothing) {
      // Unexpected commit failure: restore and report
      gitTry(project.path, ["merge", "--abort"]);
      gitTry(project.path, ["reset", "--hard", "HEAD"]);
      throw new Error(
        `Failed to commit merge: ${commitResult.combined.split("\n")[0]}`,
      );
    }
    // Empty squash (no net changes): still clean up worktree
    gitTry(project.path, ["reset", "--hard", "HEAD"]);
  }

  // (d) Remove worktree + branch, clear thread fields
  return cleanupWorktree({
    store,
    thread,
    project,
    broadcast,
    forceRemove: false,
  });
}

/**
 * Delete the thread worktree and branch without merging.
 * Rejects when dirty or unmerged unless force is true.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {boolean} [opts.force]
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {object} updated ThreadInfo
 */
function removeWorktree(opts) {
  const { store, threadId, force, broadcast } = opts;

  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.worktreePath) {
    throw new Error(
      `Thread ${threadId} has no worktree; nothing to remove`,
    );
  }

  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }

  const wtPath = thread.worktreePath;
  const branch = thread.branch;

  if (!force) {
    /** @type {string[]} */
    const lost = [];

    const wtStatus = gitOut(wtPath, ["status", "--porcelain", "-uall"], {
      raw: true,
    });
    if (wtStatus.trim()) {
      for (const line of wtStatus.split("\n")) {
        if (!line) continue;
        // XY PATH
        let filePath = line.slice(3);
        if (filePath.includes(" -> ")) {
          filePath = filePath.split(" -> ").pop() || filePath;
        }
        filePath = filePath.replace(/^"|"$/g, "");
        lost.push(`uncommitted: ${filePath}`);
      }
    }

    if (branch) {
      let base = null;
      try {
        base = defaultBranch(project.path);
      } catch {
        // Detached/unknown default branch: cannot prove the branch is merged.
        // List recent branch commits so the caller knows what would be lost.
        const log = gitTry(project.path, [
          "log",
          "-n",
          "10",
          "--oneline",
          branch,
        ]);
        if (log.ok && log.stdout.trim()) {
          for (const line of log.stdout.trim().split("\n")) {
            if (line) lost.push(`unmerged: ${line}`);
          }
        }
        if (
          !lost.some((e) => e.startsWith("unmerged:"))
        ) {
          lost.push(
            `unmerged: cannot prove ${branch} is merged (detached HEAD)`,
          );
        }
      }
      if (base) {
        const log = gitTry(project.path, [
          "log",
          `${base}..${branch}`,
          "--oneline",
        ]);
        if (log.ok && log.stdout.trim()) {
          for (const line of log.stdout.trim().split("\n")) {
            if (line) lost.push(`unmerged: ${line}`);
          }
        }
      }
    }

    if (lost.length > 0) {
      const shown = lost.slice(0, 10);
      const more =
        lost.length > 10 ? `\n... and ${lost.length - 10} more` : "";
      // Marker stays at the start of OUR message so Electron's
      // "Error invoking remote method '...': Error: WORKTREE_DIRTY: ..." wrap
      // still matches message.includes("WORKTREE_DIRTY:") in the renderer.
      throw new Error(
        `WORKTREE_DIRTY: removing would lose:\n${shown.join("\n")}${more}`,
      );
    }
  }

  return cleanupWorktree({
    store,
    thread: { ...thread, branch: branch || thread.branch },
    project,
    broadcast,
    forceRemove: true,
  });
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
  mergeWorktree,
  removeWorktree,
  slugify,
  PATCH_TRUNCATE,
};
