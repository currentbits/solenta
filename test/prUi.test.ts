/**
 * PR UI pure decisions (sidebar badge + agent PR prompt).
 * Run: node --experimental-strip-types --test test/prUi.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPrPrompt,
  isPrTooLargeMessage,
  PR_TOO_LARGE_PREFIX,
  sidebarPrBadge,
  splitPrPrompt,
} from "../src/prUi.ts";

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

describe("isPrTooLargeMessage (#402)", () => {
  it("matches the main-process refusal by its stable prefix", () => {
    assert.equal(
      isPrTooLargeMessage(
        "PR too large: 1532 lines changed vs main across 12 files (cap 400). Split the branch into smaller stacked PRs, or create the PR anyway.",
      ),
      true,
    );
  });

  it("does not match unrelated errors", () => {
    assert.equal(isPrTooLargeMessage("gh pr create failed: boom"), false);
    assert.equal(isPrTooLargeMessage("PR too large"), false, "needs the colon");
    assert.equal(isPrTooLargeMessage(""), false);
  });

  it("prefix constant stays aligned with the main process", () => {
    // electron/worktrees.js throws `${PR_TOO_LARGE_PREFIX}: ...`.
    assert.equal(PR_TOO_LARGE_PREFIX, "PR too large");
  });
});

describe("splitPrPrompt (#402)", () => {
  it("instructs a stacked-PR split under the cap, with attribution", () => {
    const prompt = splitPrPrompt("Claude Code");
    assert.ok(prompt.includes("stack of smaller"), "split into a stack");
    assert.ok(prompt.includes("400"), "names the default cap");
    assert.ok(prompt.includes("--base <previous-slice-branch>"), "stacked bases");
    assert.ok(
      prompt.includes('"- PR created by the Claude Code agent"'),
      "must carry the exact attribution bullet",
    );
  });
});
