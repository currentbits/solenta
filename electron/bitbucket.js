"use strict";

/**
 * Bitbucket Cloud PR backend (issue #456). Same contract as gitlab.js
 * (PrInfo, check buckets) for create / status / checks / merge only: the
 * planboard and issue ingestion stay GitHub/GitLab. REST 2.0 with the tokens
 * sourceControl.js probes: SOLENTA_BITBUCKET_ACCESS_TOKEN (Bearer), or
 * SOLENTA_BITBUCKET_EMAIL + SOLENTA_BITBUCKET_API_TOKEN (Basic).
 *
 * ponytail: bitbucket.org only; Bitbucket Server/Data Center is a different API.
 */

const API = "https://api.bitbucket.org/2.0";
const TIMEOUT_MS = 30_000;

/**
 * `{ workspace, repo }` from a bitbucket.org origin URL, or null.
 * @param {string} url
 */
function parseRemote(url) {
  const s = String(url || "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const m =
    s.match(/^[^@/\s]+@([^:/\s]+):(?!\d+\/)(.+)$/) || // git@bitbucket.org:ws/repo
    s.match(/^(?:ssh|https?):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/(.+)$/i);
  if (!m || m[1].toLowerCase() !== "bitbucket.org") return null;
  const parts = m[2].replace(/^\/+/, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { workspace: parts[0], repo: parts[1] };
}

/** Authorization header from the env, or null when no token is set. */
function authHeader(env = process.env) {
  const access = String(env.SOLENTA_BITBUCKET_ACCESS_TOKEN || "").trim();
  if (access) return `Bearer ${access}`;
  const email = String(env.SOLENTA_BITBUCKET_EMAIL || "").trim();
  const apiToken = String(env.SOLENTA_BITBUCKET_API_TOKEN || "").trim();
  if (email && apiToken) {
    return `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }
  return null;
}

/**
 * One REST call under repositories/{ws}/{repo}. Resolves the parsed body;
 * throws a readable Error (with .status) on auth, HTTP, or network failure.
 * @param {{ workspace: string, repo: string }} remote
 * @param {string} method
 * @param {string} endpoint e.g. "/pullrequests/3"
 * @param {object} [body]
 * @param {number} [timeout]
 */
async function bbApi(remote, method, endpoint, body, timeout) {
  const auth = authHeader();
  if (!auth) {
    throw new Error(
      "Bitbucket is not signed in; set SOLENTA_BITBUCKET_ACCESS_TOKEN, or SOLENTA_BITBUCKET_EMAIL plus SOLENTA_BITBUCKET_API_TOKEN",
    );
  }
  const url = `${API}/repositories/${encodeURIComponent(remote.workspace)}/${encodeURIComponent(remote.repo)}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout || TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error page; the status line below still says what happened
  }
  if (!res.ok) {
    const why =
      (data && data.error && data.error.message) || text.slice(0, 200) || res.statusText;
    const hint = res.status === 401 ? " (check the Bitbucket token in Settings → Source Control)" : "";
    throw Object.assign(new Error(`Bitbucket ${method} ${endpoint.split("?")[0]} failed: ${res.status} ${why}${hint}`), {
      status: res.status,
    });
  }
  return data;
}

const PR_STATE = { OPEN: "OPEN", MERGED: "MERGED", DECLINED: "CLOSED", SUPERSEDED: "CLOSED" };

/**
 * Bitbucket PR JSON → worktrees.js PrInfo shape.
 * @param {any} pr
 * @param {string} branch
 * @param {boolean} created
 */
function prInfoFromPr(pr, branch, created) {
  const number = Number(pr && pr.id);
  const url = String((pr && pr.links && pr.links.html && pr.links.html.href) || "");
  if (!Number.isInteger(number) || number <= 0 || !url) {
    throw new Error("Bitbucket returned incomplete pull request JSON");
  }
  const info = {
    number,
    url,
    state: PR_STATE[String(pr.state)] || "OPEN",
    branch: branch || String((pr.source && pr.source.branch && pr.source.branch.name) || ""),
    created: Boolean(created),
  };
  if (pr.title != null) info.title = String(pr.title);
  const base = pr.destination && pr.destination.branch && pr.destination.branch.name;
  if (base) info.baseRefName = String(base);
  return info;
}

/**
 * Most recent PR whose source is `branch`, or null. Prefers an open PR so a
 * merged predecessor never hides the live one. Throws on API failure.
 */
async function viewPr(_cwd, remote, branch) {
  const q = encodeURIComponent(`source.branch.name=${JSON.stringify(branch)}`);
  const states = ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"].map((s) => `&state=${s}`).join("");
  const data = await bbApi(remote, "GET", `/pullrequests?q=${q}${states}&sort=-updated_on&pagelen=20`);
  const rows = Array.isArray(data && data.values) ? data.values : [];
  const pr = rows.find((r) => r && r.state === "OPEN") || rows[0];
  return pr ? prInfoFromPr(pr, branch, false) : null;
}

/** PR by id for the background refresher. Never throws; null on any failure. */
async function viewPrByNumber(_cwd, remote, id, timeout) {
  try {
    return prInfoFromPr(await bbApi(remote, "GET", `/pullrequests/${Number(id)}`, null, timeout), "", false);
  } catch {
    return null;
  }
}

/** Open a PR (or return the open one on a create race). Throws on failure. */
async function createPr(cwd, remote, { branch, baseBranch, title, body, draft }) {
  try {
    const pr = await bbApi(remote, "POST", "/pullrequests", {
      title,
      description: body,
      source: { branch: { name: branch } },
      destination: { branch: { name: baseBranch } },
      draft: Boolean(draft),
    });
    return prInfoFromPr(pr, branch, true);
  } catch (err) {
    const existing = await viewPr(cwd, remote, branch).catch(() => null);
    if (existing && existing.state === "OPEN") return existing;
    throw err;
  }
}

const STATUS_BUCKET = { SUCCESSFUL: "pass", FAILED: "fail", INPROGRESS: "pending", STOPPED: "cancel" };

/** Commit statuses (Pipelines and external CI) on the branch's PR. In-band failures, like prChecks. */
async function prChecks(cwd, remote, branch) {
  try {
    const info = await viewPr(cwd, remote, branch);
    if (!info) return { ok: false, reason: "no PR" };
    const data = await bbApi(remote, "GET", `/pullrequests/${info.number}/statuses?pagelen=100`);
    const checks = (Array.isArray(data && data.values) ? data.values : [])
      .filter((s) => s && (s.name || s.key))
      .map((s) => {
        const item = { name: String(s.name || s.key), bucket: STATUS_BUCKET[String(s.state)] || "pending" };
        if (s.url) item.link = String(s.url);
        return item;
      });
    return { ok: true, checks };
  } catch (err) {
    if (err && err.status === 401) return { ok: false, reason: "auth" };
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

/** Squash-merge a PR. Throws on failure. */
async function mergePr(_cwd, remote, id) {
  await bbApi(remote, "POST", `/pullrequests/${Number(id)}/merge`, { merge_strategy: "squash" });
}

module.exports = {
  kind: "bitbucket",
  parseRemote,
  authHeader,
  prInfoFromPr,
  viewPr,
  viewPrByNumber,
  createPr,
  prChecks,
  mergePr,
};
