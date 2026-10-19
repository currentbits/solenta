"use strict";

/**
 * Azure DevOps PR backend (issue #456). Same contract as gitlab.js (PrInfo,
 * check buckets) for create / status / checks / merge only: the planboard
 * and issue ingestion stay GitHub/GitLab. Drives `az repos pr` from the
 * azure-devops extension, the same az sourceControl.js probes.
 *
 * worktrees.js requires this file lazily (it is required at load here).
 */

const { ghTryAsync, GH_TIMEOUT_MS, tailErr, normalizeCheckBucket } = require("./worktrees.js");

/** Tests set CODER_AZ_BIN to a fake; production uses PATH (same as sourceControl.js). */
function azBin() {
  return process.env.CODER_AZ_BIN || "az";
}

/** Azure caps PR descriptions at 4000 characters and rejects longer ones. */
const MAX_DESCRIPTION = 4000;

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * `{ orgUrl, project, repo }` from an Azure DevOps origin URL, or null.
 * dev.azure.com and legacy {org}.visualstudio.com, https or ssh (v3).
 * `/{org}/_git/{repo}` is the short form where the project shares the repo's name.
 * @param {string} url
 */
function parseRemote(url) {
  const s = String(url || "").trim().replace(/\/+$/, "");
  const mk = (orgUrl, project, repo) => ({ orgUrl, project: decode(project || repo), repo: decode(repo) });
  let m = s.match(/^https:\/\/(?:[^@/\s]+@)?dev\.azure\.com\/([^/\s]+)\/(?:([^/\s]+)\/)?_git\/([^/\s]+)$/i);
  if (m) return mk(`https://dev.azure.com/${m[1]}`, m[2], m[3]);
  m = s.match(
    /^https:\/\/(?:[^@/\s]+@)?([^./@\s]+)\.visualstudio\.com\/(?:DefaultCollection\/)?(?:([^/\s]+)\/)?_git\/([^/\s]+)$/i,
  );
  if (m) return mk(`https://${m[1]}.visualstudio.com`, m[2], m[3]);
  m = s.match(/^(?:ssh:\/\/)?[^@/\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::|\/)v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/i);
  if (m) return mk(`https://dev.azure.com/${m[1]}`, m[2], m[3]);
  return null;
}

/**
 * One `az` call with JSON output. Resolves the parsed stdout; throws a
 * readable Error on a missing CLI/extension, auth, or az failure.
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} [timeout]
 */
async function az(cwd, args, timeout) {
  const res = await ghTryAsync(cwd, [...args, "-o", "json"], {
    bin: azBin(),
    timeout: timeout || GH_TIMEOUT_MS,
    env: { AZURE_CORE_NO_COLOR: "1", AZURE_CORE_ONLY_SHOW_ERRORS: "1" },
  });
  if (!res.ok) {
    const text = res.stderr || res.combined || "";
    if (res.enoent) throw new Error("Azure CLI (az) is not installed");
    if (res.timedOut) throw new Error("az timed out after 30s");
    if (/az login|TF400813|not authorized|authenticat/i.test(text)) {
      throw Object.assign(new Error("az is not signed in to Azure DevOps; run `az login`"), { auth: true });
    }
    if (/'repos' is misspelled|extension.*azure-devops|azure-devops.*extension/i.test(text)) {
      throw new Error("Install the Azure DevOps CLI extension: az extension add --name azure-devops");
    }
    throw new Error(tailErr(text, `az ${args.slice(0, 3).join(" ")} failed`));
  }
  try {
    return JSON.parse(res.stdout || "null");
  } catch {
    throw new Error("az returned unparseable JSON");
  }
}

function scope(remote) {
  return ["--org", remote.orgUrl, "--project", remote.project, "--repository", remote.repo];
}

const PR_STATE = { active: "OPEN", completed: "MERGED", abandoned: "CLOSED" };

const stripHeads = (ref) => String(ref || "").replace(/^refs\/heads\//, "");

/**
 * az PR JSON → worktrees.js PrInfo shape. az has no web URL field, so the
 * link is built from the remote.
 * @param {any} pr
 * @param {{ orgUrl: string, project: string, repo: string }} remote
 * @param {string} branch
 * @param {boolean} created
 */
function prInfoFromPr(pr, remote, branch, created) {
  const number = Number(pr && pr.pullRequestId);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("az returned incomplete pull request JSON");
  }
  const info = {
    number,
    url: `${remote.orgUrl}/${encodeURIComponent(remote.project)}/_git/${encodeURIComponent(remote.repo)}/pullrequest/${number}`,
    state: PR_STATE[String(pr.status)] || "OPEN",
    branch: branch || stripHeads(pr.sourceRefName),
    created: Boolean(created),
  };
  if (pr.title != null) info.title = String(pr.title);
  if (pr.targetRefName) info.baseRefName = stripHeads(pr.targetRefName);
  if (pr.mergeStatus === "conflicts") info.mergeable = "CONFLICTING";
  else if (pr.mergeStatus === "succeeded") info.mergeable = "MERGEABLE";
  else if (pr.mergeStatus) info.mergeable = "UNKNOWN";
  return info;
}

/**
 * Most recent PR whose source is `branch`, or null. Prefers an active PR so
 * a completed predecessor never hides the live one. Throws on az failure.
 */
async function viewPr(cwd, remote, branch) {
  const rows = await az(cwd, [
    "repos", "pr", "list", ...scope(remote),
    "--source-branch", branch, "--status", "all", "--top", "20",
  ]);
  const list = Array.isArray(rows) ? rows : [];
  const pr = list.find((r) => r && r.status === "active") || list[0];
  return pr ? prInfoFromPr(pr, remote, branch, false) : null;
}

/** PR by id for the background refresher. Never throws; null on any failure. */
async function viewPrByNumber(cwd, remote, id, timeout) {
  try {
    const pr = await az(cwd, ["repos", "pr", "show", "--id", String(Number(id)), "--org", remote.orgUrl], timeout);
    return prInfoFromPr(pr, remote, "", false);
  } catch {
    return null;
  }
}

/** Open a PR (or return the active one on a create race). Throws on failure. */
async function createPr(cwd, remote, { branch, baseBranch, title, body, draft }) {
  const description =
    body.length > MAX_DESCRIPTION ? `${body.slice(0, MAX_DESCRIPTION - 1)}…` : body;
  // --opt=value: az is argparse, so a title or body starting with "-" would read as a flag.
  const args = [
    "repos", "pr", "create", ...scope(remote),
    "--source-branch", branch, "--target-branch", baseBranch,
    `--title=${title}`,
  ];
  if (description) args.push(`--description=${description}`);
  if (draft) args.push("--draft", "true");
  try {
    return prInfoFromPr(await az(cwd, args), remote, branch, true);
  } catch (err) {
    // TF401179: an active PR for this source and target already exists.
    const existing = await viewPr(cwd, remote, branch).catch(() => null);
    if (existing && existing.state === "OPEN") return existing;
    throw err;
  }
}

const POLICY_BUCKET = {
  approved: "pass",
  rejected: "fail",
  broken: "fail",
  running: "pending",
  queued: "pending",
  notApplicable: "skipping",
};

/** Branch-policy evaluations (builds, reviewers, ...) on the branch's PR. In-band failures, like prChecks. */
async function prChecks(cwd, remote, branch) {
  try {
    const info = await viewPr(cwd, remote, branch);
    if (!info) return { ok: false, reason: "no PR" };
    const rows = await az(cwd, ["repos", "pr", "policy", "list", "--id", String(info.number), "--org", remote.orgUrl]);
    const checks = (Array.isArray(rows) ? rows : [])
      .map((e) => {
        const cfg = (e && e.configuration) || {};
        const name = (cfg.settings && cfg.settings.displayName) || (cfg.type && cfg.type.displayName);
        if (!name) return null;
        return { name: String(name), bucket: POLICY_BUCKET[String(e.status)] || normalizeCheckBucket(e.status) };
      })
      .filter(Boolean);
    return { ok: true, checks };
  } catch (err) {
    if (err && err.auth) return { ok: false, reason: "auth" };
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

/**
 * Squash-complete a PR. Azure finishes the merge asynchronously, so the
 * refreshed status may still read OPEN for a moment. Throws on failure.
 */
async function mergePr(cwd, remote, id) {
  await az(cwd, [
    "repos", "pr", "update", "--id", String(Number(id)), "--org", remote.orgUrl,
    "--status", "completed", "--squash", "true",
  ]);
}

module.exports = {
  kind: "azure-devops",
  az,
  parseRemote,
  prInfoFromPr,
  viewPr,
  viewPrByNumber,
  createPr,
  prChecks,
  mergePr,
};
