/**
 * buildActivity: ordering, cap, exclusions, no fabricated times.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIVITY_LIMIT,
  buildActivity,
  groupActivityByDay,
} from "../src/activity.ts";
import type { ActivityWorkLogEntry, ActivityThread } from "../src/activity.ts";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function thread(
  over: Partial<ActivityThread> & Pick<ActivityThread, "id">,
): ActivityThread {
  return {
    projectId: "p1",
    title: over.title ?? over.id,
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    runStartedAt: null,
    archived: false,
    ...over,
  };
}

describe("buildActivity", () => {
  it("emits created from createdAt and sorts newest first", () => {
    const items = buildActivity(
      [
        thread({ id: "old", title: "older", createdAt: NOW - 5000 }),
        thread({ id: "new", title: "newer", createdAt: NOW }),
      ],
      {},
      NOW,
    );
    assert.deepEqual(
      items.map((i) => [i.threadId, i.kind, i.at, i.threadTitle]),
      [
        ["new", "created", NOW, "newer"],
        ["old", "created", NOW - 5000, "older"],
      ],
    );
  });

  it("emits started from runStartedAt only when it is a real number", () => {
    const items = buildActivity(
      [
        thread({
          id: "w",
          status: "working",
          createdAt: NOW - 1000,
          runStartedAt: NOW - 200,
        }),
        thread({ id: "idle", runStartedAt: null }),
      ],
      {},
      NOW,
    );
    const started = items.filter((i) => i.kind === "started");
    assert.equal(started.length, 1);
    assert.equal(started[0].threadId, "w");
    assert.equal(started[0].at, NOW - 200);
    assert.ok(!items.some((i) => i.threadId === "idle" && i.kind === "started"));
  });

  it("derives done/failed from status + updatedAt when work log has no ended times", () => {
    const items = buildActivity(
      [
        thread({
          id: "d",
          status: "done",
          createdAt: NOW - 8000,
          updatedAt: NOW - 100,
        }),
        thread({
          id: "f",
          status: "failed",
          createdAt: NOW - 9000,
          updatedAt: NOW - 50,
        }),
        thread({ id: "idle", status: "idle", updatedAt: NOW }),
      ],
      {
        d: [
          {
            id: "w1",
            runId: "r1",
            label: "Starting agent",
            done: true,
            timestamp: NOW - 400,
          },
        ],
      },
      NOW,
    );
    const dDone = items.find((i) => i.threadId === "d" && i.kind === "done");
    const fFail = items.find((i) => i.threadId === "f" && i.kind === "failed");
    assert.equal(dDone?.at, NOW - 100);
    assert.equal(fFail?.at, NOW - 50);
    assert.ok(!items.some((i) => i.threadId === "idle" && i.kind !== "created"));
    assert.ok(
      !items.some((i) => i.threadId === "d" && i.at === NOW - 400),
      "must not treat a step start timestamp as an end",
    );
  });

  it("uses work-log ended timestamps for done/failed when present", () => {
    const items = buildActivity(
      [
        thread({
          id: "d",
          status: "done",
          createdAt: NOW - 8000,
          updatedAt: NOW - 10,
        }),
      ],
      {
        d: [
          {
            id: "w-end",
            runId: "r1",
            label: "Agent responding",
            done: true,
            timestamp: NOW - 4000,
            endedAt: NOW - 300,
            kind: "done",
          },
        ],
      },
      NOW,
    );
    const dones = items.filter((i) => i.kind === "done");
    assert.equal(dones.length, 1);
    assert.equal(dones[0].at, NOW - 300);
    assert.ok(!dones.some((i) => i.at === NOW - 10));
  });

  it("emits failed from a work-log error entry with an ended time", () => {
    const items = buildActivity(
      [thread({ id: "f", status: "working", createdAt: NOW - 2000 })],
      {
        f: [
          {
            id: "err",
            runId: "r2",
            label: "Run error",
            done: true,
            timestamp: NOW - 500,
            finishedAt: NOW - 400,
          },
        ],
      },
      NOW,
    );
    const fails = items.filter((i) => i.kind === "failed");
    assert.equal(fails.length, 1);
    assert.equal(fails[0].at, NOW - 400);
  });

  it("omits done/failed when there is no real timestamp to use", () => {
    const items = buildActivity(
      [
        thread({
          id: "bad",
          status: "done",
          createdAt: NOW,
          updatedAt: Number.NaN,
        }),
      ],
      {
        bad: [
          {
            id: "w",
            label: "Step",
            done: true,
            timestamp: NOW - 1,
          } as ActivityWorkLogEntry,
        ],
      },
      NOW,
    );
    assert.ok(!items.some((i) => i.kind === "done" || i.kind === "failed"));
  });

  it("excludes archived threads entirely", () => {
    const items = buildActivity(
      [
        thread({
          id: "arch",
          archived: true,
          status: "done",
          createdAt: NOW,
          updatedAt: NOW,
          runStartedAt: NOW,
        }),
        thread({ id: "live", createdAt: NOW - 1 }),
      ],
      {},
      NOW,
    );
    assert.deepEqual(
      items.map((i) => i.threadId),
      ["live"],
    );
  });

  it("caps the feed at 100 newest items", () => {
    const threads = Array.from({ length: 80 }, (_, i) =>
      thread({
        id: `t${i}`,
        createdAt: NOW - 10_000 + i,
        status: i % 2 === 0 ? "done" : "idle",
        updatedAt: NOW + i,
      }),
    );
    const items = buildActivity(threads, {}, NOW);
    assert.equal(items.length, ACTIVITY_LIMIT);
    assert.ok(items[0].at >= items[items.length - 1].at);
    assert.ok(!items.some((i) => i.threadId === "t0" && i.kind === "created"));
  });
});

describe("groupActivityByDay", () => {
  it("labels Today, Yesterday, and a dated heading", () => {
    const items = buildActivity(
      [
        thread({ id: "today", createdAt: NOW }),
        thread({ id: "yest", createdAt: NOW - DAY_MS }),
        thread({ id: "old", createdAt: NOW - 10 * DAY_MS }),
      ],
      {},
      NOW,
    );
    const groups = groupActivityByDay(items, NOW);
    assert.equal(groups[0].label, "Today");
    assert.equal(groups[1].label, "Yesterday");
    assert.match(groups[2].label, /\d+ \w+ \d{4}/);
    assert.equal(groups[0].items[0].threadId, "today");
    assert.equal(groups[1].items[0].threadId, "yest");
    assert.equal(groups[2].items[0].threadId, "old");
  });
});
