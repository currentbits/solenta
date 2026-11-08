"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const source = require.resolve("../prWorkspace.js");
const localRequire = createRequire(source);
const viewerId = "gid://gitlab/User/42";
const args = { prNumber: 7, viewerId };

// Shapes from the official REST reviewers and GraphQL MergeRequest/createNote
// schemas. The account's `active` state is deliberately different from the
// review verdict: https://docs.gitlab.com/api/merge_requests/#retrieve-merge-request-reviewers
function fixture(overrides = {}) {
  const options = {
    reviewer: true, state: "unreviewed", permission: true, command: true,
    mrState: "opened", authorId: "gid://gitlab/User/9", userId: viewerId,
    mutation: { errors: [], quickActionsStatus: { commandNames: ["request_changes"], commandsOnly: true, errorMessages: [] } },
    ...overrides,
  };
  const calls = [];
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, "utf8"), { module: mod, require(name) {
    if (name === "./worktrees.js") return { ...localRequire(name), gitTryAsync: async () => ({ ok: true, stdout: options.origin || "git@gitlab.example:team/private.git" }) };
    if (name === "./gitlab.js") return {
      ...localRequire(name),
      glabApi: async (cwd, remote, method, endpoint, fields) => {
        calls.push({ cwd, remote: { ...remote }, method, endpoint, fields });
        if (endpoint.includes("/reviewers")) return options.reviewersError || { ok: true, data: options.reviewer ? [{ user: { id: 42, username: "alice", state: "active" }, state: options.state, created_at: "2026-01-01T00:00:00Z" }] : [] };
        if (endpoint.includes("/notes")) return { ok: true, data: [] };
        return { ok: true, data: { iid: 7, web_url: "https://gitlab.example/team/private/-/merge_requests/7", state: options.mrState, title: "MR", reviewers: [{ id: 42, username: "alice", state: "active" }] } };
      },
      glabGraphql: async (cwd, remote, query) => {
        const mutation = query.startsWith("mutation");
        calls.push({ cwd, remote: { ...remote }, method: mutation ? "mutation" : "query", query });
        if (mutation) {
          if (options.writeError) return options.writeError;
          if (!options.noStateChange) options.state = "requested_changes";
          Object.assign(options, options.afterMutation);
          return { ok: true, data: { createNote: options.mutation } };
        }
        if (options.capabilityError) return options.capabilityError;
        return { ok: true, data: { currentUser: { id: options.userId, username: "alice" }, project: { mergeRequest: {
          id: "gid://gitlab/MergeRequest/700", state: options.mrState, author: { id: options.authorId },
          userPermissions: { createNote: options.permission, updateMergeRequest: options.permission },
          availableQuickActions: options.command ? [{ name: "request_changes" }] : [],
        } } } };
      },
    };
    return localRequire(name);
  } });
  return { api: mod.exports, options, calls, writes: () => calls.filter((call) => call.method === "mutation") };
}

it("loads reviewer verdicts without treating account state or approvals as the MR decision", async () => {
  for (const state of ["unreviewed", "review_started", "reviewed", "approved", "unapproved", "requested_changes", "future_state"]) {
    const fx = fixture({ state });
    const result = await fx.api.viewPrDetail("/repo", 7);
    assert.equal(result.ok, true);
    assert.equal(result.pr.gitlabReview.reviewers[0].state, state === "future_state" ? "unknown" : state);
    assert.equal(result.pr.reviewDecision, undefined);
    assert.equal(fx.writes().length, 0);
  }
});

it("records only the standalone verdict, confirms the same reviewer, and scopes every call to origin host and selected repo", async () => {
  const fx = fixture();
  const result = await fx.api.requestPrChanges("/repo", { ...args, repo: "other/subgroup/mr" });
  assert.equal(result.ok, true);
  assert.equal(result.review.reviewers[0].state, "requested_changes");
  assert.equal(result.review.canRequestChanges, false);
  assert.equal(fx.writes().length, 1);
  assert.match(fx.writes()[0].query, /noteableId: "gid:\/\/gitlab\/MergeRequest\/700", body: "\/request_changes"/);
  assert.doesNotMatch(fx.writes()[0].query, /submit_review/);
  for (const call of fx.calls) {
    assert.equal(call.cwd, "/repo");
    assert.equal(call.remote.host, "gitlab.example");
    assert.equal(call.remote.path, "other/subgroup/mr");
    if (call.method === "query") assert.match(call.query, /project\(fullPath: "other\/subgroup\/mr"\)/);
  }
});

it("never submits on unsupported hosts, missing permissions, assignment, wrong account, own or closed MRs", async () => {
  for (const options of [
    { capabilityError: { ok: false, reason: "Field 'availableQuickActions' doesn't exist on type 'MergeRequest'" } },
    { capabilityError: { ok: false, reason: "auth" } },
    { command: false }, { permission: false }, { reviewer: false },
    { userId: "gid://gitlab/User/99" }, { mrState: "closed" }, { authorId: viewerId },
    { reviewersError: { ok: false, reason: "403 Forbidden" } },
    { state: "requested_changes" }, { origin: "git@github.com:team/private.git" },
  ]) {
    const fx = fixture(options);
    const result = await fx.api.requestPrChanges("/repo", args);
    assert.equal(result.ok, false, JSON.stringify(options));
    assert.ok(result.reason);
    assert.equal(fx.writes().length, 0, JSON.stringify(options));
  }
  const fx = fixture();
  assert.equal((await fx.api.requestPrChanges("/repo", { ...args, viewerId: "gid://gitlab/User/99" })).ok, false);
  assert.equal(fx.writes().length, 0);
});

it("rechecks permissions and assignment after the workspace detail was loaded", async () => {
  for (const change of [{ permission: false }, { reviewer: false }, { command: false }]) {
    const fx = fixture();
    assert.equal((await fx.api.viewPrDetail("/repo", 7)).pr.gitlabReview.canRequestChanges, true);
    Object.assign(fx.options, change);
    assert.equal((await fx.api.requestPrChanges("/repo", args)).ok, false);
    assert.equal(fx.writes().length, 0);
  }
});

it("does not report success for GraphQL, quick-action, or unconfirmed verdict failures", async () => {
  for (const options of [
    { writeError: { ok: false, reason: "auth" } },
    { mutation: { errors: ["Resource not available"] } },
    { mutation: { errors: [], quickActionsStatus: { commandNames: ["request_changes"], commandsOnly: true, errorMessages: ["Invalid permissions"] } } },
    { mutation: { errors: [], quickActionsStatus: { commandNames: [], commandsOnly: false } } },
    { noStateChange: true },
    { afterMutation: { reviewer: false } },
    { afterMutation: { userId: "gid://gitlab/User/99" } },
    { afterMutation: { capabilityError: { ok: false, reason: "auth" } } },
  ]) {
    const fx = fixture(options);
    const result = await fx.api.requestPrChanges("/repo", args);
    assert.equal(result.ok, false, JSON.stringify(options));
    assert.ok(result.reason);
  }
});

it("uses the selected host for GraphQL and handles errors inside HTTP-success responses", async () => {
  const gitlabSource = require.resolve("../gitlab.js");
  const mod = { exports: {} };
  let response = { data: { currentUser: { id: viewerId } } };
  const calls = [];
  vm.runInNewContext(fs.readFileSync(gitlabSource, "utf8"), { module: mod, process: { env: {} }, require(name) {
    if (name === "./worktrees.js") return { ...localRequire(name), ghTryAsync: async (cwd, args, opts) => {
      calls.push({ cwd, args: [...args], opts }); return { ok: true, stdout: JSON.stringify(response) };
    } };
    return localRequire(name);
  } });
  assert.equal((await mod.exports.glabGraphql("/repo", { host: "gitlab.private", path: "a/b" }, "query { currentUser { id } }")).ok, true);
  assert.deepEqual(calls[0].args, ["api", "--hostname", "gitlab.private", "-X", "POST", "graphql", "-f", "query=query { currentUser { id } }"]);
  assert.equal(calls[0].opts.bin, "glab");
  response = { errors: [{ message: "Unknown field" }] };
  assert.equal((await mod.exports.glabGraphql("/repo", { host: "gitlab.private", path: "a/b" }, "query {} ")).reason, "Unknown field");
});
