"use strict";

/**
 * GitHub API transport (issue #1528). Talks to GitHub over HTTPS instead of
 * spawning `gh` per call. The token still comes from `gh auth token
 * --hostname <host>`, so existing gh users change nothing, but it is fetched
 * once per host and cached instead of once per thread per poll. Hosts other
 * than github.com are treated as GitHub Enterprise (`https://<host>/api/graphql`).
 *
 * Callers keep their `gh` path as the fallback: every function here throws
 * (or returns null) rather than guessing, and the caller decides.
 */

const { execFile } = require("node:child_process");

const TOKEN_TTL_MS = 10 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 5_000;
/** GitHub caps a GraphQL query's node count; 50 aliased PRs is well inside it. */
const PR_BATCH = 50;

/** @type {Map<string, { token: string | null, at: number }>} */
const tokenCache = new Map();

/**
 * host/owner/repo from any git remote URL (https, ssh://, scp-style).
 * Host is lowercased; `www.` is dropped. No host allowlist: the caller decides
 * whether a non-github.com host is worth a token lookup.
 * @param {string} url
 * @returns {{ host: string, owner: string, repo: string } | null}
 */
function parseRemote(url) {
  const s = String(url || "").trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!s) return null;
  let host = "";
  let path = "";
  if (!s.includes("://")) {
    // scp-style git@host:owner/repo
    const scp = s.match(/^(?:[^@/\s]+@)?([^:/\\\s]{2,}):(.+)$/);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(s);
      if (!/^(https?|ssh|git):$/.test(u.protocol)) return null;
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (!host || parts.length < 2) return null;
  host = host.toLowerCase().replace(/^www\./, "");
  // ssh.github.com:443 is GitHub's ssh-over-https endpoint, same API host.
  if (host === "ssh.github.com") host = "github.com";
  return { host, owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

/**
 * GraphQL endpoint for a host. github.com → api.github.com, else GHE.
 * @param {string} host
 */
function graphqlUrl(host) {
  return host === "github.com"
    ? "https://api.github.com/graphql"
    : `https://${host}/api/graphql`;
}

/** @type {() => Array<{ host: string, account: string | null, token: string | null }>} */
let hostSettings = () => [];

/**
 * Settings › Source control rows (`settings.githubHosts`). main.js points this
 * at the store so this module never imports it.
 * @param {typeof hostSettings} fn
 */
function setHostSettings(fn) {
  hostSettings = typeof fn === "function" ? fn : () => [];
}

/**
 * Token for host. Order: a token saved in Settings, else
 * `gh auth token --hostname <host> [--user <account>]` with the account chosen
 * in Settings (gh's active account when none). gh results are cached per
 * host+account (hits and misses) for TOKEN_TTL_MS. Null when nothing works.
 * @param {string} host
 * @param {{ ghBin?: string, now?: () => number, timeoutMs?: number }} [opts]
 * @returns {Promise<string | null>}
 */
function githubToken(host, opts = {}) {
  let row = null;
  try {
    row = (hostSettings() || []).find((r) => r && r.host === host) || null;
  } catch {
    row = null;
  }
  if (row && row.token) return Promise.resolve(row.token);
  const account = (row && row.account) || "";
  const key = `${host}|${account}`;
  const now = (opts.now || Date.now)();
  const hit = tokenCache.get(key);
  if (hit && now - hit.at < TOKEN_TTL_MS) return Promise.resolve(hit.token);
  const bin = opts.ghBin || process.env.CODER_GH_BIN || "gh";
  const args = ["auth", "token", "--hostname", host];
  if (account) args.push("--user", account);
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        encoding: "utf8",
        timeout: opts.timeoutMs || TOKEN_TIMEOUT_MS,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
      (err, stdout) => {
        const token = err ? "" : String(stdout || "").trim().split(/\s+/)[0];
        const value = token || null;
        tokenCache.set(key, { token: value, at: now });
        resolve(value);
      },
    );
  });
}

/**
 * Drop cached tokens (on 401, a Settings change, or after re-authenticating).
 * @param {string} [host] every account for this host; all hosts when omitted
 */
function forgetToken(host) {
  if (host == null) {
    tokenCache.clear();
    return;
  }
  for (const key of tokenCache.keys()) {
    if (key.startsWith(`${host}|`)) tokenCache.delete(key);
  }
}

/**
 * One authenticated request. Throws on transport failure and on a non-2xx
 * status (err.status set, GitHub's `message` in err.message). 401 drops the
 * cached token.
 * @param {{ host: string, token: string, timeoutMs?: number, fetchFn?: typeof fetch }} req
 * @param {string} url
 * @param {string} method
 * @param {object} [body]
 */
async function send(req, url, method, body) {
  const fetchFn = req.fetchFn || fetch;
  const res = await fetchFn(url, {
    method,
    headers: {
      Authorization: `bearer ${req.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "Solenta",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(req.timeoutMs || 8_000),
  });
  if (!res.ok) {
    if (res.status === 401) forgetToken(req.host);
    let detail = "";
    try {
      const j = await res.json();
      if (j && j.message) detail = `: ${j.message}`;
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(`GitHub API ${res.status} from ${req.host}${detail}`);
    /** @type {any} */ (err).status = res.status;
    throw err;
  }
  return res;
}

/**
 * REST base for a host. github.com → api.github.com, else GHE `/api/v3`.
 * @param {string} host
 */
function restUrl(host) {
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

/**
 * One REST request; resolves the parsed JSON body (null for 204).
 * @param {{ host: string, token: string, method: string, path: string, body?: object, timeoutMs?: number, fetchFn?: typeof fetch }} req
 */
async function rest(req) {
  const res = await send(req, restUrl(req.host) + req.path, req.method, req.body);
  if (res.status === 204) return null;
  return res.json();
}

/**
 * One GraphQL request. Throws on transport/HTTP failure (err.status set) and
 * when the response carries no `data`. Partial `errors` (e.g. one PR number
 * that does not exist) are returned alongside data, not thrown.
 * @param {{ host: string, token: string, query: string, variables?: object, timeoutMs?: number, fetchFn?: typeof fetch }} req
 * @returns {Promise<{ data: any, errors?: any[] }>}
 */
async function graphql(req) {
  const res = await send(req, graphqlUrl(req.host), "POST", {
    query: req.query,
    variables: req.variables || {},
  });
  const body = await res.json();
  if (!body || body.data == null) {
    const msg = body && Array.isArray(body.errors) && body.errors[0]
      ? String(body.errors[0].message || "")
      : "no data";
    throw new Error(`GitHub API error from ${req.host}: ${msg}`);
  }
  return body;
}

/**
 * number/url/state for many PRs in one repo, PR_BATCH per request.
 * A PR GitHub cannot resolve is absent from the map (caller skips it, same as
 * a failed `gh pr view`). Throws when no token or a request fails, so the
 * caller can fall back to gh for the whole repo.
 * @param {{ host: string, owner: string, repo: string }} remote
 * @param {number[]} numbers
 * @param {{ token?: string | null, timeoutMs?: number, fetchFn?: typeof fetch, tokenFn?: typeof githubToken }} [opts]
 * @returns {Promise<Map<number, { number: number, url: string, state: "OPEN" | "CLOSED" | "MERGED" }>>}
 */
async function fetchPrStates(remote, numbers, opts = {}) {
  const token =
    opts.token !== undefined
      ? opts.token
      : await (opts.tokenFn || githubToken)(remote.host);
  if (!token) throw new Error(`No GitHub token for ${remote.host}`);
  const unique = [...new Set(numbers.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  /** @type {Map<number, { number: number, url: string, state: "OPEN" | "CLOSED" | "MERGED" }>} */
  const out = new Map();
  for (let i = 0; i < unique.length; i += PR_BATCH) {
    const chunk = unique.slice(i, i + PR_BATCH);
    const fields = chunk
      .map((n) => `p${n}: pullRequest(number: ${n}) { number url state }`)
      .join(" ");
    const { data } = await graphql({
      host: remote.host,
      token,
      query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
      variables: { owner: remote.owner, name: remote.repo },
      timeoutMs: opts.timeoutMs,
      fetchFn: opts.fetchFn,
    });
    const repo = data && data.repository;
    if (!repo) throw new Error(`GitHub API: ${remote.owner}/${remote.repo} not found on ${remote.host}`);
    for (const n of chunk) {
      const pr = repo[`p${n}`];
      if (!pr || !pr.url) continue;
      const raw = String(pr.state || "").toUpperCase();
      const state = raw === "MERGED" ? "MERGED" : raw === "CLOSED" ? "CLOSED" : "OPEN";
      out.set(n, { number: Number(pr.number) || n, url: String(pr.url), state });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// `gh pr …` over the API (#1534). Callers keep their gh argv and gh JSON
// parsers; ghPr answers the same argv with the same stdout gh would print, so
// the fallback is just "run the real gh instead".

const PR_FIELDS =
  "id number url state title body isDraft headRefName baseRefName additions deletions changedFiles mergeable updatedAt createdAt mergedAt closedAt isCrossRepository author { login }";
const PR_COMMENTS = "comments(last: 100) { nodes { author { login } body createdAt url } }";
const PR_REVIEWS = "reviews(first: 100) { nodes { author { login } state submittedAt } }";

/** Thrown for argv ghPr does not translate; the caller just runs gh. */
class Unsupported extends Error {}

/**
 * A definitive "no such PR/issue/label" answer in gh's own wording (so
 * isNoPrMessage / isIssueNotFound match). The caller returns it, no gh retry.
 */
function notFound(message) {
  const err = new Error(message);
  /** @type {any} */ (err).notFound = true;
  return err;
}

/** gh JSON shape: connections flattened to arrays. */
function ghShape(pr) {
  const out = { ...pr };
  delete out.id;
  if (pr.comments) out.comments = pr.comments.nodes || [];
  if (pr.reviews) out.reviews = pr.reviews.nodes || [];
  return out;
}

/** gh `pr checks` bucket for a CheckRun conclusion/status or StatusContext state. */
function checkBucket(state) {
  switch (String(state || "").toUpperCase()) {
    case "SUCCESS":
      return "pass";
    case "SKIPPED":
    case "NEUTRAL":
      return "skipping";
    case "ERROR":
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "fail";
    case "CANCELLED":
      return "cancel";
    default:
      return "pending";
  }
}

/**
 * Answer `gh pr <sub> …` argv against the API. Resolves gh's stdout (JSON for
 * --json reads, the URL for create/comment, "" otherwise). Throws Unsupported
 * for argv it does not know, notFound-tagged errors for a missing PR, and
 * send()'s errors (err.status) for everything else.
 * @param {{ host: string, owner: string, repo: string }} remote
 * @param {string[]} args
 * @param {{ token: string, fetchFn?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<string>}
 */
async function ghPr(remote, args, opts) {
  const req = { host: remote.host, token: opts.token, fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs };
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const sub = args[1];
  const target = args[2] != null && !String(args[2]).startsWith("-") ? String(args[2]) : null;
  const number = target && /^\d+$/.test(target) ? Number(target) : null;
  const repoPath = `/repos/${remote.owner}/${remote.repo}`;
  // Resolves data.repository; a missing repo is a real failure, never "no PR".
  const gql = async (query, variables) => {
    const { data } = await graphql({ ...req, query, variables: { owner: remote.owner, name: remote.repo, ...variables } });
    if (!data.repository) throw new Error(`GitHub API: ${remote.owner}/${remote.repo} not found on ${remote.host}`);
    return data.repository;
  };

  async function viewByNumber(n, extra = "") {
    const repo = await gql(
      `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { ${PR_FIELDS} ${extra} } } }`,
      { n },
    );
    const pr = repo.pullRequest;
    if (!pr) throw notFound(`no pull requests found for #${n}`);
    return pr;
  }

  if (sub === "view" && target) {
    const extra = String(flag("--json") || "").split(",").includes("comments") ? PR_COMMENTS : "";
    if (number != null) return JSON.stringify(ghShape(await viewByNumber(number, extra)));
    // gh pr view <branch>: same-repo PRs for that head, OPEN first, else newest.
    const repo = await gql(
      `query($owner: String!, $name: String!, $head: String!) { repository(owner: $owner, name: $name) { pullRequests(headRefName: $head, first: 30, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} ${extra} } } } }`,
      { head: target },
    );
    const nodes = repo.pullRequests.nodes.filter(
      (p) => p && !p.isCrossRepository,
    );
    const pr = nodes.find((p) => p.state === "OPEN") || nodes[0];
    if (!pr) throw notFound(`no pull requests found for branch "${target}"`);
    return JSON.stringify(ghShape(pr));
  }

  if (sub === "list" && !target) {
    const limit = Math.max(1, Number(flag("--limit")) || 30);
    const state = String(flag("--state") || "open").toUpperCase();
    const states = state === "ALL" ? ["OPEN", "CLOSED", "MERGED"] : [state];
    const extra = String(flag("--json") || "").split(",").includes("reviews") ? PR_REVIEWS : "";
    /** @type {any[]} */
    const rows = [];
    let after = null;
    // ponytail: pages of 100 until limit; gh pr list does the same.
    while (rows.length < limit) {
      const repo = await gql(
        `query($owner: String!, $name: String!, $first: Int!, $after: String, $states: [PullRequestState!]) { repository(owner: $owner, name: $name) { pullRequests(first: $first, after: $after, states: $states, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} ${extra} } pageInfo { hasNextPage endCursor } } } }`,
        { first: Math.min(100, limit - rows.length), after, states },
      );
      const page = repo.pullRequests;
      rows.push(...page.nodes.filter(Boolean).map(ghShape));
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return JSON.stringify(rows);
  }

  if (sub === "checks" && number != null) {
    const repo = await gql(
      `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } } } } }`,
      { n: number },
    );
    const pr = repo.pullRequest;
    if (!pr) throw notFound(`no pull requests found for #${number}`);
    const commit = pr.commits.nodes[0] && pr.commits.nodes[0].commit;
    const contexts = (commit && commit.statusCheckRollup && commit.statusCheckRollup.contexts.nodes) || [];
    // ponytail: first 100 contexts, no re-run dedupe; the rollup already
    // reports the latest run per check.
    const checks = contexts.filter(Boolean).map((c) =>
      c.__typename === "CheckRun"
        ? {
            name: c.name,
            state: c.status === "COMPLETED" ? c.conclusion : c.status,
            bucket: checkBucket(c.status === "COMPLETED" ? c.conclusion : c.status),
            link: c.detailsUrl || "",
          }
        : { name: c.context, state: c.state, bucket: checkBucket(c.state), link: c.targetUrl || "" },
    );
    return JSON.stringify(checks);
  }

  if (sub === "merge" && number != null && args.includes("--squash") && args.length === 4) {
    await rest({ ...req, method: "PUT", path: `${repoPath}/pulls/${number}/merge`, body: { merge_method: "squash" } });
    return "";
  }

  if (sub === "create" && !target) {
    const created = await rest({
      ...req,
      method: "POST",
      path: `${repoPath}/pulls`,
      body: {
        base: flag("--base"),
        head: flag("--head"),
        title: flag("--title") || "",
        body: flag("--body") || "",
        draft: args.includes("--draft"),
      },
    });
    return String(created.html_url || "");
  }

  if (sub === "edit" && number != null) {
    /** @type {{ title?: string, body?: string }} */
    const body = {};
    if (flag("--title") != null) body.title = flag("--title");
    if (flag("--body") != null) body.body = flag("--body");
    await rest({ ...req, method: "PATCH", path: `${repoPath}/pulls/${number}`, body });
    return "";
  }

  if (sub === "close" && number != null && args.length === 3) {
    await rest({ ...req, method: "PATCH", path: `${repoPath}/pulls/${number}`, body: { state: "closed" } });
    return "";
  }

  if (sub === "comment" && number != null) {
    const posted = await rest({
      ...req,
      method: "POST",
      path: `${repoPath}/issues/${number}/comments`,
      body: { body: flag("--body") || "" },
    });
    return String(posted.html_url || "");
  }

  if (sub === "ready" && number != null) {
    // Draft toggles are GraphQL-only and need the PR node id.
    const pr = await viewByNumber(number);
    const mutation = args.includes("--undo") ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    const res = await graphql({
      ...req,
      query: `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`,
      variables: { id: pr.id },
    });
    if (res.errors && res.errors.length) {
      throw new Error(`GitHub API error from ${remote.host}: ${String(res.errors[0].message || "")}`);
    }
    return "";
  }

  throw new Unsupported(`ghPr: unsupported argv ${args.join(" ")}`);
}

/**
 * `gh issue …` and `gh api graphql …` argv over the API, same contract as
 * ghPr. Labels go through GraphQL by name so a label missing from the repo
 * fails the whole edit with "not found", like gh, instead of REST quietly
 * creating it.
 * @param {{ host: string, owner: string, repo: string }} remote
 * @param {string[]} args
 * @param {{ token: string, fetchFn?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<string>}
 */
async function ghIssue(remote, args, opts) {
  const req = { host: remote.host, token: opts.token, fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs };
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };

  if (args[0] === "api" && args[1] === "graphql") {
    /** @type {Record<string, string | number>} */
    const variables = {};
    let query = "";
    for (let i = 2; i < args.length - 1; i++) {
      if (args[i] !== "-f" && args[i] !== "-F") continue;
      const raw = args[++i];
      const eq = raw.indexOf("=");
      const key = raw.slice(0, eq);
      const value = raw.slice(eq + 1);
      if (key === "query") query = value;
      else variables[key] = args[i - 1] === "-F" && /^-?\d+$/.test(value) ? Number(value) : value;
    }
    if (!query) throw new Unsupported("ghIssue: api graphql without a query");
    return JSON.stringify(await graphql({ ...req, query, variables }));
  }

  const sub = args[1];
  const number = /^\d+$/.test(String(args[2] || "")) ? Number(args[2]) : null;
  let target = remote;
  const r = flag("-R");
  if (r) {
    const parsed = r.includes("://") ? parseRemote(r) : null;
    const [owner, repo] = r.split("/");
    target = parsed || (owner && repo ? { host: remote.host, owner, repo } : null);
    if (!target || target.host !== remote.host) throw new Unsupported(`ghIssue: -R ${r}`);
  }
  const issuePath = `/repos/${target.owner}/${target.repo}/issues`;

  if (sub === "view" && number != null) {
    const fields = "number title body url state updatedAt createdAt labels(first: 100) { nodes { name } }";
    const { data } = await graphql({
      ...req,
      query: `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { issueOrPullRequest(number: $n) { ... on Issue { ${fields} } ... on PullRequest { ${fields} } } } }`,
      variables: { owner: target.owner, name: target.repo, n: number },
    });
    if (!data.repository) throw new Error(`GitHub API: ${target.owner}/${target.repo} not found on ${target.host}`);
    const issue = data.repository.issueOrPullRequest;
    if (!issue) throw notFound(`Could not resolve to an issue or pull request with the number of ${number}.`);
    return JSON.stringify({ ...issue, labels: issue.labels.nodes });
  }

  if (sub === "edit" && number != null) {
    const add = String(flag("--add-label") || "").split(",").filter(Boolean);
    const remove = String(flag("--remove-label") || "").split(",").filter(Boolean);
    if (!add.length && !remove.length) throw new Unsupported("ghIssue: edit without labels");
    const names = [...add, ...remove];
    const decl = names.map((_, i) => `$l${i}: String!`).join(", ");
    const lookups = names.map((_, i) => `l${i}: label(name: $l${i}) { id }`).join(" ");
    /** @type {Record<string, string | number>} */
    const variables = { owner: target.owner, name: target.repo, n: number };
    names.forEach((n, i) => { variables[`l${i}`] = n; });
    const { data } = await graphql({
      ...req,
      query: `query($owner: String!, $name: String!, $n: Int!, ${decl}) { repository(owner: $owner, name: $name) { issue(number: $n) { id } ${lookups} } }`,
      variables,
    });
    const repo = data.repository;
    if (!repo) throw new Error(`GitHub API: ${target.owner}/${target.repo} not found on ${target.host}`);
    if (!repo.issue) throw notFound(`Could not resolve to an issue with the number of ${number}.`);
    const ids = names.map((n, i) => {
      if (!repo[`l${i}`]) throw notFound(`'${n}' not found`);
      return repo[`l${i}`].id;
    });
    const res = await graphql({
      ...req,
      query: `mutation($id: ID!, $add: [ID!]!, $remove: [ID!]!) { ${add.length ? "a: addLabelsToLabelable(input: { labelableId: $id, labelIds: $add }) { clientMutationId }" : ""} ${remove.length ? "r: removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $remove }) { clientMutationId }" : ""} }`,
      variables: { id: repo.issue.id, add: ids.slice(0, add.length), remove: ids.slice(add.length) },
    });
    if (res.errors && res.errors.length) {
      throw new Error(`GitHub API error from ${remote.host}: ${String(res.errors[0].message || "")}`);
    }
    return "";
  }

  if (sub === "comment" && number != null) {
    const posted = await rest({ ...req, method: "POST", path: `${issuePath}/${number}/comments`, body: { body: flag("--body") || "" } });
    return String(posted.html_url || "");
  }

  if ((sub === "reopen" || sub === "close") && number != null) {
    if (flag("--comment")) {
      await rest({ ...req, method: "POST", path: `${issuePath}/${number}/comments`, body: { body: flag("--comment") } });
    }
    await rest({ ...req, method: "PATCH", path: `${issuePath}/${number}`, body: { state: sub === "close" ? "closed" : "open" } });
    return "";
  }

  if (sub === "create" && number == null) {
    const created = await rest({
      ...req,
      method: "POST",
      path: issuePath,
      body: { title: flag("--title") || "", body: flag("--body") || "" },
    });
    return String(created.html_url || "");
  }

  throw new Unsupported(`ghIssue: unsupported argv ${args.join(" ")}`);
}

module.exports = {
  parseRemote,
  graphqlUrl,
  restUrl,
  githubToken,
  setHostSettings,
  forgetToken,
  graphql,
  rest,
  fetchPrStates,
  ghPr,
  ghIssue,
  Unsupported,
  checkBucket,
  PR_BATCH,
};
