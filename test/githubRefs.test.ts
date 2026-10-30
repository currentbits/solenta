/**
 * GitHub reference detection: `owner/repo#123` and bare `#123` (#1771).
 *
 * Run: node --experimental-strip-types --test test/githubRefs.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findBareGithubRefs,
  findGithubRefs,
  findQualifiedGithubRefs,
  githubRefUrl,
} from "../src/githubRefs.ts";

describe("findQualifiedGithubRefs", () => {
  it("matches owner/repo#123", () => {
    const hits = findQualifiedGithubRefs("see acme/demo#482 for the fix");
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], {
      raw: "acme/demo#482",
      owner: "acme",
      repo: "demo",
      number: 482,
      start: 4,
      end: 17,
    });
  });

  it("leaves a longer path chain alone (a/b/c#123)", () => {
    assert.deepEqual(findQualifiedGithubRefs("see a/b/c#123 in the tree"), []);
  });

  it("does not treat a file path with an extension as a repo", () => {
    assert.deepEqual(findQualifiedGithubRefs("see src/app.ts#123 for context"), []);
  });

  it("skips matches inside a URL", () => {
    assert.deepEqual(
      findQualifiedGithubRefs("https://example.com/acme/demo#482"),
      [],
    );
  });

  it("does not swallow a trailing hex-color-like suffix", () => {
    assert.deepEqual(findQualifiedGithubRefs("acme/demo#123abc"), []);
  });
});

describe("findBareGithubRefs", () => {
  it("resolves #123 (2+ digits) against the given repo", () => {
    const hits = findBareGithubRefs("fixed in #482 today", "acme/demo");
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], {
      raw: "#482",
      owner: "acme",
      repo: "demo",
      number: 482,
      start: 9,
      end: 13,
    });
  });

  it("requires at least 2 digits (step #1 stays plain)", () => {
    assert.deepEqual(findBareGithubRefs("step #1 of 3", "acme/demo"), []);
  });

  it("returns nothing without a repo slug", () => {
    assert.deepEqual(findBareGithubRefs("fixed in #482 today", null), []);
    assert.deepEqual(findBareGithubRefs("fixed in #482 today", ""), []);
    // A slug with no "/" is a local project name, not a GitHub remote.
    assert.deepEqual(findBareGithubRefs("fixed in #482 today", "my-folder"), []);
  });

  it("leaves a CSS hex color alone", () => {
    assert.deepEqual(findBareGithubRefs("background: #123abc;", "acme/demo"), []);
  });

  it("does not match inside a URL", () => {
    assert.deepEqual(
      findBareGithubRefs("see https://example.com/page#482", "acme/demo"),
      [],
    );
  });

  it("does not match a ref glued to a preceding path token", () => {
    assert.deepEqual(findBareGithubRefs("see src/app.ts#482", "acme/demo"), []);
  });
});

describe("findGithubRefs", () => {
  it("prefers the qualified match over a bare one at the same spot", () => {
    const hits = findGithubRefs("see other/repo#9 here", "acme/demo");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].owner, "other");
    assert.equal(hits[0].repo, "repo");
  });

  it("combines a qualified ref and an unrelated bare ref", () => {
    const hits = findGithubRefs("other/repo#9 and also #482", "acme/demo");
    assert.equal(hits.length, 2);
    assert.equal(hits[0].repo, "repo");
    assert.equal(hits[1].owner, "acme");
    assert.equal(hits[1].number, 482);
  });
});

describe("githubRefUrl", () => {
  it("links to the issues path (GitHub redirects PRs there)", () => {
    assert.equal(
      githubRefUrl({ owner: "acme", repo: "demo", number: 482 }),
      "https://github.com/acme/demo/issues/482",
    );
  });
});
