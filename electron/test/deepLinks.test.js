const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDeepLink,
  deepLinkFromArgv,
  resolveProjectRef,
  MAX_NEW_PROMPT_LENGTH,
} = require("../deepLinks.js");

const ID = "9f837e97-3bea-4df8-86bf-d6ddd40fadbf";

describe("solenta:// deep links", () => {
  it("routes thread and project links", () => {
    assert.deepEqual(parseDeepLink(`solenta://thread/${ID}`), { kind: "thread", id: ID });
    assert.deepEqual(parseDeepLink(`solenta://project/${ID}/`), { kind: "project", id: ID });
  });

  it("rejects other schemes, kinds and malformed ids", () => {
    for (const url of [
      `https://thread/${ID}`,
      `solenta://settings/${ID}`,
      "solenta://thread/",
      "solenta://thread/a/b",
      "solenta://thread/%2e%2e",
      "not a url",
      undefined,
    ]) {
      assert.equal(parseDeepLink(url), null, String(url));
    }
  });

  it("finds the link among launch arguments", () => {
    assert.deepEqual(
      deepLinkFromArgv(["/opt/Solenta/solenta", "--no-sandbox", `solenta://thread/${ID}`]),
      { kind: "thread", id: ID },
    );
    assert.equal(deepLinkFromArgv(["/opt/Solenta/solenta"]), null);
  });

  it("parses a new-draft link: prompt decoding, cap, missing prompt", () => {
    assert.deepEqual(
      parseDeepLink("solenta://new?prompt=fix%20the%20bug&project=coder"),
      { kind: "new", prompt: "fix the bug", project: "coder" },
    );
    // No project param at all: falls back to the selected project later.
    assert.deepEqual(parseDeepLink("solenta://new?prompt=hi"), {
      kind: "new",
      prompt: "hi",
      project: null,
    });
    // '+' in a query string decodes to a space, same as %20.
    assert.deepEqual(parseDeepLink("solenta://new?prompt=fix+the+bug"), {
      kind: "new",
      prompt: "fix the bug",
      project: null,
    });
    // A link is not a run trigger: an oversized prompt is capped, not sent.
    const huge = "x".repeat(MAX_NEW_PROMPT_LENGTH + 500);
    const capped = parseDeepLink(
      `solenta://new?prompt=${encodeURIComponent(huge)}`,
    );
    assert.equal(capped.prompt.length, MAX_NEW_PROMPT_LENGTH);
    // Missing or empty prompt: not a valid link.
    assert.equal(parseDeepLink("solenta://new?project=coder"), null);
    assert.equal(parseDeepLink("solenta://new?prompt="), null);
    assert.equal(parseDeepLink("solenta://new"), null);
  });

  it("resolveProjectRef matches id, path, then name; unknown falls back to null", () => {
    const projects = [
      { id: "p1", path: "/Users/willem/code/coder", name: "coder" },
      { id: "p2", path: "/Users/willem/code/other/", name: "other" },
    ];
    assert.equal(resolveProjectRef("p1", projects), "p1");
    assert.equal(resolveProjectRef("/Users/willem/code/coder", projects), "p1");
    // Trailing slash differences between the link and the stored path.
    assert.equal(resolveProjectRef("/Users/willem/code/other", projects), "p2");
    assert.equal(resolveProjectRef("other", projects), "p2");
    assert.equal(resolveProjectRef("unknown-project", projects), null);
    assert.equal(resolveProjectRef(null, projects), null);
    assert.equal(resolveProjectRef("p1", undefined), null);
  });
});
