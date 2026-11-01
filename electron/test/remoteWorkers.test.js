"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createRemoteWorkers } = require("../remoteWorkers.js");

function fakeStore(threads) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  return {
    getThreads: () => [...byId.values()],
    getThread: (id) => byId.get(id) || null,
    getProject: () => ({ id: "p", slug: "acme/rocket" }),
    updateThread: (id, patch) => byId.set(id, { ...byId.get(id), ...patch }),
    saveNow() {},
  };
}

function fakeHub(rows, calls = []) {
  return {
    list: () => [{ key: "box:1", label: "Box", status: "online" }],
    projectsOf: () => [{ id: "rp", slug: "Acme/Rocket" }],
    threadsOf: () => rows,
    invoke: async (key, channel, args) => {
      calls.push(channel);
      if (channel === "threads:create") return { id: "w1", title: args[0].title, projectId: "rp" };
      if (channel === "threads:get") return { thread: { branch: "coder/w1" }, messages: [{ role: "assistant", text: "All done\nmore" }] };
      return {};
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("remote workers (#1821)", () => {
  it("wakes the lead once when the worker's run ends, not on its pre-run idle row", async () => {
    const store = fakeStore([{ id: "lead", projectId: "p" }]);
    const calls = [];
    const delivered = [];
    const rw = createRemoteWorkers({ store, hub: fakeHub([{ id: "w1", status: "idle" }], calls), deliver: (i) => delivered.push(i) });
    const res = await rw.fork({ lead: store.getThread("lead"), host: "Box", prompt: "go" });
    assert.deepEqual(res, { threadId: "w1", host: "Box" });
    assert.deepEqual(calls, ["threads:create", "runs:start"]);
    await tick();
    assert.equal(delivered.length, 0, "stale idle row is not a finish");

    rw.onHostThreads("box:1", [{ id: "w1", status: "working" }]);
    rw.onHostThreads("other:1", [{ id: "w1", status: "done" }]);
    await tick();
    assert.equal(delivered.length, 0);
    rw.onHostThreads("box:1", [{ id: "w1", status: "done" }]);
    rw.onHostThreads("box:1", [{ id: "w1", status: "done" }]);
    await tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].threadId, "lead");
    assert.match(delivered[0].line, /^Worker thread w1 \("go"\) on Box finished with status done\. Last reply: All done Its work is on Box, branch coder\/w1/);
    assert.equal(store.getThread("lead").remoteWorkers, null);
  });

  it("reports a stop and a failure, and picks up workers saved before a restart", async () => {
    const store = fakeStore([{
      id: "lead",
      projectId: "p",
      remoteWorkers: [
        { hostKey: "box:1", hostLabel: "Box", threadId: "a", title: null },
        { hostKey: "box:1", hostLabel: "Box", threadId: "b", title: null },
      ],
    }]);
    const delivered = [];
    const rw = createRemoteWorkers({ store, hub: fakeHub([]), deliver: (i) => delivered.push(i) });
    rw.onHostThreads("box:1", [{ id: "a", status: "working" }, { id: "b", status: "failed" }]);
    rw.onHostThreads("box:1", [{ id: "a", status: "idle" }, { id: "b", status: "failed" }]);
    await tick();
    assert.deepEqual(delivered.map((d) => d.line.match(/thread (\w) .*status (\w+)/).slice(1)), [["b", "failed"], ["a", "stopped"]]);
    assert.doesNotMatch(delivered[0].line, /Its work is on/);
  });

  it("names the connected computers and a missing repo", async () => {
    const store = fakeStore([{ id: "lead", projectId: "p" }]);
    const hub = { ...fakeHub([]), projectsOf: () => [{ id: "x", slug: "other/repo" }] };
    const rw = createRemoteWorkers({ store, hub, deliver() {} });
    await assert.rejects(rw.fork({ lead: store.getThread("lead"), host: "Nope", prompt: "go" }), /No computer called "Nope".*"Box"/);
    await assert.rejects(rw.fork({ lead: store.getThread("lead"), host: "box:1", prompt: "go" }), /Box has no project for acme\/rocket/);
  });
});
