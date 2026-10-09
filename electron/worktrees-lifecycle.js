"use strict";

// Thread worktree lifecycle: setup, retarget, rename, merge back, remove and cleanup.

const fs = require("node:fs");
const path = require("node:path");
const { execCommand } = require("./ssh.js");
const {
  resolveWorktreeDir,
  effectiveWorktreeBase,
  invalidateGitReads,
  gitOut,
  gitTry,
  splitLines,
  gitFailureText,
} = require("./worktrees-git.js");
const {
  repoDefaultBranch,
  recordedBaseBranch,
  mergeBaseName,
  resolveStartPoint,
  resolveWorktreeStart,
  refuseJjDetached,
  defaultBranch,
  worktreePathForBranch,
  slugify,
  uniqueCoderBranch,
  DEFAULT_BRANCH_PREFIX,
  branchPrefixFor,
  resolveCommitOrThrow,
} = require("./worktrees-branches.js");
const {
  unmergedFiles,
  unresolvedFiles,
  conflictError,
  autoResolveMergeArtifacts,
  parsePorcelainPath,
} = require("./worktrees-conflicts.js");
const { push } = require("./worktrees-push.js");
const {
  ensureWorktreePresent,
  gateCiWorkflowMerge,
  ciWorkflowMergeReview,
  normalizeCommitPaths,
  stageForCommit,
} = require("./worktrees-changes.js");

/**
 * Local default behind origin used to be a hard refusal (#770), but the
 * squash-landing workflow (leftover worktrees land on origin via a squash
 * from another checkout) leaves local `main` BOTH ahead (duplicate commits)
 * and behind forever — the refusal fired on every merge and new worktrees
 * kept forking from the stale base (#791). Sync instead of refusing:
 * fast-forward when only behind, a proven-conflict-free --no-edit merge when
 * diverged. A dirty checkout or a conflicting merge keeps the refusal, now
 * naming the squash-land remedy. No origin ref: skip.
 *
 * @param {string} cwd - checkout that currently has `branch` checked out
 * @param {string} branch
 */
function syncDefaultWithOrigin(cwd, branch) {
  const originRef = `origin/${branch}`;
  const hasOrigin = gitTry(cwd, ["rev-parse", "--verify", "--quiet", originRef]);
  if (!hasOrigin.ok) return;
  const counted = gitTry(cwd, [
    "rev-list",
    "--left-right",
    "--count",
    `${originRef}...${branch}`,
  ]);
  if (!counted.ok) return;
  const line = String(counted.stdout || "").trim().split(/\r?\n/)[0] || "";
  const m = line.match(/^(\d+)\s+(\d+)$/);
  if (!m) return;
  const behind = Number(m[1]);
  const ahead = Number(m[2]);
  if (behind === 0) return;

  const refuse = () => {
    throw new Error(
      `Local ${branch} is ${behind} behind origin/${branch}` +
        (ahead > 0 ? ` and ${ahead} ahead` : "") +
        "; update it before merging so the work lands on the repo default." +
        (ahead > 0
          ? ` If those ${ahead} commits already landed upstream via a squash, back the branch up and reset it: git branch backup-diverged-${branch} ${branch} && git reset --hard origin/${branch}`
          : ""),
    );
  };

  // Never move a checkout out from under uncommitted tracked work.
  const dirty = gitOut(cwd, ["status", "--porcelain", "-uno"], {
    raw: true,
  }).trim();
  if (dirty) refuse();

  if (ahead === 0) {
    if (!gitTry(cwd, ["merge", "--ff-only", originRef]).ok) refuse();
    return;
  }
  // Diverged: merge origin in only when git proves the merge conflict-free
  // (merge-tree --write-tree, git >= 2.38) — a local commit upstream never
  // saw must never be auto-resolved away. Old git or conflicts: refuse.
  if (!gitTry(cwd, ["merge-tree", "--write-tree", branch, originRef]).ok) {
    refuse();
  }
  if (!gitTry(cwd, ["merge", "--no-edit", originRef]).ok) {
    gitTry(cwd, ["merge", "--abort"]);
    refuse();
  }
}

/**
 * Merge needs a working tree that is ON `branch`. Follow that name into
 * the worktree that has it, or switch the preferred path onto the branch
 * if it is free. A different current branch is not a match (#770).
 *
 * @param {string} preferredPath
 * @param {string} branch
 * @returns {string}
 */
function checkoutForMerge(preferredPath, branch) {
  const current = gitOut(preferredPath, ["branch", "--show-current"]);
  if (current === branch) return preferredPath;
  const home = worktreePathForBranch(preferredPath, branch);
  if (home && path.resolve(home) !== path.resolve(preferredPath)) {
    return home;
  }
  const sw = gitTry(preferredPath, ["switch", "--", branch]);
  if (sw.ok) return preferredPath;
  throw new Error(
    home
      ? `${branch} is checked out in ${home}`
      : `Could not check out ${branch} to merge${current ? ` (currently on ${current})` : ""}`,
  );
}

function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * `git worktree remove` without blocking on the delete (#1392). The sync
 * remove froze the main process for the whole recursive delete (0.4 s for
 * a median worktree, 4 s for a large one; the 15 s cap failed a merge that
 * had landed). Same refusals as git, then an O(1) rename aside, a prune,
 * and an async delete. Only a LINKED worktree of repoPath qualifies (never
 * the main checkout); anything else, or a failed rename (Windows EBUSY),
 * falls back to git's own remove.
 *
 * @param {string} repoPath
 * @param {string} wtPath
 * @param {boolean} force
 * @returns {{ ok: boolean, combined: string }}
 */
function removeWorktreeDir(repoPath, wtPath, force) {
  // #1519: git's own clean check honours status.showUntrackedFiles=no and
  // would delete untracked files; force it back to normal.
  const fallback = () =>
    gitTry(
      repoPath,
      force
        ? ["worktree", "remove", "--force", wtPath]
        : ["-c", "status.showUntrackedFiles=normal", "worktree", "remove", wtPath],
    );
  const list = gitTry(repoPath, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return fallback();
  const target = realOrResolved(wtPath);
  const linked = list.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .slice(1) // the first entry is the main checkout
    .map((l) => realOrResolved(l.slice("worktree ".length)));
  if (!linked.includes(target)) return fallback();
  if (!force) {
    // git refuses worktrees with submodules; let it say so (#1519).
    if (fs.existsSync(path.join(target, ".gitmodules"))) return fallback();
    // #1519: plain status honours status.showUntrackedFiles=no and
    // submodule.*.ignore, so a dirty tree read as clean and was deleted.
    const st = gitTry(wtPath, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ]);
    if (!st.ok) return fallback();
    if (st.stdout) {
      return {
        ok: false,
        combined: `fatal: '${wtPath}' contains modified or untracked files, use --force to delete it`,
      };
    }
  }
  const trash = path.join(
    path.dirname(target),
    `.trash-${path.basename(target)}-${Date.now()}`,
  );
  try {
    fs.renameSync(target, trash);
  } catch {
    return fallback();
  }
  gitTry(repoPath, ["worktree", "prune"]);
  invalidateGitReads(target);
  // ponytail: fire-and-forget; a crash mid-delete leaves a .trash-* dir that
  // is not a git repo, which the boot orphan sweep force-removes.
  void fs.promises
    .rm(trash, { recursive: true, force: true, maxRetries: 3 })
    .catch(() => {});
  return { ok: true, combined: "" };
}

/**
 * Clear thread worktree fields, remove worktree dir + branch, save, broadcast.
 * A missing directory is already-removed: do not throw, still null
 * worktreePath + branch (not pendingWorktree). Real git failures still throw.
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
    if (fs.existsSync(wtPath)) {
      const rem = removeWorktreeDir(project.path, wtPath, Boolean(forceRemove));
      if (!rem.ok && fs.existsSync(wtPath)) {
        throw new Error(
          `Failed to remove worktree: ${rem.combined.split("\n")[0]}`,
        );
      }
    } else {
      // Already gone (orphan sweep, hand delete, leftover after #840).
      // Prune the stale registration; still clear store fields below (#843).
      gitTry(project.path, ["worktree", "prune"]);
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
    lane: undefined,
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
 * Squash-merge the thread worktree into the repo default branch
 * (origin/HEAD → main), then remove the worktree and branch. Commits any
 * uncommitted worktree changes first.
 *
 * intoPath retargets the merge at another checkout of the SAME repo — an
 * orchestrator merging a worker wants the work on its own branch in its own
 * worktree, not on main behind the user's back (thread_merge). Git-tab
 * Merge (no intoPath) targets ThreadInfo.baseBranch if set, otherwise the
 * repo default (origin/HEAD → main), not the project checkout's current
 * branch (#187 / #770). intoPath staging is not a final land: issues stay
 * open and a receipt is recorded on the lead (#947).
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} [opts.intoPath] - merge target checkout; defaults to project.path
 * @param {string[]} [opts.paths] - stage only these paths before the session
 *   commit; omitted = add -A. Leftover dirty files refuse the merge so the
 *   worktree is not deleted with uncommitted work.
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @param {(review: object) => boolean} [opts.ciWorkflowSignOff] host-only
 *   approval lookup/request, bound to the exact clean merge preview
 * @returns {object} updated ThreadInfo
 */
function mergeWorktree(opts) {
  const { store, threadId, intoPath, broadcast } = opts;

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
  ensureWorktreePresent(project.path, wtPath, branch);
  const requested = intoPath || project.path;
  if (path.resolve(requested) === path.resolve(wtPath)) {
    throw new Error(`Cannot merge thread ${threadId} into its own worktree`);
  }

  // Blast-radius gate (issue #510) before auto-commit: a workflow file in
  // the working tree or the branch vs base is a privilege-escalation, not
  // a code edit. Human sign-off is ciWorkflowApproved === true.
  //
  // Target: intoPath stays the lead checkout's current branch. Otherwise
  // honor ThreadInfo.baseBranch, falling back to the repo default
  // (origin/HEAD → main) — not whatever the project checkout happens to
  // have checked out (#187 / #770).
  let baseForGate;
  let target;
  if (intoPath) {
    baseForGate = defaultBranch(requested);
    target = requested;
  } else {
    if (!recordedBaseBranch(thread)) {
      refuseJjDetached(project.path);
    }
    baseForGate = mergeBaseName(thread, project.path);
    target = checkoutForMerge(requested, baseForGate);
    if (!recordedBaseBranch(thread)) {
      syncDefaultWithOrigin(target, baseForGate);
    }
  }
  gateCiWorkflowMerge(
    wtPath,
    baseForGate,
    true,
    typeof opts.ciWorkflowSignOff === "function"
      ? (files) => opts.ciWorkflowSignOff(ciWorkflowMergeReview(thread, target, files))
      : opts.ciWorkflowApproved === true,
  );

  // (a) Commit any uncommitted worktree changes. Refuse while conflicts are
  // unresolved: `add -A` would happily commit the markers.
  const pending = unresolvedFiles(wtPath);
  if (pending.length) {
    if (!autoResolveMergeArtifacts(wtPath) || unresolvedFiles(wtPath).length) {
      throw conflictError(
        "Unresolved conflicts in the worktree:",
        unresolvedFiles(wtPath).length ? unresolvedFiles(wtPath) : pending,
        "Resolve them in the worktree, then merge again.",
      );
    }
  }

  const wtStatus = gitOut(wtPath, ["status", "--porcelain", "-uall"], {
    raw: true,
  }).trim();
  if (wtStatus) {
    const paths = normalizeCommitPaths(wtPath, opts.paths);
    // Empty `paths` means the Git pane staged nothing further: do not
    // auto-commit. The leftover check below then refuses so the worktree
    // is not deleted with uncommitted files.
    if (!paths || paths.length > 0) {
      stageForCommit(wtPath, paths);
      const commitMsg = `coder: session changes for ${thread.title}`;
      const commitArgs = paths
        ? ["commit", "-m", commitMsg, "--", ...paths]
        : ["commit", "-m", commitMsg];
      const committed = gitTry(wtPath, commitArgs);
      if (!committed.ok) {
        throw new Error(
          `Failed to commit worktree changes: ${committed.combined.split("\n")[0]}`,
        );
      }
    }
    if (paths) {
      const leftoverRaw = gitOut(wtPath, ["status", "--porcelain", "-uall"], {
        raw: true,
      }).trim();
      if (leftoverRaw) {
        const leftover = leftoverRaw
          .split("\n")
          .map((line) => parsePorcelainPath(line))
          .filter(Boolean);
        throw new Error(
          `Uncommitted files remain:\n${leftover.map((f) => `  ${f}`).join("\n")}\nDiscard or include them before merging.`,
        );
      }
    }
  }

  // (b) Target checkout's current branch (must not be detached)
  const baseBranch = baseForGate;

  // (c) A dirty project checkout used to be a hard refusal — TRACKED changes
  // only, since a stray untracked scratch file blocked every merge forever
  // (issue #198). But the checkout is shared by every thread in the project,
  // so one uncommitted edit still blocked every merge in the app until someone
  // stashed it by hand. Stash it here and put it back below. (git's own
  // `merge --autostash` is no use: `--squash` leaves the merge uncommitted, so
  // the pop would land in a half-merged index before our commit.)
  const mainStatus = gitOut(
    target,
    ["status", "--porcelain", "--untracked-files=no"],
    { raw: true },
  ).trim();
  let stashed = false;
  if (mainStatus) {
    const push = gitTry(target, [
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
    mergeInto(target, branch, baseBranch, wtPath, thread);
  } catch (err) {
    mergeError = err;
  }
  if (stashed) {
    const popped = gitTry(target, ["stash", "pop"]);
    if (!popped.ok && !mergeError) {
      // The entry stays in the stash list when a pop fails, so nothing is
      // lost — but say where it is instead of leaving a silently empty tree.
      throw new Error(
        `Merged ${branch}, but the project checkout's own changes did not come back cleanly. They are safe in \`git stash\` (stash@{0}): ${popped.combined.split("\n")[0]}`,
      );
    }
  }
  if (mergeError) throw mergeError;

  // Classify from the target contract, not from "squash succeeded" (#947).
  // intoPath → another checkout is integration; no intoPath (or the project
  // checkout itself) is a final land.
  const { classifyMergeLanding, recordWorkerIntegration } = require("./crewIntegration.js");
  const landing = classifyMergeLanding(intoPath, project.path);

  // Staging records a receipt here, before cleanup erases the worker's
  // worktreePath/branch. Landing the lead itself (final) with receipts
  // marks the combined result Landed.
  if (typeof opts.afterMerge === "function") {
    opts.afterMerge({ thread, target, branch });
  }
  if (landing === "integrated") {
    try {
      recordWorkerIntegration(store, {
        worker: store.getThread(threadId) || thread,
        targetPath: target,
        intoPath,
      });
    } catch {
      // receipt is best-effort; the squash already succeeded
    }
  }
  if (landing === "final") {
    const live = store.getThread(thread.id) || thread;
    const receipts = Array.isArray(live.integrationReceipts)
      ? live.integrationReceipts
      : [];
    if (receipts.length) {
      const sha = gitTry(target, ["rev-parse", "HEAD"]);
      store.updateThread(thread.id, {
        integrationLanded: {
          at: Date.now(),
          sha: sha.ok ? String(sha.stdout || "").trim() || null : null,
          via: "merge",
        },
      });
      store.save();
    }
  }

  // Close planboard issues only on a final land (#632 / #947).
  // Fire-and-forget — a gh hiccup must not fail a merge that succeeded.
  if (landing === "final" && opts.skipIssueComplete !== true) {
    try {
      void require("./postmerge.js")
        .completeThreadIssue(store, threadId)
        .catch(() => {});
    } catch {
      // ignore
    }
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
 * Squash `branch` into the current branch of the `target` checkout and commit
 * it. Split out of mergeWorktree so every throw in here unwinds through the one
 * stash-restore step there.
 */
function mergeInto(target, branch, baseBranch, wtPath, thread) {
  // Untracked files the merge WOULD write over: git refuses these too, but
  // only mid-merge, reported as a conflict against files nobody edited.
  const incoming = gitTry(
    target,
    ["diff", "--name-only", `${baseBranch}...${branch}`],
    { raw: true },
  );
  if (incoming.ok) {
    const untracked = new Set(splitLines(
      gitOut(target, ["ls-files", "--others", "--exclude-standard"], {
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

  // Squash into the target checkout, always restoring it on failure.
  const squash = () => {
    const res = gitTry(target, ["merge", "--squash", branch]);
    if (res.ok) return null;
    if (autoResolveMergeArtifacts(target)) return null;
    const files = unmergedFiles(target);
    gitTry(target, ["merge", "--abort"]);
    gitTry(target, ["reset", "--hard", "HEAD"]);
    return { files, combined: res.combined };
  };

  let failed = squash();
  if (failed) {
    // Replay the conflict inside the worktree — that is where the agent, the
    // editor and the user can actually resolve it. A clean replay means the
    // branch only needed the newer base commits, so the squash can retry.
    const replay = gitTry(wtPath, ["merge", baseBranch]);
    if (!replay.ok && autoResolveMergeArtifacts(wtPath)) {
      gitTry(wtPath, [
        "commit",
        "--no-edit",
        "-m",
        `Merge ${baseBranch} into ${branch}`,
      ]);
      failed = squash();
    } else {
      failed = replay.ok ? squash() : failed;
    }
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
  const commitResult = gitTry(target, ["commit", "-m", commitMsg]);
  if (!commitResult.ok) {
    const nothing =
      /nothing to commit|no changes added to commit/i.test(
        commitResult.combined,
      );
    if (!nothing) {
      // Unexpected commit failure: restore and report
      gitTry(target, ["merge", "--abort"]);
      gitTry(target, ["reset", "--hard", "HEAD"]);
      throw new Error(
        `Failed to commit merge: ${commitResult.combined.split("\n")[0]}`,
      );
    }
    // Empty squash (no net changes): still clean up worktree
    gitTry(target, ["reset", "--hard", "HEAD"]);
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
  const wanted = `${branchPrefixFor(project)}${slugify(thread.title)}-${shortId}`;
  const branch = uniqueCoderBranch(project.path, wanted) || wanted;
  const base = effectiveWorktreeBase(store, worktreeBase);
  const { dir, addPath } = resolveWorktreeDir(project, base, thread.id);

  if (addPath === dir) {
    fs.mkdirSync(base, { recursive: true });
  } else {
    // Parent of the linux worktree must exist inside the distro. The
    // Windows userData path is the wrong side and git worktree add will
    // not create intermediate directories.
    execCommand(project, "mkdir", ["-p", path.posix.dirname(addPath)]);
  }

  // Timed for the transcript's "Worktree ready · … · 2.1s" line (#1411);
  // covers the start-point resolution (incl. a Start-from-origin fetch).
  const setupStartedAt = Date.now();
  try {
    const start = resolveWorktreeStart(thread, project.path);
    gitOut(project.path, ["worktree", "add", "-b", branch, addPath, start]);
  } catch (err) {
    // Verbatim git stderr (#511). Never first-line-only: the lock/disk/
    // submodule reason is almost always on a later line.
    throw new Error(`Failed to create worktree:\n${gitFailureText(err)}`);
  }

  const updated = store.updateThread(threadId, {
    worktreePath: dir,
    branch,
    worktreeSetupMs: Math.max(0, Date.now() - setupStartedAt),
  });
  store.save();

  if (typeof broadcast === "function") {
    const { listThreads } = require("./services.js");
    broadcast("threads:changed", listThreads(store));
  }

  // Issue #153: fire-and-forget. A failed npm install must not undo the
  // worktree, and setupWorktree stays sync for the existing call sites.
  const { kickWorktreeSetup } = require("./projectCommands.js");
  const setup = kickWorktreeSetup({
    store,
    threadId,
    cwd: dir,
    project,
    broadcast,
  });
  if (setup && typeof setup.catch === "function") {
    setup.catch(() => {});
  }

  return updated ? { ...updated } : { ...thread, worktreePath: dir, branch };
}

function retargetWorktreeBase(opts) {
  const { store, thread, baseName, fromRef, ontoRef } = opts;
  const wtPath = thread && thread.worktreePath;
  if (!wtPath) return;

  const project = store.getProject(thread.projectId);
  if (!project || !project.path) {
    throw new Error(`Unknown project for thread: ${thread.id}`);
  }

  const porcelain = gitOut(wtPath, ["status", "--porcelain", "-uall"], {
    raw: true,
  });
  if (String(porcelain || "").trim()) {
    throw new Error(
      "WORKTREE_DIRTY: cannot change the merge base while the worktree has uncommitted changes",
    );
  }

  const startName = ontoRef || baseName || repoDefaultBranch(project.path);
  const start = ontoRef
    ? resolveCommitOrThrow(project.path, ontoRef)
    : resolveStartPoint(project.path, startName);
  const oldStartName =
    fromRef || recordedBaseBranch(thread) || repoDefaultBranch(project.path);
  const oldStart = fromRef
    ? resolveCommitOrThrow(project.path, fromRef)
    : resolveStartPoint(project.path, oldStartName);
  const oldSha = gitOut(project.path, [
    "rev-parse",
    "--verify",
    `${oldStart}^{commit}`,
  ]);
  const newSha = gitOut(project.path, [
    "rev-parse",
    "--verify",
    `${start}^{commit}`,
  ]);
  if (oldSha === newSha) return;

  const uniqueCount = gitOut(wtPath, [
    "rev-list",
    "--count",
    `${oldStart}..HEAD`,
  ]);
  if (uniqueCount && uniqueCount !== "0") {
    const before = gitOut(wtPath, ["rev-parse", "HEAD"]);
    const replay = gitTry(wtPath, ["rebase", "--onto", start, oldStart], {
      env: { GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" },
    });
    if (!replay.ok) {
      const files = unmergedFiles(wtPath);
      if (!files.length) {
        for (const m of String(replay.combined || "").matchAll(
          /Merge conflict in (.+)/g,
        )) {
          const p = m[1].trim();
          if (p && !files.includes(p)) files.push(p);
        }
      }
      const aborted = gitTry(wtPath, ["rebase", "--abort"]);
      if (!aborted.ok) {
        gitTry(wtPath, ["reset", "--hard", before]);
      }
      const listed = files.length
        ? `\n${files.map((f) => `  ${f}`).join("\n")}`
        : "";
      throw new Error(
        `WORKTREE_REBASE_CONFLICT: cannot rebase onto ${startName}${listed}`,
      );
    }
  } else {
    gitOut(wtPath, ["reset", "--hard", start]);
  }
  invalidateGitReads(wtPath);
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
  // Keep the prefix the branch was born with (#1506): the project's
  // prefix may have changed since, and older threads carry `coder/`.
  const placeholderTail = `new-thread-${shortId}`;
  const bornWith = thread.branch.endsWith(placeholderTail)
    ? thread.branch.slice(0, -placeholderTail.length)
    : null;
  const project = store.getProject(thread.projectId);
  if (
    bornWith === null ||
    (bornWith !== DEFAULT_BRANCH_PREFIX && bornWith !== branchPrefixFor(project))
  ) {
    return null;
  }
  const wanted = `${bornWith}${slugify(newTitle)}-${shortId}`;
  if (wanted === thread.branch) {
    return null;
  }
  const next = uniqueCoderBranch(thread.worktreePath, wanted);
  // Best-effort: if every suffix is taken, leave the placeholder alone.
  if (!next || next === thread.branch) {
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
 * Ready a worktree-isolated thread for a turn (#511). A missing folder
 * re-arms pendingWorktree and rematerializes. Creation failure throws and
 * keeps the flag — there is no fallback to the project checkout.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.worktreeBase
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {object} current ThreadInfo
 */
function prepareThreadWorktree(opts) {
  clearMissingWorktree(opts);
  return ensureWorktree(opts);
}

/**
 * Drop a worktreePath that no longer exists on disk. A worktree removed
 * outside the app (an agent running `git worktree remove`, or the folder
 * deleted by hand) leaves the thread pointing at nothing, and spawning a CLI
 * into a missing cwd fails as "spawn kimi ENOENT" — which reads as a missing
 * binary (#74). Re-arms pendingWorktree so the next turn rematerializes
 * instead of silently running in the project checkout (#511).
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

  store.updateThread(threadId, {
    worktreePath: null,
    branch: null,
    pendingWorktree: true,
  });
  store.save();

  if (typeof broadcast === "function") {
    const { listThreads } = require("./services.js");
    broadcast("threads:changed", listThreads(store));
  }
  return wtPath;
}

module.exports = {
  removeWorktreeDir,
  mergeWorktree,
  removeWorktree,
  setupWorktree,
  retargetWorktreeBase,
  maybeRenameWorktreeBranch,
  ensureWorktree,
  prepareThreadWorktree,
  clearMissingWorktree,
};
