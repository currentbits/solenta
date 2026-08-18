const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createToolHandlers, INSTRUCTIONS } = require("../orchServer.js");

/**
 * @param {Partial<object>} overrides
 */
function makeThread(overrides = {}) {
  return {
    id: "t1",
    projectId: "p1",
    title: "Hello",
    status: "idle",
    createdAt: 1,
    updatedAt: 1_700_000_000_000,
    handoffFrom: null,
    ...overrides,
  };
}

function makeFakeStore(threads, projects) {
  const list = threads.slice();
  const proj = projects || {
    p1: { id: "p1", name: "Alpha" },
    p2: { id: "p2", name: "Beta" },
  };
  return {
    getThreads: () => list,
    getThread: (id) => list.find((t) => t.id === id) || null,
    getProject: (id) => proj[id] || null,
    getMessages: () => [],
    updateThread: (id, patch) => {
      const t = list.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
      return t || null;
    },
    save: () => {},
    threads: list,
  };
}

describe("teach_review MCP tool", () => {
  function makeDeps(threads) {
    return {
      store: makeFakeStore(threads),
      runner: { startRun: async () => ({}) },
      forkThread: () => ({ id: "fork-1" }),
      getProvider: () => null,
    };
  }

  it("instructions name teach_review and TODO(human)", () => {
    assert.match(INSTRUCTIONS, /teach_review/);
    assert.match(INSTRUCTIONS, /TODO\(human\)/);
    assert.match(INSTRUCTIONS, /hints not solutions/);
  });

  it("increments reviewsPassed on passed:true", async () => {
    const deps = makeDeps([
      makeThread({
        id: "t1",
        projectId: "p1",
        teach: { autonomy: "hint", reviewsPassed: 2 },
      }),
    ]);
    const h = createToolHandlers(deps);
    const out = await h.teach_review({
      threadId: "t1",
      projectId: "p1",
      passed: true,
    });
    assert.equal(out.passed, true);
    assert.equal(out.reviewsPassed, 3);
    assert.equal(out.autonomy, "review");
    assert.equal(out.promoted, true);
    assert.equal(deps.store.getThread("t1").teach.autonomy, "review");
  });

  it("throws on a thread with no teach", async () => {
    const deps = makeDeps([makeThread({ id: "t1", projectId: "p1" })]);
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.teach_review({ threadId: "t1", projectId: "p1", passed: true }),
      /not in teach mode/,
    );
  });

  it("rejects a thread whose projectId does not match", async () => {
    const deps = makeDeps([
      makeThread({
        id: "t3",
        projectId: "p2",
        title: "Other",
        teach: { autonomy: "hint", reviewsPassed: 0 },
      }),
    ]);
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.teach_review({ threadId: "t3", projectId: "p1", passed: true }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    assert.equal(deps.store.getThread("t3").teach.reviewsPassed, 0);
  });
});
