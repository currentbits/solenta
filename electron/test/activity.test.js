/**
 * electron/activity.js: same semantics as src/activity.ts.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ACTIVITY_LIMIT, buildActivity } = require("../activity.js");

const NOW = 1_700_000_000_000;

function thread(over) {
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

describe("electron buildActivity", () => {
  it("sorts newest first and excludes archived", () => {
    const items = buildActivity(
      [
        thread({ id: "arch", archived: true, createdAt: NOW + 10 }),
        thread({ id: "old", createdAt: NOW - 5 }),
        thread({ id: "new", createdAt: NOW }),
      ],
      {},
      NOW,
    );
    assert.deepEqual(
      items.map((i) => i.threadId),
      ["new", "old"],
    );
  });

  it("does not treat work-log start timestamps as ends", () => {
    const items = buildActivity(
      [thread({ id: "d", status: "done", createdAt: NOW - 8, updatedAt: NOW - 1 })],
      {
        d: [
          {
            id: "w1",
            runId: "r1",
            label: "Starting agent",
            done: true,
            timestamp: NOW - 4,
          },
        ],
      },
      NOW,
    );
    const done = items.find((i) => i.kind === "done");
    assert.equal(done.at, NOW - 1);
  });

  it("caps at 100", () => {
    const threads = Array.from({ length: 80 }, (_, i) =>
      thread({
        id: `t${i}`,
        createdAt: NOW + i,
        status: i % 2 === 0 ? "done" : "idle",
        updatedAt: NOW + 1000 + i,
      }),
    );
    const items = buildActivity(threads, {}, NOW);
    assert.equal(items.length, ACTIVITY_LIMIT);
  });
});
