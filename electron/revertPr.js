"use strict";

/**
 * "Open revert PR" for a thread whose PR merged (#1531): revert the merge on a
 * fresh branch off the latest base, push it, and open `Revert "<title>"`.
 *
 * All git work happens in a throwaway worktree, never the user's checkout.
 * Any failure removes the temp worktree and the branch (local, and remote if
 * it was pushed). In-band like prWorkspace: returns { ok: false, reason },
 * never throws.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitTryAsync, tailErr } = require("./worktrees-git.js");
const { ghTryAsync, isGitHubRemote, GH_TIMEOUT_MS } = require("./worktrees-pr.js");

const NET = { timeout: 60_000 };

/**
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {typeof ghTryAsync} [opts.runGh] test seam
 * @returns {Promise<{ ok: true, url: string, branch: string } | { ok: false, reason: string }>}
 */
async function openRevertPr(opts) {
  const runGh = opts.runGh || ((cwd, args) => ghTryAsync(cwd, args, { timeout: GH_TIMEOUT_MS }));
  const thread = opts.store.getThread(opts.threadId);
  if (!thread) return { ok: false, reason: "Unknown thread" };
  const project = opts.store.getProject(thread.projectId);
  if (!project || !project.path || project.remoteHost) {
    return { ok: false, reason: "Not available for this project" };
  }
  if (thread.prNumber == null || thread.prState !== "MERGED") {
    return { ok: false, reason: "Only a merged pull request can be reverted" };
  }
  const cwd = project.path;
  // Raw config, not get-url: url.insteadOf rewrites are a transport detail.
  const remote = await gitTryAsync(cwd, ["config", "--get", "remote.origin.url"]);
  if (!remote.ok || !isGitHubRemote(remote.stdout.trim())) {
    return { ok: false, reason: "Remote origin is not a GitHub repository" };
  }

  const viewed = await runGh(cwd, [
    "pr",
    "view",
    String(thread.prNumber),
    "--json",
    "number,title,url,baseRefName,mergeCommit",
  ]);
  if (!viewed.ok) {
    return { ok: false, reason: tailErr(viewed.stderr || viewed.combined, "gh pr view failed") };
  }
  let pr;
  try {
    pr = JSON.parse(viewed.stdout);
  } catch {
    return { ok: false, reason: "gh returned unparseable PR JSON" };
  }
  const sha = pr && pr.mergeCommit && pr.mergeCommit.oid;
  const base = pr && pr.baseRefName;
  if (!sha || !base) {
    return { ok: false, reason: "GitHub has no merge commit for this PR" };
  }

  const fetched = await gitTryAsync(cwd, ["fetch", "origin", base], NET);
  if (!fetched.ok) {
    return { ok: false, reason: tailErr(fetched.stderr || fetched.combined, `git fetch origin ${base} failed`) };
  }

  const branch = `revert-pr-${pr.number}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-revert-"));
  const wt = path.join(tmp, "wt");
  let created = false;
  let pushed = false;
  const fail = async (res, fallback) => {
    if (created) {
      await gitTryAsync(wt, ["revert", "--abort"]);
      await gitTryAsync(cwd, ["worktree", "remove", "--force", wt]);
      await gitTryAsync(cwd, ["branch", "-D", branch]);
    }
    if (pushed) await gitTryAsync(cwd, ["push", "origin", "--delete", branch], NET);
    fs.rmSync(tmp, { recursive: true, force: true });
    await gitTryAsync(cwd, ["worktree", "prune"]);
    return { ok: /** @type {const} */ (false), reason: tailErr(res.stderr || res.combined, fallback) };
  };

  const added = await gitTryAsync(cwd, ["worktree", "add", "-b", branch, wt, `origin/${base}`]);
  if (!added.ok) return fail(added, `Could not create branch ${branch}`);
  created = true;

  // A true merge commit needs a mainline; a squash/rebase commit has one parent.
  const parents = await gitTryAsync(wt, ["rev-list", "--parents", "-n", "1", sha]);
  if (!parents.ok) return fail(parents, `Merge commit ${sha.slice(0, 7)} is not on origin/${base}`);
  const isMerge = parents.stdout.trim().split(/\s+/).length > 2;
  const reverted = await gitTryAsync(
    wt,
    isMerge ? ["revert", "--no-edit", "-m", "1", sha] : ["revert", "--no-edit", sha],
  );
  if (!reverted.ok) {
    // git's conflict chatter is noise here; say what happened instead.
    return fail(
      { combined: "" },
      `Reverting #${pr.number} conflicts with later changes on ${base}; nothing was created. Revert it by hand.`,
    );
  }

  const push = await gitTryAsync(wt, ["push", "-u", "origin", branch], NET);
  if (!push.ok) return fail(push, `git push ${branch} failed`);
  pushed = true;

  const title = `Revert "${pr.title}"`;
  const body = `Reverts #${pr.number}${pr.url ? ` (${pr.url})` : ""}.`;
  const opened = await runGh(wt, [
    "pr",
    "create",
    "--base",
    base,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
  ]);
  if (!opened.ok) return fail(opened, "gh pr create failed");
  const url = opened.stdout.trim().split("\n").pop() || "";

  // The branch lives on origin now; drop the local scaffolding.
  await gitTryAsync(cwd, ["worktree", "remove", "--force", wt]);
  await gitTryAsync(cwd, ["branch", "-D", branch]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { ok: true, url, branch };
}

module.exports = { openRevertPr };
