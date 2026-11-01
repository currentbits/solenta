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
    assert.deepEqual(calls, ["threads:create", "threads:setCrewRelay", "runs:start"]);
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
    assert.match(delivered[0].line, /^Worker thread w1 \("go"\) on Box finished with status done\. Last reply: All done Its work is still only on branch coder\/w1 on Box/);
    assert.equal(store.getThread("lead").remoteWorkers[0].out, false, "kept on record, no longer owed");
    assert.equal(rw.find("w1").leadId, "lead");
  });

  it("reports a stop and a failure, and picks up workers saved before a restart", async () => {
    const store = fakeStore([{
      id: "lead",
      projectId: "p",
      remoteWorkers: [
        { hostKey: "box:1", hostLabel: "Box", threadId: "a", title: null, out: true, first: true },
        { hostKey: "box:1", hostLabel: "Box", threadId: "b", title: null, out: true, first: true },
      ],
    }]);
    const delivered = [];
    const rw = createRemoteWorkers({ store, hub: fakeHub([]), deliver: (i) => delivered.push(i) });
    rw.onHostThreads("box:1", [{ id: "a", status: "working" }, { id: "b", status: "failed" }]);
    rw.onHostThreads("box:1", [{ id: "a", status: "idle" }, { id: "b", status: "failed" }]);
    await tick();
    assert.deepEqual(delivered.map((d) => d.line.match(/thread (\w) .*status (\w+)/).slice(1)), [["b", "failed"], ["a", "stopped"]]);
    assert.doesNotMatch(delivered[0].line, /Its work/);
  });

  it("a follow-up queued behind a running turn wakes the lead after the follow-up, not before", async () => {
    const rows = [{ id: "w1", status: "working" }];
    const calls = [];
    const store = fakeStore([{ id: "lead", projectId: "p", remoteWorkers: [{ hostKey: "box:1", hostLabel: "Box", threadId: "w1", title: null, out: false }] }]);
    const delivered = [];
    const rw = createRemoteWorkers({ store, hub: fakeHub(rows, calls), deliver: (i) => delivered.push(i) });
    const res = await rw.send("lead", rw.find("w1").w, "more");
    assert.equal(res.outcome, "queued");
    assert.deepEqual(calls, ["threads:setQueued"]);
    rw.onHostThreads("box:1", [{ id: "w1", status: "done" }]);
    await tick();
    assert.equal(delivered.length, 0, "the turn that was already running");
    rw.onHostThreads("box:1", [{ id: "w1", status: "working" }]);
    rw.onHostThreads("box:1", [{ id: "w1", status: "done" }]);
    await tick();
    assert.equal(delivered.length, 1);
    assert.deepEqual(rw.listFor("p").map((r) => [r.id, r.host, r.handoffFrom]), [["w1", "Box", "lead"]]);
  });

  it("answers crew calls only for its own worker on that host, and only crew tools", async () => {
    const store = fakeStore([{ id: "lead", projectId: "p", remoteWorkers: [{ hostKey: "box:1", hostLabel: "Box", threadId: "w1", title: null }] }]);
    const rw = createRemoteWorkers({ store, hub: fakeHub([]), deliver() {} });
    assert.equal(rw.onCrewCall("other:1", { callId: "c", workerId: "w1", tool: "task_list", args: {} }), null, "same id from another computer");
    assert.equal(rw.onCrewCall("box:1", { callId: "c", workerId: "nope", tool: "task_list", args: {} }), null);
    await assert.rejects(rw.onCrewCall("box:1", { callId: "c", workerId: "w1", tool: "thread_merge", args: {} }), /does not run on the lead's computer/);
  });

  it("names the connected computers and a missing repo", async () => {
    const store = fakeStore([{ id: "lead", projectId: "p" }]);
    const hub = { ...fakeHub([]), projectsOf: () => [{ id: "x", slug: "other/repo" }] };
    const rw = createRemoteWorkers({ store, hub, deliver() {} });
    await assert.rejects(rw.fork({ lead: store.getThread("lead"), host: "Nope", prompt: "go" }), /No computer called "Nope".*"Box"/);
    await assert.rejects(rw.fork({ lead: store.getThread("lead"), host: "box:1", prompt: "go" }), /Box has no project for acme\/rocket/);
  });
});
