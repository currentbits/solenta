"use strict";

/**
 * Publish a checkout that has no `origin` (issue #456): create the repo on
 * the chosen forge, add it as origin, push the current branch. The secret
 * scan runs over the whole history first, since all of it leaves the machine.
 *
 * GitHub: `gh repo create --source . --push` (gh adds origin and pushes).
 * GitLab: `glab repo create`, Azure DevOps: `az repos create`, Bitbucket
 * Cloud: REST POST; for those three Solenta adds origin and pushes itself.
 */

const { ghTryAsync, gitTryAsync, tailErr } = require("./worktrees.js");
const { scanOutgoingPush } = require("./worktrees-push.js");
const { resolveThreadRoot } = require("./ipc-shared.js");

const FORGES = new Set(["github", "gitlab", "bitbucket", "azure-devops"]);
/** gh --push and a first push carry the whole history; give them longer than 30s. */
const PUBLISH_TIMEOUT_MS = 120_000;
const NAME_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function git(cwd, args) {
  const res = await gitTryAsync(cwd, args, { timeout: PUBLISH_TIMEOUT_MS });
  if (!res.ok) {
    if (res.timedOut) throw new Error(`git ${args[0]} timed out`);
    throw new Error(tailErr(res.stderr || res.combined, `git ${args[0]} failed`));
  }
  return String(res.stdout || "").trim();
}

/** Throws unless `value` is a plain path segment (no flags, slashes, or spaces). */
function segment(value, what) {
  const s = String(value || "").trim();
  if (!NAME_RE.test(s)) throw new Error(`Invalid ${what}: ${JSON.stringify(s)}`);
  return s;
}

/** `name` or `owner/name` for gh and glab, which take an optional namespace. */
function namespaced(value) {
  const parts = String(value || "").trim().split("/");
  if (parts.length > 2) throw new Error(`Invalid repository name: ${JSON.stringify(value)}`);
  return parts.map((p) => segment(p, "repository name")).join("/");
}

/** Bare org name or an https org URL → org URL for `az --org`. */
function azureOrgUrl(org) {
  const s = String(org || "").trim().replace(/\/+$/, "");
  if (/^https:\/\/[^\s]+$/i.test(s)) return s;
  return `https://dev.azure.com/${segment(s, "Azure DevOps organization")}`;
}

/**
 * Create the remote repo. GitHub also adds origin and pushes.
 * @returns {Promise<{ webUrl: string, remoteUrl: string | null, pushed: boolean }>}
 */
async function createRemote(cwd, input) {
  const priv = input.visibility !== "public";
  if (input.forge === "github") {
    const res = await ghTryAsync(
      cwd,
      ["repo", "create", namespaced(input.name), "--source", ".", "--remote", "origin", "--push", priv ? "--private" : "--public"],
      { timeout: PUBLISH_TIMEOUT_MS },
    );
    if (!res.ok) {
      if (res.enoent) throw new Error("GitHub CLI (gh) is not installed");
      throw new Error(tailErr(res.stderr || res.combined, "gh repo create failed"));
    }
    const url = (res.combined.match(/https:\/\/\S+/) || [""])[0];
    return { webUrl: url, remoteUrl: null, pushed: true };
  }
  if (input.forge === "gitlab") {
    const { glabBin } = require("./gitlab.js");
    const res = await ghTryAsync(
      cwd,
      ["repo", "create", namespaced(input.name), priv ? "--private" : "--public"],
      { bin: glabBin(), timeout: PUBLISH_TIMEOUT_MS },
    );
    if (!res.ok) {
      if (res.enoent) throw new Error("GitLab CLI (glab) is not installed");
      throw new Error(tailErr(res.stderr || res.combined, "glab repo create failed"));
    }
    // glab prints "Created repository … on GitLab: <url>", and may add origin itself.
    const printed = (res.combined.match(/https?:\/\/\S+/) || [""])[0].replace(/[.,]$/, "");
    const origin = await gitTryAsync(cwd, ["remote", "get-url", "origin"]);
    const remoteUrl = origin.ok ? String(origin.stdout).trim() : printed ? `${printed}.git` : "";
    if (!remoteUrl) throw new Error("glab created the repository but printed no URL; add origin by hand");
    return { webUrl: printed || remoteUrl, remoteUrl, pushed: false };
  }
  if (input.forge === "azure-devops") {
    const { az } = require("./azureDevops.js");
    // Project names may hold spaces; --opt=value keeps a leading "-" from reading as a flag.
    const azProject = String(input.project || "").trim();
    if (!azProject) throw new Error("Azure DevOps project is required");
    const repo = await az(
      cwd,
      ["repos", "create", `--name=${segment(input.name, "repository name")}`, `--project=${azProject}`, "--org", azureOrgUrl(input.org)],
      PUBLISH_TIMEOUT_MS,
    );
    if (!repo || !repo.remoteUrl) throw new Error("az repos create returned no remoteUrl");
    return { webUrl: String(repo.webUrl || repo.remoteUrl), remoteUrl: String(repo.remoteUrl), pushed: false };
  }
  const { bbApi } = require("./bitbucket.js");
  const remote = {
    workspace: segment(input.workspace, "Bitbucket workspace"),
    repo: segment(input.name, "repository name").toLowerCase(),
  };
  const repo = await bbApi(remote, "POST", "", { scm: "git", is_private: priv });
  const links = (repo && repo.links) || {};
  const clone = (Array.isArray(links.clone) ? links.clone : []).find((l) => l && l.name === "https");
  if (!clone || !clone.href) throw new Error("Bitbucket returned no https clone URL");
  return {
    webUrl: String((links.html && links.html.href) || clone.href),
    remoteUrl: String(clone.href),
    pushed: false,
  };
}

/**
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {"github"|"gitlab"|"bitbucket"|"azure-devops"} opts.forge
 * @param {string} opts.name repo name (`owner/name` allowed for GitHub/GitLab)
 * @param {"private"|"public"} [opts.visibility] ignored by Azure (project-level)
 * @param {string} [opts.workspace] Bitbucket
 * @param {string} [opts.org] Azure DevOps org name or URL
 * @param {string} [opts.project] Azure DevOps project
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {Promise<{ forge: string, webUrl: string, branch: string }>}
 */
async function publishRepo(opts) {
  const { project, root } = resolveThreadRoot(opts.store, opts.threadId);
  if (project.remoteHost) throw new Error("Publish is not available on remote projects");
  if (!FORGES.has(opts.forge)) throw new Error(`Unknown forge: ${opts.forge}`);
  const remotes = (await git(root, ["remote"])).split("\n").map((s) => s.trim());
  if (remotes.includes("origin")) throw new Error("This checkout already has an origin remote");
  const branch = await git(root, ["branch", "--show-current"]);
  if (!branch) throw new Error("Check out a branch before publishing");
  await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => {
    throw new Error("Commit something before publishing");
  });

  scanOutgoingPush(root, branch, { wholeHistory: true });

  const created = await createRemote(root, opts);
  if (!created.pushed) {
    try {
      // glab may already have added origin; only add when it is still missing.
      const now = (await git(root, ["remote"])).split("\n").map((s) => s.trim());
      if (!now.includes("origin")) await git(root, ["remote", "add", "origin", created.remoteUrl]);
      await git(root, ["push", "-u", "origin", branch]);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      throw new Error(`Created ${created.webUrl}, but the push failed: ${msg} Fix the remote credentials, then use Push.`);
    }
  }

  if (typeof opts.broadcast === "function") {
    const { listThreads } = require("./services.js");
    opts.broadcast("threads:changed", listThreads(opts.store));
  }
  return { forge: opts.forge, webUrl: created.webUrl, branch };
}

module.exports = { publishRepo, azureOrgUrl };
