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

/** Tests set CODER_GLAB_BIN to a fake; production uses PATH. */
function glabBin() {
  return process.env.CODER_GLAB_BIN || "glab";
}

/**
 * Host + project path from a GitLab origin URL, or null.
 * ponytail: "GitLab" means gitlab.com or a host whose name contains "gitlab";
 * self-hosted on a neutral name (git.acme.dev) needs a host allowlist setting.
 * @param {string} url
 * @returns {{ host: string, path: string } | null}
 */
function gitlabRemote(url) {
  const s = String(url || "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const m =
    s.match(/^[^@/\s]+@([^:/\s]+):(?!\d+\/)(.+)$/) || // git@host:group/repo
    s.match(/^(?:ssh|https?):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/(.+)$/i);
  if (!m || !/gitlab/i.test(m[1])) return null;
  const projectPath = m[2].replace(/^\/+/, "");
  if (!projectPath.includes("/")) return null;
  return { host: m[1].toLowerCase(), path: projectPath };
}

/**
 * One `glab api` call. Resolves `{ ok: true, data }` or `{ ok: false, reason }`
 * where reason is "glab missing" | "auth" | "not found" | glab's tail.
 * @param {string} cwd
 * @param {{ host: string, path: string }} remote
 * @param {string} method
 * @param {string} endpoint relative to projects/:id, e.g. "/issues/3"
 * @param {Record<string, string | number | boolean>} [fields] body fields (non-GET)
 * @param {number} [timeout]
 */
async function glabApi(cwd, remote, method, endpoint, fields, timeout) {
  const args = [
    "api",
    "--hostname",
    remote.host,
    "-X",
    method,
    `projects/${encodeURIComponent(remote.path)}${endpoint}`,
  ];
  for (const [k, v] of Object.entries(fields || {})) {
    // -F types booleans/numbers; -f keeps titles like "123" as strings.
    args.push(typeof v === "string" ? "-f" : "-F", `${k}=${v}`);
  }
  const res = await ghTryAsync(cwd, args, {
    bin: glabBin(),
    timeout: timeout || GH_TIMEOUT_MS,
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

/** Throw a gh-style Error from a failed glabApi result. */
function fail(res, what) {
  if (res.reason === "glab missing") throw new Error("GitLab CLI (glab) is not installed");
  if (res.reason === "auth") throw new Error(`glab is not authenticated; run \`glab auth login\` (${what})`);
  throw new Error(`${what}: ${res.reason}`);
}

const MR_STATE = { opened: "OPEN", merged: "MERGED", closed: "CLOSED", locked: "CLOSED" };

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

/** GitLab issue URL → { number, owner, repo } (owner may hold subgroups). */
function parseGitlabIssueUrl(s) {
  const m = String(s || "").trim().match(
    /^https?:\/\/[^/\s]+\/(.+)\/([^/#?\s]+)\/-\/issues\/(\d+)(?:[/?#].*)?$/i,
  );
  if (!m) return null;
  const number = Number(m[3]);
  return number > 0 ? { number, owner: m[1], repo: m[2] } : null;
}

async function fetchIssue(cwd, remote, parsed) {
  const target =
    parsed.owner && parsed.repo
      ? { host: remote.host, path: `${parsed.owner}/${parsed.repo}` }
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

async function addNote(cwd, remote, number, body) {
  const res = await glabApi(cwd, remote, "POST", `/issues/${number}/notes`, { body });
  if (!res.ok) return issueFail(res);
  return {
    ok: true,
    url: `https://${remote.host}/${remote.path}/-/issues/${number}#note_${res.data && res.data.id}`,
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
  gitlabRemote,
  glabApi,
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
  addNote,
  reopenIssue,
  completeIssue,
  createIssue,
};
