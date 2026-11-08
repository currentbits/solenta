"use strict";

/**
 * GitLab forge backend (issue #193). Same contract as the gh paths in
 * worktrees.js (PrInfo, check buckets) and issues.js (`{ ok, reason }`), via
 * `glab api` REST calls so self-hosted hosts work through `--hostname`.
 *
 * worktrees.js requires this file lazily (it is required at load here).
 */

const {
  ghTryAsync,
  GH_TIMEOUT_MS,
  tailErr,
  normalizeCheckBucket,
} = require("./worktrees.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

/** Tests set CODER_GLAB_BIN to a fake; production uses PATH. */
function glabBin() {
  return process.env.CODER_GLAB_BIN || "glab";
}

/** A configured web authority, never a URL containing a token or project path. */
function webOrigin(value, protocol = "https") {
  try {
    const s = String(value || "").trim();
    if (!s || /[\s?#]/.test(s)) return null;
    const u = new URL(s.includes("://") ? s : `${protocol}://${s}`);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && u.pathname === "/"
      ? u : null;
  } catch {
    return null;
  }
}

function environmentHost() {
  return process.env.GITLAB_HOST || process.env.GITLAB_URI || process.env.GL_HOST || "";
}

/**
 * Read only host keys and api_protocol from glab's block-style config.yml.
 * Tokens stay with glab. Quoted scalars and host:port keys are accepted;
 * unsupported YAML shapes do not grant trust to an unconfigured hostname.
 */
function configuredOrigins() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const dir = process.env.GLAB_CONFIG_DIR || path.join(configHome, "glab-cli");
  const scalar = (s) => s.trim().replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2");
  const hosts = new Map();
  let defaultHost = "";
  try {
    let inHosts = false;
    let host = "";
    let hostIndent = 0;
    for (const line of fs.readFileSync(path.join(dir, "config.yml"), "utf8").split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      if (/^\S/.test(line)) {
        inHosts = /^hosts:\s*(?:#.*)?$/.test(line);
        host = "";
        const m = line.match(/^host:\s+(.+)$/);
        if (m) defaultHost = scalar(m[1]);
        continue;
      }
      if (!inHosts) continue;
      const entry = line.match(/^(\s+)(.+):\s*(?:#.*)?$/);
      if (entry && (!host || entry[1].length <= hostIndent)) {
        host = scalar(entry[2]);
        hostIndent = entry[1].length;
        hosts.set(host, "https");
      } else {
        const m = line.match(/^\s+api_protocol:\s+(.+)$/);
        if (host && m && /^(http|https)$/.test(scalar(m[1]))) hosts.set(host, scalar(m[1]));
      }
    }
  } catch {
    // No readable config: only public/named GitLab hosts and an explicit env host.
  }
  if (defaultHost && !hosts.has(defaultHost)) hosts.set(defaultHost, "https");
  const origins = [...hosts].map(([host, protocol]) => webOrigin(host, protocol)).filter(Boolean);
  const envHost = webOrigin(environmentHost());
  const configured = envHost && origins.find((o) => o.host === envHost.host);
  const protocol = process.env.GLAB_API_PROTOCOL || process.env.API_PROTOCOL || configured?.protocol.slice(0, -1) || "https";
  const env = webOrigin(environmentHost(), protocol);
  return { origins, env, defaultOrigin: webOrigin(defaultHost) };
}

/**
 * Web origin, account authority (including web port), and project path.
 * Neutral names require glab host configuration. SSH transport ports are
 * unrelated to web ports; choose a unique configured web origin or HTTPS.
 * @param {string} url
 * @returns {{ host: string, origin: string, path: string } | null}
 */
function gitlabRemote(url) {
  const s = String(url || "").trim();
  if (!s || /[\s?#\\]/.test(s)) return null;
  let u;
  let projectPath;
  let ssh;
  try {
    const scp = !s.includes("://") && s.match(/^(?:[^@/:]+@)?([^:/]{2,}):(?!\d+\/)(.+)$/);
    u = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : s);
    if (!/^(https?|ssh):$/.test(u.protocol)) return null;
    ssh = u.protocol === "ssh:";
    // Inspect the raw path before URL can normalize away '..' segments.
    const rawPath = scp ? scp[2] : s.replace(/^[^:]+:\/\/[^/]+\//, "");
    if (rawPath.split("/").some((p) => [".", ".."].includes(decodeURIComponent(p)))) return null;
    projectPath = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  } catch {
    return null;
  }
  if (projectPath.split("/").filter(Boolean).length < 2) return null;
  const hostname = u.hostname.toLowerCase();
  const { origins, env } = configuredOrigins();
  let candidates;
  if (ssh) {
    candidates = env && env.hostname === hostname ? [env] : origins.filter((o) => o.hostname === hostname);
  } else {
    candidates = [...origins, env].filter((o) => o && o.host === u.host);
  }
  if (!/gitlab/i.test(hostname) && candidates.length === 0) return null;
  let origin;
  if (ssh) {
    const unique = [...new Set(candidates.map((o) => o.origin))];
    if (unique.length > 1) return null;
    origin = unique[0] || `https://${hostname}`;
  } else {
    origin = u.origin;
  }
  return { host: new URL(origin).host, origin, path: projectPath };
}

/** Child-only overrides: a target change must not rebind a global token. */
function glabEnvironment(origin) {
  const selected = environmentHost() ? webOrigin(environmentHost()) : configuredOrigins().defaultOrigin;
  const tokenHost = selected ? selected.host : environmentHost() ? "" : "gitlab.com";
  const env = {
    GITLAB_HOST: origin.host,
    GITLAB_URI: undefined, GL_HOST: undefined, GITLAB_URL: undefined, GITLAB_REPO: undefined,
    GITLAB_API_HOST: origin.host,
    GLAB_API_PROTOCOL: origin.protocol.slice(0, -1), API_PROTOCOL: undefined,
    GITLAB_CI: undefined, CI_JOB_TOKEN: undefined,
    GLAB_NO_PROMPT: "1",
  };
  if (tokenHost !== origin.host) {
    for (const key of [
      "GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "JOB_TOKEN",
      "GLAB_IS_OAUTH2", "OAUTH2_REFRESH_TOKEN", "REFRESH_TOKEN",
    ]) env[key] = undefined;
  }
  return env;
}

/**
 * One `glab api` call. Resolves `{ ok: true, data }` or `{ ok: false, reason }`
 * where reason is "glab missing" | "auth" | "not found" | glab's tail.
 * @param {string} cwd
 * @param {{ host: string, origin?: string, path: string }} remote
 * @param {string} method
 * @param {string} endpoint relative to projects/:id, e.g. "/issues/3"
 * @param {Record<string, string | number | boolean>} [fields] body fields (non-GET)
 * @param {number} [timeout]
 */
async function glabApi(cwd, remote, method, endpoint, fields, timeout) {
  return glabHostApi(cwd, remote, method, `projects/${encodeURIComponent(remote.path)}${endpoint}`, fields, timeout);
}

/** Host-scoped API calls use the same glab account as project-scoped calls. */
async function glabHostApi(cwd, remote, method, endpoint, fields, timeout) {
  const origin = webOrigin(remote.origin || remote.host);
  if (!origin || origin.host !== remote.host) return { ok: false, reason: "invalid GitLab origin" };
  const args = [
    "api",
    "--hostname",
    remote.host,
    "-X",
    method,
    endpoint,
  ];
  for (const [k, v] of Object.entries(fields || {})) {
    // -F types booleans/numbers; -f keeps titles like "123" as strings.
    args.push(typeof v === "string" ? "-f" : "-F", `${k}=${v}`);
  }
  const res = await ghTryAsync(cwd, args, {
    bin: glabBin(),
    timeout: timeout || GH_TIMEOUT_MS,
    env: glabEnvironment(origin),
  });
  if (!res.ok) {
    const text = res.stderr || res.combined || res.stdout || "";
    if (res.enoent) return { ok: false, reason: "glab missing" };
    if (res.timedOut) return { ok: false, reason: "glab timed out after 30s" };
    if (/\b401\b|unauthori[sz]ed|not authenticated|glab auth login/i.test(text)) {
      return { ok: false, reason: "auth" };
    }
    if (/\b404\b/.test(text)) return { ok: false, reason: "not found" };
    return { ok: false, reason: tailErr(text, "glab api failed") };
  }
  try {
    return { ok: true, data: JSON.parse(res.stdout || "null") };
  } catch {
    return { ok: false, reason: "glab returned unparseable JSON" };
  }
}

async function glabGraphql(cwd, remote, query) {
  const result = await glabHostApi(cwd, remote, "POST", "graphql", { query });
  if (!result.ok) return result;
  const errors = result.data && result.data.errors;
  if (Array.isArray(errors) && errors.length) {
    return { ok: false, reason: errors.map((error) => String(error.message || "GitLab GraphQL error")).join("; ") };
  }
  if (!result.data || !result.data.data) return { ok: false, reason: "Invalid GitLab GraphQL response" };
  return { ok: true, data: result.data.data };
}

/** Throw a gh-style Error from a failed glabApi result. */
function fail(res, what) {
  if (res.reason === "glab missing") throw new Error("GitLab CLI (glab) is not installed");
  if (res.reason === "auth") throw new Error(`glab is not authenticated; run \`glab auth login\` (${what})`);
  throw new Error(`${what}: ${res.reason}`);
}

const MR_STATE = { opened: "OPEN", merged: "MERGED", closed: "CLOSED", locked: "CLOSED" };

/** GitLab MR JSON → `listPrs` / `parsePrListItem` row. */
function prListItemFromMr(mr) {
  const number = Number(mr && mr.iid);
  const url = mr && mr.web_url ? String(mr.web_url) : "";
  if (!Number.isInteger(number) || number <= 0 || !url) {
    throw new Error("glab returned incomplete merge request JSON");
  }
  const item = {
    number,
    title: mr.title != null ? String(mr.title) : "",
    url,
    state: MR_STATE[String(mr.state)] || "OPEN",
    headRefName: mr.source_branch != null ? String(mr.source_branch) : "",
    isDraft: Boolean(mr.draft || mr.work_in_progress),
  };
  if (mr.updated_at) item.updatedAt = String(mr.updated_at);
  if (mr.created_at) item.createdAt = String(mr.created_at);
  if (mr.merged_at) item.mergedAt = String(mr.merged_at);
  if (mr.closed_at) item.closedAt = String(mr.closed_at);
  return item;
}

/** GitLab MR JSON → `parsePrCheckoutView` shape. */
function prCheckoutViewFromMr(mr) {
  const number = Number(mr && mr.iid);
  const url = mr && mr.web_url ? String(mr.web_url) : "";
  if (!Number.isInteger(number) || number <= 0 || !url) {
    throw new Error("glab returned incomplete merge request JSON");
  }
  const src = Number(mr.source_project_id);
  const tgt = Number(mr.target_project_id);
  return {
    number,
    title: mr.title != null ? String(mr.title) : "",
    body: mr.description != null ? String(mr.description) : "",
    url,
    headRefName: mr.source_branch != null ? String(mr.source_branch) : "",
    isCrossRepository: Number.isFinite(src) && Number.isFinite(tgt) && src !== tgt,
    state: MR_STATE[String(mr.state)] || "OPEN",
  };
}

/**
 * Open (or filtered) MRs as `listPrsRaw` rows. GitLab `per_page` max is 100,
 * so this pages until `limit` (capped at 200, same as listPrs).
 * @param {string} cwd
 * @param {{ host: string, path: string }} remote
 * @param {{ limit?: number, state?: string }} [opts]
 */
async function listMrs(cwd, remote, opts) {
  const want = Math.min(Math.max(Number(opts && opts.limit) || 50, 1), 200);
  const state = (opts && opts.state) || "opened";
  // Keep per_page stable: GitLab page N is items (N-1)*per_page, so shrinking
  // the page size on the next request would overlap the previous page.
  const perPage = Math.min(100, want);
  const prs = [];
  let page = 1;
  while (prs.length < want) {
    const res = await glabApi(
      cwd,
      remote,
      "GET",
      `/merge_requests?state=${encodeURIComponent(state)}&per_page=${perPage}&page=${page}&order_by=updated_at&sort=desc`,
    );
    if (!res.ok) return { ok: false, reason: res.reason };
    const rows = Array.isArray(res.data) ? res.data : [];
    try {
      for (const row of rows) prs.push(prListItemFromMr(row));
    } catch (err) {
      return {
        ok: false,
        reason: err && err.message ? String(err.message) : "glab returned incomplete merge request JSON",
      };
    }
    if (rows.length < perPage) break;
    page += 1;
  }
  return { ok: true, prs: prs.slice(0, want) };
}

/**
 * GitLab MR JSON → worktrees.js PrInfo shape.
 * @param {any} mr
 * @param {string} branch
 * @param {boolean} created
 */
function prInfoFromMr(mr, branch, created) {
  const number = Number(mr && mr.iid);
  const url = mr && mr.web_url ? String(mr.web_url) : "";
  if (!Number.isInteger(number) || number <= 0 || !url) {
    throw new Error("glab returned incomplete merge request JSON");
  }
  const info = {
    number,
    url,
    state: MR_STATE[String(mr.state)] || "OPEN",
    branch: branch || String(mr.source_branch || ""),
    created: Boolean(created),
  };
  if (mr.title != null) info.title = String(mr.title);
  if (mr.target_branch) info.baseRefName = String(mr.target_branch);
  const files = parseInt(String(mr.changes_count ?? ""), 10);
  if (Number.isFinite(files)) info.changedFiles = files;
  const ms = String(mr.detailed_merge_status || mr.merge_status || "");
  if (mr.has_conflicts || /conflict|cannot_be_merged/.test(ms)) info.mergeable = "CONFLICTING";
  else if (/^(mergeable|can_be_merged)$/.test(ms)) info.mergeable = "MERGEABLE";
  else if (ms) info.mergeable = "UNKNOWN";
  return info;
}

/**
 * Most recent MR whose source is `branch` (like `gh pr view <branch>`), or null.
 * Prefers an open MR so a merged predecessor never hides the live one.
 * Throws on glab/auth/network failure.
 */
async function viewMr(cwd, remote, branch) {
  const res = await glabApi(
    cwd,
    remote,
    "GET",
    `/merge_requests?source_branch=${encodeURIComponent(branch)}&order_by=updated_at&sort=desc&per_page=20`,
  );
  if (!res.ok) fail(res, "glab merge request lookup failed");
  const rows = Array.isArray(res.data) ? res.data : [];
  const mr = rows.find((r) => r && r.state === "opened") || rows[0];
  return mr ? prInfoFromMr(mr, branch, false) : null;
}

/** MR by iid for the background refresher. Never throws; null on any failure. */
async function viewMrByNumber(cwd, remote, iid, timeout) {
  const res = await glabApi(cwd, remote, "GET", `/merge_requests/${Number(iid)}`, null, timeout);
  if (!res.ok) return null;
  try {
    return prInfoFromMr(res.data, "", false);
  } catch {
    return null;
  }
}

/**
 * Jobs of the MR's head pipeline as worktrees.js check items.
 * In-band failures, like prChecks.
 */
async function mrChecks(cwd, remote, branch) {
  let info;
  try {
    info = await viewMr(cwd, remote, branch);
  } catch (err) {
    const msg = String(err.message || err);
    if (/not installed/.test(msg)) return { ok: false, reason: "glab missing" };
    if (/not authenticated/.test(msg)) return { ok: false, reason: "auth" };
    return { ok: false, reason: msg };
  }
  if (!info) return { ok: false, reason: "no PR" };
  // The list endpoint omits head_pipeline; the single-MR one carries it.
  const mr = await glabApi(cwd, remote, "GET", `/merge_requests/${info.number}`);
  if (!mr.ok) return { ok: false, reason: mr.reason };
  const pipeline = mr.data && mr.data.head_pipeline;
  if (!pipeline || !pipeline.id) return { ok: true, checks: [] };
  const jobs = await glabApi(cwd, remote, "GET", `/pipelines/${pipeline.id}/jobs?per_page=100`);
  if (!jobs.ok) return { ok: false, reason: jobs.reason };
  const checks = (Array.isArray(jobs.data) ? jobs.data : [])
    .filter((j) => j && j.name)
    .map((j) => {
      // allow_failure jobs that fail render as a warning in GitLab, not red.
      const bucket =
        j.allow_failure && j.status === "failed" ? "skipping" : normalizeCheckBucket(j.status);
      const item = { name: String(j.name), bucket };
      if (j.web_url) item.link = String(j.web_url);
      return item;
    });
  return { ok: true, checks };
}

/**
 * Open an MR (or return the open one on a create race). Throws on failure.
 */
async function createMr(cwd, remote, { branch, baseBranch, title, body, draft }) {
  const res = await glabApi(cwd, remote, "POST", "/merge_requests", {
    source_branch: branch,
    target_branch: baseBranch,
    title: draft ? `Draft: ${title}` : title,
    description: body,
  });
  if (res.ok) return prInfoFromMr(res.data, branch, true);
  // 409: "Another open merge request already exists for this source branch".
  const existing = await viewMr(cwd, remote, branch).catch(() => null);
  if (existing && existing.state === "OPEN") return existing;
  fail(res, "glab merge request create failed");
}

/** Squash-merge an MR. Throws on failure. */
async function mergeMr(cwd, remote, iid) {
  const res = await glabApi(cwd, remote, "PUT", `/merge_requests/${Number(iid)}/merge`, {
    squash: true,
  });
  if (!res.ok) fail(res, "glab merge request merge failed");
}

// ---------------------------------------------------------------------------
// Issues: issues.js contract, `{ ok: false, reason }`, never throws.
// ---------------------------------------------------------------------------

function issueFail(res) {
  return { ok: false, reason: res.reason === "not found" ? "issue not found" : res.reason };
}

/** GitLab issue URL with its web origin (owner may hold subgroups). */
function parseGitlabIssueUrl(s) {
  const m = String(s || "").trim().match(
    /^https?:\/\/[^/\s]+\/(.+)\/([^/#?\s]+)\/-\/issues\/(\d+)(?:[/?#].*)?$/i,
  );
  if (!m) return null;
  const number = Number(m[3]);
  try {
    const u = new URL(String(s).trim());
    if (u.username || u.password || !Number.isSafeInteger(number)) return null;
    return number > 0 ? { number, owner: m[1], repo: m[2], origin: u.origin } : null;
  } catch {
    return null;
  }
}

async function fetchIssue(cwd, remote, parsed) {
  if (parsed.origin && parsed.origin !== (remote.origin || `https://${remote.host}`)) {
    return { ok: false, reason: "issue origin does not match the project's GitLab origin" };
  }
  const target =
    parsed.owner && parsed.repo
      ? { ...remote, path: `${parsed.owner}/${parsed.repo}` }
      : remote;
  const res = await glabApi(cwd, target, "GET", `/issues/${parsed.number}`);
  if (!res.ok) return issueFail(res);
  const d = res.data || {};
  const number = Number(d.iid);
  if (!Number.isInteger(number) || number <= 0 || !d.title || !d.web_url) {
    return { ok: false, reason: "glab returned incomplete issue JSON" };
  }
  return {
    ok: true,
    issue: {
      number,
      title: String(d.title),
      body: d.description == null ? "" : String(d.description),
      url: String(d.web_url),
    },
  };
}

/** GitLab issue JSON → the row shape parseIssueListJson accepts. */
function ghShapedIssue(d) {
  return {
    number: d && d.iid,
    title: d && d.title,
    url: d && d.web_url,
    state: d && d.state === "closed" ? "CLOSED" : "OPEN",
    labels: Array.isArray(d && d.labels) ? d.labels.map((name) => ({ name })) : [],
    updatedAt: d && d.updated_at,
    createdAt: d && d.created_at,
  };
}

/**
 * One page. The cursor is the next page number; a full page implies another.
 * ponytail: offset paging, so a burst of edits between pages can skip a row;
 * keyset pagination (pagination=keyset) if that ever bites.
 * @returns {Promise<{ ok: true, rows: object[], nextCursor: string | null } | { ok: false, reason: string }>}
 */
async function listIssuePage(cwd, remote, { state, limit, cursor, number }) {
  if (number !== null) {
    const res = await glabApi(cwd, remote, "GET", `/issues/${number}`);
    if (!res.ok) return issueFail(res);
    return { ok: true, rows: [ghShapedIssue(res.data)], nextCursor: null };
  }
  const page = cursor ? Number(cursor) : 1;
  if (!Number.isInteger(page) || page < 1) return { ok: false, reason: "Invalid issue list options" };
  const glState = state === "open" ? "opened" : state;
  const res = await glabApi(
    cwd,
    remote,
    "GET",
    `/issues?state=${glState}&per_page=${limit}&page=${page}&order_by=updated_at&sort=desc`,
  );
  if (!res.ok) return issueFail(res);
  const rows = Array.isArray(res.data) ? res.data : [];
  return {
    ok: true,
    rows: rows.map(ghShapedIssue),
    nextCursor: rows.length === limit ? String(page + 1) : null,
  };
}

/** Swap plan:* labels. GitLab creates missing labels on assignment. */
async function setPlanLabel(cwd, remote, number, label, planLabels, extra) {
  const res = await glabApi(cwd, remote, "PUT", `/issues/${number}`, {
    add_labels: label,
    remove_labels: planLabels.filter((l) => l !== label).join(","),
    ...(extra || {}),
  });
  return res.ok ? { ok: true } : issueFail(res);
}

async function addLabels(cwd, remote, number, labels) {
  const res = await glabApi(cwd, remote, "PUT", `/issues/${number}`, { add_labels: labels.join(",") });
  return res.ok ? { ok: true } : issueFail(res);
}

async function addNote(cwd, remote, number, body) {
  const res = await glabApi(cwd, remote, "POST", `/issues/${number}/notes`, { body });
  if (!res.ok) return issueFail(res);
  return {
    ok: true,
    url: `${remote.origin || `https://${remote.host}`}/${remote.path}/-/issues/${number}#note_${res.data && res.data.id}`,
  };
}

async function reopenIssue(cwd, remote, number, comment, planLabels) {
  // Reopening an open issue is a no-op in GitLab, so this covers both cases.
  const moved = await setPlanLabel(cwd, remote, number, "plan:todo", planLabels, {
    state_event: "reopen",
  });
  if (!moved.ok) return moved;
  if (comment) await addNote(cwd, remote, number, comment); // evidence, not the action
  return { ok: true };
}

async function completeIssue(cwd, remote, number, comment, planLabels) {
  const viewed = await glabApi(cwd, remote, "GET", `/issues/${number}`);
  if (!viewed.ok) return issueFail(viewed);
  const d = viewed.data || {};
  if (d.state === "closed") return { ok: true, skipped: "already closed" };
  if (!Array.isArray(d.labels) || !d.labels.includes("plan:doing")) {
    return { ok: true, skipped: "not in progress" };
  }
  if (comment) await addNote(cwd, remote, number, comment);
  return setPlanLabel(cwd, remote, number, "plan:done", planLabels, { state_event: "close" });
}

async function createIssue(cwd, remote, title, body) {
  const res = await glabApi(cwd, remote, "POST", "/issues", {
    title,
    description: body,
    labels: "plan:todo",
  });
  if (!res.ok) return issueFail(res);
  const number = Number(res.data && res.data.iid);
  if (!Number.isInteger(number) || number <= 0) {
    return { ok: false, reason: "glab returned incomplete issue JSON" };
  }
  return { ok: true, number, url: String(res.data.web_url || "") };
}

module.exports = {
  glabBin,
  gitlabRemote,
  glabApi,
  glabGraphql,
  prListItemFromMr,
  prCheckoutViewFromMr,
  listMrs,
  prInfoFromMr,
  viewMr,
  viewMrByNumber,
  mrChecks,
  createMr,
  mergeMr,
  parseGitlabIssueUrl,
  fetchIssue,
  listIssuePage,
  setPlanLabel,
  addLabels,
  addNote,
  reopenIssue,
  completeIssue,
  createIssue,
  // Forge-neutral PR names worktrees-pr.js prForge dispatches on (#456).
  kind: "gitlab",
  parseRemote: gitlabRemote,
  viewPr: viewMr,
  viewPrByNumber: viewMrByNumber,
  createPr: createMr,
  prChecks: mrChecks,
  mergePr: mergeMr,
};
