/**
 * Pure helpers for the Environment tab Verification card (issue #296).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PostMergeVerify, VerifyResult } from "../src/shared/ipc.ts";
import {
  formatPostMergeLine,
  formatPostMergeRemaining,
  formatVerifyAge,
  formatVerifyDuration,
  formatVerifyExit,
  formatVerifySha,
  formatVerifySummary,
  verifyLogStartsCollapsed,
  verifyNowDisabled,
} from "../src/verifyCard.ts";

const NOW = 1_700_000_000_000;

function result(over: Partial<VerifyResult> = {}): VerifyResult {
  return {
    runId: "manual",
    command: "npm test",
    ok: true,
    exitCode: 0,
    timedOut: false,
    log: "ok",
    sha: "a1b2c3d4e5f6",
    durationMs: 4200,
    at: NOW - 3 * 60_000,
    attempt: 1,
    ...over,
  };
}

describe("formatVerifyDuration", () => {
  it("uses the same labels as formatElapsed", () => {
    assert.equal(formatVerifyDuration(0), "0s");
    assert.equal(formatVerifyDuration(4200), "4s");
    assert.equal(formatVerifyDuration(65_000), "1m");
    assert.equal(formatVerifyDuration(3_600_000 + 4 * 60_000), "1h 4m");
  });

  it("clamps negative elapsed to zero", () => {
    assert.equal(formatVerifyDuration(-12), "0s");
  });
});

describe("formatVerifyAge", () => {
  it("keeps 'now' and suffixes older spans so they do not look like a duration", () => {
    assert.equal(formatVerifyAge(NOW, NOW), "now");
    assert.equal(formatVerifyAge(NOW - 3 * 60_000, NOW), "3m ago");
    assert.equal(formatVerifyAge(NOW - 2 * 3_600_000, NOW), "2h ago");
  });
});

describe("formatVerifyExit", () => {
  it("prefers timed out over a missing exit code", () => {
    assert.equal(formatVerifyExit(result({ timedOut: true, exitCode: null })), "timed out");
    assert.equal(formatVerifyExit(result({ timedOut: false, exitCode: null })), "timed out");
    assert.equal(formatVerifyExit(result({ exitCode: 1 })), "exit 1");
    assert.equal(formatVerifyExit(result({ exitCode: 0 })), "exit 0");
  });
});

describe("formatVerifySha", () => {
  it("shortens a full sha and leaves a short one alone", () => {
    assert.equal(formatVerifySha("a1b2c3d4e5f67890"), "a1b2c3d");
    assert.equal(formatVerifySha("a1b2c3d"), "a1b2c3d");
    assert.equal(formatVerifySha(null), null);
  });
});

describe("formatVerifySummary", () => {
  it("joins outcome, command, exit, duration, age, and short sha", () => {
    assert.equal(
      formatVerifySummary(result(), NOW),
      "Passed · npm test · exit 0 · 4s · 3m ago · a1b2c3d",
    );
  });

  it("drops the sha when the run was not pinned to a checkpoint", () => {
    assert.equal(
      formatVerifySummary(
        result({ ok: false, exitCode: 1, sha: null, durationMs: 12_000, at: NOW }),
        NOW,
      ),
      "Failed · npm test · exit 1 · 12s · now",
    );
  });

  it("labels a killed run as timed out", () => {
    assert.equal(
      formatVerifySummary(
        result({
          ok: false,
          timedOut: true,
          exitCode: null,
          sha: null,
          durationMs: 10 * 60_000,
          at: NOW,
        }),
        NOW,
      ),
      "Failed · npm test · timed out · 10m · now",
    );
  });
});

describe("verifyLogStartsCollapsed", () => {
  it("collapses a pass and expands a failure", () => {
    assert.equal(verifyLogStartsCollapsed(result({ ok: true })), true);
    assert.equal(verifyLogStartsCollapsed(result({ ok: false })), false);
  });
});

describe("verifyNowDisabled", () => {
  it("is disabled without a command, while a run is active, or in flight", () => {
    assert.equal(
      verifyNowDisabled({ command: "npm test", runActive: false, verifying: false }),
      false,
    );
    assert.equal(
      verifyNowDisabled({ command: null, runActive: false, verifying: false }),
      true,
    );
    assert.equal(
      verifyNowDisabled({ command: "   ", runActive: false, verifying: false }),
      true,
    );
    assert.equal(
      verifyNowDisabled({ command: "npm test", runActive: true, verifying: false }),
      true,
    );
    assert.equal(
      verifyNowDisabled({ command: "npm test", runActive: false, verifying: true }),
      true,
    );
  });
});

describe("formatPostMergeRemaining", () => {
  it("labels the delay in minutes, hours, or days", () => {
    assert.equal(formatPostMergeRemaining(NOW + 30_000, NOW), "under a minute");
    assert.equal(formatPostMergeRemaining(NOW + 3 * 60_000, NOW), "3m");
    assert.equal(formatPostMergeRemaining(NOW + 5 * 3_600_000, NOW), "5h");
    assert.equal(formatPostMergeRemaining(NOW + 2 * 86_400_000, NOW), "2d");
  });
});

describe("formatPostMergeLine", () => {
  function check(over: Partial<PostMergeVerify> = {}): PostMergeVerify {
    return {
      dueAt: NOW + 3_600_000,
      status: "scheduled",
      at: null,
      result: null,
      fixThreadId: null,
      ...over,
    };
  }

  it("is silent when no check is armed", () => {
    assert.equal(formatPostMergeLine(null), null);
    assert.equal(formatPostMergeLine(undefined), null);
  });

  it("names the remaining delay, a pass, and a failed reopen", () => {
    assert.equal(
      formatPostMergeLine(check(), NOW),
      "Post-merge check in 1h",
    );
    assert.equal(formatPostMergeLine(check({ status: "running" })), "Post-merge check running…");
    assert.equal(
      formatPostMergeLine(check({ status: "passed", at: NOW - 3 * 60_000 }), NOW),
      "Post-merge check passed · 3m ago",
    );
    assert.equal(
      formatPostMergeLine(
        check({ status: "failed", at: NOW, fixThreadId: "fix-1" }),
        NOW,
      ),
      "Post-merge check failed · fix thread started · now",
    );
    assert.equal(
      formatPostMergeLine(
        check({ status: "skipped", skipReason: "remote project" }),
      ),
      "Post-merge check skipped · remote project",
    );
  });
});
