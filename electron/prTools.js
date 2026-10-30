"use strict";

/**
 * PR + CI tools for agents (issue #1749).
 * The coder-threads handlers own scoping and the merge gate; this module is
 * the GitHub side, written against a small client ({ remote, gql, rest, text })
 * so tests stub it. The real client rides github.js: one token per host, no
 * `gh` spawn per call.
 */

const github = require("./github.js");

const LOG_LINES = 200;
const LOG_JOBS = 3;
const LOG_LINE_CHARS = 400;
const BODY_CHARS = 500;
const REVIEWS = 5;
const THREADS = 10;
const GREEN = new Set(["pass", "skipping"]);

/**
 * API client for a project's GitHub origin. Throws a plain message when the
 * origin is not GitHub or no token exists (the token is never logged).
 * @param {object | null} project
 */
async function clientFor(project) {
  const { originUrlOf } = require("./issues.js");
  const { githubApiTarget } = require("./worktrees-pr.js");
  const target = project ? await githubApiTarget(originUrlOf(project)) : null;
  if (!target) {
    throw new Error(
      "No GitHub API access for this project: its origin is not a GitHub " +
        "remote, or no token is available (gh auth login, or a token in " +
        "Settings › Source control).",
    );
  }
  const { remote, token } = target;
  const req = { host: remote.host, token, timeoutMs: 30_000 };
  const repoPath = `/repos/${remote.owner}/${remote.repo}`;
  return {
    remote,
    /** @param {string} query @param {object} variables */
    async gql(query, variables) {
      const res = await github.graphql({ ...req, query, variables });
      if (res.errors && res.errors.length) {
        throw new Error(`GitHub API error: ${String(res.errors[0].message || "")}`);
      }
      return res.data;
    },
    /** @param {string} method @param {string} path - below /repos/o/r @param {object} [body] */
    rest: (method, path, body) => github.rest({ ...req, method, path: repoPath + path, body }),
    /** @param {string} path - below /repos/o/r */
    text: (path) => github.restText({ ...req, path: repoPath + path }),
  };
}

const PR_QUERY = `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) {
  id number url title state isDraft mergeable mergeStateStatus reviewDecision headRefName headRefOid baseRefName
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename
    ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $n) }
    ... on StatusContext { context state isRequired(pullRequestNumber: $n) } } } } } } }
  reviews(last: ${REVIEWS}) { nodes { author { login } state body submittedAt } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated path line
    root: comments(first: 1) { nodes { databaseId } }
    comments(last: 3) { totalCount nodes { author { login } body createdAt } } } }
} } }`;

/** @param {unknown} s */
function clip(s) {
  const text = String(s || "");
  return text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS)}… [truncated]` : text;
}

/**
 * @param {{ remote: { owner: string, repo: string }, gql: Function }} client
 * @param {number} n
 */
async function fetchPr(client, n) {
  const data = await client.gql(PR_QUERY, { owner: client.remote.owner, name: client.remote.repo, n });
  const pr = data && data.repository && data.repository.pullRequest;
  if (!pr) throw new Error(`PR #${n} not found in ${client.remote.owner}/${client.remote.repo}`);
  return pr;
}

/** Rollup contexts as { name, status, conclusion, required, bucket }. */
function checksOf(pr) {
  const node = pr.commits && pr.commits.nodes && pr.commits.nodes[0];
  const rollup = node && node.commit && node.commit.statusCheckRollup;
  const contexts = (rollup && rollup.contexts && rollup.contexts.nodes) || [];
  return contexts.filter(Boolean).map((c) => {
    if (c.__typename === "StatusContext") {
      const pending = c.state === "PENDING" || c.state === "EXPECTED";
      return {
        name: c.context,
        status: pending ? "PENDING" : "COMPLETED",
        conclusion: pending ? null : c.state,
        required: Boolean(c.isRequired),
        bucket: github.checkBucket(c.state),
      };
    }
    const done = c.status === "COMPLETED";
    return {
      name: c.name,
      status: c.status,
      conclusion: done ? c.conclusion : null,
      required: Boolean(c.isRequired),
      bucket: github.checkBucket(done ? c.conclusion : c.status),
    };
  });
}

async function viewPr(client, n) {
  const pr = await fetchPr(client, n);
  const node = pr.commits && pr.commits.nodes && pr.commits.nodes[0];
  const rollup = node && node.commit && node.commit.statusCheckRollup;
  const checks = checksOf(pr);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const c of checks) counts[c.bucket] = (counts[c.bucket] || 0) + 1;
  const threads = (pr.reviewThreads.nodes || []).filter(Boolean);
  // Unresolved first, then newest activity; GitHub returns oldest first.
  const ordered = [...threads.filter((t) => !t.isResolved).reverse(), ...threads.filter((t) => t.isResolved).reverse()];
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    draft: pr.isDraft,
    mergeable: pr.mergeable,
    mergeState: pr.mergeStateStatus,
    head: pr.headRefName,
    headSha: pr.headRefOid,
    base: pr.baseRefName,
    reviewDecision: pr.reviewDecision || null,
    checks: {
      state: (rollup && rollup.state) || null,
      counts,
      items: checks.map(({ bucket, ...c }) => c),
    },
    reviews: (pr.reviews.nodes || []).filter(Boolean).reverse().map((r) => ({
      author: r.author ? r.author.login : null,
      state: r.state,
      body: clip(r.body),
      submittedAt: r.submittedAt,
    })),
    unresolvedThreads: threads.filter((t) => !t.isResolved).length,
    reviewThreads: ordered.slice(0, THREADS).map((t) => ({
      resolved: t.isResolved,
      outdated: t.isOutdated,
      path: t.path,
      line: t.line,
      inReplyTo: t.root.nodes[0] ? t.root.nodes[0].databaseId : null,
      commentCount: t.comments.totalCount,
      comments: t.comments.nodes.filter(Boolean).map((c) => ({
        author: c.author ? c.author.login : null,
        body: clip(c.body),
        createdAt: c.createdAt,
      })),
    })),
  };
}

/** @param {string} text @param {string} where */
function scanOutbound(text, where) {
  if (!text) return;
  require("./worktrees.js").assertNoOutboundSecrets(text, where);
}

/**
 * @param {{ title?: string, body?: string, draft?: boolean, base?: string }} input
 */
async function updatePr(client, n, input) {
  /** @type {Record<string, string>} */
  const patch = {};
  for (const key of ["title", "body", "base"]) {
    if (typeof input[key] === "string") patch[key] = input[key];
  }
  if (!Object.keys(patch).length && typeof input.draft !== "boolean") {
    throw new Error("Nothing to update: pass title, body, base, or draft.");
  }
  scanOutbound(`${patch.title || ""}\n${patch.body || ""}`.trim(), "PR edit");
  const updated = [];
  if (Object.keys(patch).length) {
    await client.rest("PATCH", `/pulls/${n}`, patch);
    updated.push(...Object.keys(patch));
  }
  if (typeof input.draft === "boolean") {
    const pr = await fetchPr(client, n);
    if (pr.isDraft !== input.draft) {
      // Draft toggles are GraphQL-only.
      const mutation = input.draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
      await client.gql(
        `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`,
        { id: pr.id },
      );
      updated.push("draft");
    }
  }
  return { number: n, updated };
}

/** @param {{ body: string, inReplyTo?: number }} input */
async function commentPr(client, n, input) {
  const body = String((input && input.body) || "");
  if (!body.trim()) throw new Error("Comment body is empty.");
  scanOutbound(body, "PR comment");
  const posted =
    input.inReplyTo != null
      ? await client.rest("POST", `/pulls/${n}/comments/${Number(input.inReplyTo)}/replies`, { body })
      : await client.rest("POST", `/issues/${n}/comments`, { body });
  return { number: n, url: (posted && posted.html_url) || null };
}

/**
 * Why GitHub state says this PR must not merge now; empty when it may.
 * Cancelled is not green: a CANCELLED required check let a red PR land once.
 */
function mergeBlockers(pr) {
  const out = [];
  if (pr.state !== "OPEN") out.push(`PR is ${String(pr.state).toLowerCase()}`);
  if (pr.isDraft) out.push("PR is a draft (pr_update draft:false first)");
  if (pr.mergeable === "CONFLICTING") out.push(`PR conflicts with ${pr.baseRefName}`);
  else if (pr.mergeable !== "MERGEABLE") out.push("GitHub has not finished computing mergeability; retry shortly");
  if (pr.mergeStateStatus === "BLOCKED") out.push("branch protection blocks the merge (required reviews or checks)");
  for (const c of checksOf(pr)) {
    if (c.bucket === "fail") out.push(`check "${c.name}" failed (${c.conclusion})`);
    else if (c.required && !GREEN.has(c.bucket)) {
      out.push(`required check "${c.name}" is ${String(c.conclusion || c.status).toLowerCase()}`);
    }
  }
  return out;
}

/** The PR when GitHub says it may merge now; throws the blockers otherwise. */
async function mergeablePr(client, n) {
  const pr = await fetchPr(client, n);
  const blockers = mergeBlockers(pr);
  if (blockers.length) {
    throw new Error(`Not merging PR #${n}: ${blockers.join("; ")}. Nothing was merged.`);
  }
  return pr;
}

/**
 * @param {"merge" | "squash" | "rebase"} method
 * @param {string} headSha - the signed-off head; a newer push makes GitHub refuse
 */
async function mergePr(client, n, method, headSha) {
  const res = await client.rest("PUT", `/pulls/${n}/merge`, { merge_method: method, sha: headSha });
  return { number: n, merged: Boolean(res && res.merged), sha: (res && res.sha) || null, method };
}

/** @param {unknown} url */
function runIdOf(url) {
  const m = String(url || "").match(/\/actions\/runs\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Strip ANSI and Actions' per-line timestamps, keep the last `max` lines.
 * @param {string} text
 */
function tailLog(text, max = LOG_LINES) {
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) =>
      l
        .replace(/^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/, "")
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .slice(0, LOG_LINE_CHARS),
    );
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { log: lines.slice(-max).join("\n"), omittedLines: Math.max(0, lines.length - max) };
}

/** Failed check runs on the PR head, newest API order. */
async function failedRuns(client, sha) {
  const res = await client.rest("GET", `/commits/${sha}/check-runs?filter=latest&per_page=100`);
  return ((res && res.check_runs) || []).filter(
    (r) => r && github.checkBucket(String(r.conclusion || "")) === "fail",
  );
}

async function ciLogs(client, n) {
  const pr = await fetchPr(client, n);
  const failed = await failedRuns(client, pr.headRefOid);
  const jobs = [];
  for (const run of failed.slice(0, LOG_JOBS)) {
    const job = {
      name: run.name,
      conclusion: run.conclusion,
      runId: runIdOf(run.details_url || run.html_url),
      jobId: run.id,
      url: run.html_url || run.details_url || null,
    };
    if (!run.app || run.app.slug !== "github-actions") {
      jobs.push({ ...job, log: null, summary: clip(run.output && (run.output.summary || run.output.title)) });
      continue;
    }
    try {
      // GitHub Actions: a check run id is the job id.
      jobs.push({ ...job, ...tailLog(await client.text(`/actions/jobs/${run.id}/logs`)) });
    } catch (err) {
      jobs.push({ ...job, log: null, logError: String((err && err.message) || err) });
    }
  }
  return { number: n, headSha: pr.headRefOid, failedCount: failed.length, jobs };
}

/** @param {number} [runId] - omitted: every Actions run with a failed job on the PR head */
async function ciRerun(client, n, runId) {
  const pr = await fetchPr(client, n);
  let ids;
  if (runId != null) {
    const run = await client.rest("GET", `/actions/runs/${Number(runId)}`);
    if (!run || run.head_sha !== pr.headRefOid) {
      throw new Error(`Run ${runId} is not for PR #${n}'s head commit ${String(pr.headRefOid).slice(0, 7)}.`);
    }
    ids = [Number(runId)];
  } else {
    const failed = await failedRuns(client, pr.headRefOid);
    ids = [...new Set(failed.map((r) => runIdOf(r.details_url || r.html_url)).filter(Boolean))];
    if (!ids.length) throw new Error(`No failed GitHub Actions jobs on PR #${n}'s head commit.`);
  }
  for (const id of ids) await client.rest("POST", `/actions/runs/${id}/rerun-failed-jobs`);
  return { number: n, rerunRunIds: ids };
}

module.exports = {
  clientFor,
  viewPr,
  updatePr,
  commentPr,
  mergeablePr,
  mergePr,
  mergeBlockers,
  ciLogs,
  ciRerun,
  tailLog,
  LOG_LINES,
  LOG_JOBS,
};
