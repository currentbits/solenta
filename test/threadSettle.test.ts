/**
 * effectiveSettled unit table (round 39). Every branch of the t3 resolution.
 * Run: node --experimental-strip-types --test test/threadSettle.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTO_SETTLE_AFTER_DAYS,
  effectiveSettled,
} from "../src/threadSettle.ts";
import type { ThreadInfo } from "../src/shared/ipc.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fixed clock so inactivity math is deterministic. Not Date.now(). */
const NOW = 1_700_000_000_000;

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: over.id ?? "t",
    projectId: "p1",
    title: over.title ?? "thread",
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  };
}

const opts = (over: { now?: number; autoSettleAfterDays?: number | null } = {}) => ({
  now: over.now ?? NOW,
  autoSettleAfterDays:
    over.autoSettleAfterDays === undefined
      ? AUTO_SETTLE_AFTER_DAYS
      : over.autoSettleAfterDays,
});

describe("AUTO_SETTLE_AFTER_DAYS", () => {
  it("is the single default knob (3 days)", () => {
    assert.equal(AUTO_SETTLE_AFTER_DAYS, 3);
  });
});

describe("effectiveSettled", () => {
  it("working is never settled, even with a settled override", () => {
    // Live work wins attention over any pin; backend refuses settle too.
    assert.equal(
      effectiveSettled(
        thread({
          id: "live",
          status: "working",
          settledOverride: "settled",
          prState: "MERGED",
          updatedAt: NOW - 30 * DAY_MS,
        }),
        opts(),
      ),
      false,
      "working-beats-override: a running thread must stay visible",
    );
  });

  it("settledOverride settled pins into the fold", () => {
    assert.equal(
      effectiveSettled(
        thread({ id: "pinned", status: "done", settledOverride: "settled" }),
        opts(),
      ),
      true,
      "manual settle must fold a fresh done thread",
    );
  });

  it("settledOverride active pins OUT even when PR is MERGED", () => {
    // Override beats PR so the user can keep closed work visible.
    assert.equal(
      effectiveSettled(
        thread({
          id: "keep-open",
          status: "done",
          settledOverride: "active",
          prState: "MERGED",
          updatedAt: NOW - 30 * DAY_MS,
        }),
        opts(),
      ),
      false,
      "override-beats-PR: active pin suppresses MERGED auto-settle",
    );
  });

  it("prState MERGED settles without an override", () => {
    assert.equal(
      effectiveSettled(
        thread({ id: "merged", status: "done", prState: "MERGED" }),
        opts(),
      ),
      true,
      "merged PR means the branch job is finished",
    );
  });

  it("prState CLOSED settles without an override", () => {
    assert.equal(
      effectiveSettled(
        thread({ id: "closed", status: "failed", prState: "CLOSED" }),
        opts(),
      ),
      true,
      "closed PR is also terminal work",
    );
  });

  it("prState OPEN blocks settle even after long inactivity", () => {
    assert.equal(
      effectiveSettled(
        thread({
          id: "open-pr",
          status: "done",
          prState: "OPEN",
          updatedAt: NOW - 90 * DAY_MS,
        }),
        opts(),
      ),
      false,
      "open-PR-blocks-inactivity: an open PR is unfinished business",
    );
  });

  it("freshly done is NOT settled (round 39 semantic change)", () => {
    assert.equal(
      effectiveSettled(
        thread({ id: "fresh-done", status: "done", updatedAt: NOW }),
        opts(),
      ),
      false,
      "a just-finished run stays visible until PR, inactivity, or manual settle",
    );
  });

  it("inactivity settles quiet threads after the window", () => {
    assert.equal(
      effectiveSettled(
        thread({
          id: "old-idle",
          status: "idle",
          updatedAt: NOW - (AUTO_SETTLE_AFTER_DAYS + 1) * DAY_MS,
        }),
        opts(),
      ),
      true,
      "idle threads auto-settle on silence (quiet is quiet)",
    );
    assert.equal(
      effectiveSettled(
        thread({
          id: "old-failed",
          status: "failed",
          updatedAt: NOW - (AUTO_SETTLE_AFTER_DAYS + 1) * DAY_MS,
        }),
        opts(),
      ),
      true,
      "failed threads also auto-settle on long silence",
    );
    assert.equal(
      effectiveSettled(
        thread({
          id: "old-done",
          status: "done",
          updatedAt: NOW - (AUTO_SETTLE_AFTER_DAYS + 1) * DAY_MS,
        }),
        opts(),
      ),
      true,
      "done threads settle via inactivity once the window elapses",
    );
  });

  it("inactivity does not settle when still inside the window", () => {
    assert.equal(
      effectiveSettled(
        thread({
          id: "recent",
          status: "done",
          // 1 day ago, default window is 3: still attention.
          updatedAt: NOW - 1 * DAY_MS,
        }),
        opts(),
      ),
      false,
      "inside the window the thread stays in the main list",
    );
  });

  it("autoSettleAfterDays null disables inactivity settle", () => {
    assert.equal(
      effectiveSettled(
        thread({
          id: "ancient",
          status: "done",
          updatedAt: NOW - 365 * DAY_MS,
        }),
        opts({ autoSettleAfterDays: null }),
      ),
      false,
      "null window means never auto-settle on silence alone",
    );
  });

  it("malformed timestamps never settle (NaN safety)", () => {
    assert.equal(
      effectiveSettled(
        thread({ id: "nan-updated", status: "done", updatedAt: Number.NaN }),
        opts(),
      ),
      false,
      "NaN updatedAt must stay active, not fall into a false comparison",
    );
    assert.equal(
      effectiveSettled(
        thread({
          id: "nan-now",
          status: "done",
          updatedAt: NOW - 30 * DAY_MS,
        }),
        opts({ now: Number.NaN }),
      ),
      false,
      "NaN now must stay active",
    );
    assert.equal(
      effectiveSettled(
        thread({
          id: "nan-days",
          status: "done",
          updatedAt: NOW - 30 * DAY_MS,
        }),
        opts({ autoSettleAfterDays: Number.NaN }),
      ),
      false,
      "NaN autoSettleAfterDays must stay active",
    );
  });

  it("override settled beats OPEN prState", () => {
    // Manual settle is deliberate; user can fold even with an open PR.
    assert.equal(
      effectiveSettled(
        thread({
          id: "manual-open",
          status: "done",
          settledOverride: "settled",
          prState: "OPEN",
        }),
        opts(),
      ),
      true,
      "override-beats-PR: settled pin folds an open-PR thread",
    );
  });
});
