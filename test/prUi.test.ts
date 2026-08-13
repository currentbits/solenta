/**
 * PR UI pure decisions (sidebar badge + agent PR prompt).
 * Run: node --experimental-strip-types --test test/prUi.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPrPrompt, sidebarPrBadge } from "../src/prUi.ts";

describe("sidebarPrBadge", () => {
  it("returns null when there is no PR number", () => {
    assert.equal(
      sidebarPrBadge({ prNumber: null, prUrl: "https://example.com" }),
      null,
    );
  });

  it("labels the number and links when prUrl is set", () => {
    const badge = sidebarPrBadge({
      prNumber: 842,
      prUrl: "https://github.com/pingdotgg/t3code/pull/842",
    });
    assert.deepEqual(badge, {
      label: "PR #842",
      href: "https://github.com/pingdotgg/t3code/pull/842",
    });
  });

  it("keeps the label but drops the href when prUrl is missing", () => {
    assert.deepEqual(sidebarPrBadge({ prNumber: 7, prUrl: null }), {
      label: "PR #7",
      href: null,
    });
    assert.deepEqual(sidebarPrBadge({ prNumber: 7, prUrl: "   " }), {
      label: "PR #7",
      href: null,
    });
  });
});

describe("createPrPrompt", () => {
  it("names the agent in the exact attribution bullet", () => {
    const prompt = createPrPrompt("Claude Code");
    assert.ok(
      prompt.includes('"- PR created by the Claude Code agent"'),
      "must carry the exact attribution bullet",
    );
    assert.ok(prompt.includes("pull request"));
    assert.ok(prompt.includes("gh pr create"));
  });
});
