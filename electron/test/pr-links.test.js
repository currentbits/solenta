"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectPrStacks,
  linkPullRequest,
  normalizePrLinks,
  parseRepoSlug,
  upsertPrLink,
} = require("../prLinks.js");

function fakeStore(rows) {
  return {
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
}

describe("parseRepoSlug (#1842)", () => {
  const cases = [
    ["https://github.com/currentbits/solenta/pull/1838", "currentbits/solenta"],
    ["https://github.com/acme/app/pull/4/files", "acme/app"],
    ["https://gitlab.com/group/sub/repo/-/merge_requests/7", "group/sub/repo"],
    ["https://github.com/acme/app", "acme/app"],
    ["https://github.com/acme/app.git", "acme/app"],
    ["https://gitlab.com/group/sub/repo.git", "group/sub/repo"],
    ["git@github.com:acme/app.git", "acme/app"],
    ["git@gitlab.com:group/sub/repo.git", "group/sub/repo"],
    ["acme/app", "acme/app"],
    ["", null],
  ];
  for (const [input, want] of cases) {
    it(`${input || "(empty)"} -> ${want}`, () => {
      assert.equal(parseRepoSlug(input), want);
    });
  }
});

describe("PR link dedup (#1842)", () => {
  const url = "https://github.com/currentbits/solenta/pull/1838";

  it("heals a stored pull/N repo from its url on load", () => {
    const links = normalizePrLinks({
      prLinks: [
        { number: 1838, repo: "pull/1838", url },
        { number: 1838, repo: "currentbits/solenta", url },
      ],
    });
    assert.deepEqual(links, [{ number: 1838, repo: "currentbits/solenta", url }]);
  });

  it("drops a malformed repo it cannot re-derive", () => {
    assert.deepEqual(normalizePrLinks({ prLinks: [{ number: 5, repo: "merge_requests/5" }] }), [
      { number: 5 },
    ]);
  });

  it("upsert replaces a same-url link whose repo was missing", () => {
    const out = upsertPrLink([{ number: 1838, url, state: "OPEN" }], {
      number: 1838,
      repo: "currentbits/solenta",
      url,
    });
    assert.deepEqual(out, [{ number: 1838, repo: "currentbits/solenta", url, state: "OPEN" }]);
  });

  it("upsert without a repo keeps the existing same-url link's repo", () => {
    const out = upsertPrLink([{ number: 1838, repo: "currentbits/solenta", url }], {
      number: 1838,
      url,
      state: "MERGED",
    });
    assert.deepEqual(out, [{ number: 1838, repo: "currentbits/solenta", url, state: "MERGED" }]);
  });

  it("a retry with an explicit repo does not add a duplicate", () => {
    const rows = [
      {
        id: "t1",
        prNumber: 1838,
        prUrl: url,
        prState: null,
        prLinks: [{ number: 1838, repo: "pull/1838", url }],
      },
    ];
    const store = fakeStore(rows);
    linkPullRequest(store, { threadId: "t1", number: 1838, url });
    const after = linkPullRequest(store, {
      threadId: "t1",
      number: 1838,
      repo: "currentbits/solenta",
      url,
    });
    assert.deepEqual(after.prLinks, [{ number: 1838, repo: "currentbits/solenta", url }]);
  });
});

describe("linkPullRequest (#1527)", () => {
  it("primary: true makes a later link the primary PR (#1842)", () => {
    const rows = [
      {
        id: "t1",
        prNumber: 4,
        prUrl: "https://github.com/acme/app/pull/4",
        prState: "CLOSED",
        prLinks: [{ number: 4, url: "https://github.com/acme/app/pull/4", state: "CLOSED" }],
      },
    ];
    const store = fakeStore(rows);
    const plain = linkPullRequest(store, { threadId: "t1", number: 5, repo: "acme/app" });
    assert.equal(plain.prNumber, 4);
    const after = linkPullRequest(store, {
      threadId: "t1",
      number: 6,
      url: "https://github.com/acme/app/pull/6",
      primary: true,
    });
    assert.equal(after.prNumber, 6);
    assert.equal(after.prUrl, "https://github.com/acme/app/pull/6");
    assert.equal(after.prState, null);
    assert.equal(after.prLinks.length, 3);
  });

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
