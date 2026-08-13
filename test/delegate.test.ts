/**
 * parseDelegate fixtures: first-token `@provider` is a delegation, everything
 * else falls through to a normal send.
 *
 * Run: node --import=./test/support/render.mjs --test test/delegate.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDelegate } from "../src/delegate";

const INSTALLED = ["claude", "codex", "grok", "kimi", "opencode"];

describe("parseDelegate", () => {
  it("parses a first-token provider id into provider + task", () => {
    assert.deepEqual(parseDelegate("@grok fix the flaky test", INSTALLED), {
      provider: "grok",
      task: "fix the flaky test",
    });
  });

  it("keeps multi-line tasks intact", () => {
    assert.deepEqual(parseDelegate("@codex line one\nline two", INSTALLED), {
      provider: "codex",
      task: "line one\nline two",
    });
  });

  it("returns null when the first token is not an installed provider", () => {
    assert.equal(parseDelegate("@file.ts summarize this", INSTALLED), null);
    assert.equal(parseDelegate("@grok-4 fix this", INSTALLED), null);
    // Installed list, not the full registry: an unavailable id does not parse.
    assert.equal(parseDelegate("@grok hi", ["claude"]), null);
  });

  it("returns null when @ is not the first token", () => {
    assert.equal(parseDelegate("please @grok fix this", INSTALLED), null);
  });

  it("returns null for a bare provider token (no task)", () => {
    assert.equal(parseDelegate("@grok", INSTALLED), null);
    assert.equal(parseDelegate("@grok   ", INSTALLED), null);
  });

  it("returns null for empty and @-less prompts", () => {
    assert.equal(parseDelegate("", INSTALLED), null);
    assert.equal(parseDelegate("just a prompt", INSTALLED), null);
    assert.equal(parseDelegate("@", INSTALLED), null);
  });
});
