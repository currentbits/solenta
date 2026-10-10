"use strict";

// Working-tree changes: diff, changed paths, CI-workflow merge gate, commit, revert, file search.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SYNC_TIMEOUT_MS } = require("./ssh.js");
const {
  blastRadiusFor,
  ciWorkflowFiles,
  assertCiWorkflowSignOff,
  inspectFailedMessage,
} = require("./blastRadius.js");
const {
  PATCH_TRUNCATE,
  GIT_READ_TTL_MS,
  diffByCwd,
  invalidateGitReads,
  cachedRead,
  gitOut,
  gitTry,
  gitOutForDiffAsync,
  tailErr,
  gitTryAsync,
} = require("./worktrees-git.js");
const { defaultBranchAsync } = require("./worktrees-branches.js");
const { assertNoOutboundSecrets } = require("./worktrees-push.js");

/** True when the error means the repo has no HEAD yet (no commits). */
function isNoHeadError(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return /ambiguous argument 'HEAD'|bad revision|unknown revision/i.test(msg);
}

/** Review scopes for the Git pane (#1493). */
const DIFF_SCOPES = new Set(["uncommitted", "branch", "turn"]);

/** One file's patch above this ships only on "Show anyway" (#1493). */
const FILE_PATCH_CAP = 60_000;
/** Ceiling for "Show anyway", so one generated file cannot wedge the renderer. */
const FILE_PATCH_MAX = 1_000_000;

/**
 * Changes in the thread's cwd (worktree if set, else project).
 *
 * `scope` picks the range: uncommitted (working tree vs HEAD, default),
 * branch (merge-base with the thread's base to the working tree) or turn
 * (the newest checkpoint's turn). With `path` only that file's patch is
 * returned, capped at FILE_PATCH_CAP unless `full`.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} [opts.scope]
 * @param {boolean} [opts.ignoreWhitespace]
 * @param {string} [opts.path]
 * @param {boolean} [opts.full]
 * @returns {Promise<{ files: Array<{path: string, status: string, additions: number, deletions: number, patchOmitted?: string}>, patch: string, truncated: boolean, scopeLabel?: string }>}
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

  const view = {
    scope: DIFF_SCOPES.has(String(opts.scope)) ? String(opts.scope) : "uncommitted",
    ignoreWhitespace: opts.ignoreWhitespace === true,
    path: opts.path ? String(opts.path) : "",
    full: opts.full === true,
  };
  const key = path.resolve(String(cwd || ""));
  const plain = view.scope === "uncommitted" && !view.ignoreWhitespace && !view.path;
  // Only the default view is TTL-cached: invalidateGitReads clears it by cwd.
  // Other views still coalesce concurrent calls but never serve stale reads.
  return cachedRead(
    diffByCwd,
    plain ? key : `${key}\0${view.scope}\0${view.ignoreWhitespace}\0${view.path}\0${view.full}`,
    plain ? GIT_READ_TTL_MS : 0,
    () => diffOnce(store, thread, project, cwd, view),
  );
}

/**
 * `git diff` revision args for a scope, or null when the scope has nothing
 * to show yet (no checkpoint).
 * @returns {Promise<{ range: string[], label: string } | null>}
 */
async function scopeRange(store, thread, project, cwd, scope) {
  if (scope === "turn") {
    // Lazy: worktrees-checkpoints requires this module.
    const { latestTurnRange } = require("./worktrees-checkpoints.js");
    const turn = project.remoteHost ? null : await latestTurnRange({ store, threadId: thread.id });
    return turn ? { range: [turn.from, turn.to], label: `Turn ${turn.turn}` } : null;
  }
  if (scope === "branch") {
    const base = thread.baseBranch
      || (project.remoteHost ? "origin/HEAD" : await defaultBranchAsync(project.path));
    for (const ref of diffBaseCandidates(base)) {
      try {
        const sha = await gitOutForDiffAsync(project, cwd, ["merge-base", ref, "HEAD"]);
        if (sha) return { range: [sha], label: `since ${base} (${sha.slice(0, 7)})` };
      } catch {
        // try the next candidate
      }
    }
    throw new Error(`No merge base with ${base}`);
  }
  return { range: ["HEAD"], label: "" };
}

/** Path a `diff --git` chunk belongs to (mirrors src/reviewItinerary.ts pathFromPatch). */
function chunkPath(chunk) {
  const plus = chunk.match(/^\+\+\+ [ab]\/(.+)$/m);
  if (plus && plus[1] && plus[1] !== "/dev/null") return plus[1].trim();
  const git = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (git) return (git[2] || git[1] || "").trim();
  return "";
}

/**
 * Keep whole-file patches up to PATCH_TRUNCATE total. Files over
 * FILE_PATCH_CAP are "large" (Show anyway); files past the budget are
 * "lazy" (fetched when opened). Nothing is cut mid-file.
 * @param {string} patch
 * @returns {{ patch: string, omitted: Map<string, string> }}
 */
function budgetPatch(patch) {
  const omitted = new Map();
  if (patch.length <= PATCH_TRUNCATE) return { patch, omitted };
  const kept = [];
  let used = 0;
  for (const chunk of patch.split(/(?=^diff --git )/m)) {
    const file = chunkPath(chunk);
    if (chunk.length > FILE_PATCH_CAP) omitted.set(file, "large");
    else if (used + chunk.length > PATCH_TRUNCATE) omitted.set(file, "lazy");
    else {
      kept.push(chunk);
      used += chunk.length;
    }
  }
  return { patch: kept.join(""), omitted };
}

/**
 * Uncached diff. `diff()` coalesces this per cwd and view (#688).
 * @param {import('./store').Store} store
 * @param {object} thread
 * @param {object} project
 * @param {string} cwd
 * @param {{ scope: string, ignoreWhitespace: boolean, path: string, full: boolean }} view
 */
async function diffOnce(store, thread, project, cwd, view) {
  const { scope } = view;
  const resolved = await scopeRange(store, thread, project, cwd, scope);
  if (!resolved) {
    return { files: [], patch: "", truncated: false, scopeLabel: "" };
  }
  const { range, label } = resolved;
  // Committed scopes skip rename pairing so numstat, name-status and the
  // patch all key a file by the same path.
  const flags = [
    ...(view.ignoreWhitespace ? ["-w"] : []),
    ...(scope === "uncommitted" ? [] : ["--no-renames"]),
  ];
  /** @param {string[]} args @param {string} what */
  const gitDiff = async (args, what) => {
    try {
      return await gitOutForDiffAsync(project, cwd, ["diff", ...flags, ...range, ...args]);
    } catch (err) {
      if (!isNoHeadError(err)) {
        throw new Error(`git diff${what} failed: ${String(err.message || err).split("\n")[0]}`);
      }
      return "";
    }
  };

  if (view.path) {
    const rel = assertRelPathInCwd(path.resolve(String(cwd || "")), view.path);
    const one = await gitDiff(["--", `:(literal)${rel}`], "");
    const cap = view.full ? FILE_PATCH_MAX : FILE_PATCH_CAP;
    return {
      files: [],
      patch: one.length > cap ? one.slice(0, cap) : one,
      truncated: one.length > cap,
      scopeLabel: label,
    };
  }

  /** @type {Map<string, { path: string, status: string, additions: number, deletions: number, patchOmitted?: string }>} */
  const byPath = new Map();

  if (scope !== "turn") {
    // Porcelain status for all entries; -uall lists untracked files
    // individually instead of collapsing whole directories into "?? dir/".
    // raw: the 2-char XY column starts with a significant space.
    const porcelain = await gitOutForDiffAsync(project, cwd, ["status", "--porcelain", "-uall"], {
      raw: true,
    });

    for (const line of String(porcelain || "").split("\n")) {
      if (!line) continue;
      // XY PATH or XY ORIG -> PATH for renames
      const status = line.slice(0, 2).trim() || line.slice(0, 1);
      // Branch scope takes tracked letters from name-status below.
      if (scope === "branch" && status !== "??") continue;
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

  if (scope !== "uncommitted") {
    const nameStatus = await gitDiff(["--name-status"], " --name-status");
    for (const line of nameStatus.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 2) continue;
      const filePath = parts[parts.length - 1].replace(/^"|"$/g, "");
      byPath.set(filePath, {
        path: filePath,
        status: (parts[0].trim().charAt(0) || "M").toUpperCase(),
        additions: 0,
        deletions: 0,
      });
    }
  }

  const numstat = await gitDiff(["--numstat"], " --numstat");
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

  // Untracked: additions = line count. Remote trees are not on this disk.
  for (const entry of byPath.values()) {
    if (entry.status === "??") {
      if (project.remoteHost) {
        continue;
      }
      try {
        const text = fs.readFileSync(path.join(cwd, entry.path), "utf8");
        // "a\nb\n" splits into 3 parts with a trailing empty: count 2.
        entry.additions = text.length === 0 ? 0 : text.split(/\r?\n/).length;
        if (text.endsWith("\n") && entry.additions > 0) {
          entry.additions -= 1;
        }
        entry.deletions = 0;
      } catch {
        entry.additions = 0;
        entry.deletions = 0;
      }
    }
  }

  const rawPatch = await gitDiff([], "");
  const budgeted = budgetPatch(rawPatch);
  const patch = budgeted.patch;
  for (const [file, why] of budgeted.omitted) {
    const entry = byPath.get(file);
    if (entry) entry.patchOmitted = why;
  }

  const extra = [];
  let lintPatch = rawPatch;
  if (!project.remoteHost) {
    try {
      const base = await defaultBranchAsync(project.path);
      if (base) {
        const vsBase = await gitTryAsync(cwd, [
          "diff",
          "--name-only",
          `${base}...HEAD`,
        ]);
        if (vsBase.ok) {
          for (const line of String(vsBase.stdout || "").split("\n")) {
            const p = line.trim();
            if (p) extra.push(p);
          }
        }
        const committedCi = ciWorkflowFiles(extra);
        if (committedCi.length) {
          const vsPatch = await gitTryAsync(cwd, [
            "diff",
            `${base}...HEAD`,
            "--",
            ...committedCi,
          ]);
          if (vsPatch.ok && vsPatch.stdout) {
            lintPatch = `${rawPatch}\n${vsPatch.stdout}`;
          }
        }
      }
    } catch {
      // Classification is additive; a missing base must not blank the diff.
    }
  }

  return {
    files: [...byPath.values()],
    patch,
    truncated: false,
    scopeLabel: label,
    blastRadius: blastRadiusFor(
      [...byPath.keys(), ...extra],
      lintPatch,
    ),
  };
}

/** Refs tried, in order, for a diff base name (#760). */
function diffBaseCandidates(base) {
  const name = String(base || "").trim();
  if (!name || name.includes("...")) return [];
  const out = [name];
  if (!name.startsWith("refs/") && !name.includes("://")) {
    out.push(`refs/heads/${name}`, `origin/${name}`, `refs/remotes/origin/${name}`);
  }
  return [...new Set(out)];
}

/**
 * Turn a short default-branch name (`main`) into a revision `git diff`
 * can resolve. Detached checkouts often have no local `refs/heads/main`
 * — only `origin/main` — and `main...HEAD` then fail-closes the #510
 * gate (#760).
 *
 * @param {string} cwd
 * @param {string} base
 * @returns {string}
 */
function resolveDiffBase(cwd, base) {
  for (const ref of diffBaseCandidates(base)) {
    const probe = gitTry(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (probe.ok && probe.stdout) return ref;
  }
  return "";
}

/**
 * Async variant of {@link resolveDiffBase} for read models that must not
 * block main.
 * @param {string} cwd
 * @param {string} base
 * @returns {Promise<string>}
 */
async function resolveDiffBaseAsync(cwd, base) {
  for (const ref of diffBaseCandidates(base)) {
    const probe = await gitTryAsync(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (probe.ok && probe.stdout) return ref;
  }
  return "";
}

/**
 * Async committed-diff variant of listChangedPaths for read models that
 * must not block main (crew integration). Working tree is not included.
 * @param {string} cwd
 * @param {string} base
 * @returns {Promise<{ ok: boolean, paths: string[], reason?: string }>}
 */
async function listChangedPathsAsync(cwd, base) {
  const name = String(base || "").trim();
  const ref = await resolveDiffBaseAsync(cwd, name);
  if (!ref) return { ok: false, paths: [], reason: `unknown revision '${name}'` };
  const res = await gitTryAsync(cwd, ["diff", "--name-only", `${ref}...HEAD`]);
  if (!res.ok) {
    return {
      ok: false,
      paths: [],
      reason: (res.stderr || res.combined || "").split("\n")[0].trim(),
    };
  }
  const paths = [...new Set(String(res.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean))];
  return { ok: true, paths };
}

/**
 * Re-bind a thread worktree that still has a branch but lost its
 * directory (prune, retention, hand delete). `git worktree add <dir>
 * <branch>` restores committed work. Throws a worktree error, not a
 * CI inspect block, when restore is impossible (#760).
 *
 * @param {string} projectPath
 * @param {string} wtPath
 * @param {string} branch
 */
function ensureWorktreePresent(projectPath, wtPath, branch) {
  if (wtPath && fs.existsSync(wtPath)) return;
  gitTry(projectPath, ["worktree", "remove", "--force", wtPath]);
  gitTry(projectPath, ["worktree", "prune"]);
  if (wtPath) fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const add = gitTry(projectPath, ["worktree", "add", wtPath, branch]);
  if (!add.ok) {
    throw new Error(
      tailErr(
        add.stderr || add.combined,
        `Worktree is missing and could not be restored (${wtPath})`,
      ),
    );
  }
}

/**
 * Paths changed on the branch vs `base` (three-dot) and optionally the
 * working tree. Fail-closed: a git failure returns ok:false so merge
 * cannot skip the #510 gate.
 *
 * @param {string} cwd
 * @param {{ base?: string | null, includeWorkingTree?: boolean }} opts
 * @returns {{ ok: boolean, paths: string[], reason?: string }}
 */
function listChangedPaths(cwd, opts) {
  const paths = new Set();
  const baseName = opts && opts.base ? String(opts.base).trim() : "";
  if (baseName) {
    const base = resolveDiffBase(cwd, baseName);
    if (!base) {
      return {
        ok: false,
        paths: [],
        reason: `unknown revision '${baseName}'`,
      };
    }
    const committed = gitTry(cwd, ["diff", "--name-only", `${base}...HEAD`]);
    if (!committed.ok) {
      return {
        ok: false,
        paths: [],
        reason: (committed.stderr || committed.combined || "")
          .split("\n")[0]
          .trim(),
      };
    }
    for (const line of String(committed.stdout || "").split("\n")) {
      const p = line.trim();
      if (p) paths.add(p);
    }
  }
  if (opts && opts.includeWorkingTree) {
    let dirty = "";
    try {
      dirty = gitOut(cwd, ["status", "--porcelain", "-uall"], { raw: true });
    } catch (err) {
      return {
        ok: false,
        paths: [],
        reason: String((err && err.message) || err)
          .split("\n")[0]
          .trim(),
      };
    }
    for (const line of String(dirty || "").split("\n")) {
      if (!line) continue;
      let filePath = line.slice(3);
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ").pop() || filePath;
      }
      filePath = filePath.replace(/^"|"$/g, "");
      if (filePath) paths.add(filePath);
    }
  }
  return { ok: true, paths: [...paths] };
}

/**
 * Refuse a merge when the change set touches CI/workflow files unless the
 * caller passed ciWorkflowApproved (explicit human sign-off). Issue #510;
 * also the #161 reaction-loop invariant: a machine-delivered workflow fix
 * must not bypass this.
 *
 * @param {string} cwd
 * @param {string | null | undefined} base
 * @param {boolean} includeWorkingTree
 * @param {unknown} approved
 */
function gateCiWorkflowMerge(cwd, base, includeWorkingTree, approved) {
  const listed = listChangedPaths(cwd, {
    base,
    includeWorkingTree,
  });
  if (!listed.ok) {
    throw new Error(inspectFailedMessage(listed.reason));
  }
  const files = ciWorkflowFiles(listed.paths);
  assertCiWorkflowSignOff(files, files.length && typeof approved === "function"
    ? approved(files) === true : approved === true);
}

/** Host-generated review, before checkout writes. Never truncate what is signed. */
function ciWorkflowMergeReview(thread, target, files) {
  // Require committed, clean inputs so the reviewed Git trees are exactly the
  // ones mergeWorktree will use (no auto-commit, stash, or conflict replay).
  for (const cwd of [thread.worktreePath, target]) {
    if (gitOut(cwd, ["status", "--porcelain", "-uall"])) {
      throw new Error("CI_WORKFLOW: Commit or stash changes in the worker and destination before requesting workflow sign-off.");
    }
  }
  const sourceSha = gitOut(thread.worktreePath, ["rev-parse", "HEAD"]);
  if (gitOut(thread.worktreePath, ["rev-parse", thread.branch]) !== sourceSha) {
    throw new Error("CI_WORKFLOW: Worker checkout no longer matches its branch.");
  }
  const destinationPath = fs.realpathSync(target);
  const destinationBranch = gitOut(target, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const destinationSha = gitOut(target, ["rev-parse", "HEAD"]);
  const merged = gitTry(target, ["merge-tree", "--write-tree", destinationSha, sourceSha]);
  if (!merged.ok) {
    throw new Error("CI_WORKFLOW: Could not preview a clean merge. Resolve conflicts in the worker before requesting workflow sign-off.");
  }
  const tree = merged.stdout.split("\n")[0];
  const changed = gitOut(target, ["diff", "--name-only", "--no-renames", "-z", destinationSha, tree], { raw: true });
  const workflowFiles = [...new Set([...files, ...ciWorkflowFiles(changed.split("\0"))])].sort();
  const patch = gitOut(target, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary",
    destinationSha, tree, "--", ...workflowFiles.map((file) => `:(literal)${file}`)], { raw: true });
  return {
    workerThreadId: thread.id, sourcePath: fs.realpathSync(thread.worktreePath),
    sourceBranch: thread.branch, sourceSha, destinationPath, destinationBranch,
    destinationSha, tree, files: workflowFiles, patch,
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
 * Repo-relative path from the diff file list. Rejects empties, absolute
 * paths, leading-dash pathspecs (git flags even after `--`), and anything
 * that resolves outside cwd.
 *
 * @param {string} cwd
 * @param {string} relPath
 * @returns {string}
 */
function assertRelPathInCwd(cwd, relPath) {
  const rel = String(relPath || "");
  if (!rel || path.isAbsolute(rel) || rel.startsWith("-")) {
    throw new Error(`Invalid path: ${rel || "(empty)"}`);
  }
  if (rel.split(/[/\\]/).includes("..")) {
    throw new Error(`Path escapes the working tree: ${rel}`);
  }
  const full = path.resolve(cwd, rel);
  if (full !== cwd && !full.startsWith(cwd + path.sep)) {
    throw new Error(`Path escapes the working tree: ${rel}`);
  }
  return rel;
}

/**
 * Validate an optional commit path list. `null` means stage everything
 * (`git add -A`). An empty array is a caller error (nothing selected).
 *
 * @param {string} cwd
 * @param {unknown} paths
 * @returns {string[] | null}
 */
function normalizeCommitPaths(cwd, paths) {
  if (paths == null) return null;
  if (!Array.isArray(paths)) {
    throw new Error("paths must be an array");
  }
  const out = [];
  const seen = new Set();
  for (const raw of paths) {
    const rel = assertRelPathInCwd(cwd, String(raw || ""));
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/**
 * Stage the given paths, or the whole tree when `paths` is null.
 *
 * @param {string} cwd
 * @param {string[] | null} paths
 */
function stageForCommit(cwd, paths) {
  const args = paths ? ["add", "-A", "--", ...paths] : ["add", "-A"];
  const add = gitTry(cwd, args);
  if (!add.ok) {
    throw new Error(tailErr(add.stderr || add.combined, "git add failed"));
  }
}

/**
 * Commit changes in the thread's tree. With `paths`, only those files are
 * staged and committed (`git add -A -- <paths>` + `git commit -- <paths>`);
 * omitted `paths` is add -A of the whole tree. The message is one argv
 * element, never shell-interpolated.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.message
 * @param {string[]} [opts.paths]
 * @param {Array<{ path: string, patch: string }>} [opts.patches] - hunk-level
 *   staging (#191): for these paths commit only the given patch (a subset of
 *   the file's `git diff HEAD` hunks) instead of the whole file. Each path
 *   must also be in `paths`.
 * @returns {{ subject: string }}
 */
function commit(opts) {
  const { store, threadId } = opts;
  const message = String(opts.message || "").trim();
  if (!message) {
    throw new Error("Commit message is empty");
  }
  assertNoOutboundSecrets(message, "commit message");
  const { cwd } = threadGitCwd(store, threadId);
  const paths = normalizeCommitPaths(cwd, opts.paths);
  if (paths && paths.length === 0) {
    throw new Error("No files selected");
  }
  if (!gitOut(cwd, ["status", "--porcelain", "-uall"])) {
    throw new Error("Nothing to commit");
  }
  if (paths) {
    const listed = listChangedPaths(cwd, { includeWorkingTree: true });
    const dirty = new Set(listed.ok ? listed.paths : []);
    for (const p of paths) {
      if (!dirty.has(p)) {
        throw new Error(`Not a changed file: ${p}`);
      }
    }
  }
  const patches = normalizeCommitPatches(cwd, opts.patches, paths);
  if (patches.size > 0) {
    commitPartial(cwd, message, /** @type {string[]} */ (paths), patches);
    invalidateGitReads(cwd);
    return { subject: message.split("\n")[0] };
  }
  stageForCommit(cwd, paths);
  const commitArgs = paths
    ? ["commit", "-m", message, "--", ...paths]
    : ["commit", "-m", message];
  const res = gitTry(cwd, commitArgs);
  if (!res.ok) {
    throw new Error(tailErr(res.stderr || res.combined, "git commit failed"));
  }
  invalidateGitReads(cwd);
  return { subject: message.split("\n")[0] };
}

/**
 * @param {string} cwd
 * @param {unknown} patches
 * @param {string[] | null} paths
 * @returns {Map<string, string>} path -> patch text
 */
function normalizeCommitPatches(cwd, patches, paths) {
  const out = new Map();
  if (patches == null) return out;
  if (!Array.isArray(patches)) throw new Error("patches must be an array");
  for (const p of patches) {
    const rel = assertRelPathInCwd(cwd, String((p && p.path) || ""));
    if (!paths || !paths.includes(rel)) {
      throw new Error(`Partial patch for an unselected file: ${rel}`);
    }
    const text = String((p && p.patch) || "");
    if (!text.trim()) throw new Error(`Empty patch for ${rel}`);
    out.set(rel, text);
  }
  return out;
}

/**
 * `git apply` one patch from a temp file (gitTry has no stdin). --recount:
 * gitOut trims the diff, so the last hunk can lose a blank context line.
 * --include pins the patch to `relPath` so it cannot touch other files.
 *
 * @param {string} cwd
 * @param {string[]} flags
 * @param {string} relPath
 * @param {string} patch
 * @param {NodeJS.ProcessEnv} [env]
 */
function applyPatch(cwd, flags, relPath, patch, env) {
  // ponytail: os.tmpdir() paths are invisible to git running inside WSL;
  // hunk staging/revert on WSL repos needs the patch under the git dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-patch-"));
  try {
    const file = path.join(dir, "hunk.patch");
    fs.writeFileSync(file, patch.endsWith("\n") ? patch : `${patch}\n`);
    const res = gitTry(
      cwd,
      ["apply", ...flags, "--recount", `--include=${relPath}`, file],
      env ? { env } : undefined,
    );
    if (!res.ok) {
      throw new Error(tailErr(res.stderr || res.combined, "git apply failed"));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Commit whole files plus hunk subsets through a throwaway index seeded
 * from HEAD, so the user's real index (and anything already staged outside
 * `paths`) is untouched. Afterwards the committed paths are reset to the
 * new HEAD in the real index, matching `git commit --only` semantics; the
 * unselected hunks stay as worktree changes.
 *
 * @param {string} cwd
 * @param {string} message
 * @param {string[]} paths
 * @param {Map<string, string>} patches
 */
function commitPartial(cwd, message, paths, patches) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-index-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  const run = (/** @type {string[]} */ args, /** @type {string} */ fallback) => {
    const res = gitTry(cwd, args, { env });
    if (!res.ok) throw new Error(tailErr(res.stderr || res.combined, fallback));
  };
  try {
    run(["read-tree", "HEAD"], "git read-tree failed");
    const whole = paths.filter((p) => !patches.has(p));
    if (whole.length) run(["add", "-A", "--", ...whole], "git add failed");
    for (const [rel, text] of patches) applyPatch(cwd, ["--cached"], rel, text, env);
    run(["commit", "-m", message], "git commit failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  gitTry(cwd, ["reset", "-q", "--", ...paths]);
}

/**
 * Discard one hunk (#191): reverse-apply a single-hunk patch from the
 * `git diff HEAD` output to the worktree. Other hunks in the file stay.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.path
 * @param {string} opts.patch - file header + the one hunk
 * @returns {{ path: string }}
 */
function revertHunk(opts) {
  const { store, threadId } = opts;
  const { cwd } = threadGitCwd(store, threadId);
  const relPath = assertRelPathInCwd(cwd, String(opts.path || ""));
  const patch = String(opts.patch || "");
  if (!patch.trim()) throw new Error("Empty patch");
  applyPatch(cwd, ["-R"], relPath, patch);
  invalidateGitReads(cwd);
  return { path: relPath };
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
  const { cwd } = threadGitCwd(store, threadId);
  const relPath = assertRelPathInCwd(cwd, String(opts.path || ""));
  const full = path.resolve(cwd, relPath);
  if (status === "??") {
    fs.rmSync(full, { recursive: true, force: true });
    invalidateGitReads(cwd);
    return { path: relPath };
  }
  if (status === "A") {
    const rm = gitTry(cwd, ["rm", "-f", "--", relPath]);
    if (!rm.ok) {
      throw new Error(tailErr(rm.stderr || rm.combined, "git rm failed"));
    }
    invalidateGitReads(cwd);
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
  invalidateGitReads(cwd);
  return { path: relPath };
}

const LS_FILES_CAP = 20000;
const LIST_FILES_RESULT = 20;
const LIST_FILES_RESULT_MAX = 80;
const LS_FILES_TTL_MS = 5000;
const SEARCH_FILES_RESULT = 50;
const SEARCH_FILES_TIMEOUT_MS = 8000;
const SEARCH_QUERY_MAX = 200;

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
 * Unique directory prefixes of repo-relative file paths, each with a trailing
 * slash so the mention popup can insert `@src/` as a folder token.
 *
 * @param {string[]} files
 * @returns {string[]}
 */
function directoriesFromFiles(files) {
  const dirs = new Set();
  for (const file of files) {
    const parts = String(file).split("/");
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      dirs.add(`${acc}/`);
    }
  }
  return [...dirs];
}

/**
 * Files and folders matchable by the composer's @-mention popup: tracked plus
 * untracked (gitignored excluded), plus directory prefixes derived from those
 * paths (trailing slash). Filtered case-insensitively by substring. Paths that
 * START with the query rank above mid-string matches; directories rank above
 * files at the same prefix rank so `@src` offers the folder first.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} [opts.query]
 * @param {number} [opts.limit]
 * @returns {Promise<{ files: string[] }>}
 */
async function listFiles(opts) {
  const { store, threadId } = opts;
  const query = String(opts.query || "").toLowerCase();
  const { cwd } = threadGitCwd(store, threadId);
  const all = await lsFiles(cwd);
  const entries = all.concat(directoriesFromFiles(all));
  // Copy when unfiltered: the sort below must not reorder the cached list.
  const matched = query
    ? entries.filter((p) => p.toLowerCase().includes(query))
    : entries.slice();
  matched.sort((a, b) => {
    const aPrefix = a.toLowerCase().startsWith(query) ? 0 : 1;
    const bPrefix = b.toLowerCase().startsWith(query) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    const aDir = a.endsWith("/") ? 0 : 1;
    const bDir = b.endsWith("/") ? 0 : 1;
    return aDir - bDir;
  });
  const rawLimit = Number(opts.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), LIST_FILES_RESULT_MAX)
      : LIST_FILES_RESULT;
  return { files: matched.slice(0, limit) };
}

/**
 * Fixed-string content search in the thread cwd (`git grep`). Exit 1 (no
 * hits) is empty, not an error. Scoped to the active worktree / checkout.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} [opts.query]
 * @returns {Promise<{ hits: Array<{ path: string, line: number, text: string }> }>}
 */
async function searchFiles(opts) {
  const { store, threadId } = opts;
  const query = String(opts.query || "").slice(0, SEARCH_QUERY_MAX);
  if (!query.trim()) return { hits: [] };
  const { cwd } = threadGitCwd(store, threadId);
  const out = await gitTryAsync(
    cwd,
    ["grep", "-n", "-I", "-i", "-F", "-e", query],
    { timeout: SEARCH_FILES_TIMEOUT_MS, raw: true },
  );
  if (!out.ok) {
    const code = out.error && out.error.code;
    if (code === 1) return { hits: [] };
    if (out.timedOut) throw new Error("file search timed out");
    throw new Error(tailErr(out.stderr || out.combined, "git grep failed"));
  }
  const hits = [];
  for (const line of String(out.stdout || "").split("\n")) {
    if (!line) continue;
    const m = line.match(/^(.*):(\d+):(.*)$/);
    if (!m) continue;
    hits.push({
      path: m[1],
      line: Number(m[2]),
      text: m[3].slice(0, 200),
    });
    if (hits.length >= SEARCH_FILES_RESULT) break;
  }
  return { hits };
}

module.exports = {
  diff,
  listChangedPathsAsync,
  ensureWorktreePresent,
  listChangedPaths,
  gateCiWorkflowMerge,
  ciWorkflowMergeReview,
  normalizeCommitPaths,
  stageForCommit,
  commit,
  revertFile,
  revertHunk,
  directoriesFromFiles,
  listFiles,
  lsFiles,
  searchFiles,
};
