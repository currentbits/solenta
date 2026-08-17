const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createToolHandlers } = require("../orchServer.js");

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

/** Fake store over plain data, matching the Store read/write API. */
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

describe("spec_submit MCP tool", () => {
  function makeDeps(threads) {
    return {
      store: makeFakeStore(threads),
      runner: { startRun: async () => ({}) },
      forkThread: () => ({ id: "fork-1" }),
      getProvider: () => null,
    };
  }

  it("flips awaitingApproval and returns the stage", async () => {
    const deps = makeDeps([
      makeThread({
        id: "t1",
        projectId: "p1",
        spec: { slug: "hello", stage: "requirements", awaitingApproval: false },
      }),
    ]);
    const h = createToolHandlers(deps);
    const out = await h.spec_submit({ threadId: "t1", projectId: "p1" });
    assert.deepEqual(out, { stage: "requirements", awaitingApproval: true });
    const spec = deps.store.getThread("t1").spec;
    assert.equal(spec.awaitingApproval, true);
    assert.equal(spec.stage, "requirements");
  });

  it("throws on a thread with no spec", async () => {
    const deps = makeDeps([makeThread({ id: "t1", projectId: "p1" })]);
    const h = createToolHandlers(deps);
    await assert.rejects(
      () => h.spec_submit({ threadId: "t1", projectId: "p1" }),
      /not in spec mode/,
    );
  });

  it("rejects a thread whose projectId does not match", async () => {
    const deps = makeDeps([
      makeThread({
        id: "t3",
        projectId: "p2",
        title: "Other",
        spec: { slug: "other", stage: "design", awaitingApproval: false },
      }),
    ]);
    const h = createToolHandlers(deps);
    await assert.rejects(
      () => h.spec_submit({ threadId: "t3", projectId: "p1" }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    assert.equal(deps.store.getThread("t3").spec.awaitingApproval, false);
  });
});
