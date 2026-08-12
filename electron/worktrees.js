"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, execFile } = require("node:child_process");

const PATCH_TRUNCATE = 100_000;

const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** Per-thread background PR refresh timeout. Hard kill; never block the main process. */
const PR_REFRESH_TIMEOUT_MS = 8_000;

/** MERGED/CLOSED are terminal — never re-query. */
const TERMINAL_PR_STATES = new Set(["MERGED", "CLOSED"]);

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
 * @param {{ raw?: boolean, env?: NodeJS.ProcessEnv, timeout?: number }} [opts]
 */
function gitTry(cwd, args, opts) {
  try {
    /** @type {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} */
    const execOpts = {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_MAX_BUFFER,
    };
    if (opts && opts.env) {
      execOpts.env = { ...process.env, ...opts.env };
    }
    if (opts && opts.timeout != null) {
      execOpts.timeout = opts.timeout;
    }
    const out = execFileSync("git", args, execOpts);
    const stdout = opts && opts.raw ? out : out.trim();
    return { ok: true, stdout, stderr: "", combined: stdout };
  } catch (err) {
    const stdout = err && err.stdout != null ? String(err.stdout) : "";
    const stderr = err && err.stderr != null ? String(err.stderr) : "";
    const msg = err && err.message ? String(err.message) : String(err);
    const timedOut =
      (err && err.code === "ETIMEDOUT") ||
      (err && err.killed && /ETIMEDOUT|timed out/i.test(msg));
    const combined = [stdout, stderr, msg].filter(Boolean).join("\n");
    return {
      ok: false,
      stdout,
      stderr,
      combined,
      error: err,
      timedOut: Boolean(timedOut),
    };
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

/**
 * Resolve the git cwd for a thread (worktree when bound, else the project
 * checkout), throwing the same unknown-thread/project errors as diff().
 * @param {import('./store').Store} store
 * @param {string} threadId
 */
function threadGitCwd(store, threadId) {
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }
  return { thread, project, cwd: thread.worktreePath || project.path };
}

/**
 * Commit every change in the thread's tree (add -A + commit -m). The message
 * is one argv element, never shell-interpolated.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.message
 * @returns {{ subject: string }}
 */
function commit(opts) {
  const { store, threadId } = opts;
  const message = String(opts.message || "").trim();
  if (!message) {
    throw new Error("Commit message is empty");
  }
  const { cwd } = threadGitCwd(store, threadId);
  if (!gitOut(cwd, ["status", "--porcelain", "-uall"])) {
    throw new Error("Nothing to commit");
  }
  const add = gitTry(cwd, ["add", "-A"]);
  if (!add.ok) {
    throw new Error(tailErr(add.stderr || add.combined, "git add failed"));
  }
  const res = gitTry(cwd, ["commit", "-m", message]);
  if (!res.ok) {
    throw new Error(tailErr(res.stderr || res.combined, "git commit failed"));
  }
  return { subject: message.split("\n")[0] };
}

/**
 * Discard one file's changes from the thread's tree.
 * - untracked ("??"): delete from disk
 * - staged-new ("A"): remove from index and disk
 * - anything else: restore index + worktree from HEAD
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.path - repo-relative path from the diff file list
 * @param {string} opts.status - status letter from the diff file list
 * @returns {{ path: string }}
 */
function revertFile(opts) {
  const { store, threadId, status } = opts;
  const relPath = String(opts.path || "");
  if (!relPath || path.isAbsolute(relPath)) {
    throw new Error(`Invalid path: ${relPath || "(empty)"}`);
  }
  const { cwd } = threadGitCwd(store, threadId);
  const full = path.resolve(cwd, relPath);
  if (full !== cwd && !full.startsWith(cwd + path.sep)) {
    throw new Error(`Path escapes the working tree: ${relPath}`);
  }
  if (status === "??") {
    fs.rmSync(full, { recursive: true, force: true });
    return { path: relPath };
  }
  if (status === "A") {
    const rm = gitTry(cwd, ["rm", "-f", "--", relPath]);
    if (!rm.ok) {
      throw new Error(tailErr(rm.stderr || rm.combined, "git rm failed"));
    }
    return { path: relPath };
  }
  const res = gitTry(cwd, [
    "restore",
    "--staged",
    "--worktree",
    "--",
    relPath,
  ]);
  if (!res.ok) {
    throw new Error(tailErr(res.stderr || res.combined, "git restore failed"));
  }
  return { path: relPath };
}

const LS_FILES_CAP = 20000;
const LIST_FILES_RESULT = 20;

/**
 * Files matchable by the composer's @-mention popup: tracked plus untracked
 * (gitignored excluded), filtered case-insensitively by substring. Paths that
 * START with the query rank above mid-string matches.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} [opts.query]
 * @returns {{ files: string[] }}
 */
function listFiles(opts) {
  const { store, threadId } = opts;
  const query = String(opts.query || "").toLowerCase();
  const { cwd } = threadGitCwd(store, threadId);
  const out = gitTry(cwd, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (!out.ok) {
    throw new Error(
      tailErr(out.stderr || out.combined, "git ls-files failed"),
    );
  }
  const all = out.stdout.split("\n").filter(Boolean).slice(0, LS_FILES_CAP);
  const matched = query
    ? all.filter((p) => p.toLowerCase().includes(query))
    : all;
  matched.sort((a, b) => {
    const aPrefix = a.toLowerCase().startsWith(query) ? 0 : 1;
    const bPrefix = b.toLowerCase().startsWith(query) ? 0 : 1;
    return aPrefix - bPrefix;
  });
  return { files: matched.slice(0, LIST_FILES_RESULT) };
}

/**
 * Push the thread's current branch (worktree if set, else project checkout)
 * to origin with -u.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {{ remote: string, branch: string }}
 */
function push(opts) {
  const { store, threadId, broadcast } = opts;

  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }

  const cwd = thread.worktreePath || project.path;

  let branch = "";
  try {
    branch = gitOut(cwd, ["branch", "--show-current"]);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(
      `Could not determine current branch: ${msg.split("\n")[0]}`,
    );
  }
  if (!branch) {
    throw new Error(
      "Checkout is detached HEAD or has no branch name; check out a branch before pushing",
    );
  }

  const remote = gitTry(cwd, ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    throw new Error("No git remote configured for this project.");
  }

  // Never prompt for credentials on the main process; cap wait so a hung
  // remote cannot freeze Electron.
  const result = gitTry(cwd, ["push", "-u", "origin", branch], {
    env: { GIT_TERMINAL_PROMPT: "0" },
    timeout: 30_000,
  });
  if (!result.ok) {
    if (result.timedOut) {
      throw new Error("git push timed out after 30s");
    }
    const errText = (result.stderr || result.combined || "").trim();
    // Last 300 chars (tail), not the head: useful error text is often at the end.
    const tail =
      (errText.length <= 300 ? errText : errText.slice(-300)) ||
      "git push failed";
    throw new Error(tail);
  }

  if (typeof broadcast === "function") {
    const { listThreads } = require("./services.js");
    broadcast("threads:changed", listThreads(store));
  }

  return { remote: "origin", branch };
}

const GH_TIMEOUT_MS = 30_000;

/**
 * Resolve the gh binary. Tests set CODER_GH_BIN to a fake; production uses PATH.
 * @returns {string}
 */
function ghBin() {
  return process.env.CODER_GH_BIN || "gh";
}

/**
 * True when origin points at github.com (https, ssh, or git@).
 * Local bare paths, gitlab, and arbitrary ssh hosts return false.
 * @param {string} url
 * @returns {boolean}
 */
function isGitHubRemote(url) {
  const s = String(url || "").trim();
  if (!s) return false;
  if (/^git@github\.com:/i.test(s)) return true;
  if (/^ssh:\/\/([^@/\s]+@)?github\.com\//i.test(s)) return true;
  if (/^https?:\/\/(www\.)?github\.com\//i.test(s)) return true;
  return false;
}

/**
 * Tail-trim stderr/combined the same way push does (last 300 chars).
 * @param {string} errText
 * @param {string} fallback
 * @returns {string}
 */
function tailErr(errText, fallback) {
  const t = String(errText || "").trim();
  if (!t) return fallback;
  return t.length <= 300 ? t : t.slice(-300);
}

/**
 * Classify a failed execFileSync/execFile error into the shared ghTry shape.
 * @param {any} err
 * @returns {{ ok: false, enoent: boolean, stdout: string, stderr: string, combined: string, error: any, timedOut: boolean }}
 */
function ghFailFromError(err) {
  if (err && err.code === "ENOENT") {
    return {
      ok: false,
      enoent: true,
      stdout: "",
      stderr: "",
      combined: "",
      error: err,
      timedOut: false,
    };
  }
  const stdout = err && err.stdout != null ? String(err.stdout) : "";
  const stderr = err && err.stderr != null ? String(err.stderr) : "";
  const msg = err && err.message ? String(err.message) : String(err);
  // Node marks timeout kills with err.killed + ETIMEDOUT / "timed out" message.
  const timedOut =
    (err && err.code === "ETIMEDOUT") ||
    (err && err.killed && /ETIMEDOUT|timed out/i.test(msg)) ||
    (err && err.killed === true && err.signal != null);
  const combined = [stdout, stderr, msg].filter(Boolean).join("\n");
  return {
    ok: false,
    enoent: false,
    stdout,
    stderr,
    combined,
    error: err,
    timedOut: Boolean(timedOut),
  };
}

/**
 * Run gh without throwing. Mirrors gitTry: timeout, no prompt, enoent flag.
 * SYNC — only for interactive createPr/prStatus paths that already run off
 * the UI thread via ipcMain.handle. Background refresh MUST use ghTryAsync.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeout?: number }} [opts]
 */
function ghTry(cwd, args, opts) {
  const timeout =
    opts && opts.timeout != null ? opts.timeout : GH_TIMEOUT_MS;
  try {
    /** @type {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} */
    const execOpts = {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_MAX_BUFFER,
      timeout,
      env: {
        ...process.env,
        ...(opts && opts.env ? opts.env : {}),
        // Never prompt for auth/input on the main process.
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    };
    const out = execFileSync(ghBin(), args, execOpts);
    const stdout = out.trim();
    return { ok: true, stdout, stderr: "", combined: stdout };
  } catch (err) {
    return ghFailFromError(err);
  }
}

/**
 * Async gh. NEVER blocks the Electron main process. Uses execFile (not Sync)
 * with a hard timeout that kills the child. Used by the PR-state refresher.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeout?: number }} [opts]
 * @returns {Promise<{ ok: boolean, enoent?: boolean, stdout: string, stderr: string, combined: string, timedOut?: boolean, error?: any }>}
 */
function ghTryAsync(cwd, args, opts) {
  const timeout =
    opts && opts.timeout != null ? opts.timeout : PR_REFRESH_TIMEOUT_MS;
  const env = {
    ...process.env,
    ...(opts && opts.env ? opts.env : {}),
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  return new Promise((resolve) => {
    execFile(
      ghBin(),
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        timeout,
        env,
      },
      (err, stdout, stderr) => {
        if (!err) {
          const out = String(stdout || "").trim();
          resolve({ ok: true, stdout: out, stderr: "", combined: out });
          return;
        }
        // Attach stdout/stderr from the callback when the error object lacks them.
        if (err && err.stdout == null && stdout != null) err.stdout = stdout;
        if (err && err.stderr == null && stderr != null) err.stderr = stderr;
        resolve(ghFailFromError(err));
      },
    );
  });
}

/**
 * Throw a clear Error from a failed ghTry result (or ENOENT / timeout).
 * @param {{ ok: boolean, enoent?: boolean, timedOut?: boolean, stderr?: string, combined?: string }} result
 * @param {string} fallback
 */
function throwGhFailure(result, fallback) {
  if (result.enoent) {
    throw new Error("GitHub CLI (gh) is not installed");
  }
  if (result.timedOut) {
    throw new Error("gh timed out after 30s");
  }
  throw new Error(tailErr(result.stderr || result.combined, fallback));
}

/**
 * Parse `gh pr view --json number,url,state` into a PrInfo-shaped object.
 * @param {string} stdout
 * @param {string} branch
 * @param {boolean} created
 * @returns {{ number: number, url: string, state: "OPEN" | "CLOSED" | "MERGED", branch: string, created: boolean }}
 */
function parsePrJson(stdout, branch, created) {
  let data;
  try {
    data = JSON.parse(String(stdout || "").trim());
  } catch {
    throw new Error("gh returned unparseable PR JSON");
  }
  const number = Number(data && data.number);
  const url = data && data.url != null ? String(data.url) : "";
  if (!Number.isFinite(number) || number <= 0 || !url) {
    throw new Error("gh returned incomplete PR JSON");
  }
  const raw = String((data && data.state) || "OPEN").toUpperCase();
  /** @type {"OPEN" | "CLOSED" | "MERGED"} */
  const state =
    raw === "MERGED" ? "MERGED" : raw === "CLOSED" ? "CLOSED" : "OPEN";
  return { number, url, state, branch, created: Boolean(created) };
}

/**
 * True when gh exit means "no PR for this branch" (not an env failure).
 * @param {string} text
 * @returns {boolean}
 */
function isNoPrMessage(text) {
  // Deliberately narrow. A bare /not found/ also matches "HTTP 404: Not Found",
  // which is a deleted or renamed repo or a token without scope, and treating
  // that as "no PR yet" hides a real failure behind a spurious create attempt.
  return /no (open )?pull requests? found|no pull request found/i.test(
    String(text || ""),
  );
}

/**
 * Resolve thread cwd + current branch name (same rules as push).
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @returns {{ thread: object, project: object, cwd: string, branch: string, originUrl: string }}
 */
function resolveThreadGit(store, threadId) {
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }

  const cwd = thread.worktreePath || project.path;

  let branch = "";
  try {
    branch = gitOut(cwd, ["branch", "--show-current"]);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(
      `Could not determine current branch: ${msg.split("\n")[0]}`,
    );
  }
  if (!branch) {
    throw new Error(
      "Checkout is detached HEAD or has no branch name; check out a branch before opening a PR",
    );
  }

  const remote = gitTry(cwd, ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    throw new Error("No git remote configured for this project.");
  }
  const originUrl = String(remote.stdout || "").trim();

  return { thread, project, cwd, branch, originUrl };
}

/**
 * Live PR for the thread's branch, or null when none exists.
 * Rejects on gh missing / not authenticated / non-GitHub remote.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @returns {{ number: number, url: string, state: "OPEN" | "CLOSED" | "MERGED", branch: string, created: boolean } | null}
 */
function prStatus(opts) {
  const { store, threadId } = opts;
  const { cwd, branch, originUrl } = resolveThreadGit(store, threadId);

  if (!isGitHubRemote(originUrl)) {
    throw new Error(
      `Remote origin is not a GitHub repository (got: ${originUrl}). PR status requires github.com.`,
    );
  }

  const viewed = ghTry(cwd, [
    "pr",
    "view",
    branch,
    "--json",
    "number,url,state",
  ]);
  if (!viewed.ok) {
    if (viewed.enoent || viewed.timedOut) {
      throwGhFailure(viewed, "gh pr view failed");
    }
    if (isNoPrMessage(viewed.stderr || viewed.combined || viewed.stdout)) {
      return null;
    }
    throwGhFailure(viewed, "gh pr view failed");
  }

  const info = parsePrJson(viewed.stdout, branch, false);
  // Persist last-known PR state (interactive path). Background freshness is
  // refreshPrStates — async, serialized, failure-silent, on a latch.
  store.updateThread(threadId, {
    prNumber: info.number,
    prUrl: info.url,
    prState: info.state,
  });
  store.save();
  return info;
}

/**
 * True when a thread should be considered for background PR-state refresh:
 * has a prNumber, is not archived, and prState is not already terminal.
 * @param {object} t
 * @returns {boolean}
 */
function isPrRefreshCandidate(t) {
  if (!t || typeof t !== "object") return false;
  if (t.archived) return false;
  if (t.prNumber == null || !Number.isFinite(Number(t.prNumber))) return false;
  const raw =
    t.prState == null || t.prState === ""
      ? null
      : String(t.prState).toUpperCase();
  if (raw && TERMINAL_PR_STATES.has(raw)) return false;
  return true;
}

/**
 * Lazy background PR-state refresh for non-archived threads with a prNumber
 * whose prState is not yet terminal (MERGED/CLOSED).
 *
 * Structural guarantees (docs/ISSUES.md):
 * - gh is ALWAYS async (execFile, never execFileSync) so the main process
 *   cannot freeze the way prStatus once did.
 * - Strictly serialized: one gh at a time (for-await), never parallel.
 * - Hard per-call timeout (~8s) with kill.
 * - Non-GitHub origin, missing gh, network, timeout: skip silently — never
 *   surface an error, never persist a failure.
 * - ONE store.save() and ONE threads:changed push at the end iff anything
 *   actually changed.
 *
 * @param {import('./store').Store} store
 * @param {object} [opts]
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @param {number} [opts.timeoutMs] default PR_REFRESH_TIMEOUT_MS
 * @param {(cwd: string, args: string[], opts?: object) => Promise<object>} [opts.ghTryAsyncFn] test inject
 * @returns {Promise<{ examined: number, changed: number, spawned: number }>}
 */
async function refreshPrStates(store, opts) {
  const broadcast = opts && opts.broadcast;
  const timeoutMs =
    opts && opts.timeoutMs != null ? opts.timeoutMs : PR_REFRESH_TIMEOUT_MS;
  const runGh =
    opts && typeof opts.ghTryAsyncFn === "function"
      ? opts.ghTryAsyncFn
      : ghTryAsync;

  const candidates = store.getThreads().filter(isPrRefreshCandidate);
  if (candidates.length === 0) {
    return { examined: 0, changed: 0, spawned: 0 };
  }

  let changed = 0;
  let spawned = 0;

  // Strict serialization: await each call before starting the next.
  for (const snapshot of candidates) {
    const threadId = snapshot.id;
    try {
      let cwd;
      let originUrl;
      try {
        const resolved = resolveThreadGit(store, threadId);
        cwd = resolved.cwd;
        originUrl = resolved.originUrl;
      } catch {
        // Missing project/cwd/branch: not an event. Skip.
        continue;
      }
      if (!isGitHubRemote(originUrl)) {
        // Non-GitHub origin must never paint an error (ISSUES.md). Skip.
        continue;
      }

      const prNumber = Number(snapshot.prNumber);
      spawned += 1;
      const viewed = await runGh(
        cwd,
        ["pr", "view", String(prNumber), "--json", "number,url,state"],
        { timeout: timeoutMs },
      );
      if (!viewed || !viewed.ok) {
        // gh missing / network / timeout / no-PR: skip silently.
        continue;
      }

      let info;
      try {
        info = parsePrJson(viewed.stdout, "", false);
      } catch {
        continue;
      }

      const current = store.getThread(threadId);
      if (!current) continue;

      const nextState = info.state;
      const nextUrl = info.url;
      const nextNumber = info.number;
      if (
        current.prState === nextState &&
        current.prUrl === nextUrl &&
        current.prNumber === nextNumber
      ) {
        continue;
      }

      // Do not touch updatedAt: a background PR poll is not user activity.
      store.updateThread(threadId, {
        prNumber: nextNumber,
        prUrl: nextUrl,
        prState: nextState,
      });
      changed += 1;
    } catch {
      // A refresh failure is not an event. Never throw out of the loop.
      continue;
    }
  }

  if (changed > 0) {
    store.save();
    if (typeof broadcast === "function") {
      const { listThreads } = require("./services.js");
      broadcast("threads:changed", listThreads(store));
    }
  }

  return { examined: candidates.length, changed, spawned };
}

/**
 * Schedule + latch for background PR refresh.
 * - Boolean latch: a tick during a running pass is a no-op (not queued).
 * - Startup pass after startupDelayMs; then every intervalMs.
 * - Timers are unref'd so they do not keep a short-lived process alive.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @param {number} [opts.intervalMs] default 5 min
 * @param {number} [opts.startupDelayMs] default 30s
 * @param {typeof setTimeout} [opts.setTimeoutFn]
 * @param {typeof setInterval} [opts.setIntervalFn]
 * @param {typeof clearTimeout} [opts.clearTimeoutFn]
 * @param {typeof clearInterval} [opts.clearIntervalFn]
 * @param {typeof refreshPrStates} [opts.refreshFn]
 * @param {object} [opts.refreshOpts] forwarded into refreshFn (timeoutMs, ghTryAsyncFn)
 */
function createPrStateRefresher(opts) {
  const store = opts.store;
  const broadcast = opts.broadcast;
  const intervalMs =
    opts.intervalMs != null ? opts.intervalMs : 5 * 60 * 1000;
  const startupDelayMs =
    opts.startupDelayMs != null ? opts.startupDelayMs : 30_000;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const refreshFn = opts.refreshFn || refreshPrStates;
  const refreshOpts = opts.refreshOpts || {};

  let running = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let startupTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let intervalTimer = null;

  /**
   * @returns {Promise<{ ran: boolean, result?: { examined: number, changed: number, spawned: number } | null }>}
   */
  async function trigger() {
    if (running) return { ran: false };
    running = true;
    try {
      const result = await refreshFn(store, {
        broadcast,
        ...refreshOpts,
      });
      return { ran: true, result };
    } catch {
      // refreshPrStates is failure-silent; this is belt-and-suspenders.
      return { ran: true, result: null };
    } finally {
      running = false;
    }
  }

  function start() {
    if (startupTimer != null || intervalTimer != null) return;
    startupTimer = setTimeoutFn(() => {
      startupTimer = null;
      void trigger();
    }, startupDelayMs);
    if (startupTimer && typeof startupTimer.unref === "function") {
      startupTimer.unref();
    }
    intervalTimer = setIntervalFn(() => {
      void trigger();
    }, intervalMs);
    if (intervalTimer && typeof intervalTimer.unref === "function") {
      intervalTimer.unref();
    }
  }

  function stop() {
    if (startupTimer != null) {
      clearTimeoutFn(startupTimer);
      startupTimer = null;
    }
    if (intervalTimer != null) {
      clearIntervalFn(intervalTimer);
      intervalTimer = null;
    }
  }

  return {
    trigger,
    start,
    stop,
    isRunning: () => running,
  };
}

/**
 * Push the thread branch, open a GitHub PR via gh, persist prNumber/prUrl.
 * Idempotent: an existing PR is returned with created:false.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {boolean} [opts.draft]
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {{ number: number, url: string, state: "OPEN" | "CLOSED" | "MERGED", branch: string, created: boolean }}
 */
function createPr(opts) {
  const { store, threadId, title, body, draft, broadcast } = opts;

  const { project, cwd, branch, originUrl } = resolveThreadGit(
    store,
    threadId,
  );

  if (!isGitHubRemote(originUrl)) {
    throw new Error(
      `Remote origin is not a GitHub repository (got: ${originUrl}). PR creation requires github.com.`,
    );
  }

  const baseBranch = defaultBranch(project.path);
  const ahead = gitTry(cwd, ["log", `${baseBranch}..${branch}`, "--oneline"]);
  if (!ahead.ok) {
    throw new Error(
      `Could not compare branch to ${baseBranch}: ${tailErr(ahead.combined, "git log failed")}`,
    );
  }
  if (!String(ahead.stdout || "").trim()) {
    throw new Error(
      `Branch has no commits ahead of ${baseBranch}; nothing to propose in a pull request`,
    );
  }

  // Reuse push for remote/branch/timeout/prompt discipline; no intermediate broadcast.
  push({ store, threadId });

  // Idempotency: return the existing PR rather than erroring.
  const existing = ghTry(cwd, [
    "pr",
    "view",
    branch,
    "--json",
    "number,url,state",
  ]);
  // Only an OPEN PR short-circuits. gh pr view also returns CLOSED and MERGED
  // ones, and returning those would permanently block opening a follow-up PR
  // from a branch whose first PR was already merged.
  const existingInfo = existing.ok
    ? parsePrJson(existing.stdout, branch, false)
    : null;
  if (existingInfo && existingInfo.state === "OPEN") {
    const info = existingInfo;
    store.updateThread(threadId, {
      prNumber: info.number,
      prUrl: info.url,
      prState: info.state,
    });
    store.save();
    if (typeof broadcast === "function") {
      const { listThreads } = require("./services.js");
      broadcast("threads:changed", listThreads(store));
    }
    return info;
  }
  // A successful view of a CLOSED or MERGED PR is not a failure: it just means
  // there is no CURRENT PR, so fall through and open one. Only classify the
  // error text when the view itself actually failed.
  if (!existing.ok) {
    if (existing.enoent || existing.timedOut) {
      throwGhFailure(existing, "gh pr view failed");
    }
    if (!isNoPrMessage(existing.stderr || existing.combined || existing.stdout)) {
      // Auth / network / other: surface gh's own message (tail-trimmed).
      throwGhFailure(existing, "gh pr view failed");
    }
  }

  /** @type {string[]} */
  const createArgs = [
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    branch,
    "--title",
    String(title ?? ""),
    "--body",
    body != null ? String(body) : "",
  ];
  if (draft) {
    createArgs.push("--draft");
  }

  const created = ghTry(cwd, createArgs);
  if (!created.ok) {
    // Race: PR appeared between view and create. Prefer idempotent return.
    if (!created.enoent && !created.timedOut) {
      const raced = ghTry(cwd, [
        "pr",
        "view",
        branch,
        "--json",
        "number,url,state",
      ]);
      // Same OPEN filter as the first lookup. Without it a MERGED PR on this
      // branch turns a genuine create failure into a silent success: we would
      // return the old merged PR, swallow gh's error, and stamp the store.
      const racedInfo = raced.ok
        ? parsePrJson(raced.stdout, branch, false)
        : null;
      if (racedInfo && racedInfo.state === "OPEN") {
        const info = racedInfo;
        store.updateThread(threadId, {
          prNumber: info.number,
          prUrl: info.url,
          prState: info.state,
        });
        store.save();
        if (typeof broadcast === "function") {
          const { listThreads } = require("./services.js");
          broadcast("threads:changed", listThreads(store));
        }
        return info;
      }
    }
    throwGhFailure(created, "gh pr create failed");
  }

  // create prints a URL; re-view for number/state so we match PrInfo exactly.
  const viewed = ghTry(cwd, [
    "pr",
    "view",
    branch,
    "--json",
    "number,url,state",
  ]);
  if (!viewed.ok) {
    // Fall back to URL-only parse from create stdout when view is flaky.
    const urlMatch = String(created.stdout || "").match(
      /https:\/\/github\.com\/[^\s]+/i,
    );
    if (urlMatch) {
      const url = urlMatch[0];
      const numMatch = url.match(/\/pull\/(\d+)/i);
      if (numMatch) {
        const info = {
          number: Number(numMatch[1]),
          url,
          state: /** @type {"OPEN"} */ ("OPEN"),
          branch,
          created: true,
        };
        store.updateThread(threadId, {
          prNumber: info.number,
          prUrl: info.url,
          prState: info.state,
        });
        store.save();
        if (typeof broadcast === "function") {
          const { listThreads } = require("./services.js");
          broadcast("threads:changed", listThreads(store));
        }
        return info;
      }
    }
    throwGhFailure(viewed, "gh pr view failed after create");
  }

  const info = parsePrJson(viewed.stdout, branch, true);
  store.updateThread(threadId, {
    prNumber: info.number,
    prUrl: info.url,
    prState: info.state,
  });
  store.save();
  if (typeof broadcast === "function") {
    const { listThreads } = require("./services.js");
    broadcast("threads:changed", listThreads(store));
  }
  return info;
}

// ---------------------------------------------------------------------------
// Round 50: worktree turn checkpoints (async git only — never execFileSync)
// ---------------------------------------------------------------------------

const CHECKPOINT_SUBJECT_PREFIX = "coder-checkpoint: turn ";
const CHECKPOINT_GIT_TIMEOUT_MS = 30_000;

/**
 * Async git. Never blocks the Electron main process (round-47 discipline).
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeout?: number, env?: NodeJS.ProcessEnv, raw?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, combined: string, timedOut?: boolean }>}
 */
function gitTryAsync(cwd, args, opts) {
  const timeout =
    opts && opts.timeout != null ? opts.timeout : CHECKPOINT_GIT_TIMEOUT_MS;
  const env = {
    ...process.env,
    ...(opts && opts.env ? opts.env : {}),
    GIT_TERMINAL_PROMPT: "0",
  };
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        timeout,
        env,
      },
      (err, stdout, stderr) => {
        if (!err) {
          const out = opts && opts.raw ? String(stdout || "") : String(stdout || "").trim();
          resolve({ ok: true, stdout: out, stderr: "", combined: out });
          return;
        }
        const out = err && err.stdout != null ? String(err.stdout) : String(stdout || "");
        const errText =
          err && err.stderr != null ? String(err.stderr) : String(stderr || "");
        const msg = err && err.message ? String(err.message) : String(err);
        const timedOut =
          (err && err.code === "ETIMEDOUT") ||
          (err && err.killed && /ETIMEDOUT|timed out/i.test(msg));
        resolve({
          ok: false,
          stdout: out,
          stderr: errText,
          combined: [out, errText, msg].filter(Boolean).join("\n"),
          timedOut: Boolean(timedOut),
        });
      },
    );
  });
}

/**
 * @param {string} subject
 * @returns {number | null}
 */
function parseCheckpointTurn(subject) {
  const m = String(subject || "").match(
    /^coder-checkpoint:\s*turn\s+(\d+)\s*$/i,
  );
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Count existing checkpoint commits in a worktree (any order).
 * @param {string} cwd
 * @returns {Promise<number>}
 */
async function countCheckpointCommits(cwd) {
  const log = await gitTryAsync(cwd, [
    "log",
    "--grep=coder-checkpoint:",
    "--format=%s",
  ]);
  if (!log.ok || !String(log.stdout || "").trim()) return 0;
  return String(log.stdout)
    .split(/\r?\n/)
    .filter((line) => parseCheckpointTurn(line) != null).length;
}

/**
 * After a successful turn: if the thread has a dirty WORKTREE, auto-commit
 * `coder-checkpoint: turn N`. Best-effort — never throws, never fails the turn.
 * Never touches the main project repo.
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @returns {Promise<{ sha: string, turn: number, message: string } | null>}
 */
async function maybeCreateCheckpoint(store, threadId) {
  try {
    const thread = store.getThread(threadId);
    if (!thread || !thread.worktreePath) return null;
    const cwd = thread.worktreePath;
    if (!fs.existsSync(cwd)) return null;

    const status = await gitTryAsync(cwd, ["status", "--porcelain", "-uall"], {
      raw: true,
    });
    if (!status.ok) return null;
    if (!String(status.stdout || "").trim()) return null; // clean → no commit

    const n = (await countCheckpointCommits(cwd)) + 1;
    const message = `${CHECKPOINT_SUBJECT_PREFIX}${n}`;

    const add = await gitTryAsync(cwd, ["add", "-A"]);
    if (!add.ok) return null;

    const commit = await gitTryAsync(cwd, [
      "-c",
      "user.email=coder@local",
      "-c",
      "user.name=Coder",
      "commit",
      "-m",
      message,
    ]);
    if (!commit.ok) return null;

    const rev = await gitTryAsync(cwd, ["rev-parse", "HEAD"]);
    if (!rev.ok || !rev.stdout) return { sha: "", turn: n, message };
    return { sha: String(rev.stdout).trim(), turn: n, message };
  } catch {
    return null;
  }
}

/**
 * List checkpoints in the thread worktree, newest-first.
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @returns {Promise<Array<{ sha: string, turn: number, message: string, at: number }>>}
 */
async function listCheckpoints(opts) {
  const { store, threadId } = opts;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.worktreePath) {
    return [];
  }
  const cwd = thread.worktreePath;
  if (!fs.existsSync(cwd)) return [];

  // %H sha, %ct committer unix, %s subject — newest first (git log default).
  const log = await gitTryAsync(cwd, [
    "log",
    "--grep=coder-checkpoint:",
    "--format=%H\t%ct\t%s",
  ]);
  if (!log.ok || !String(log.stdout || "").trim()) return [];

  /** @type {Array<{ sha: string, turn: number, message: string, at: number }>} */
  const out = [];
  for (const line of String(log.stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const sha = parts[0];
    const ct = Number(parts[1]);
    const message = parts.slice(2).join("\t");
    const turn = parseCheckpointTurn(message);
    if (turn == null) continue;
    out.push({
      sha,
      turn,
      message,
      at: Number.isFinite(ct) ? ct * 1000 : 0,
    });
  }
  return out;
}

/**
 * Hard-reset the thread WORKTREE to a prior checkpoint sha.
 * Guards (in order): unknown thread → run active → no worktree → sha not ours.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.sha
 * @param {(threadId: string) => boolean} [opts.isRunning]
 * @returns {Promise<void>}
 */
async function restoreCheckpoint(opts) {
  const { store, threadId, sha, isRunning } = opts;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (typeof isRunning === "function" && isRunning(threadId)) {
    throw new Error("Cannot restore a checkpoint while a run is active");
  }
  if (!thread.worktreePath) {
    throw new Error(
      `Thread ${threadId} has no worktree; call setupWorktree first`,
    );
  }

  const want = String(sha || "").trim();
  if (!want) {
    throw new Error(`Unknown checkpoint: ${sha}`);
  }

  // THIS THREAD's HEAD-reachable checkpoints only. Sibling worktrees of the
  // same project share an object DB, so `git log -1 <sha>` would accept
  // another thread's checkpoint and hard-reset into foreign state (data
  // loss). Membership in listCheckpoints is the contract boundary.
  const list = await listCheckpoints({ store, threadId });
  const match = list.find(
    (c) => c.sha === want || c.sha.startsWith(want) || want.startsWith(c.sha),
  );
  if (!match) {
    throw new Error(`Unknown checkpoint: ${sha}`);
  }

  const reset = await gitTryAsync(thread.worktreePath, [
    "reset",
    "--hard",
    match.sha,
  ]);
  if (!reset.ok) {
    throw new Error(
      tailErr(reset.stderr || reset.combined, "git reset --hard failed"),
    );
  }
}

module.exports = {
  setupWorktree,
  diff,
  commit,
  revertFile,
  listFiles,
  mergeWorktree,
  removeWorktree,
  push,
  createPr,
  prStatus,
  refreshPrStates,
  createPrStateRefresher,
  isPrRefreshCandidate,
  isGitHubRemote,
  slugify,
  PATCH_TRUNCATE,
  PR_REFRESH_TIMEOUT_MS,
  maybeCreateCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  gitTryAsync,
  CHECKPOINT_SUBJECT_PREFIX,
};
