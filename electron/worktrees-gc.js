"use strict";

// Worktree garbage collection: merged-worktree cleanup, orphan sweep, gc scan/clean and retention.

const fs = require("node:fs");
const path = require("node:path");
// #559 persists this default (10) on every project; 0 is keep-everything.
const { DEFAULT_WORKTREE_RETENTION } = require("./store.js");
const {
  GIT_READ_TTL_MS,
  inspectByDir,
  invalidateGitReads,
  cachedRead,
  tailErr,
  gitTryAsync,
  duBytes,
} = require("./worktrees-git.js");

/** Periodic retention sweep (#641): grace crossings during a long uptime. */
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Same delay as the boot orphan sweep so startup stays fast. */
const RETENTION_SWEEP_STARTUP_MS = 15_000;

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
 * Commit a dirty orphan's working state to `recovered/<name>` (#1386) so
 * the sweep can remove the folder without losing it. The branch is not
 * under an app branch prefix, so no GC path ever deletes it. Fixed identity and no hooks or
 * signing: this is a salvage commit, not the user's own.
 *
 * @param {string} dir
 * @param {string} name worktree dir name (thread id)
 * @returns {Promise<string | null>} the branch, or null when any step failed
 */
const RECOVER_MAX_PATHS = 1000;

async function saveOrphanToRecoveryBranch(dir, name) {
  const branch = `recovered/${name}`;
  const steps = [
    ["switch", "-c", branch],
    ["add", "-A"],
    [
      "-c",
      "user.name=Solenta",
      "-c",
      "user.email=solenta@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-verify",
      "-m",
      `Recovered uncommitted work from deleted thread worktree ${name}`,
    ],
  ];
  for (const args of steps) {
    const r = await gitTryAsync(dir, args);
    if (!r.ok) return null;
  }
  return branch;
}

/**
 * Prefixes the app names worktree branches with: the default plus every
 * project's own (#1506), so an orphan keeps getting its branch tidied
 * after its project changed prefix. Deletion stays non-force.
 * @param {import('./store').Store} store
 * @returns {string[]}
 */
function appBranchPrefixes(store) {
  const { DEFAULT_BRANCH_PREFIX, branchPrefixFor } = require("./worktrees-branches.js");
  return [
    ...new Set([
      DEFAULT_BRANCH_PREFIX,
      ...store.getProjects().map((p) => branchPrefixFor(p)),
    ]),
  ];
}

/**
 * Boot-time GC: remove worktree dirs under worktreeBase that no thread
 * references. A dirty orphan is first committed to `recovered/<name>`
 * (#1386) so its work survives as a branch; if that fails the dir is kept
 * (a reset store must never cost uncommitted work). A directory git reports as
 * "not a git repository" is force-removed (#642): there is no status to
 * honor, and the branch (if any) lives in the repo. Other git failures
 * still keep the dir. Branches are only safe-deleted (-d) so unmerged
 * commits always stay reachable.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.worktreeBase
 * @returns {Promise<{ removed: string[], kept: string[] }>}
 */
async function sweepOrphanWorktrees(opts) {
  const { store, worktreeBase } = opts;
  /** @type {{ removed: string[], kept: string[], recovered: { dir: string, branch: string }[] }} */
  const result = { removed: [], kept: [], recovered: [] };

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
        if (gitSaysNotARepo(common)) {
          const forced = await forceRemoveWorktreeDir(dir, null);
          if (forced.ok) result.removed.push(dir);
          else result.kept.push(dir);
        } else {
          result.kept.push(dir);
        }
        continue;
      }
      const repoPath = path.dirname(path.resolve(dir, common.stdout));

      const status = await gitTryAsync(
        dir,
        ["status", "--porcelain", "-uall"],
        { raw: true },
      );
      if (!status.ok) {
        if (!String(status.stdout || "").trim() && gitSaysNotARepo(status)) {
          const forced = await forceRemoveWorktreeDir(dir, repoPath);
          if (forced.ok) result.removed.push(dir);
          else result.kept.push(dir);
        } else {
          result.kept.push(dir);
        }
        continue;
      }
      const dirty = String(status.stdout || "").trim();
      if (dirty) {
        // #1386: no thread will ever surface this dir again, so keeping it
        // dirty keeps it forever. Commit the work to a branch first; any
        // failure keeps the dir exactly as before.
        // ponytail: path-count cap so unignored build output never lands in
        // the repo's object store; such dirs stay kept, as before #1386.
        const saved =
          dirty.split("\n").length <= RECOVER_MAX_PATHS
            ? await saveOrphanToRecoveryBranch(dir, entry.name)
            : null;
        if (!saved) {
          result.kept.push(dir);
          continue;
        }
        result.recovered.push({ dir, branch: saved });
      }

      const br = await gitTryAsync(dir, ["branch", "--show-current"]);
      const branch = br.ok ? br.stdout.trim() : "";

      const removed = await gitTryAsync(repoPath, ["worktree", "remove", dir]);
      if (!removed.ok) {
        result.kept.push(dir);
        continue;
      }
      if (branch && appBranchPrefixes(store).some((p) => branch.startsWith(p))) {
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
 * Rank clock for retention: newest of updatedAt / lastActivityAt.
 * @param {object} thread
 */
function threadActivityAt(thread) {
  const updated = Number(thread && thread.updatedAt);
  const activity = Number(thread && thread.lastActivityAt);
  const times = [updated, activity].filter((n) => Number.isFinite(n));
  return times.length ? Math.max(...times) : 0;
}

/**
 * A project's settled-worktree keep count (#601 / #559).
 * Missing field → default 10. Stored 0 → keep everything. Positive → that N.
 * @param {object} project
 * @returns {number}
 */
function retentionFor(project) {
  if (
    project &&
    Object.prototype.hasOwnProperty.call(project, "worktreeRetention")
  ) {
    const n = Math.floor(Number(project.worktreeRetention));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_WORKTREE_RETENTION;
}

/**
 * The per-project setting only — 0 when unset or explicitly unlimited, so
 * `enforceRetention` can skip a keep-everything project.
 * @param {object} project
 * @returns {number}
 */
function explicitRetention(project) {
  const n = Math.floor(Number(project && project.worktreeRetention));
  return n > 0 ? n : 0;
}

/**
 * Conservative settle check, mirrored from src/threadSettle.ts.
 * working / pinned never settle. Explicit "active" override wins over PR.
 * @param {object} thread
 * @param {number} now
 * @param {number | null | undefined} autoSettleAfterDays
 */
function isSettledForGc(thread, now, autoSettleAfterDays) {
  if (!thread) return false;
  if (thread.status === "working" || thread.status === "quota-wait") return false;
  if (thread.pinnedAt != null && Number.isFinite(thread.pinnedAt)) return false;
  // Archived is a stronger signal than settled: the user pushed the thread
  // out of sight entirely. The renderer filters archived threads BEFORE the
  // settle split (sidebarGroups), so they never carry a settled override —
  // and those are precisely the invisible worktrees #316 is about (108 of
  // 127 worktree-holding threads on the reporter's own machine).
  if (thread.archived === true) return true;
  if (thread.settledOverride === "settled") return true;
  if (thread.settledOverride === "active") return false;
  const pr = String(thread.prState || "").toUpperCase();
  if (pr === "MERGED" || pr === "CLOSED") return true;
  if (pr === "OPEN") return false;
  if (
    autoSettleAfterDays == null ||
    !Number.isFinite(autoSettleAfterDays) ||
    autoSettleAfterDays < 0
  ) {
    return false;
  }
  const updatedAt = Number(thread.updatedAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now)) return false;
  return updatedAt < now - autoSettleAfterDays * 24 * 60 * 60 * 1000;
}

/** Quiet time an unmerged fork / archived worktree gets before GC takes it. */
const UNMERGED_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * A worktree that was never meant to outlive its thread (#624): one a fork
 * created (`handoffFrom` — worker threads and handoffs) or one whose thread
 * the user archived. These do not occupy the per-project keep-N buffer —
 * ten abandoned worker checkouts is ~7 GB of node_modules nobody will open
 * again — and unmerged commits do not block them, because GC removes the
 * directory only and the branch stays.
 *
 * @param {object} thread
 * @returns {boolean}
 */
function isTransientWorktree(thread) {
  if (!thread) return false;
  return thread.archived === true || thread.handoffFrom != null;
}

/**
 * Realpath when the path exists so macOS /var vs /private/var matches.
 * @param {string} p
 */
function realpathOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(String(p));
  }
}

/**
 * Branch checked out in the owning repo, memoized per repo across one scan.
 * Same convention as the sync `defaultBranch` the merge paths use, but it
 * never throws — a detached-HEAD repo just yields null and the unmerged probe
 * is skipped.
 *
 * @param {string | null} repoPath
 * @param {Map<string, Promise<string | null>>} cache
 * @returns {Promise<string | null>}
 */
function baseBranchOf(repoPath, cache) {
  if (!repoPath) return Promise.resolve(null);
  const key = path.resolve(repoPath);
  let pending = cache.get(key);
  if (!pending) {
    pending = gitTryAsync(repoPath, ["branch", "--show-current"]).then((res) =>
      res.ok && res.stdout.trim() ? res.stdout.trim() : null,
    );
    cache.set(key, pending);
  }
  return pending;
}

/**
 * True only for `fatal: not a git repository`. Other git failures (lock,
 * timeout, missing binary) must not be treated as a corrupt worktree —
 * those stay blocked so we never `fs.rm` a checkout git simply couldn't
 * talk to (#642).
 * @param {{ ok?: boolean, stderr?: string, combined?: string, stdout?: string } | null | undefined} res
 */
function gitSaysNotARepo(res) {
  if (!res || res.ok) return false;
  const text = String(res.stderr || res.combined || res.stdout || "");
  return /not a git repository/i.test(text);
}

/**
 * Drop a worktree directory git cannot operate on, then prune the repo's
 * worktree list if we know it. Never touches branches (#642).
 * @param {string} dir
 * @param {string | null} repoPath
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function forceRemoveWorktreeDir(dir, repoPath) {
  try {
    // #1392: async rm, so a sweep never blocks the main process on a delete.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? String(err.message) : "force-remove failed",
    };
  }
  if (repoPath) await gitTryAsync(repoPath, ["worktree", "prune"]);
  if (fs.existsSync(dir)) {
    return { ok: false, error: "directory still exists after force-remove" };
  }
  invalidateGitReads(dir);
  return { ok: true };
}

/**
 * @param {string} dir
 * @param {Map<string, Promise<string | null>>} [baseCache] memo for the owning
 *   repo's branch, so N worktrees of one repo cost one extra git call.
 * @param {number} [ttlMs] 0 = inflight only (destructive scans). Default GIT_READ_TTL_MS.
 * @returns {Promise<{ repoPath: string | null, readable: boolean, dirty: boolean, branch: string | null, unmerged: number, notARepo: boolean }>}
 */
async function inspectWorktreeDir(dir, baseCache, ttlMs) {
  const ttl = ttlMs == null ? GIT_READ_TTL_MS : ttlMs;
  const key = path.resolve(dir);
  return cachedRead(inspectByDir, key, ttl, () =>
    inspectWorktreeDirUncached(dir, baseCache),
  );
}

async function inspectWorktreeDirUncached(dir, baseCache) {
  const common = await gitTryAsync(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  let repoPath = null;
  if (common.ok && common.stdout) {
    repoPath = path.dirname(path.resolve(dir, common.stdout));
  }
  const status = await gitTryAsync(
    dir,
    ["status", "--porcelain", "-uall"],
    { raw: true },
  );
  const readable = Boolean(status.ok);
  const notARepo = gitSaysNotARepo(common) || gitSaysNotARepo(status);
  const dirty = readable && Boolean(String(status.stdout || "").trim());
  const br = await gitTryAsync(dir, ["branch", "--show-current"]);
  const branch = br.ok && br.stdout.trim() ? br.stdout.trim() : null;
  const unmerged = readable
    ? await unmergedCount(dir, branch, repoPath, baseCache || new Map())
    : 0;
  return { repoPath, readable, dirty, branch, unmerged, notARepo };
}

/**
 * Commits on this worktree's HEAD that the owning repo's branch does not have
 * (#601) — the line between "work nobody landed" and dead weight. Removing the
 * directory never loses them (GC keeps every branch), but a candidate carrying
 * commits must never be reclaimed by accident, so the count is surfaced and
 * `enforceRetention` skips it.
 *
 * Best-effort: any git failure counts as 0 rather than blocking a scan. That
 * biases toward reclaimable, which is safe precisely because the branch ref
 * outlives the directory.
 *
 * @param {string} dir
 * @param {string | null} branch
 * @param {string | null} repoPath
 * @param {Map<string, Promise<string | null>>} baseCache
 * @returns {Promise<number>}
 */
async function unmergedCount(dir, branch, repoPath, baseCache) {
  const base = await baseBranchOf(repoPath, baseCache);
  if (!base || (branch && branch === base)) return 0;
  const res = await gitTryAsync(dir, [
    "rev-list",
    "--count",
    "HEAD",
    `^${base}`,
  ]);
  if (!res.ok) return 0;
  const n = parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Worktree GC scan (#316). Read-only; never rejects.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.worktreeBase
 * @param {boolean} [opts.skipSizes]  skip `du` — candidates and classification
 *   are stat + git only. Boot retention never needs bytes; the GC dialog does.
 * @param {boolean} [opts.fresh]  skip inspect TTL (gcClean / enforceRetention).
 * @returns {Promise<{ candidates: object[], usage: object[], totalBytes: number }>}
 */
async function gcScan(opts) {
  try {
    return await gcScanInner(opts);
  } catch {
    return { candidates: [], usage: [], totalBytes: 0 };
  }
}

/**
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.worktreeBase
 * @param {boolean} [opts.skipSizes]
 */
async function gcScanInner(opts) {
  const { store, worktreeBase, skipSizes, fresh } = opts || {};
  const empty = { candidates: [], usage: [], totalBytes: 0 };
  if (!worktreeBase) return empty;

  /** @type {fs.Dirent[]} */
  let entries = [];
  try {
    entries = fs.readdirSync(worktreeBase, { withFileTypes: true });
  } catch {
    return empty;
  }

  const dirs = [];
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(path.join(worktreeBase, entry.name));
  }
  if (dirs.length === 0) return empty;

  const threads = (store.getThreads() || []).filter(Boolean);
  const projects = (store.getProjects() || []).filter(Boolean);
  const settings = store.getSettings ? store.getSettings() : {};
  const autoSettleAfterDays =
    settings && Object.prototype.hasOwnProperty.call(settings, "autoSettleAfterDays")
      ? settings.autoSettleAfterDays
      : 3;
  const now = Date.now();

  /** @type {Map<string, object>} */
  const threadByWt = new Map();
  for (const t of threads) {
    if (t.worktreePath) {
      threadByWt.set(path.resolve(String(t.worktreePath)), t);
    }
  }
  /** @type {Map<string, object>} */
  const projectByPath = new Map();
  for (const p of projects) {
    if (p.path) projectByPath.set(realpathOrResolve(p.path), p);
  }

  const sizes = skipSizes
    ? dirs.map(() => 0)
    : await Promise.all(dirs.map((d) => duBytes(d)));
  /** @type {Map<string, Promise<string | null>>} */
  const baseCache = new Map();
  const inspectTtl = fresh ? 0 : GIT_READ_TTL_MS;
  const inspections = await Promise.all(
    dirs.map((d) => inspectWorktreeDir(d, baseCache, inspectTtl)),
  );

  /** @type {Map<string, Array<{ thread: object, dir: string }>>} */
  const settledByProject = new Map();
  /** @type {Set<string>} */
  const transientDrop = new Set();
  for (let i = 0; i < dirs.length; i++) {
    const thread = threadByWt.get(path.resolve(dirs[i]));
    if (!thread || !isSettledForGc(thread, now, autoSettleAfterDays)) continue;
    if (isTransientWorktree(thread)) {
      // Unmerged commits do not block a transient worktree, but they buy a
      // grace period: the directory is what makes the branch mergeable in
      // app, so wait until the thread has actually gone quiet.
      if (
        inspections[i].unmerged > 0 &&
        threadActivityAt(thread) > now - UNMERGED_GRACE_MS
      ) {
        continue;
      }
      transientDrop.add(path.resolve(dirs[i]));
      continue;
    }
    const list = settledByProject.get(thread.projectId) || [];
    list.push({ thread, dir: dirs[i] });
    settledByProject.set(thread.projectId, list);
  }

  /** @type {Set<string>} */
  const retentionDrop = new Set(transientDrop);
  for (const [projectId, list] of settledByProject) {
    const project = store.getProject(projectId);
    const n = retentionFor(project);
    if (!(n > 0)) continue;
    list.sort((a, b) => threadActivityAt(b.thread) - threadActivityAt(a.thread));
    for (const item of list.slice(n)) {
      retentionDrop.add(path.resolve(item.dir));
    }
  }

  /** @type {Map<string, { projectId: string, worktrees: number, bytes: number }>} */
  const usageMap = new Map();
  const candidates = [];
  let totalBytes = 0;

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    const bytes = sizes[i];
    const insp = inspections[i];
    totalBytes += bytes;
    const thread = threadByWt.get(path.resolve(dir));

    let projectId = null;
    if (thread) {
      projectId = thread.projectId || null;
    } else if (insp.repoPath) {
      const p = projectByPath.get(realpathOrResolve(insp.repoPath));
      projectId = p ? p.id : null;
    }

    if (projectId) {
      const u = usageMap.get(projectId) || {
        projectId,
        worktrees: 0,
        bytes: 0,
      };
      u.worktrees += 1;
      u.bytes += bytes;
      usageMap.set(projectId, u);
    }

    /** @type {"orphan" | "retention" | null} */
    let reason = null;
    if (!thread) reason = "orphan";
    else if (retentionDrop.has(path.resolve(dir))) reason = "retention";
    if (!reason) continue;

    // working / pinned are never candidates (even as a safety net).
    if (thread && (thread.status === "working" || thread.status === "quota-wait")) continue;
    if (
      thread &&
      thread.pinnedAt != null &&
      Number.isFinite(thread.pinnedAt)
    ) {
      continue;
    }

    let blocked;
    let corrupt = false;
    // Orphans and transients (archived / fork) whose gitdir is gone are
    // reclaimable: `git worktree remove` cannot run, so GC force-deletes
    // the directory. Settled keep-N overflow stays blocked — the user
    // may still reopen that thread (#642).
    if (insp.notARepo && (!thread || isTransientWorktree(thread))) {
      corrupt = true;
    } else if (!insp.readable) {
      blocked = "git could not read the directory";
    } else if (insp.dirty) {
      blocked = "uncommitted changes";
    } else if (thread && (thread.status === "working" || thread.status === "quota-wait")) {
      blocked = "thread is currently working";
    }

    candidates.push({
      path: dir,
      bytes,
      reason,
      threadId: thread ? thread.id : null,
      title: thread ? thread.title || null : null,
      projectId,
      branch: thread ? thread.branch || null : insp.branch,
      ...(transientDrop.has(path.resolve(dir)) ? { transient: true } : {}),
      ...(insp.unmerged > 0 ? { unmerged: insp.unmerged } : {}),
      ...(corrupt ? { corrupt: true } : {}),
      ...(blocked ? { blocked } : {}),
    });
  }

  return {
    candidates,
    usage: [...usageMap.values()],
    totalBytes,
  };
}

/**
 * Remove one worktree directory. NEVER deletes a branch — GC reclaims
 * disk only; every commit stays reachable via its branch ref
 * (issue #316 / Conductor's cautionary tale).
 *
 * @param {import('./store').Store} store
 * @param {{ path: string, threadId: string | null, corrupt?: boolean }} cand
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function removeGcWorktree(store, cand) {
  const dir = cand.path;
  let repoPath = null;
  if (cand.threadId) {
    const thread = store.getThread(cand.threadId);
    const project = thread && store.getProject(thread.projectId);
    if (project && project.path) repoPath = project.path;
  }
  if (!repoPath && fs.existsSync(dir)) {
    const common = await gitTryAsync(dir, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (common.ok && common.stdout) {
      repoPath = path.dirname(path.resolve(dir, common.stdout));
    }
  }
  if (!fs.existsSync(dir)) {
    if (repoPath) await gitTryAsync(repoPath, ["worktree", "prune"]);
    return { ok: true };
  }
  if (cand.corrupt) {
    const forced = await forceRemoveWorktreeDir(dir, repoPath);
    if (forced.ok) invalidateGitReads(dir);
    return forced;
  }
  if (!repoPath) return { ok: false, error: "could not find owning repo" };
  const removed = await gitTryAsync(repoPath, ["worktree", "remove", dir]);
  if (removed.ok) {
    invalidateGitReads(dir);
    return { ok: true };
  }
  if (!fs.existsSync(dir)) {
    await gitTryAsync(repoPath, ["worktree", "prune"]);
    invalidateGitReads(dir);
    return { ok: true };
  }
  return {
    ok: false,
    error: tailErr(removed.stderr || removed.combined, "worktree remove failed"),
  };
}

/**
 * Batch worktree cleanup (#316). Re-scans and only removes paths the
 * fresh scan still reports as unblocked candidates.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.worktreeBase
 * @param {string[]} opts.paths
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @param {boolean} [opts.skipSizes]
 * @returns {Promise<{ removed: string[], failed: Array<{path: string, error: string}>, bytes: number }>}
 */
async function gcClean(opts) {
  const { store, worktreeBase, paths, broadcast, skipSizes } = opts || {};
  const requested = Array.isArray(paths) ? paths : [];
  const scan = await gcScan({ store, worktreeBase, skipSizes, fresh: true });
  /** @type {Map<string, object>} */
  const cleanable = new Map();
  /** @type {Map<string, object>} */
  const scanned = new Map();
  for (const c of scan.candidates) {
    const key = path.resolve(c.path);
    scanned.set(key, c);
    if (!c.blocked) cleanable.set(key, c);
  }

  const removed = [];
  const failed = [];
  let bytes = 0;
  let touchedThread = false;

  for (const raw of requested) {
    const key = path.resolve(String(raw));
    const cand = cleanable.get(key);
    if (!cand) {
      const known = scanned.get(key);
      failed.push({
        path: String(raw),
        error: known && known.blocked
          ? String(known.blocked)
          : "not a reclaimable candidate",
      });
      continue;
    }
    try {
      const result = await removeGcWorktree(store, cand);
      if (!result.ok) {
        failed.push({
          path: cand.path,
          error: result.error || "worktree remove failed",
        });
        continue;
      }
      if (cand.threadId) {
        const thread = store.getThread(cand.threadId);
        if (thread) {
          store.updateThread(cand.threadId, {
            worktreePath: null,
            branch: null,
          });
          touchedThread = true;
        }
      }
      removed.push(cand.path);
      bytes += Number(cand.bytes) || 0;
    } catch (err) {
      failed.push({
        path: cand.path,
        error: err && err.message ? String(err.message) : String(err),
      });
    }
  }

  if (touchedThread) {
    store.save();
    if (typeof broadcast === "function") {
      const { listThreads } = require("./services.js");
      broadcast("threads:changed", listThreads(store));
    }
  }
  return { removed, failed, bytes };
}

/**
 * Enforce per-project retention limits (#316 / #559): reclaim the settled
 * worktrees a project keeps past its `worktreeRetention`. After #559 the
 * default is 10, persisted on every project, so this actually runs. 0 is
 * the keep-everything hatch and is skipped. When a limit is set, the scan
 * skips `du` (activity time, not size, picks what to drop). Runs gcClean,
 * so the same guards apply: dirty trees and unreadable non-transient
 * trees are skipped; corrupt transients/orphans are force-removed (#642).
 * Branches are never deleted.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.worktreeBase
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {Promise<{ removed: string[], failed: Array<{path: string, error: string}>, bytes: number }>}
 */
async function enforceRetention(opts) {
  const { store, worktreeBase, broadcast } = opts || {};
  const projects =
    store && typeof store.getProjects === "function"
      ? store.getProjects() || []
      : [];
  const configured = new Set(
    projects.filter((p) => explicitRetention(p) > 0).map((p) => p.id),
  );
  // Unset on every project → nothing to reclaim; don't walk the disk.
  if (configured.size === 0) return { removed: [], failed: [], bytes: 0 };

  const scan = await gcScan({ store, worktreeBase, skipSizes: true, fresh: true });
  const paths = scan.candidates
    .filter(
      (c) =>
        c.reason === "retention" &&
        !c.blocked &&
        // Skip a project whose stored value is 0 (keep everything). The
        // default of 10 is persisted (#559), so it is in `configured`.
        configured.has(c.projectId) &&
        // ...and never a worktree holding commits nobody landed, unless it is
        // a fork / archived one, which the scan already put past its grace
        // period (#624). The branch survives either way.
        (c.transient === true || !(c.unmerged > 0)),
    )
    .map((c) => c.path);
  if (paths.length === 0) return { removed: [], failed: [], bytes: 0 };
  return gcClean({ store, worktreeBase, paths, broadcast, skipSizes: true });
}

/**
 * Run enforceRetention without throwing. Archive / merge call this so a
 * GC failure cannot fail the user-facing action (#559). Also reclaims
 * stale kimi-homes overlays on the same pass (#675). Also reclaims
 * remote $HOME/.solenta overlay dirs for archived ssh/WSL threads (#838).
 *
 * @param {object} opts
 * @param {import('./store').Store} [opts.store]
 * @param {string} [opts.worktreeBase]
 * @param {string} [opts.userDataPath]
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {Promise<{ removed: string[], failed: Array<{path: string, error: string}>, bytes: number }>}
 */
async function scheduleRetention(opts) {
  let result = { removed: [], failed: [], bytes: 0 };
  try {
    result = await enforceRetention(opts);
  } catch (err) {
    console.warn(
      "worktree retention:",
      err && err.message ? err.message : err,
    );
  }
  try {
    const { reclaimKimiHomes } = require("./kimi.js");
    reclaimKimiHomes(opts);
  } catch (err) {
    console.warn(
      "kimi-home retention:",
      err && err.message ? err.message : err,
    );
  }
  try {
    const { reclaimGrokHomes } = require("./grok.js");
    reclaimGrokHomes(opts);
  } catch (err) {
    console.warn(
      "grok-home retention:",
      err && err.message ? err.message : err,
    );
  }
  try {
    const { reclaimMuseHomes } = require("./muse.js");
    reclaimMuseHomes(opts);
  } catch (err) {
    console.warn(
      "muse-home retention:",
      err && err.message ? err.message : err,
    );
  }
  try {
    const { reclaimCursorHomes } = require("./cursor.js");
    reclaimCursorHomes(opts);
  } catch (err) {
    console.warn(
      "cursor-home retention:",
      err && err.message ? err.message : err,
    );
  }
  try {
    const { reclaimRemoteOverlays } = require("./remote-overlay.js");
    reclaimRemoteOverlays(opts);
  } catch (err) {
    console.warn(
      "remote-overlay retention:",
      err && err.message ? err.message : err,
    );
  }
  return result;
}

/**
 * Schedule + latch for background worktree retention (#641).
 * - Boolean latch: a tick during a running pass is a no-op (not queued).
 * - Startup pass after startupDelayMs; then every intervalMs.
 * - Timers are unref'd so they do not keep a short-lived process alive.
 * - Default sweep is scheduleRetention (failure-silent). Cheap when no
 *   project sets a limit: enforceRetention returns before any disk walk.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.worktreeBase
 * @param {string} [opts.userDataPath]
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @param {number} [opts.intervalMs] default 6 h
 * @param {number} [opts.startupDelayMs] default 15 s
 * @param {typeof setTimeout} [opts.setTimeoutFn]
 * @param {typeof setInterval} [opts.setIntervalFn]
 * @param {typeof clearTimeout} [opts.clearTimeoutFn]
 * @param {typeof clearInterval} [opts.clearIntervalFn]
 * @param {typeof scheduleRetention} [opts.sweepFn]
 */
function createRetentionSweeper(opts) {
  const store = opts.store;
  const worktreeBase = opts.worktreeBase;
  const userDataPath = opts.userDataPath;
  const broadcast = opts.broadcast;
  const intervalMs =
    opts.intervalMs != null ? opts.intervalMs : RETENTION_SWEEP_INTERVAL_MS;
  const startupDelayMs =
    opts.startupDelayMs != null
      ? opts.startupDelayMs
      : RETENTION_SWEEP_STARTUP_MS;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const sweepFn = opts.sweepFn || scheduleRetention;

  let running = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let startupTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let intervalTimer = null;

  /**
   * @returns {Promise<{ ran: boolean, result?: { removed: string[], failed: Array<{path: string, error: string}>, bytes: number } | null }>}
   */
  async function trigger() {
    if (running) return { ran: false };
    running = true;
    try {
      const result = await sweepFn({
        store,
        worktreeBase,
        userDataPath,
        broadcast,
      });
      if (result && result.removed && result.removed.length > 0) {
        console.warn(
          `worktree retention: reclaimed ${result.removed.length} worktree(s)`,
        );
      }
      return { ran: true, result };
    } catch {
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

module.exports = {
  RETENTION_SWEEP_INTERVAL_MS,
  RETENTION_SWEEP_STARTUP_MS,
  maybeCleanupMergedWorktree,
  sweepOrphanWorktrees,
  gcScan,
  removeGcWorktree,
  gcClean,
  enforceRetention,
  scheduleRetention,
  createRetentionSweeper,
};
