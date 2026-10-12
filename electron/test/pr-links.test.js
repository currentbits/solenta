"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectPrStacks,
  linkPullRequest,
  normalizePrLinks,
} = require("../prLinks.js");

describe("linkPullRequest (#1527)", () => {
  it("first link becomes prNumber; extras stay on prLinks", () => {
    const rows = [
      { id: "t1", projectId: "p1", prNumber: null, prUrl: null, prState: null, prLinks: [] },
    ];
    const store = {
      getThread(id) {
        return rows.find((t) => t.id === id) || null;
      },
      updateThread(id, patch) {
        const i = rows.findIndex((t) => t.id === id);
        rows[i] = { ...rows[i], ...patch };
        return rows[i];
      },
      save() {},
    };
    const first = linkPullRequest(store, {
      threadId: "t1",
      number: 4,
      url: "https://github.com/acme/app/pull/4",
    });
    assert.equal(first.prNumber, 4);
    assert.equal(first.prLinks.length, 1);
    const second = linkPullRequest(store, {
      threadId: "t1",
      number: 9,
      repo: "acme/other",
    });
    assert.equal(second.prNumber, 4);
    assert.equal(second.prLinks.length, 2);
    assert.equal(second.prLinks[1].repo, "acme/other");
  });

  it("normalizePrLinks backfills the legacy prNumber", () => {
    const links = normalizePrLinks({
      prNumber: 3,
      prUrl: "https://github.com/acme/app/pull/3",
      prState: "OPEN",
    });
    assert.deepEqual(links, [
      { number: 3, url: "https://github.com/acme/app/pull/3", state: "OPEN" },
    ]);
  });
});

describe("detectPrStacks", () => {
  it("orders the chain bottom-up", () => {
    const stacks = detectPrStacks([
      { number: 2, headRefName: "mid", baseRefName: "bot" },
      { number: 1, headRefName: "bot", baseRefName: "main" },
      { number: 3, headRefName: "top", baseRefName: "mid" },
    ]);
    assert.deepEqual(stacks[0].map((p) => p.number), [1, 2, 3]);
  });
});
