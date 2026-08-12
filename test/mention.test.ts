import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyMention, getMentionQuery } from "../src/mention.ts";

describe("getMentionQuery", () => {
  it("a bare @ at the caret opens with an empty query", () => {
    assert.deepEqual(getMentionQuery("@", 1), { start: 0, query: "" });
    assert.deepEqual(getMentionQuery("look at @", 9), { start: 8, query: "" });
  });

  it("captures the token between @ and caret", () => {
    assert.deepEqual(getMentionQuery("open @src/com", 13), {
      start: 5,
      query: "src/com",
    });
  });

  it("works when the caret is mid-text", () => {
    // Caret sits right after "@ab"; trailing text is not part of the token.
    assert.deepEqual(getMentionQuery("@ab and more", 3), { start: 0, query: "ab" });
  });

  it("a newline before @ still starts a token", () => {
    assert.deepEqual(getMentionQuery("line one\n@re", 12), {
      start: 9,
      query: "re",
    });
  });

  it("email-shaped a@b never opens", () => {
    assert.equal(getMentionQuery("mail a@b", 8), null);
  });

  it("@@ never opens", () => {
    assert.equal(getMentionQuery("@@", 2), null);
  });

  it("whitespace after the token closes it", () => {
    assert.equal(getMentionQuery("@src done", 9), null);
  });

  it("no @ at all", () => {
    assert.equal(getMentionQuery("plain text", 10), null);
  });
});

describe("applyMention", () => {
  it("replaces the token with @path plus a trailing space", () => {
    const out = applyMention("open @sr please", 8, 5, "src/App.tsx");
    assert.equal(out.text, "open @src/App.tsx  please");
    assert.equal(out.caret, "open @src/App.tsx ".length);
  });

  it("replaces at end of text", () => {
    const out = applyMention("@re", 3, 0, "README.md");
    assert.equal(out.text, "@README.md ");
    assert.equal(out.caret, 11);
  });
});
