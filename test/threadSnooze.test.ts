/**
 * Round 44 pure snooze / pin / presets.
 * Run: node --experimental-strip-types --test test/threadSnooze.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareSnoozedWakeSoonest,
  effectiveSnoozed,
  formatSnoozeWakeLabel,
  resolveSnoozeUntil,
  snoozePresetUntil,
} from "../src/threadSnooze.ts";
import { effectiveSettled } from "../src/threadSettle.ts";
import {
  partitionSidebar,
  defaultSettleOpts,
} from "../src/sidebarGroups.ts";
import type { ThreadInfo } from "../src/shared/ipc.ts";

const NOW = 1_700_000_000_000; // fixed epoch

function t(
  over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">,
): ThreadInfo {
  return {
    projectId: "p1",
    title: over.id,
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
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: NOW,
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

describe("effectiveSnoozed", () => {
  it("table: future until → snoozed", () => {
    assert.equal(
      effectiveSnoozed(
        t({ id: "a", snoozedUntil: NOW + 1000, snoozedAt: NOW - 100 }),
        NOW,
      ),
      true,
    );
  });

  it("table: past until → not snoozed", () => {
    assert.equal(
      effectiveSnoozed(
        t({ id: "a", snoozedUntil: NOW - 1, snoozedAt: NOW - 1000 }),
        NOW,
      ),
      false,
    );
  });

  it("table: until === now is already awake (exact boundary)", () => {
    // Contract: until must be strictly in the future; effectiveSnoozed uses <=.
    assert.equal(
      effectiveSnoozed(
        t({ id: "a", snoozedUntil: NOW, snoozedAt: NOW - 1000 }),
        NOW,
      ),
      false,
    );
  });

  it("table: raised-hand fresh failure wakes", () => {
    // Failed AFTER snooze was set → raised hand.
    assert.equal(
      effectiveSnoozed(
        t({
          id: "a",
          status: "failed",
          snoozedUntil: NOW + 10_000,
          snoozedAt: NOW - 5000,
          updatedAt: NOW - 1000, // after snoozedAt
        }),
        NOW,
      ),
      false,
    );
  });

  it("table: raised-hand fresh completion wakes", () => {
    assert.equal(
      effectiveSnoozed(
        t({
          id: "a",
          status: "done",
          snoozedUntil: NOW + 10_000,
          snoozedAt: NOW - 5000,
          updatedAt: NOW - 100, // after snoozedAt
        }),
        NOW,
      ),
      false,
    );
  });

  it("table: snoozed-while-already-failed stays snoozed", () => {
    // Failed BEFORE snooze ("I saw it, not now") — updatedAt < snoozedAt.
    assert.equal(
      effectiveSnoozed(
        t({
          id: "a",
          status: "failed",
          snoozedUntil: NOW + 10_000,
          snoozedAt: NOW - 100,
          updatedAt: NOW - 5000, // before snoozedAt
        }),
        NOW,
      ),
      true,
    );
  });

  it("table: NaN/malformed never snoozed", () => {
    assert.equal(
      effectiveSnoozed(
        t({ id: "a", snoozedUntil: Number.NaN, snoozedAt: NOW }),
        NOW,
      ),
      false,
    );
    assert.equal(
      effectiveSnoozed(
        t({ id: "a", snoozedUntil: NOW + 1000, snoozedAt: NOW }),
        Number.NaN,
      ),
      false,
    );
    assert.equal(
      effectiveSnoozed(t({ id: "a", snoozedUntil: null }), NOW),
      false,
    );
  });
});

describe("effectiveSettled pin blocker (round 44)", () => {
  it("pinned never auto-settles even when PR is MERGED", () => {
    assert.equal(
      effectiveSettled(
        t({
          id: "p",
          status: "done",
          prState: "MERGED",
          pinnedAt: NOW - 100,
        }),
        defaultSettleOpts(NOW),
      ),
      false,
    );
  });
});

describe("partitionSidebar pin+snooze precedence", () => {
  const opts = defaultSettleOpts(NOW);

  it("pinned + settled-override → pinned wins (mutual exclusion path leaves pin)", () => {
    // A race can leave both; partition: pin beats settle when not snoozed.
    // (Honest setPinned clears settled; this is the residual-race case.)
    // After mutual exclusion, pin has settledOverride null. If both set:
    const row = t({
      id: "both",
      projectId: "p1",
      pinnedAt: NOW - 10,
      settledOverride: "settled",
      settledAt: NOW - 5,
      status: "done",
    });
    // pin blocks effectiveSettled; not snoozed → pinned shelf
    const { pinned, settled, attentionThreads } = partitionSidebar([row], opts);
    assert.deepEqual(pinned.map((x) => x.id), ["both"]);
    assert.equal(settled.length, 0);
    assert.equal(attentionThreads.length, 0);
  });

  it("snoozed + pinned → snooze shelf (suspends pin)", () => {
    const row = t({
      id: "sp",
      projectId: "p1",
      pinnedAt: NOW - 100,
      snoozedUntil: NOW + 50_000,
      snoozedAt: NOW - 10,
    });
    const { pinned, snoozed, attentionThreads } = partitionSidebar([row], opts);
    assert.deepEqual(snoozed.map((x) => x.id), ["sp"]);
    assert.equal(pinned.length, 0);
    assert.equal(attentionThreads.length, 0);
  });

  it("snoozed wakes (timer) → attention", () => {
    const row = t({
      id: "woke",
      projectId: "p1",
      snoozedUntil: NOW - 1,
      snoozedAt: NOW - 10_000,
      status: "idle",
    });
    const { snoozed, attentionThreads } = partitionSidebar([row], opts);
    assert.equal(snoozed.length, 0);
    assert.deepEqual(attentionThreads.map((x) => x.id), ["woke"]);
  });

  it("pinned sorted oldest-first; snoozed wake-soonest first", () => {
    const threads = [
      t({ id: "p-new", projectId: "p1", pinnedAt: NOW - 10 }),
      t({ id: "p-old", projectId: "p2", pinnedAt: NOW - 1000 }),
      t({
        id: "s-late",
        projectId: "p1",
        snoozedUntil: NOW + 9000,
        snoozedAt: NOW,
      }),
      t({
        id: "s-soon",
        projectId: "p2",
        snoozedUntil: NOW + 1000,
        snoozedAt: NOW,
      }),
    ];
    const { pinned, snoozed } = partitionSidebar(threads, opts);
    assert.deepEqual(
      pinned.map((x) => x.id),
      ["p-old", "p-new"],
    );
    assert.deepEqual(
      snoozed.map((x) => x.id),
      ["s-soon", "s-late"],
    );
  });
});

describe("snoozePresetUntil (local calendar, injectable now)", () => {
  it("This evening is today 18:00 when before 18:00", () => {
    // 2024-06-15 10:00 local
    const now = new Date(2024, 5, 15, 10, 0, 0, 0).getTime();
    const until = snoozePresetUntil("this-evening", now);
    const d = new Date(until);
    assert.equal(d.getFullYear(), 2024);
    assert.equal(d.getMonth(), 5);
    assert.equal(d.getDate(), 15);
    assert.equal(d.getHours(), 18);
    assert.equal(d.getMinutes(), 0);
  });

  it("This evening rolls to tomorrow when past 18:00", () => {
    const now = new Date(2024, 5, 15, 19, 30, 0, 0).getTime();
    const until = snoozePresetUntil("this-evening", now);
    const d = new Date(until);
    assert.equal(d.getDate(), 16);
    assert.equal(d.getHours(), 18);
  });

  it("This evening at exact 18:00:00.000 rolls to tomorrow (<=)", () => {
    // Pins the `<=` boundary: a bare `<` would leave until === now (not future).
    const now = new Date(2024, 5, 15, 18, 0, 0, 0).getTime();
    const until = snoozePresetUntil("this-evening", now);
    const d = new Date(until);
    assert.equal(d.getFullYear(), 2024);
    assert.equal(d.getMonth(), 5);
    assert.equal(d.getDate(), 16, "exact 18:00 must roll to tomorrow");
    assert.equal(d.getHours(), 18);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
    assert.ok(until > now, "must be strictly after the frozen now");
  });

  it("Tomorrow morning is always calendar-tomorrow 09:00 (label wins)", () => {
    // Even at 07:00, "Tomorrow morning" is NOT today's 09:00 (a 2h snooze).
    const morning = new Date(2024, 5, 15, 7, 0, 0, 0).getTime();
    const d1 = new Date(snoozePresetUntil("tomorrow-morning", morning));
    assert.equal(d1.getDate(), 16, "07:00 → tomorrow 09:00, not today");
    assert.equal(d1.getHours(), 9);
    assert.equal(d1.getMinutes(), 0);

    const afternoon = new Date(2024, 5, 15, 14, 0, 0, 0).getTime();
    const d2 = new Date(snoozePresetUntil("tomorrow-morning", afternoon));
    assert.equal(d2.getDate(), 16);
    assert.equal(d2.getHours(), 9);
  });

  it("In 3 days is now + 3×24h elapsed (not three midnights)", () => {
    const now = new Date(2024, 5, 15, 12, 30, 0, 0).getTime();
    assert.equal(
      snoozePresetUntil("in-3-days", now),
      now + 3 * 24 * 60 * 60 * 1000,
    );
  });
});

describe("wake label = sort consistency", () => {
  it("formatSnoozeWakeLabel and compareSnoozedWakeSoonest use resolveSnoozeUntil", () => {
    const a = t({
      id: "a",
      snoozedUntil: NOW + 5000,
      snoozedAt: NOW,
    });
    const b = t({
      id: "b",
      snoozedUntil: NOW + 1000,
      snoozedAt: NOW,
    });
    assert.equal(resolveSnoozeUntil(a), NOW + 5000);
    assert.ok(compareSnoozedWakeSoonest(b, a) < 0, "sooner first");
  });

  it("pins the RENDERED wake string for a known until (not just the prefix)", () => {
    // 2024-06-15 10:00 local, wake today 18:00 → "until 6pm".
    // A label one hour off (e.g. "until 5pm") must fail this assert.
    const now = new Date(2024, 5, 15, 10, 0, 0, 0).getTime();
    const until = new Date(2024, 5, 15, 18, 0, 0, 0).getTime();
    const label = formatSnoozeWakeLabel(
      t({ id: "a", snoozedUntil: until, snoozedAt: now }),
      now,
    );
    assert.equal(label, "until 6pm");

    // Tomorrow morning wake from the afternoon → "until tomorrow 9am".
    const afternoon = new Date(2024, 5, 15, 14, 0, 0, 0).getTime();
    const tomorrow9 = new Date(2024, 5, 16, 9, 0, 0, 0).getTime();
    assert.equal(
      formatSnoozeWakeLabel(
        t({ id: "b", snoozedUntil: tomorrow9, snoozedAt: afternoon }),
        afternoon,
      ),
      "until tomorrow 9am",
    );
  });
});
