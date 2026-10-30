const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { createToolHandlers } = require("../orchServer.js");
const { tailLog } = require("../prTools.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createPermissions } = require("../runner-permissions.js");

/** t1 owns PR 7, t2 is t1's worker on PR 8, t4 is a sibling on PR 9, t3 is another project. */
function makeStore() {
  const threads = [
    { id: "t1", projectId: "p1", prNumber: 7, handoffFrom: null },
    { id: "t2", projectId: "p1", prNumber: 8, handoffFrom: "t1" },
    { id: "t4", projectId: "p1", prNumber: 9, handoffFrom: null, title: "Sibling" },
    { id: "t3", projectId: "p2", prNumber: 7, handoffFrom: null },
    { id: "t5", projectId: "p1", prNumber: null, handoffFrom: null },
    {
      id: "t6",
      projectId: "p1",
      prNumber: 3,
      prLinks: [{ number: 3, repo: "elsewhere/other" }],
      handoffFrom: null,
    },
  ];
  const projects = { p1: { id: "p1", path: "/tmp/alpha" }, p2: { id: "p2", path: "/tmp/beta" } };
  return {
    getThreads: () => threads,
    getThread: (id) => threads.find((t) => t.id === id) || null,
    getProject: (id) => projects[id] || null,
  };
}

function prFixture(over = {}) {
  return {
    id: "PR_node",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "Add thing",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefName: "feat",
    headRefOid: "abc1234def",
    baseRefName: "main",
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: "SUCCESS",
              contexts: {
                nodes: [
                  { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true },
                  { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", isRequired: false },
                ],
              },
            },
          },
        },
      ],
    },
    reviews: {
      nodes: [
        { author: { login: "old" }, state: "COMMENTED", body: "first", submittedAt: "2026-10-01" },
        { author: { login: "new" }, state: "APPROVED", body: "x".repeat(900), submittedAt: "2026-10-02" },
      ],
    },
    reviewThreads: {
      nodes: [
        { isResolved: true, isOutdated: false, path: "a.js", line: 1, root: { nodes: [{ databaseId: 11 }] }, comments: { totalCount: 1, nodes: [{ author: { login: "r" }, body: "done", createdAt: "t" }] } },
        { isResolved: false, isOutdated: false, path: "b.js", line: 2, root: { nodes: [{ databaseId: 22 }] }, comments: { totalCount: 1, nodes: [{ author: { login: "r" }, body: "fix me", createdAt: "t" }] } },
      ],
    },
    ...over,
  };
}

/** Stub GitHub client: records every call; never touches the network. */
function makeClient({ pr = prFixture(), rest = {}, text = {} } = {}) {
  const calls = [];
  return {
    calls,
    remote: { host: "github.com", owner: "acme", repo: "app" },
    async gql(query, variables) {
      calls.push(["gql", query.trim().startsWith("mutation") ? "mutation" : "query", variables]);
      if (query.trim().startsWith("mutation")) return {};
      return { repository: { pullRequest: variables.n === pr.number || variables.n === 8 || variables.n === 42 ? pr : null } };
    },
    async rest(method, path, body) {
      calls.push(["rest", method, path, body]);
      const hit = rest[`${method} ${path}`];
      if (typeof hit === "function") return hit(body);
      return hit === undefined ? { html_url: "https://github.com/acme/app/pull/7#c" } : hit;
    },
    async text(path) {
      calls.push(["text", path]);
      if (text[path] instanceof Error) throw text[path];
      return text[path] || "";
    },
  };
}

function handlersWith(client, { auto = false, bound = "" } = {}) {
  return createToolHandlers({
    store: makeStore(),
    runner: { isAutoTurn: () => auto },
    githubClient: async () => client,
    boundThreadId: bound || undefined,
  });
}

const own = { threadId: "t1", projectId: "p1" };

describe("pr_view (#1749)", () => {
  it("summarizes the thread's linked PR: checks, reviews, unresolved threads first", async () => {
    const client = makeClient();
    const out = await handlersWith(client).pr_view(own);
    assert.equal(client.calls[0][2].n, 7);
    assert.deepEqual(client.calls[0][2], { owner: "acme", name: "app", n: 7 });
    assert.equal(out.title, "Add thing");
    assert.equal(out.mergeable, "MERGEABLE");
    assert.equal(out.head, "feat");
    assert.equal(out.base, "main");
    assert.equal(out.reviewDecision, "APPROVED");
    assert.deepEqual(out.checks.items[0], { name: "test", status: "COMPLETED", conclusion: "SUCCESS", required: true });
    assert.deepEqual(out.checks.counts, { pass: 2 });
    assert.equal(out.reviews[0].author, "new");
    assert.ok(out.reviews[0].body.length < 600 && out.reviews[0].body.endsWith("[truncated]"));
    assert.equal(out.unresolvedThreads, 1);
    assert.equal(out.reviewThreads[0].path, "b.js");
    assert.equal(out.reviewThreads[0].inReplyTo, 22);
  });

  it("rejects another project's thread, another thread's PR, and a foreign-repo link", async () => {
    const h = handlersWith(makeClient());
    await assert.rejects(h.pr_view({ threadId: "t3", projectId: "p1" }), /not to/);
    await assert.rejects(h.pr_view({ ...own, number: 9 }), /linked to thread t4, not yours/);
    await assert.rejects(h.pr_view({ threadId: "t5", projectId: "p1" }), /no linked PR/);
    await assert.rejects(h.pr_view({ threadId: "t6", projectId: "p1" }), /elsewhere\/other/);
    // A worker's PR and an unlinked PR in the project repo are allowed.
    await h.pr_view({ ...own, number: 8 });
    await h.pr_view({ ...own, number: 42 });
  });

  it("a bound session cannot act as another thread", async () => {
    const h = handlersWith(makeClient(), { bound: "t1" });
    await assert.rejects(h.pr_view({ threadId: "t4", projectId: "p1" }), /does not match the bound caller/);
  });

  it("reports a missing PR as a clear error", async () => {
    const h = handlersWith(makeClient());
    await assert.rejects(h.pr_view({ ...own, number: 99 }), /PR #99 not found in acme\/app/);
  });
});

describe("pr_update / pr_comment (#1749)", () => {
  it("patches title/body/base over REST and toggles draft via GraphQL", async () => {
    const client = makeClient({ pr: prFixture({ isDraft: true }) });
    const out = await handlersWith(client).pr_update({ ...own, title: "New", base: "dev", draft: false });
    assert.deepEqual(out.updated, ["title", "base", "draft"]);
    assert.deepEqual(client.calls[0], ["rest", "PATCH", "/pulls/7", { title: "New", base: "dev" }]);
    assert.equal(client.calls.at(-1)[1], "mutation");
    assert.deepEqual(client.calls.at(-1)[2], { id: "PR_node" });
  });

  it("skips the draft mutation when already in that state, refuses an empty update", async () => {
    const client = makeClient();
    const out = await handlersWith(client).pr_update({ ...own, draft: false });
    assert.deepEqual(out.updated, []);
    assert.ok(!client.calls.some((c) => c[1] === "mutation"));
    await assert.rejects(handlersWith(client).pr_update(own), /Nothing to update/);
  });

  it("posts an issue comment, or a review-thread reply with inReplyTo", async () => {
    const client = makeClient();
    const h = handlersWith(client);
    await h.pr_comment({ ...own, body: "hi" });
    await h.pr_comment({ ...own, body: "fixed", inReplyTo: 22 });
    assert.deepEqual(client.calls[0], ["rest", "POST", "/issues/7/comments", { body: "hi" }]);
    assert.deepEqual(client.calls[1], ["rest", "POST", "/pulls/7/comments/22/replies", { body: "fixed" }]);
  });

  it("another thread's PR cannot be commented on", async () => {
    const client = makeClient();
    await assert.rejects(handlersWith(client).pr_comment({ ...own, number: 9, body: "x" }), /not yours/);
    assert.equal(client.calls.length, 0);
  });
});

describe("tailLog (#1749)", () => {
  it("strips ANSI and timestamps", () => {
    const raw = "﻿2026-10-29T10:00:00.1234567Z \x1b[36;1mRun npm test\x1b[0m\r\n2026-10-29T10:00:01Z \x1b[31mFAIL\x1b[0m x\n";
    assert.deepEqual(tailLog(raw), { log: "Run npm test\nFAIL x", omittedLines: 0 });
  });
});

describe("pr_merge sign-off (#1749)", () => {
  const merged = { "PUT /pulls/7/merge": { merged: true, sha: "m3rg3d" } };
  let tmpDir;
  let store;
  let thread;
  let project;
  let auto;
  let perms;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pr-merge-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "Lead" });
    // working holds the queued Accept resume: nothing drains it here.
    store.updateThread(thread.id, { prNumber: 7, status: "working" });
    auto = false;
    perms = createPermissions({
      store,
      active: new Map(),
      appendMessage: () => {},
      pushDetail: () => {},
      pushThreadsChanged: () => {},
      refreshDetail: () => {},
      lastAssistantText: () => "",
      maybeDrainQueued: () => {},
      isAutoTurn: () => auto,
    });
  });

  afterEach(() => {
    store.saveNow();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(pr = prFixture()) {
    const client = makeClient({ pr, rest: merged });
    const h = createToolHandlers({ store, runner: perms, githubClient: async () => client });
    const args = { threadId: thread.id, projectId: project.id };
    const puts = () => client.calls.filter((c) => c[1] === "PUT");
    const card = () => perms.getPendingPermission(thread.id);
    const respond = (decision) =>
      perms.respondPermission({ threadId: thread.id, requestId: card().requestId, decision });
    return { client, h, args, puts, card, respond, pr };
  }

  it("opens a host card instead of merging; approved:true from the agent changes nothing", async () => {
    const { h, args, puts, card } = setup();
    const out = await h.pr_merge(args);
    assert.equal(out.merged, false);
    assert.equal(out.signOff, "requested");
    assert.match(out.note, /End your turn/);
    const c = card();
    assert.equal(c.toolName, "Merge pull request");
    assert.equal(c.guardrail.rule, "PR_MERGE");
    assert.equal(c.acceptAlways, false);
    for (const want of ["acme/app", "#7", "Add thing", "squash", "abc1234def"]) {
      assert.ok(c.input.includes(want), `card input names ${want}`);
    }
    assert.equal(store.getThread(thread.id).awaitingInput, true);
    await h.pr_merge({ ...args, approved: true });
    assert.equal(card().requestId, c.requestId, "same card, not self-granted");
    assert.equal(puts().length, 0);
  });

  it("Accept then a matching call merges exactly once with the sha; the next call asks again", async () => {
    const { h, args, puts, card, respond } = setup();
    await h.pr_merge(args);
    respond("allow");
    assert.equal(card(), null);
    assert.match(JSON.stringify(store.getThread(thread.id).queued), /pr_merge again with number 7 and method squash/);
    const out = await h.pr_merge(args);
    assert.deepEqual(out, { number: 7, merged: true, sha: "m3rg3d", method: "squash" });
    assert.deepEqual(puts(), [["rest", "PUT", "/pulls/7/merge", { merge_method: "squash", sha: "abc1234def" }]]);
    const again = await h.pr_merge(args);
    assert.equal(again.signOff, "requested");
    assert.ok(card(), "consumed: a new card");
    assert.equal(puts().length, 1);
  });

  it("a moved head SHA or another method voids the Accept", async () => {
    const { h, args, puts, card, respond, pr } = setup();
    await h.pr_merge(args);
    const first = card().requestId;
    respond("allow");
    pr.headRefOid = "n3wpush";
    assert.equal((await h.pr_merge(args)).signOff, "requested");
    assert.notEqual(card().requestId, first);
    assert.match(card().input, /n3wpush/);
    respond("allow");
    assert.equal((await h.pr_merge({ ...args, method: "rebase" })).signOff, "requested");
    assert.equal(puts().length, 0);
  });

  it("Deny clears the card and nothing merges", async () => {
    const { h, args, puts, card, respond } = setup();
    await h.pr_merge(args);
    const first = card().requestId;
    respond("deny");
    assert.equal(card(), null);
    assert.equal(store.getThread(thread.id).awaitingInput, false);
    assert.equal((await h.pr_merge(args)).signOff, "requested");
    assert.notEqual(card().requestId, first);
    assert.equal(puts().length, 0);
  });

  it("an auto turn opens the card but never merges, even after Accept", async () => {
    const { h, args, puts, card, respond } = setup();
    auto = true;
    await h.pr_merge({ ...args, approved: true });
    assert.ok(card());
    respond("allow");
    assert.equal((await h.pr_merge(args)).merged, false);
    assert.equal(puts().length, 0);
    auto = false; // the queued Accept resume is a human turn
    assert.equal((await h.pr_merge(args)).merged, true);
    assert.equal(puts().length, 1);
  });

  it("refuses failing, pending-required and cancelled-required checks, and non-mergeable PRs before any card", async () => {
    const rollup = (nodes) => ({
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes } } } }] },
    });
    const cases = [
      [rollup([{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", isRequired: false }]), /check "lint" failed/],
      [rollup([{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null, isRequired: true }]), /required check "test" is in_progress/],
      [rollup([{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "CANCELLED", isRequired: true }]), /required check "test" is cancelled/],
      [rollup([{ __typename: "StatusContext", context: "ci", state: "PENDING", isRequired: true }]), /required check "ci" is pending/],
      [{ mergeable: "CONFLICTING" }, /conflicts with main/],
      [{ isDraft: true }, /draft/],
      [{ mergeStateStatus: "BLOCKED" }, /branch protection/],
    ];
    for (const [over, why] of cases) {
      const { h, args, puts, card } = setup(prFixture(over));
      await assert.rejects(h.pr_merge(args), why);
      assert.equal(card(), null, `card opened despite ${why}`);
      assert.equal(puts().length, 0);
    }
  });

  it("another thread's PR is refused", async () => {
    const client = makeClient({ rest: merged });
    await assert.rejects(handlersWith(client).pr_merge({ ...own, number: 9 }), /not yours/);
    assert.equal(client.calls.length, 0);
  });
});

describe("ci_logs / ci_rerun (#1749)", () => {
  const checkRuns = (n) => ({
    "GET /commits/abc1234def/check-runs?filter=latest&per_page=100": {
      check_runs: [
        { id: 900, name: "green", conclusion: "success", app: { slug: "github-actions" }, details_url: "https://github.com/acme/app/actions/runs/50/job/900" },
        ...Array.from({ length: n }, (_, i) => ({
          id: 100 + i,
          name: `job${i}`,
          conclusion: i === 1 ? "timed_out" : "failure",
          app: { slug: "github-actions" },
          html_url: `https://github.com/acme/app/actions/runs/${i < 2 ? 60 : 61}/job/${100 + i}`,
        })),
        { id: 777, name: "vercel", conclusion: "failure", app: { slug: "vercel" }, output: { summary: "Build failed" } },
      ],
    },
  });

  it("tails at most 3 failed jobs, 200 lines each, stripped", async () => {
    const long = Array.from({ length: 500 }, (_, i) => `2026-10-29T10:00:00.0000000Z \x1b[31mline ${i}\x1b[0m`).join("\n");
    const client = makeClient({
      rest: checkRuns(4),
      text: { "/actions/jobs/100/logs": long, "/actions/jobs/101/logs": new Error("GitHub API 410 from github.com: gone") },
    });
    const out = await handlersWith(client).ci_logs(own);
    assert.equal(out.failedCount, 5);
    assert.equal(out.jobs.length, 3);
    const first = out.jobs[0];
    assert.equal(first.runId, 60);
    assert.equal(first.jobId, 100);
    assert.equal(first.omittedLines, 300);
    const lines = first.log.split("\n");
    assert.equal(lines.length, 200);
    assert.equal(lines[0], "line 300");
    assert.equal(lines.at(-1), "line 499");
    assert.ok(!/\x1b|2026-10-29T/.test(first.log));
    assert.match(out.jobs[1].logError, /410/);
    assert.ok(!client.calls.some((c) => c[1] === "/actions/jobs/900/logs"), "green job fetched");
  });

  it("returns the summary instead of a log for non-Actions checks", async () => {
    const client = makeClient({ rest: checkRuns(0) });
    const out = await handlersWith(client).ci_logs(own);
    assert.deepEqual(out.jobs.map((j) => [j.name, j.log, j.summary]), [["vercel", null, "Build failed"]]);
  });

  it("re-runs every failed run on the head, or one run that belongs to it", async () => {
    const client = makeClient({
      rest: {
        ...checkRuns(3),
        "GET /actions/runs/61": { head_sha: "abc1234def" },
        "GET /actions/runs/5": { head_sha: "0ld" },
        "POST /actions/runs/60/rerun-failed-jobs": null,
        "POST /actions/runs/61/rerun-failed-jobs": null,
      },
    });
    const h = handlersWith(client);
    assert.deepEqual((await h.ci_rerun(own)).rerunRunIds, [60, 61]);
    assert.deepEqual((await h.ci_rerun({ ...own, runId: 61 })).rerunRunIds, [61]);
    await assert.rejects(h.ci_rerun({ ...own, runId: 5 }), /not for PR #7's head commit/);
    const posts = client.calls.filter((c) => c[1] === "POST").map((c) => c[2]);
    assert.deepEqual(posts, ["/actions/runs/60/rerun-failed-jobs", "/actions/runs/61/rerun-failed-jobs", "/actions/runs/61/rerun-failed-jobs"]);
  });

  it("another thread's PR is refused", async () => {
    const client = makeClient();
    await assert.rejects(handlersWith(client).ci_logs({ ...own, number: 9 }), /not yours/);
    await assert.rejects(handlersWith(client).ci_rerun({ ...own, number: 9 }), /not yours/);
    assert.equal(client.calls.length, 0);
  });
});
