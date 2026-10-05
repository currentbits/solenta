"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execCommand } = require("./ssh.js");
// #559 persists this default (10) on every project; 0 is keep-everything.
const { DEFAULT_WORKTREE_RETENTION } = require("./store.js");
const {
  setExecFile,
  PATCH_TRUNCATE,
  resolveGitCommand,
  linuxPathToUnc,
  resolveWorktreeDir,
  GIT_READ_TTL_MS,
  resetGitReadCaches,
  gitOut,
  gitTry,
  gitOutAsync,
  gitOutForDiffAsync,
  gitFailureText,
  tailErr,
  gitTryAsync,
} = require("./worktrees-git.js");
const {
  repoDefaultBranch,
  repoDefaultBranchAsync,
  recordedBaseBranch,
  captureLeadSnapshot,
  resolveWorktreeStart,
  listBranches,
  defaultBranch,
  defaultBranchAsync,
  slugify,
} = require("./worktrees-branches.js");
const { conflictContext, conflictForecast } = require("./worktrees-conflicts.js");
const { push, assertNoOutboundSecrets } = require("./worktrees-push.js");
const {
  diff,
  listChangedPathsAsync,
  listChangedPaths,
  commit,
  revertFile,
  directoriesFromFiles,
  listFiles,
  searchFiles,
} = require("./worktrees-changes.js");
const {
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
} = require("./worktrees-gc.js");
const {
  removeWorktreeDir,
  mergeWorktree,
  removeWorktree,
  setupWorktree,
  retargetWorktreeBase,
  maybeRenameWorktreeBranch,
  ensureWorktree,
  prepareThreadWorktree,
  clearMissingWorktree,
} = require("./worktrees-lifecycle.js");
const {
  CHECKPOINT_SUBJECT_PREFIX,
  parseShortstat,
  runStats,
  turnDiff,
  maybeCreateCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} = require("./worktrees-checkpoints.js");
const {
  PR_REFRESH_TIMEOUT_MS,
  GH_TIMEOUT_MS,
  isGitHubRemote,
  ghTryAsync,
  parsePrJson,
  PR_LIST_FIELDS,
  PR_LIST_FIELDS_FALLBACK,
  isUnknownJsonField,
  isGhAuthFailure,
  parsePrListJson,
  listPrsRaw,
  listPrs,
  prStatus,
  parsePrChecksJson,
  parsePrChecksText,
  rollupPrChecks,
  prChecks,
  mergePr,
  isPrRefreshCandidate,
  refreshPrStates,
  createPrStateRefresher,
  PR_TOO_LARGE_PREFIX,
  parseNumstat,
  diffStatVsBase,
  createPr,
} = require("./worktrees-pr.js");

const PR_CHECKOUT_VIEW_FIELDS =
  "number,title,body,url,headRefName,isCrossRepository,state";
const PR_CHECKOUT_VIEW_FIELDS_FALLBACK =
  "number,title,body,url,headRefName,state";
const PR_CHECKOUT_FETCH_TIMEOUT_MS = 60_000;

const FORK_READONLY_NOTE =
  "This checkout is read-only (the PR comes from a fork). The branch will not be pushed unless you ask.";
const DETACHED_READONLY_NOTE =
  "This checkout is detached because the PR branch is already in use. The branch will not be pushed unless you ask.";

/**
 * Parse `gh pr view --json` for a checkout (issue #611).
 * @param {string} stdout
 * @returns {{
 *   number: number,
 *   title: string,
 *   body: string,
 *   url: string,
 *   headRefName: string,
 *   isCrossRepository: boolean,
 *   state: string,
 * }}
 */
function parsePrCheckoutView(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout || "").trim());
  } catch {
    throw new Error("gh returned unparseable PR view JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("gh returned incomplete PR view JSON");
  }
  const number = Number(data.number);
  const url = data.url != null ? String(data.url) : "";
  if (!Number.isFinite(number) || number <= 0 || !url) {
    throw new Error("gh returned incomplete PR view JSON");
  }
  return {
    number,
    title: data.title != null ? String(data.title) : "",
    body: data.body != null ? String(data.body) : "",
    url,
    headRefName: data.headRefName != null ? String(data.headRefName) : "",
    isCrossRepository: data.isCrossRepository === true,
    state: String(data.state || "OPEN").toUpperCase(),
  };
}

/**
 * First-message prompt so the agent can review the inbound PR immediately.
 * @param {{ number: number, title?: string, body?: string, url?: string }} pr
 * @param {{ diff?: string, readOnlyNote?: string | null }} [opts]
 * @returns {string}
 */
function buildPrCheckoutPrompt(pr, opts) {
  const lines = [
    `GitHub pull request #${pr.number}: ${pr.title || ""}`.trimEnd(),
    pr.url || "",
    "",
  ];
  const note = opts && opts.readOnlyNote;
  if (note) {
    lines.push(String(note), "");
  }
  const body = String((pr && pr.body) || "").trim();
  if (body) {
    lines.push(body, "");
  }
  let diff = String((opts && opts.diff) || "").trim();
  if (diff) {
    if (diff.length > PATCH_TRUNCATE) {
      diff = `${diff.slice(0, PATCH_TRUNCATE)}\n... (truncated)\n`;
    }
    lines.push("## Diff", "", "```diff", diff, "```");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * @param {import('./store').Store} store
 * @param {string} projectId
 * @param {number} prNumber
 * @param {string} [headRefName]
 */
function findExistingPrThread(store, projectId, prNumber, headRefName) {
  const threads = store.getThreads() || [];
  const inProject = threads.filter(
    (t) => t.projectId === projectId && t.archived !== true,
  );
  const byNumber = inProject.find((t) => t.prNumber === prNumber);
  if (byNumber) return byNumber;
  if (headRefName) {
    return inProject.find((t) => t.branch === headRefName) || null;
  }
  return null;
}

/**
 * Drop a half-created checkout: force-remove the worktree, then the thread
 * if we created it. Never throws — a rollback must not hide the real error.
 * @param {object} opts
 */
function abandonCheckout(opts) {
  const { store, project, threadId, addPath, created } = opts;
  if (addPath && project && project.path) {
    gitTry(project.path, ["worktree", "remove", "--force", addPath]);
  }
  if (!threadId || !store) return;
  try {
    store.updateThread(threadId, { worktreePath: null, branch: null });
    store.save();
  } catch {
    /* keep going so deleteThread can run */
  }
  if (created) {
    try {
      // Checkout-abandon rollback: thread never ran, so no artifacts to reclaim.
      require("./services.js").deleteThread(store, { threadId });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Check out a GitHub PR into a fresh worktree thread (issue #611).
 * Same-repo: `gh pr checkout` inside a new worktree. Fork (or a branch
 * already checked out elsewhere): fetch `pull/N/head` and detach, with a
 * read-only note. Never throws: missing gh / auth / non-GitHub remotes
 * come back `{ ok: false, reason }`.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.projectId
 * @param {number} opts.prNumber
 * @param {string} opts.worktreeBase
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {Promise<
 *   | { ok: true, created: boolean, readOnly: boolean, thread: object, prompt: string }
 *   | { ok: false, reason: string }
 * >}
 */
async function checkoutPr(opts) {
  const { store, projectId, worktreeBase, broadcast } = opts || {};
  const prNumber = Number(opts && opts.prNumber);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return { ok: false, reason: "Invalid pull request number" };
  }
  if (!worktreeBase) {
    return { ok: false, reason: "worktreeBase is not configured" };
  }
  const project = store && store.getProject(projectId);
  if (!project) {
    return { ok: false, reason: "Unknown project" };
  }
  if (project.remoteHost) {
    return {
      ok: false,
      reason: "Worktree threads are not available for remote projects",
    };
  }

  // Prefer the configured URL over `git remote get-url`, which applies
  // url.*.insteadOf and would hide a GitHub origin behind a local rewrite.
  let origin = await gitTryAsync(project.path, [
    "config",
    "--get",
    "remote.origin.url",
  ]);
  if (!origin.ok || !String(origin.stdout || "").trim()) {
    origin = await gitTryAsync(project.path, ["remote", "get-url", "origin"]);
  }
  if (!origin.ok) {
    return { ok: false, reason: "not a GitHub repo" };
  }
  if (!isGitHubRemote(String(origin.stdout || "").trim())) {
    return { ok: false, reason: "not a GitHub repo" };
  }

  let viewed = await ghTryAsync(
    project.path,
    ["pr", "view", String(prNumber), "--json", PR_CHECKOUT_VIEW_FIELDS],
    { timeout: GH_TIMEOUT_MS },
  );
  if (
    !viewed.ok &&
    isUnknownJsonField(viewed.stderr || viewed.combined || viewed.stdout)
  ) {
    viewed = await ghTryAsync(
      project.path,
      ["pr", "view", String(prNumber), "--json", PR_CHECKOUT_VIEW_FIELDS_FALLBACK],
      { timeout: GH_TIMEOUT_MS },
    );
  }
  if (!viewed.ok) {
    if (viewed.enoent) return { ok: false, reason: "gh missing" };
    if (isGhAuthFailure(viewed.stderr || viewed.combined || viewed.stdout)) {
      return { ok: false, reason: "auth" };
    }
    return {
      ok: false,
      reason: tailErr(viewed.stderr || viewed.combined, "gh pr view failed"),
    };
  }

  let pr;
  try {
    pr = parsePrCheckoutView(viewed.stdout);
  } catch (err) {
    return {
      ok: false,
      reason:
        err && err.message
          ? String(err.message)
          : "gh returned unparseable PR view JSON",
    };
  }

  const existing = findExistingPrThread(
    store,
    projectId,
    pr.number,
    pr.headRefName,
  );
  if (existing && existing.worktreePath && fs.existsSync(existing.worktreePath)) {
    const diffed = await ghTryAsync(
      project.path,
      ["pr", "diff", String(pr.number)],
      { timeout: GH_TIMEOUT_MS },
    );
    return {
      ok: true,
      created: false,
      readOnly: !existing.branch,
      thread: { ...existing },
      prompt: buildPrCheckoutPrompt(pr, {
        diff: diffed.ok ? diffed.stdout : "",
        readOnlyNote: existing.branch ? null : FORK_READONLY_NOTE,
      }),
    };
  }

  const services = require("./services.js");
  let thread = existing;
  let created = false;
  if (!thread) {
    thread = services.createThread(store, {
      projectId,
      title: pr.title || `PR #${pr.number}`,
    });
    created = true;
  }

  const { dir, addPath } = resolveWorktreeDir(project, worktreeBase, thread.id);
  if (addPath === dir) {
    fs.mkdirSync(worktreeBase, { recursive: true });
  } else {
    execCommand(project, "mkdir", ["-p", path.posix.dirname(addPath)]);
  }

  let readOnly = false;
  let readOnlyNote = null;
  let branch = null;

  const fail = async (reason) => {
    abandonCheckout({
      store,
      project,
      threadId: thread.id,
      addPath,
      created,
    });
    return { ok: false, reason };
  };

  const fetchPrHead = async () => {
    const fetched = await gitTryAsync(
      project.path,
      ["fetch", "origin", `pull/${pr.number}/head`],
      { timeout: PR_CHECKOUT_FETCH_TIMEOUT_MS },
    );
    if (!fetched.ok) {
      return {
        ok: false,
        reason: tailErr(fetched.stderr || fetched.combined, "git fetch failed"),
      };
    }
    const parsed = await gitTryAsync(project.path, ["rev-parse", "FETCH_HEAD"]);
    const sha = String(parsed.ok ? parsed.stdout : "").trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      return { ok: false, reason: "git fetch did not return a commit" };
    }
    return { ok: true, sha };
  };

  if (pr.isCrossRepository) {
    const head = await fetchPrHead();
    if (!head.ok) return fail(head.reason);
    try {
      gitOut(project.path, ["worktree", "add", "--detach", addPath, head.sha]);
    } catch (err) {
      return fail(`Failed to create worktree:\n${gitFailureText(err)}`);
    }
    readOnly = true;
    readOnlyNote = FORK_READONLY_NOTE;
  } else {
    try {
      gitOut(project.path, ["worktree", "add", "--detach", addPath]);
    } catch (err) {
      return fail(`Failed to create worktree:\n${gitFailureText(err)}`);
    }
    const checked = await ghTryAsync(
      dir,
      ["pr", "checkout", String(pr.number)],
      { timeout: GH_TIMEOUT_MS },
    );
    if (checked.ok) {
      try {
        branch = gitOut(dir, ["branch", "--show-current"]) || null;
      } catch {
        branch = null;
      }
      if (!branch) {
        readOnly = true;
        readOnlyNote = DETACHED_READONLY_NOTE;
      }
    } else {
      const head = await fetchPrHead();
      if (!head.ok) {
        if (checked.enoent) return fail("gh missing");
        if (isGhAuthFailure(checked.stderr || checked.combined || checked.stdout)) {
          return fail("auth");
        }
        return fail(
          tailErr(checked.stderr || checked.combined, "gh pr checkout failed"),
        );
      }
      try {
        gitOut(dir, ["checkout", "--detach", head.sha]);
      } catch (err) {
        return fail(`Failed to create worktree:\n${gitFailureText(err)}`);
      }
      readOnly = true;
      readOnlyNote = DETACHED_READONLY_NOTE;
    }
  }

  const diffed = await ghTryAsync(
    project.path,
    ["pr", "diff", String(pr.number)],
    { timeout: GH_TIMEOUT_MS },
  );
  const prompt = buildPrCheckoutPrompt(pr, {
    diff: diffed.ok ? diffed.stdout : "",
    readOnlyNote,
  });

  const updated = store.updateThread(thread.id, {
    worktreePath: dir,
    branch,
    prNumber: pr.number,
    prUrl: pr.url,
    prState:
      pr.state === "MERGED" || pr.state === "CLOSED" ? pr.state : "OPEN",
    pendingWorktree: false,
  });
  store.save();
  if (typeof broadcast === "function") {
    broadcast("threads:changed", services.listThreads(store));
  }
  const row = updated || store.getThread(thread.id);
  return {
    ok: true,
    created,
    readOnly,
    thread: { ...row },
    prompt,
  };
}

module.exports = {
  assertNoOutboundSecrets,
  setupWorktree,
  retargetWorktreeBase,
  listBranches,
  recordedBaseBranch,
  repoDefaultBranch,
  repoDefaultBranchAsync,
  captureLeadSnapshot,
  resolveWorktreeStart,
  clearMissingWorktree,
  removeWorktreeDir,
  prepareThreadWorktree,
  gitFailureText,
  maybeRenameWorktreeBranch,
  diff,
  commit,
  revertFile,
  listFiles,
  searchFiles,
  directoriesFromFiles,
  listChangedPaths,
  listChangedPathsAsync,
  mergeWorktree,
  conflictContext,
  removeWorktree,
  push,
  createPr,
  PR_TOO_LARGE_PREFIX,
  parseNumstat,
  diffStatVsBase,
  prStatus,
  prChecks,
  mergePr,
  parsePrJson,
  parsePrChecksJson,
  parsePrChecksText,
  rollupPrChecks,
  listPrs,
  listPrsRaw,
  parsePrListJson,
  checkoutPr,
  parsePrCheckoutView,
  buildPrCheckoutPrompt,
  FORK_READONLY_NOTE,
  DETACHED_READONLY_NOTE,
  isUnknownJsonField,
  PR_LIST_FIELDS,
  PR_LIST_FIELDS_FALLBACK,
  refreshPrStates,
  createPrStateRefresher,
  createRetentionSweeper,
  maybeCleanupMergedWorktree,
  sweepOrphanWorktrees,
  gcScan,
  gcClean,
  removeGcWorktree,
  enforceRetention,
  scheduleRetention,
  DEFAULT_WORKTREE_RETENTION,
  ensureWorktree,
  isPrRefreshCandidate,
  isGitHubRemote,
  gitTry,
  resolveGitCommand,
  resolveWorktreeDir,
  linuxPathToUnc,
  defaultBranch,
  defaultBranchAsync,
  gitOutAsync,
  gitOutForDiffAsync,
  setExecFile,
  ghTryAsync,
  GH_TIMEOUT_MS,
  isGhAuthFailure,
  tailErr,
  slugify,
  PATCH_TRUNCATE,
  PR_REFRESH_TIMEOUT_MS,
  RETENTION_SWEEP_INTERVAL_MS,
  RETENTION_SWEEP_STARTUP_MS,
  GIT_READ_TTL_MS,
  resetGitReadCaches,
  maybeCreateCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  runStats,
  turnDiff,
  conflictForecast,
  parseShortstat,
  gitTryAsync,
  CHECKPOINT_SUBJECT_PREFIX,
};
