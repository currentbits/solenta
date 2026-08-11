/**
 * effectiveSettled + resolveSettledTimestamp unit tables.
 * Run: node --experimental-strip-types --test test/threadSettle.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTO_SETTLE_AFTER_DAYS,
  compareSettledNewestFirst,
  effectiveSettled,
  resolveSettledTimestamp,
} from "../src/threadSettle.ts";
import type { ThreadInfo } from "../src/shared/ipc.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
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
    lastVisitedAt: null,
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
  });

  it("malformed timestamps never settle (NaN safety)", () => {
    assert.equal(
      effectiveSettled(
        thread({ id: "nan-updated", status: "done", updatedAt: Number.NaN }),
        opts(),
      ),
      false,
      "NaN updatedAt must stay active",
    );
  });
});

describe("resolveSettledTimestamp (sort=label consistency)", () => {
  it("prefers finite settledAt over updatedAt", () => {
    const t = thread({
      id: "pinned-time",
      settledAt: 1000,
      updatedAt: 9999,
    });
    assert.equal(
      resolveSettledTimestamp(t),
      1000,
      "settledAt is the wrap-up clock when present",
    );
  });

  it("falls back to updatedAt when settledAt is null", () => {
    const t = thread({ id: "no-pin", settledAt: null, updatedAt: 4242 });
    assert.equal(resolveSettledTimestamp(t), 4242);
  });

  it("ignores NaN settledAt so sort and label stay honest", () => {
    const t = thread({
      id: "bad-pin",
      settledAt: Number.NaN,
      updatedAt: 555,
    });
    assert.equal(
      resolveSettledTimestamp(t),
      555,
      "NaN settledAt must not invent a sort key",
    );
  });

  it("compareSettledNewestFirst uses the same resolver as the label", () => {
    // Mid-list interesting case is deliberately not index 0.
    const older = thread({
      id: "older",
      settledAt: 100,
      updatedAt: 9000,
    });
    const newer = thread({
      id: "newer",
      settledAt: 200,
      updatedAt: 50,
    });
    const noise = thread({
      id: "noise",
      settledAt: null,
      updatedAt: 150,
    });
    const sorted = [older, noise, newer].sort(compareSettledNewestFirst);
    assert.deepEqual(
      sorted.map((t) => t.id),
      ["newer", "noise", "older"],
      "newest-settled first must match resolveSettledTimestamp order",
    );
    assert.equal(
      resolveSettledTimestamp(sorted[0]!),
      200,
      "the label clock of the first row is the highest timestamp",
    );
  });
});
