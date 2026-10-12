"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  fetchTriggerIssues,
  ISSUES_CREATED_QUERY,
  ISSUES_STATUS_QUERY,
} = require("../linear.js");

describe("fetchTriggerIssues", () => {
  it("throws when the api key is missing", async () => {
    await assert.rejects(
      () => fetchTriggerIssues("created", { linearApiKey: "" }),
      /no api key \(Settings → Git\)/,
    );
  });

  it("posts the created query and returns nodes", async () => {
    const nodes = [{ identifier: "ENG-1", createdAt: "2026-10-11T00:00:00Z" }];
    const seen = [];
    const out = await fetchTriggerIssues("created", {
      linearApiKey: "k",
      linearGraphql: async (args) => {
        seen.push(args);
        return nodes;
      },
    });
    assert.deepEqual(out, nodes);
    assert.equal(seen[0].source, "created");
    assert.equal(seen[0].apiKey, "k");
    assert.match(seen[0].query, /TriggerIssuesCreated/);
    assert.deepEqual(seen[0].variables, { first: 50 });
  });

  it("posts the status query", async () => {
    const out = await fetchTriggerIssues("status", {
      linearApiKey: "k",
      linearGraphql: async ({ query }) => {
        assert.match(query, /TriggerIssuesStatus/);
        assert.match(query, /stateHistory/);
        return [];
      },
    });
    assert.deepEqual(out, []);
  });
});
