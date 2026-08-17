"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, execFile } = require("node:child_process");
const { execCommand, wrapCommand, SYNC_TIMEOUT_MS } = require("./ssh.js");

/** @type {typeof execFile} */
let execFileImpl = execFile;

/**
 * Test hook: swap async execFile (hot git reads) for a fake spawn.
 * Pass null/undefined to restore the real implementation.
 * @param {typeof execFile | null | undefined} fn
 */
function setExecFile(fn) {
  execFileImpl = typeof fn === "function" ? fn : execFile;
}

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
  // ponytail: write paths (merge/push/PR/setup) stay sync — they fire once per
  // click and are already bounded at 15s by #88. Hot reads use the Async pair.
  // execCommand, not execFileSync: it owns the default timeout that keeps a
  // hung git off the main-process event loop.
  const raw = execCommand(null, "git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });
  const out = raw == null ? "" : String(raw);
  return opts && opts.raw ? out : out.trim();
}

/**
 * gitOut for the diff path: prefix git with ssh when the project is remote.
 * Other worktrees operations stay local (worktrees/PRs are out of scope on remotes).
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null} project
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ raw?: boolean }} [opts]
 */
function gitOutForDiff(project, cwd, args, opts) {
  if (project && project.remoteHost) {
    const out = execCommand(project, "git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_MAX_BUFFER,
    });
    const text = out == null ? "" : String(out);
    return opts && opts.raw ? text : text.trim();
  }
  return gitOut(cwd, args, opts);
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
    // execCommand defaults the timeout when the caller did not set one.
    const raw = execCommand(null, "git", args, execOpts);
    const out = raw == null ? "" : String(raw);
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
 * Async gitOut. Never blocks the Electron main process.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ raw?: boolean, timeout?: number }} [opts]
 * @returns {Promise<string>}
 */
function gitOutAsync(cwd, args, opts) {
  return gitExecThrowAsync(null, cwd, args, opts);
}

/**
 * Async gitOutForDiff: prefix git with ssh when the project is remote.
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null} project
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ raw?: boolean, timeout?: number }} [opts]
 * @returns {Promise<string>}
 */
function gitOutForDiffAsync(project, cwd, args, opts) {
  if (project && project.remoteHost) {
    return gitExecThrowAsync(project, cwd, args, opts);
  }
  return gitOutAsync(cwd, args, opts);
}

/**
 * execFile through wrapCommand. Drops cwd on remotes (same as execCommand).
 * Throws on failure so callers match gitOut / gitOutForDiff.
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null} project
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ raw?: boolean, timeout?: number }} [opts]
 * @returns {Promise<string>}
 */
function gitExecThrowAsync(project, cwd, args, opts) {
  const cmd = wrapCommand(project, "git", args);
  const timeout =
    opts && opts.timeout != null ? opts.timeout : SYNC_TIMEOUT_MS;
  /** @type {import("node:child_process").ExecFileOptionsWithStringEncoding} */
  const execOpts = {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (!(project && project.remoteHost)) {
    execOpts.cwd = cwd;
  }
  return new Promise((resolve, reject) => {
    execFileImpl(cmd.bin, cmd.args, execOpts, (err, stdout, stderr) => {
      if (err) {
        if (err.stdout == null && stdout != null) err.stdout = stdout;
        if (err.stderr == null && stderr != null) err.stderr = stderr;
        reject(err);
        return;
      }
      const out = stdout == null ? "" : String(stdout);
      resolve(opts && opts.raw ? out : out.trim());
    });
  });
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
 * Paths with unmerged index entries (conflict markers on disk).
 * @param {string} cwd
 * @returns {string[]}
 */
function unmergedFiles(cwd) {
  const res = gitTry(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  if (!res.ok) return [];
  return splitLines(res.stdout);
}

/**
 * git output (one path per line) as a trimmed, non-empty list.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Unmerged paths that still carry conflict markers on disk. Editing the file
 * counts as resolved even without `git add` — the merge path stages with
 * `add -A` anyway, and requiring the stage would strand anyone resolving in an
 * editor.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
function unresolvedFiles(cwd) {
  return unmergedFiles(cwd).filter((file) => {
    try {
      return /^<{7}[ \t]/m.test(fs.readFileSync(path.join(cwd, file), "utf8"));
    } catch {
      // Binary or deleted (delete/modify): nothing to strip, let it through.
      return false;
    }
  });
}

/**
 * Conflict error carrying the file list. The MERGE_CONFLICT marker tells the
 * renderer to show a resolution block instead of a raw git dump (same trick as
 * WORKTREE_DIRTY).
 *
 * @param {string} headline
 * @param {string[]} files
 * @param {string|null} footer
 */
function conflictError(headline, files, footer) {
  const lines = [headline, ...files.map((f) => `  ${f}`)];
  if (footer) lines.push(footer);
  return new Error(`MERGE_CONFLICT:${lines.join("\n")}`);
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

  // (a) Commit any uncommitted worktree changes. Refuse while conflicts are
  // unresolved: `add -A` would happily commit the markers.
  const pending = unresolvedFiles(wtPath);
  if (pending.length) {
    throw conflictError(
      "Unresolved conflicts in the worktree:",
      pending,
      "Resolve them in the worktree, then merge again.",
    );
  }

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

  // (c) A dirty project checkout used to be a hard refusal — TRACKED changes
  // only, since a stray untracked scratch file blocked every merge forever
  // (issue #198). But the checkout is shared by every thread in the project,
  // so one uncommitted edit still blocked every merge in the app until someone
  // stashed it by hand. Stash it here and put it back below. (git's own
  // `merge --autostash` is no use: `--squash` leaves the merge uncommitted, so
  // the pop would land in a half-merged index before our commit.)
  const mainStatus = gitOut(
    project.path,
    ["status", "--porcelain", "--untracked-files=no"],
    { raw: true },
  ).trim();
  let stashed = false;
  if (mainStatus) {
    const push = gitTry(project.path, [
      "stash",
      "push",
      "-m",
      `solenta: project changes set aside to merge ${branch}`,
    ]);
    if (!push.ok) {
      throw new Error(
        `Project checkout has uncommitted changes that could not be stashed; commit or stash before merging:\n${mainStatus}`,
      );
    }
    stashed = true;
  }

  // Everything from here can throw, and the stash must come back either way.
  let mergeError = null;
  try {
    mergeInto(project, branch, baseBranch, wtPath, thread);
  } catch (err) {
    mergeError = err;
  }
  if (stashed) {
    const popped = gitTry(project.path, ["stash", "pop"]);
    if (!popped.ok && !mergeError) {
      // The entry stays in the stash list when a pop fails, so nothing is
      // lost — but say where it is instead of leaving a silently empty tree.
      throw new Error(
        `Merged ${branch}, but the project checkout's own changes did not come back cleanly. They are safe in \`git stash\` (stash@{0}): ${popped.combined.split("\n")[0]}`,
      );
    }
  }
  if (mergeError) throw mergeError;

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
 * Squash `branch` into the project checkout's default branch and commit it.
 * Split out of mergeWorktree so every throw in here unwinds through the one
 * stash-restore step there.
 */
function mergeInto(project, branch, baseBranch, wtPath, thread) {
  // Untracked files the merge WOULD write over: git refuses these too, but
  // only mid-merge, reported as a conflict against files nobody edited.
  const incoming = gitTry(
    project.path,
    ["diff", "--name-only", `${baseBranch}...${branch}`],
    { raw: true },
  );
  if (incoming.ok) {
    const untracked = new Set(splitLines(
      gitOut(project.path, ["ls-files", "--others", "--exclude-standard"], {
        raw: true,
      }),
    ));
    const clobbered = splitLines(incoming.stdout).filter((f) =>
      untracked.has(f),
    );
    if (clobbered.length) {
      throw new Error(
        `Untracked files in the project checkout would be overwritten by this merge; move or remove them:\n${clobbered
          .map((f) => `  ${f}`)
          .join("\n")}`,
      );
    }
  }

  // Squash into the project checkout, always restoring it on failure.
  const squash = () => {
    const res = gitTry(project.path, ["merge", "--squash", branch]);
    if (res.ok) return null;
    const files = unmergedFiles(project.path);
    gitTry(project.path, ["merge", "--abort"]);
    gitTry(project.path, ["reset", "--hard", "HEAD"]);
    return { files, combined: res.combined };
  };

  let failed = squash();
  if (failed) {
    // Replay the conflict inside the worktree — that is where the agent, the
    // editor and the user can actually resolve it. A clean replay means the
    // branch only needed the newer base commits, so the squash can retry.
    const replay = gitTry(wtPath, ["merge", baseBranch]);
    failed = replay.ok ? squash() : failed;
    if (failed) {
      const inWorktree = unmergedFiles(wtPath);
      throw conflictError(
        `${branch} conflicts with ${baseBranch}:`,
        inWorktree.length ? inWorktree : failed.files,
        inWorktree.length
          ? `${baseBranch} was merged into the worktree — resolve these files there, then merge again.`
          : failed.combined.split("\n")[0],
      );
    }
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
 * Rename the auto-generated placeholder branch to match the real title once
 * the first prompt has promoted it (T3-style: worktree branches start as a
 * temp name and become human-readable after the first turn). Only touches
 * branches that still carry the exact placeholder name — user-renamed or
 * manually created branches are left alone. Best-effort: any git failure
 * keeps the old branch and never throws, so a rename can never break a run.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.newTitle
 * @returns {object|null} updated ThreadInfo, or null when no rename happened
 */
function maybeRenameWorktreeBranch(opts) {
  const { store, threadId, newTitle } = opts;
  const thread = store.getThread(threadId);
  if (!thread || !thread.worktreePath || !thread.branch) {
    return null;
  }
  const shortId = String(thread.id).slice(0, 6);
  const placeholder = `coder/new-thread-${shortId}`;
  if (thread.branch !== placeholder) {
    return null;
  }
  const next = `coder/${slugify(newTitle)}-${shortId}`;
  if (next === thread.branch) {
    return null;
  }
  try {
    gitOut(thread.worktreePath, ["branch", "-m", thread.branch, next]);
  } catch {
    return null;
  }
  const updated = store.updateThread(threadId, { branch: next });
  store.save();
  return updated ? { ...updated } : null;
}

/**
 * Working-tree changes in the thread's cwd (worktree if set, else project).
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @returns {Promise<{ files: Array<{path: string, status: string, additions: number, deletions: number}>, patch: string, truncated: boolean }>}
 */
async function diff(opts) {
  const { store, threadId } = opts;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }

  const cwd = project.remoteHost
    ? project.remotePath || project.path
    : thread.worktreePath || project.path;

  /** @type {Map<string, { path: string, status: string, additions: number, deletions: number }>} */
  const byPath = new Map();

  // Porcelain status for all entries; -uall lists untracked files
  // individually instead of collapsing whole directories into "?? dir/".
  // raw: the 2-char XY column starts with a significant space.
  const porcelain = await gitOutForDiffAsync(project, cwd, ["status", "--porcelain", "-uall"], {
    raw: true,
  });

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
    numstat = await gitOutForDiffAsync(project, cwd, ["diff", "HEAD", "--numstat"]);
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

  // Untracked: additions = line count. Remote trees are not on this disk.
  for (const entry of byPath.values()) {
    if (entry.status === "??") {
      if (project.remoteHost) {
        continue;
      }
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
    patch = await gitOutForDiffAsync(project, cwd, ["diff", "HEAD"]);
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
const LS_FILES_TTL_MS = 5000;

/**
 * Last `git ls-files` result, so a burst of @-mention keystrokes filters an
 * in-memory list instead of forking git on every one.
 *
 * ponytail: single entry, not a per-cwd map — the popup only looks at one cwd
 * at a time. Key it by cwd if two threads start thrashing it.
 *
 * @type {{ cwd: string, at: number, files: string[] } | null}
 */
let lsFilesCache = null;

/**
 * Tracked plus untracked (gitignored excluded) paths for a repo, cached for
 * LS_FILES_TTL_MS.
 *
 * @param {string} cwd
 * @returns {Promise<string[]>}
 */
async function lsFiles(cwd) {
  const now = Date.now();
  const hit =
    lsFilesCache &&
    lsFilesCache.cwd === cwd &&
    now - lsFilesCache.at < LS_FILES_TTL_MS;
  if (hit) return lsFilesCache.files;
  const out = await gitTryAsync(cwd, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ], { timeout: SYNC_TIMEOUT_MS });
  if (!out.ok) {
    throw new Error(tailErr(out.stderr || out.combined, "git ls-files failed"));
  }
  const files = out.stdout.split("\n").filter(Boolean).slice(0, LS_FILES_CAP);
  lsFilesCache = { cwd, at: now, files };
  return files;
}

/**
 * Files matchable by the composer's @-mention popup: tracked plus untracked
 * (gitignored excluded), filtered case-insensitively by substring. Paths that
 * START with the query rank above mid-string matches.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} [opts.query]
 * @returns {Promise<{ files: string[] }>}
 */
async function listFiles(opts) {
  const { store, threadId } = opts;
  const query = String(opts.query || "").toLowerCase();
  const { cwd } = threadGitCwd(store, threadId);
  const all = await lsFiles(cwd);
  // Copy when unfiltered: the sort below must not reorder the cached list.
  const matched = query
    ? all.filter((p) => p.toLowerCase().includes(query))
    : all.slice();
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
 * SYNC — leftover for createPr / mergePr view+merge. listPrs, prStatus,
 * and prChecks go through ghTryAsync so a hanging GitHub call cannot
 * beachball the main process.
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

/** Interactive `gh pr view` field set. Background refresh and create stay minimal. */
const PR_JSON_MINIMAL = "number,url,state";
const PR_JSON_ENRICHED =
  "number,url,state,title,additions,deletions,changedFiles";

/**
 * Finite number from gh JSON, or undefined when the field is absent/unusable.
 * @param {unknown} value
 * @returns {number | undefined}
 */
function optionalPrCount(value) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse `gh pr view --json` into a PrInfo-shaped object.
 * Optional title/diff stats are passed through when present.
 * @param {string} stdout
 * @param {string} branch
 * @param {boolean} created
 * @returns {{
 *   number: number,
 *   url: string,
 *   state: "OPEN" | "CLOSED" | "MERGED",
 *   branch: string,
 *   created: boolean,
 *   title?: string,
 *   additions?: number,
 *   deletions?: number,
 *   changedFiles?: number,
 * }}
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
  /** @type {{ number: number, url: string, state: "OPEN" | "CLOSED" | "MERGED", branch: string, created: boolean, title?: string, additions?: number, deletions?: number, changedFiles?: number }} */
  const info = { number, url, state, branch, created: Boolean(created) };
  if (data && data.title != null) info.title = String(data.title);
  const additions = optionalPrCount(data && data.additions);
  if (additions !== undefined) info.additions = additions;
  const deletions = optionalPrCount(data && data.deletions);
  if (deletions !== undefined) info.deletions = deletions;
  const changedFiles = optionalPrCount(data && data.changedFiles);
  if (changedFiles !== undefined) info.changedFiles = changedFiles;
  return info;
}

const PR_LIST_FIELDS =
  "number,title,url,state,headRefName,isDraft,additions,deletions,updatedAt";
const PR_LIST_FIELDS_FALLBACK = "number,title,url,state,headRefName";

/**
 * True when gh rejected --json because a field name is unknown (older gh).
 * @param {string} text
 * @returns {boolean}
 */
function isUnknownJsonField(text) {
  return /unknown (json )?field/i.test(String(text || ""));
}

/**
 * True when gh's error is missing/expired auth, not a repo or network issue.
 * @param {string} text
 * @returns {boolean}
 */
function isGhAuthFailure(text) {
  return /gh auth login|GH_TOKEN|not logged into|authentication required|HTTP 401|Bad credentials/i.test(
    String(text || ""),
  );
}

/**
 * Normalize one `gh pr list --json` row into a PrListItem.
 * @param {any} row
 * @returns {{
 *   number: number,
 *   title: string,
 *   url: string,
 *   state: "OPEN" | "CLOSED" | "MERGED",
 *   headRefName: string,
 *   isDraft?: boolean,
 *   additions?: number,
 *   deletions?: number,
 *   updatedAt?: string,
 * }}
 */
function parsePrListItem(row) {
  const number = Number(row && row.number);
  const url = row && row.url != null ? String(row.url) : "";
  if (!Number.isFinite(number) || number <= 0 || !url) {
    throw new Error("gh returned incomplete PR list JSON");
  }
  const raw = String((row && row.state) || "OPEN").toUpperCase();
  /** @type {"OPEN" | "CLOSED" | "MERGED"} */
  const state =
    raw === "MERGED" ? "MERGED" : raw === "CLOSED" ? "CLOSED" : "OPEN";
  /** @type {{
   *   number: number,
   *   title: string,
   *   url: string,
   *   state: "OPEN" | "CLOSED" | "MERGED",
   *   headRefName: string,
   *   isDraft?: boolean,
   *   additions?: number,
   *   deletions?: number,
   *   updatedAt?: string,
   * }} */
  const item = {
    number,
    title: row && row.title != null ? String(row.title) : "",
    url,
    state,
    headRefName:
      row && row.headRefName != null ? String(row.headRefName) : "",
  };
  if (typeof (row && row.isDraft) === "boolean") {
    item.isDraft = row.isDraft;
  }
  if (row && row.additions != null && Number.isFinite(Number(row.additions))) {
    item.additions = Number(row.additions);
  }
  if (row && row.deletions != null && Number.isFinite(Number(row.deletions))) {
    item.deletions = Number(row.deletions);
  }
  if (row && row.updatedAt != null && String(row.updatedAt).trim() !== "") {
    item.updatedAt = String(row.updatedAt);
  }
  return item;
}

/**
 * Parse `gh pr list --json ...` stdout (an array) into PrListItem[].
 * @param {string} stdout
 * @returns {ReturnType<typeof parsePrListItem>[]}
 */
function parsePrListJson(stdout) {
  let data;
  try {
    const trimmed = String(stdout || "").trim();
    data = JSON.parse(trimmed === "" ? "[]" : trimmed);
  } catch {
    throw new Error("gh returned unparseable PR list JSON");
  }
  if (!Array.isArray(data)) {
    throw new Error("gh returned incomplete PR list JSON");
  }
  return data.map(parsePrListItem);
}

/**
 * Open PRs for a project checkout. Never throws: missing gh, a non-GitHub
 * remote, or auth failure come back as `{ ok: false, reason }` so the UI
 * can render a per-project error row.
 *
 * @param {string} projectPath
 * @returns {Promise<{ ok: true, prs: ReturnType<typeof parsePrListItem>[] } | { ok: false, reason: string }>}
 */
async function listPrs(projectPath) {
  const cwd = String(projectPath || "");
  if (!cwd) {
    return { ok: false, reason: "not a GitHub repo" };
  }

  const remote = gitTry(cwd, ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    return { ok: false, reason: "not a GitHub repo" };
  }
  const originUrl = String(remote.stdout || "").trim();
  if (!isGitHubRemote(originUrl)) {
    return { ok: false, reason: "not a GitHub repo" };
  }

  let listed = await ghTryAsync(cwd, [
    "pr",
    "list",
    "--json",
    PR_LIST_FIELDS,
    "--limit",
    "50",
  ], { timeout: GH_TIMEOUT_MS });
  if (
    !listed.ok &&
    isUnknownJsonField(listed.stderr || listed.combined || listed.stdout)
  ) {
    listed = await ghTryAsync(cwd, [
      "pr",
      "list",
      "--json",
      PR_LIST_FIELDS_FALLBACK,
      "--limit",
      "50",
    ], { timeout: GH_TIMEOUT_MS });
  }
  if (!listed.ok) {
    if (listed.enoent) {
      return { ok: false, reason: "gh missing" };
    }
    if (isGhAuthFailure(listed.stderr || listed.combined || listed.stdout)) {
      return { ok: false, reason: "auth" };
    }
    return {
      ok: false,
      reason: tailErr(listed.stderr || listed.combined, "gh pr list failed"),
    };
  }
  try {
    return { ok: true, prs: parsePrListJson(listed.stdout) };
  } catch (err) {
    return {
      ok: false,
      reason:
        err && err.message
          ? String(err.message)
          : "gh returned unparseable PR list JSON",
    };
  }
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
 * @returns {Promise<{ number: number, url: string, state: "OPEN" | "CLOSED" | "MERGED", branch: string, created: boolean } | null>}
 */
async function prStatus(opts) {
  const { store, threadId } = opts;
  const { cwd, branch, originUrl } = resolveThreadGit(store, threadId);

  if (!isGitHubRemote(originUrl)) {
    throw new Error(
      `Remote origin is not a GitHub repository (got: ${originUrl}). PR status requires github.com.`,
    );
  }

  let viewed = await ghTryAsync(cwd, ["pr", "view", branch, "--json", PR_JSON_ENRICHED], {
    timeout: GH_TIMEOUT_MS,
  });
  if (
    !viewed.ok &&
    isUnknownJsonField(viewed.stderr || viewed.combined || viewed.stdout)
  ) {
    viewed = await ghTryAsync(cwd, ["pr", "view", branch, "--json", PR_JSON_MINIMAL], {
      timeout: GH_TIMEOUT_MS,
    });
  }
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

/** Buckets `gh pr checks --json` reports. */
const PR_CHECK_BUCKETS = new Set([
  "pass",
  "fail",
  "pending",
  "skipping",
  "cancel",
]);

/**
 * Map a gh check state/bucket string onto the five buckets the UI knows.
 * @param {unknown} raw
 * @returns {"pass" | "fail" | "pending" | "skipping" | "cancel"}
 */
function normalizeCheckBucket(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  if (s === "pass" || s === "success" || s === "completed") return "pass";
  if (s === "fail" || s === "failure" || s === "failed" || s === "error") {
    return "fail";
  }
  if (s === "skipping" || s === "skipped" || s === "skip") return "skipping";
  if (s === "cancel" || s === "cancelled" || s === "canceled") return "cancel";
  if (
    s === "pending" ||
    s === "queued" ||
    s === "in_progress" ||
    s === "inprogress" ||
    s === "waiting"
  ) {
    return "pending";
  }
  return "pending";
}

/**
 * True when gh rejected `pr checks --json` (older CLI, unknown field/flag).
 * @param {string} text
 * @returns {boolean}
 */
function isChecksJsonRejected(text) {
  const s = String(text || "");
  if (isUnknownJsonField(s)) return true;
  return (
    /json/i.test(s) &&
    /unknown flag|flag provided but not defined|unknown (command|argument|shorthand)/i.test(
      s,
    )
  );
}

/**
 * Parse one `gh pr checks --json` row.
 * @param {any} row
 * @returns {{ name: string, bucket: "pass" | "fail" | "pending" | "skipping" | "cancel", link?: string }}
 */
function parsePrCheckItem(row) {
  const name = row && row.name != null ? String(row.name).trim() : "";
  if (!name) {
    throw new Error("gh returned incomplete PR checks JSON");
  }
  const bucket = normalizeCheckBucket(
    (row && row.bucket) || (row && row.state),
  );
  /** @type {{ name: string, bucket: "pass" | "fail" | "pending" | "skipping" | "cancel", link?: string }} */
  const item = { name, bucket };
  if (row && row.link != null && String(row.link).trim() !== "") {
    item.link = String(row.link);
  }
  return item;
}

/**
 * Parse `gh pr checks --json name,state,bucket,link` stdout (an array).
 * @param {string} stdout
 * @returns {ReturnType<typeof parsePrCheckItem>[]}
 */
function parsePrChecksJson(stdout) {
  let data;
  try {
    const trimmed = String(stdout || "").trim();
    data = JSON.parse(trimmed === "" ? "[]" : trimmed);
  } catch {
    throw new Error("gh returned unparseable PR checks JSON");
  }
  if (!Array.isArray(data)) {
    throw new Error("gh returned incomplete PR checks JSON");
  }
  return data.map(parsePrCheckItem);
}

const CHECK_TEXT_BUCKET =
  /^(pass|fail|pending|skipping|cancel|success|failure|failed|error|queued|in_progress|inprogress|waiting|skipped|skip|cancelled|canceled)$/i;

/**
 * Parse plain `gh pr checks <number>` text (tab- or multi-space-separated
 * name / pass-fail-pending / duration / link rows).
 * @param {string} stdout
 * @returns {ReturnType<typeof parsePrCheckItem>[]}
 */
function parsePrChecksText(stdout) {
  const checks = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.includes("\t")
      ? trimmed.split("\t").map((s) => s.trim())
      : trimmed.split(/\s{2,}/).map((s) => s.trim());
    if (cols.length < 2) continue;
    let bucketIdx = -1;
    for (let i = 0; i < cols.length; i++) {
      if (CHECK_TEXT_BUCKET.test(cols[i])) {
        bucketIdx = i;
        break;
      }
    }
    if (bucketIdx <= 0) continue;
    const name = cols.slice(0, bucketIdx).join(" ").trim();
    if (!name) continue;
    const bucket = normalizeCheckBucket(cols[bucketIdx]);
    /** @type {{ name: string, bucket: "pass" | "fail" | "pending" | "skipping" | "cancel", link?: string }} */
    const item = { name, bucket };
    const last = cols[cols.length - 1];
    if (last && /^https?:\/\//i.test(last)) item.link = last;
    checks.push(item);
  }
  return checks;
}

/**
 * Counts per check bucket. Unknown buckets are ignored.
 * @param {{ bucket: string }[]} checks
 * @returns {{ pass: number, fail: number, pending: number, skipping: number, cancel: number }}
 */
function rollupPrChecks(checks) {
  const counts = {
    pass: 0,
    fail: 0,
    pending: 0,
    skipping: 0,
    cancel: 0,
  };
  if (!Array.isArray(checks)) return counts;
  for (const c of checks) {
    const bucket = c && c.bucket;
    if (PR_CHECK_BUCKETS.has(bucket)) counts[bucket] += 1;
  }
  return counts;
}

/**
 * Pull checks from a ghTry result. `gh pr checks` exits 1 when any check
 * failed and 8 when some are pending, so a non-zero exit with parseable
 * stdout is still success.
 * @param {{ ok: boolean, stdout?: string, stderr?: string, combined?: string }} result
 * @param {boolean} preferText
 * @returns {ReturnType<typeof parsePrCheckItem>[] | null}
 */
function extractPrChecks(result, preferText) {
  const out = result && result.stdout != null ? String(result.stdout) : "";
  const trimmed = out.trim();
  if (!preferText && (trimmed.startsWith("[") || trimmed.startsWith("{"))) {
    try {
      return parsePrChecksJson(trimmed);
    } catch {
      // Fall through to the text table (older gh, or JSON mixed with a banner).
    }
  }
  const fromText = parsePrChecksText(trimmed);
  if (fromText.length > 0) return fromText;
  if (preferText || trimmed === "") return fromText;
  try {
    return parsePrChecksJson(trimmed);
  } catch {
    return null;
  }
}

/**
 * CI checks for the thread's current PR. Failures stay in-band so the
 * card can retry: `{ ok: false, reason }` for missing gh, no PR, or auth.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @returns {Promise<{ ok: true, checks: ReturnType<typeof parsePrCheckItem>[] } | { ok: false, reason: string }>}
 */
async function prChecks(opts) {
  const { store, threadId } = opts;
  let cwd;
  let branch;
  let originUrl;
  try {
    const resolved = resolveThreadGit(store, threadId);
    cwd = resolved.cwd;
    branch = resolved.branch;
    originUrl = resolved.originUrl;
  } catch (err) {
    return {
      ok: false,
      reason: err && err.message ? String(err.message) : "no PR",
    };
  }

  if (!isGitHubRemote(originUrl)) {
    return { ok: false, reason: "not a GitHub repo" };
  }

  let viewed = await ghTryAsync(cwd, ["pr", "view", branch, "--json", PR_JSON_ENRICHED], {
    timeout: GH_TIMEOUT_MS,
  });
  if (
    !viewed.ok &&
    isUnknownJsonField(viewed.stderr || viewed.combined || viewed.stdout)
  ) {
    viewed = await ghTryAsync(cwd, ["pr", "view", branch, "--json", PR_JSON_MINIMAL], {
      timeout: GH_TIMEOUT_MS,
    });
  }
  if (!viewed.ok) {
    if (viewed.enoent) return { ok: false, reason: "gh missing" };
    if (isGhAuthFailure(viewed.stderr || viewed.combined || viewed.stdout)) {
      return { ok: false, reason: "auth" };
    }
    if (isNoPrMessage(viewed.stderr || viewed.combined || viewed.stdout)) {
      return { ok: false, reason: "no PR" };
    }
    return {
      ok: false,
      reason: tailErr(viewed.stderr || viewed.combined, "gh pr view failed"),
    };
  }

  let info;
  try {
    info = parsePrJson(viewed.stdout, branch, false);
  } catch (err) {
    return {
      ok: false,
      reason:
        err && err.message
          ? String(err.message)
          : "gh returned unparseable PR JSON",
    };
  }

  let checked = await ghTryAsync(cwd, [
    "pr",
    "checks",
    String(info.number),
    "--json",
    "name,state,bucket,link",
  ], { timeout: GH_TIMEOUT_MS });
  let preferText = false;
  if (
    !checked.ok &&
    isChecksJsonRejected(checked.stderr || checked.combined || checked.stdout)
  ) {
    checked = await ghTryAsync(cwd, ["pr", "checks", String(info.number)], {
      timeout: GH_TIMEOUT_MS,
    });
    preferText = true;
  }

  if (checked.enoent) return { ok: false, reason: "gh missing" };
  if (isGhAuthFailure(checked.stderr || checked.combined || checked.stdout)) {
    return { ok: false, reason: "auth" };
  }

  const checks = extractPrChecks(checked, preferText);
  if (checks) return { ok: true, checks };

  return {
    ok: false,
    reason: tailErr(
      checked.stderr || checked.combined,
      "gh pr checks failed",
    ),
  };
}

/**
 * Squash-merge the thread's current PR via `gh pr merge --squash`, then
 * return the refreshed PrInfo. Throws (with gh's own tail) on failure.
 * CLOSED/MERGED PRs are left to gh; we do not invent a pre-check.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {Promise<Awaited<ReturnType<typeof prStatus>>>}
 */
async function mergePr(opts) {
  const { store, threadId, broadcast } = opts;
  const { cwd, branch, originUrl } = resolveThreadGit(store, threadId);

  if (!isGitHubRemote(originUrl)) {
    throw new Error(
      `Remote origin is not a GitHub repository (got: ${originUrl}). Merging a PR requires github.com.`,
    );
  }

  let viewed = ghTry(cwd, ["pr", "view", branch, "--json", PR_JSON_ENRICHED]);
  if (
    !viewed.ok &&
    isUnknownJsonField(viewed.stderr || viewed.combined || viewed.stdout)
  ) {
    viewed = ghTry(cwd, ["pr", "view", branch, "--json", PR_JSON_MINIMAL]);
  }
  if (!viewed.ok) {
    if (viewed.enoent || viewed.timedOut) {
      throwGhFailure(viewed, "gh pr view failed");
    }
    if (isNoPrMessage(viewed.stderr || viewed.combined || viewed.stdout)) {
      throw new Error("No pull request found for this branch");
    }
    throwGhFailure(viewed, "gh pr view failed");
  }

  const info = parsePrJson(viewed.stdout, branch, false);
  const merged = ghTry(cwd, [
    "pr",
    "merge",
    String(info.number),
    "--squash",
  ]);
  if (!merged.ok) {
    throwGhFailure(merged, "gh pr merge failed");
  }

  const live = await prStatus({ store, threadId });
  if (typeof broadcast === "function") {
    const { listThreads } = require("./services.js");
    broadcast("threads:changed", listThreads(store));
  }
  return live;
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

      if (nextState === "MERGED") {
        // The PR path used to strand worktree+branch forever (t3 deep-dive).
        // Reclaim now; dirty/unpushed trees are skipped for manual cleanup.
        await maybeCleanupMergedWorktree(store, threadId);
      }
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
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, combined: string, error?: any, timedOut?: boolean }>}
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
    execFileImpl(
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
        // execFileSync sets code=ETIMEDOUT; async execFile kills with
        // SIGTERM and leaves code=null. Both are a timeout.
        const timedOut =
          (err && err.code === "ETIMEDOUT") ||
          (err && err.killed && /ETIMEDOUT|timed out/i.test(msg)) ||
          (err && err.killed && err.signal != null && err.code == null);
        resolve({
          ok: false,
          stdout: out,
          stderr: errText,
          combined: [out, errText, msg].filter(Boolean).join("\n"),
          error: err,
          timedOut: Boolean(timedOut),
        });
      },
    );
  });
}

/**
 * Parse `git diff --shortstat` output.
 * " 3 files changed, 24 insertions(+), 9 deletions(-)"
 * Missing insertion/deletion clauses become 0. Returns null when unparseable.
 *
 * @param {string} text
 * @returns {{ files: number, additions: number, deletions: number } | null}
 */
function parseShortstat(text) {
  const s = String(text || "");
  const files = s.match(/(\d+)\s+files?\s+changed/);
  if (!files) return null;
  const add = s.match(/(\d+)\s+insertions?\(\+\)/);
  const del = s.match(/(\d+)\s+deletions?\(-\)/);
  return {
    files: Number(files[1]),
    additions: add ? Number(add[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

/**
 * Per-checkpoint-pair shortstat for a thread worktree.
 * Checkpoint N diffs against N-1 (first checkpoint diffs against <sha>^).
 * Never throws: missing worktree / checkpoints / git failures return [].
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @returns {Promise<Array<{ sha: string, turn: number, files: number, additions: number, deletions: number }>>}
 */
async function runStats(opts) {
  try {
    const { store, threadId } = opts;
    if (!threadId) return [];
    const thread = store.getThread(threadId);
    if (!thread || !thread.worktreePath) return [];
    const cwd = thread.worktreePath;
    if (!fs.existsSync(cwd)) return [];

    const list = await listCheckpoints({ store, threadId });
    if (!list.length) return [];

    const oldestFirst = [...list].sort((a, b) => {
      if (a.turn !== b.turn) return a.turn - b.turn;
      return a.at - b.at;
    });

    /** @type {Array<{ sha: string, turn: number, files: number, additions: number, deletions: number }>} */
    const out = [];
    for (let i = 0; i < oldestFirst.length; i++) {
      const cp = oldestFirst[i];
      const from = i === 0 ? `${cp.sha}^` : oldestFirst[i - 1].sha;
      const diff = await gitTryAsync(
        cwd,
        ["diff", "--shortstat", from, cp.sha],
        { raw: true },
      );
      if (!diff.ok) continue;
      const parsed = parseShortstat(diff.stdout);
      if (!parsed) continue;
      out.push({
        sha: cp.sha,
        turn: cp.turn,
        files: parsed.files,
        additions: parsed.additions,
        deletions: parsed.deletions,
      });
    }
    return out;
  } catch {
    return [];
  }
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
      "user.email=solenta@local",
      "-c",
      "user.name=Solenta",
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
 * A dirty worktree is checkpointed first so the reset never eats uncommitted work.
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

  // Uncommitted work here (manual edits, or a run whose post-turn checkpoint
  // failed) would be destroyed by the reset. Commit it first — best-effort,
  // same as the post-turn path. ponytail: the safety commit is off-HEAD after
  // the reset so it drops out of listCheckpoints; recovery is `git reflog` in
  // the worktree. Surface it in the UI if anyone actually needs it back.
  await maybeCreateCheckpoint(store, threadId);

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

// ---------------------------------------------------------------------------
// Worktree junk collection (t3 deep-dive round): merged-PR reclaim, lazy
// creation, boot-time orphan sweep. All async git (never block the main
// process) and all failure-silent where they run unattended.
// ---------------------------------------------------------------------------

/**
 * Reclaim a thread's worktree + local branch once its PR has MERGED.
 * Safe by construction — cleans only when ALL of:
 * - thread.prState is MERGED (the flip is one-shot: terminal states leave
 *   the refresh candidate set, so this cannot re-fire)
 * - the worktree has no uncommitted changes
 * - local HEAD equals origin/<branch> (everything local was in the PR)
 * Does NOT save or broadcast; callers own durability (refresher saves once).
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @returns {Promise<{ cleaned: boolean, reason?: string }>}
 */
async function maybeCleanupMergedWorktree(store, threadId) {
  try {
    const thread = store.getThread(threadId);
    if (!thread || !thread.worktreePath || !thread.branch) {
      return { cleaned: false, reason: "no worktree" };
    }
    if (String(thread.prState || "").toUpperCase() !== "MERGED") {
      return { cleaned: false, reason: "PR not merged" };
    }
    const project = store.getProject(thread.projectId);
    if (!project || project.remoteHost) {
      return { cleaned: false, reason: "no local project" };
    }
    const wtPath = thread.worktreePath;
    if (!fs.existsSync(wtPath)) {
      // Dir already gone (manual rm): just drop the registration + fields.
      await gitTryAsync(project.path, ["worktree", "prune"]);
      await gitTryAsync(project.path, ["branch", "-D", thread.branch]);
      store.updateThread(threadId, { worktreePath: null, branch: null });
      return { cleaned: true };
    }

    const status = await gitTryAsync(
      wtPath,
      ["status", "--porcelain", "-uall"],
      { raw: true },
    );
    if (!status.ok || String(status.stdout || "").trim()) {
      return { cleaned: false, reason: "uncommitted changes" };
    }

    const localSha = await gitTryAsync(wtPath, ["rev-parse", "HEAD"]);
    const remoteSha = await gitTryAsync(wtPath, [
      "rev-parse",
      `refs/remotes/origin/${thread.branch}`,
    ]);
    if (!localSha.ok || !remoteSha.ok || localSha.stdout !== remoteSha.stdout) {
      return { cleaned: false, reason: "unpushed commits" };
    }

    const removed = await gitTryAsync(project.path, [
      "worktree",
      "remove",
      wtPath,
    ]);
    if (!removed.ok) {
      return { cleaned: false, reason: "worktree remove failed" };
    }
    // -D: a squash-merged branch is never "merged" in git's own bookkeeping,
    // but local == origin/<branch> and the PR merged that tip, so it is safe.
    await gitTryAsync(project.path, ["branch", "-D", thread.branch]);
    store.updateThread(threadId, { worktreePath: null, branch: null });
    return { cleaned: true };
  } catch {
    return { cleaned: false, reason: "error" };
  }
}

/**
 * Boot-time GC: remove worktree dirs under worktreeBase that no thread
 * references. Conservative — only CLEAN worktrees are removed (a corrupted
 * or reset store must never cost uncommitted work), and branches are only
 * safe-deleted (-d) so unmerged commits always stay reachable.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.worktreeBase
 * @returns {Promise<{ removed: string[], kept: string[] }>}
 */
async function sweepOrphanWorktrees(opts) {
  const { store, worktreeBase } = opts;
  /** @type {{ removed: string[], kept: string[] }} */
  const result = { removed: [], kept: [] };

  /** @type {fs.Dirent[]} */
  let entries = [];
  try {
    entries = fs.readdirSync(worktreeBase, { withFileTypes: true });
  } catch {
    return result;
  }

  const referenced = new Set(
    store
      .getThreads()
      .map((t) => t && t.worktreePath)
      .filter(Boolean)
      .map((p) => path.resolve(String(p))),
  );

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(worktreeBase, entry.name);
    if (referenced.has(path.resolve(dir))) continue;

    try {
      // Owning repo: the worktree's common git dir is <repo>/.git.
      const common = await gitTryAsync(dir, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      if (!common.ok || !common.stdout) {
        result.kept.push(dir);
        continue;
      }
      const repoPath = path.dirname(path.resolve(dir, common.stdout));

      const status = await gitTryAsync(
        dir,
        ["status", "--porcelain", "-uall"],
        { raw: true },
      );
      if (!status.ok || String(status.stdout || "").trim()) {
        result.kept.push(dir);
        continue;
      }

      const br = await gitTryAsync(dir, ["branch", "--show-current"]);
      const branch = br.ok ? br.stdout.trim() : "";

      const removed = await gitTryAsync(repoPath, ["worktree", "remove", dir]);
      if (!removed.ok) {
        result.kept.push(dir);
        continue;
      }
      if (branch && branch.startsWith("coder/")) {
        // Non-force: an unmerged orphan branch survives as a recoverable ref.
        await gitTryAsync(repoPath, ["branch", "-d", branch]);
      }
      result.removed.push(dir);
    } catch {
      result.kept.push(dir);
    }
  }

  return result;
}

/**
 * Materialize the worktree for a pendingWorktree thread (lazy, t3-style:
 * a thread that never runs leaves nothing on disk). No-op for plain threads
 * and threads that already have one; a stale flag is cleared either way.
 * Creation failures propagate AND keep the flag so the next run retries.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.worktreeBase
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {object} current ThreadInfo
 */
function ensureWorktree(opts) {
  const { store, threadId, worktreeBase, broadcast } = opts;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.worktreePath) {
    if (thread.pendingWorktree) {
      store.updateThread(threadId, { pendingWorktree: false });
      store.save();
    }
    return { ...store.getThread(threadId) };
  }
  if (!thread.pendingWorktree) {
    return { ...thread };
  }
  setupWorktree({ store, threadId, worktreeBase, broadcast });
  store.updateThread(threadId, { pendingWorktree: false });
  store.save();
  return { ...store.getThread(threadId) };
}

/**
 * Drop a worktreePath that no longer exists on disk. A worktree removed
 * outside the app (an agent running `git worktree remove`, or the folder
 * deleted by hand) leaves the thread pointing at nothing, and spawning a CLI
 * into a missing cwd fails as "spawn kimi ENOENT" — which reads as a missing
 * binary (#74). Leaves the thread in the same state the app's own removal
 * does, so it falls back to the project folder.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {string | null} the dropped path, or null when nothing was stale
 */
function clearMissingWorktree(opts) {
  const { store, threadId, broadcast } = opts;
  const thread = store.getThread(threadId);
  const wtPath = thread && thread.worktreePath;
  if (!wtPath || fs.existsSync(wtPath)) return null;

  store.updateThread(threadId, { worktreePath: null, branch: null });
  store.save();

  if (typeof broadcast === "function") {
    const { listThreads } = require("./services.js");
    broadcast("threads:changed", listThreads(store));
  }
  return wtPath;
}

module.exports = {
  setupWorktree,
  clearMissingWorktree,
  maybeRenameWorktreeBranch,
  diff,
  commit,
  revertFile,
  listFiles,
  mergeWorktree,
  removeWorktree,
  push,
  createPr,
  prStatus,
  prChecks,
  mergePr,
  parsePrJson,
  parsePrChecksJson,
  parsePrChecksText,
  rollupPrChecks,
  listPrs,
  parsePrListJson,
  isUnknownJsonField,
  refreshPrStates,
  createPrStateRefresher,
  maybeCleanupMergedWorktree,
  sweepOrphanWorktrees,
  ensureWorktree,
  isPrRefreshCandidate,
  isGitHubRemote,
  gitTry,
  gitOutAsync,
  gitOutForDiffAsync,
  setExecFile,
  ghTry,
  ghTryAsync,
  GH_TIMEOUT_MS,
  isGhAuthFailure,
  tailErr,
  slugify,
  PATCH_TRUNCATE,
  PR_REFRESH_TIMEOUT_MS,
  maybeCreateCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  runStats,
  parseShortstat,
  gitTryAsync,
  CHECKPOINT_SUBJECT_PREFIX,
};
