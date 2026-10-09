/**
 * #1531: opt-in stripping of agent Co-authored-by trailers from squash merges.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isAgentIdentity,
  stripAgentCoauthors,
  strippedSquashBodyArgs,
} = require("../coauthors.js");
const { squashBodyArgs } = require("../worktrees.js");

describe("stripAgentCoauthors", () => {
  it("drops agent trailers, keeps humans, collapses trailing blanks", () => {
    const msg = [
      "Fix the thing",
      "",
      "Longer body.",
      "",
      "Co-authored-by: Ada Lovelace <ada@example.com>",
      "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
      "co-authored-by: Cursor Agent <cursoragent@cursor.com>",
      "Co-authored-by: Codex <codex@openai.com>",
      "Co-authored-by: gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>",
      "",
      "",
    ].join("\n");
    assert.equal(
      stripAgentCoauthors(msg),
      "Fix the thing\n\nLonger body.\n\nCo-authored-by: Ada Lovelace <ada@example.com>",
    );
  });

  it("removes the trailer block's blank separator when only agents were there", () => {
    assert.equal(
      stripAgentCoauthors("Body\n\nCo-authored-by: Claude <noreply@anthropic.com>\n"),
      "Body",
    );
  });

  it("leaves a message without agent trailers untouched", () => {
    const msg = "Title\n\nCo-authored-by: Bob <bob@corp.dev>";
    assert.equal(stripAgentCoauthors(msg), msg);
    assert.equal(stripAgentCoauthors(""), "");
  });

  it("tells agent identities from humans who share a name", () => {
    assert.equal(isAgentIdentity("Claude Monet", "claude@monet.fr"), false);
    assert.equal(isAgentIdentity("Ada", "ada@anthropic.com"), false);
    assert.equal(isAgentIdentity("Claude", "noreply@anthropic.com"), true);
    assert.equal(isAgentIdentity("Grok", "grok@x.ai"), true);
    assert.equal(isAgentIdentity("Copilot", "175728472+Copilot@users.noreply.github.com"), true);
  });
});

describe("strippedSquashBodyArgs", () => {
  const ghWith = (commits) => async () => ({
    ok: true,
    stdout: JSON.stringify({ commits }),
  });

  it("rebuilds the commit-list body with agents stripped per commit", async () => {
    const args = await strippedSquashBodyArgs(
      "/x",
      7,
      ghWith([
        {
          messageHeadline: "one",
          messageBody: "Co-Authored-By: Claude <noreply@anthropic.com>",
        },
        {
          messageHeadline: "two",
          messageBody: "why\n\nCo-authored-by: Ada <ada@example.com>",
        },
      ]),
    );
    assert.deepEqual(args, [
      "--body",
      "* one\n\n* two\n\nwhy\n\nCo-authored-by: Ada <ada@example.com>",
    ]);
  });

  it("returns [] when nothing would change or gh fails", async () => {
    assert.deepEqual(
      await strippedSquashBodyArgs("/x", 7, ghWith([{ messageHeadline: "a", messageBody: "b" }])),
      [],
    );
    assert.deepEqual(
      await strippedSquashBodyArgs("/x", 7, async () => ({ ok: false, stdout: "" })),
      [],
    );
  });
});

describe("squashBodyArgs", () => {
  const store = (on) => ({ getSettings: () => ({ stripAgentCoauthors: on }) });

  it("is a no-op unless the setting is on and the method is squash", async () => {
    // Off / non-squash never reach gh, so no stub is needed.
    assert.deepEqual(await squashBodyArgs(store(false), "/x", 1, {}), []);
    assert.deepEqual(await squashBodyArgs(store(true), "/x", 1, { method: "merge" }), []);
    assert.deepEqual(await squashBodyArgs(null, "/x", 1, {}), []);
  });
});

describe("stripAgentCoauthors setting", () => {
  const { normalizeSettings } = require("../store-normalize.js");

  it("defaults off; only an explicit true turns it on", () => {
    assert.equal(normalizeSettings({}).stripAgentCoauthors, false);
    assert.equal(normalizeSettings({ stripAgentCoauthors: "yes" }).stripAgentCoauthors, false);
    assert.equal(normalizeSettings({ stripAgentCoauthors: true }).stripAgentCoauthors, true);
  });
});
