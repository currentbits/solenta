/**
 * `/btw` parse (issue #471).
 *
 * Run: node --experimental-strip-types --test test/btw.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asBtwPrompt, parseBtwCommand } from "../src/btw.ts";

describe("parseBtwCommand", () => {
  it("returns the question after /btw", () => {
    assert.equal(parseBtwCommand("/btw where is createThread"), "where is createThread");
    assert.equal(
      parseBtwCommand("  /btw   which file owns that  "),
      "which file owns that",
    );
  });

  it("keeps a multi-line tail", () => {
    assert.equal(
      parseBtwCommand("/btw first\nsecond"),
      "first\nsecond",
    );
  });

  it("returns null for a bare /btw and for anything else", () => {
    assert.equal(parseBtwCommand("/btw"), null);
    assert.equal(parseBtwCommand("/btw   "), null);
    assert.equal(parseBtwCommand("/handoff do it"), null);
    assert.equal(parseBtwCommand("btw where"), null);
    assert.equal(parseBtwCommand("/BTW where"), null);
  });
});

describe("asBtwPrompt", () => {
  it("prefixes a plain draft", () => {
    assert.equal(asBtwPrompt("where is createThread"), "/btw where is createThread");
  });

  it("leaves an already-/btw draft alone", () => {
    assert.equal(asBtwPrompt("/btw where is it"), "/btw where is it");
  });

  it("returns null when there is nothing to ask", () => {
    assert.equal(asBtwPrompt(""), null);
    assert.equal(asBtwPrompt("   "), null);
    assert.equal(asBtwPrompt("/btw"), null);
    assert.equal(asBtwPrompt("/btw   "), null);
  });
});
