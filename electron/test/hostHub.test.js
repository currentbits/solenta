"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { createHostHub, applyListPush } = require("../hostHub.js");

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A stand-in remote Solenta Web host: auth + invoke + push. */
async function fakeHost({ token = "tok", threads = [], projects = [] } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/ws" });
  const state = { threads, projects, calls: [], sockets: new Set() };
  wss.on("connection", (ws) => {
    let authed = false;
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (!authed) {
        if (msg.kind !== "auth" || msg.token !== token) return ws.close(4401);
        authed = true;
        state.sockets.add(ws);
        ws.send(JSON.stringify({ kind: "auth-ok" }));
        return;
      }
      state.calls.push({ channel: msg.channel, args: msg.args });
      let result;
      if (msg.channel === "threads:list") result = state.threads;
      else if (msg.channel === "projects:list") result = state.projects;
      else if (msg.channel === "threads:get") result = { thread: state.threads.find((t) => t.id === msg.args[0]), messages: [] };
      else if (msg.channel === "threads:create") result = { id: "r-new", projectId: msg.args[0].projectId, title: "new" };
      else if (msg.channel === "boom") return ws.send(JSON.stringify({ kind: "reply", id: msg.id, error: "remote failed" }));
      ws.send(JSON.stringify({ kind: "reply", id: msg.id, result }));
    });
    ws.on("close", () => state.sockets.delete(ws));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    port: server.address().port,
    push(channel, payload) {
      for (const ws of state.sockets) ws.send(JSON.stringify({ kind: "push", channel, payload }));
    },
    dropAll() {
      for (const ws of state.sockets) ws.terminate();
    },
    close: () => new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

function makeHub(remote, overrides = {}) {
  const pushes = [];
  let changed = 0;
  let tunnels = 0;
  const hub = createHostHub({
    openTunnel: async () => {
      tunnels += 1;
      return { child: { backPort: remote.port, kill() {} }, token: "tok" };
    },
    pushWindows: (channel, payload) => pushes.push({ channel, payload }),
    onThreadsChanged: () => { changed += 1; },
    // Fast retries for the reconnect test.
    setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 60)),
    ...overrides,
  });
  return { hub, pushes, changed: () => changed, tunnels: () => tunnels };
}

const LOCAL = [{ id: "l1", projectId: "lp", title: "local" }];
const HOST = { host: "me@box", remotePort: 4620, label: "Box" };

describe("hostHub", () => {
  /** @type {Array<() => unknown>} */
  let cleanup = [];
  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn();
    cleanup = [];
  });

  it("merges a host's threads and projects, tagged, after local rows", async () => {
    const remote = await fakeHost({
      threads: [{ id: "r1", projectId: "rp", title: "remote" }],
      projects: [{ id: "rp", name: "repo" }],
    });
    const { hub } = makeHub(remote);
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.mergeThreads(LOCAL).length === 2);
    const merged = hub.mergeThreads(LOCAL);
    assert.equal(merged[0], LOCAL[0], "local row untouched");
    assert.deepEqual(merged[1].host, { key: "me@box:4620", label: "Box", status: "online" });
    // Same source row → same tagged object, so the encoder sends a patch.
    assert.equal(hub.mergeThreads(LOCAL)[1], merged[1]);
    const projects = await hub.route("projects:list", [], async () => [{ id: "lp" }]);
    assert.deepEqual(projects.map((p) => [p.id, p.host?.label]), [["lp", undefined], ["rp", "Box"]]);
  });

  it("forwards calls naming a remote thread or project and tags thread results", async () => {
    const remote = await fakeHost({
      threads: [{ id: "r1", projectId: "rp", title: "remote" }],
      projects: [{ id: "rp", name: "repo" }],
    });
    const { hub } = makeHub(remote);
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.ownerOf(["rp"]) != null);
    assert.equal(hub.route("threads:get", ["l1"], async () => "local"), null, "local ids stay local");
    const detail = await hub.route("threads:get", ["r1"], () => assert.fail("ran locally"));
    assert.equal(detail.thread.host.label, "Box");
    const created = await hub.route("threads:create", [{ projectId: "rp" }], () => assert.fail("ran locally"));
    assert.equal(created.host.label, "Box");
    assert.ok(hub.ownerOf([{ threadId: "r-new" }]), "a created thread routes before the next list push");
    await assert.rejects(hub.route("boom", [{ threadId: "r1" }], async () => null), /remote failed/);
    assert.deepEqual(remote.state.calls.at(-3), { channel: "threads:get", args: ["r1"] });
  });

  it("runs onHost calls on that host, without the routing key, and tags new projects", async () => {
    const remote = await fakeHost();
    const { hub } = makeHub(remote);
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.list()[0].status === "online");
    remote.state.projects = [];
    const origCalls = remote.state.calls.length;
    await hub.route("fs:browse", [{ path: "~", onHost: "me@box:4620" }], () => assert.fail("ran locally"));
    assert.deepEqual(remote.state.calls[origCalls], { channel: "fs:browse", args: [{ path: "~" }] });
    assert.equal(hub.route("fs:browse", [{ path: "~" }], async () => null), null, "no onHost: local");
    await assert.rejects(hub.route("fs:browse", [{ path: "~", onHost: "gone:1" }], async () => null), /no longer in the sidebar/);
  });

  it("applies the host's row-patch pushes and refetches on a gap", async () => {
    const remote = await fakeHost({ threads: [{ id: "r1", projectId: "rp", title: "a" }] });
    const { hub, pushes } = makeHub(remote);
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.mergeThreads([]).length === 1);
    remote.push("threads:changed", { seq: 5, threads: [{ id: "r1", projectId: "rp", title: "b" }] });
    await waitFor(() => hub.mergeThreads([])[0].title === "b");
    remote.push("threads:changed", { seq: 6, base: 5, upserts: [{ id: "r1", projectId: "rp", title: "c" }], removedIds: [] });
    await waitFor(() => hub.mergeThreads([])[0].title === "c");
    // Base we never saw: refetch threads:list.
    remote.state.threads = [{ id: "r2", projectId: "rp", title: "fresh" }];
    remote.push("threads:changed", { seq: 9, base: 8, upserts: [], removedIds: ["r1"] });
    await waitFor(() => hub.mergeThreads([])[0]?.id === "r2");
    remote.push("thread:updated", { thread: { id: "r2", projectId: "rp", title: "fresh" }, seq: 1 });
    remote.push("boot:ready", null);
    remote.push("terminal:data", { id: "t", data: "x" });
    await waitFor(() => pushes.some((p) => p.channel === "terminal:data"));
    const updated = pushes.find((p) => p.channel === "thread:updated");
    assert.equal(updated.payload.thread.host.label, "Box");
    assert.ok(!pushes.some((p) => p.channel === "boot:ready"), "remote boot:ready does not reach the window");
  });

  it("goes offline on a drop, refuses calls, then reconnects", async () => {
    const remote = await fakeHost({ threads: [{ id: "r1", projectId: "rp", title: "a" }] });
    const { hub, tunnels } = makeHub(remote);
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.list()[0].status === "online");
    remote.dropAll();
    await waitFor(() => hub.list()[0].status !== "online");
    // Still owned by Box while it is down: refused, never run locally.
    await assert.rejects(hub.route("threads:get", ["r1"], () => assert.fail("ran locally")), /Box is (offline|still connecting)/);
    await waitFor(() => hub.list()[0].status === "online");
    assert.ok(tunnels() >= 2, "a fresh tunnel per reconnect");
    // Rows from the last list stay visible while offline.
    assert.equal(hub.mergeThreads([]).length, 1);
  });

  it("reports a host that cannot be reached and keeps its slot", async () => {
    const { hub, pushes } = makeHub({ port: 0 }, {
      openTunnel: async () => { throw new Error("Cannot find box."); },
      setTimer: () => 0,
    });
    cleanup.push(() => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.list()[0].status === "offline");
    assert.equal(hub.list()[0].error, "Cannot find box.");
    assert.ok(pushes.some((p) => p.channel === "hosts:changed"));
  });

  it("does not retry a refused login until the host is saved again", async () => {
    let tries = 0;
    const { hub } = makeHub({ port: 0 }, {
      openTunnel: async () => {
        tries += 1;
        throw new Error("SSH refused the login to me@box. Check the user name and password.");
      },
    });
    cleanup.push(() => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.list()[0].status === "offline");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(tries, 1, "no background retry, so no repeated password prompt");
    hub.setHosts([HOST]);
    await waitFor(() => tries === 2);
  });

  it("drops a host's rows when it is removed", async () => {
    const remote = await fakeHost({ threads: [{ id: "r1", projectId: "rp", title: "a" }] });
    const { hub } = makeHub(remote);
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.mergeThreads([]).length === 1);
    hub.setHosts([]);
    assert.equal(hub.mergeThreads(LOCAL), LOCAL, "no hosts: the local array itself");
    assert.equal(hub.route("threads:list", [], async () => LOCAL), null);
  });

  it("keys a direct host by its address and drops one that stops answering pings (#1824)", async () => {
    const remote = await fakeHost({ threads: [{ id: "r1", projectId: "rp", title: "a" }] });
    const { hub } = makeHub(remote, {
      openTunnel: async (input) => {
        assert.equal(input.url, `http://127.0.0.1:${remote.port}`);
        return { child: { backPort: null, kill() {} }, token: "tok", wsUrl: `ws://127.0.0.1:${remote.port}/ws` };
      },
    });
    cleanup.push(() => remote.close(), () => hub.close());
    const [row] = hub.setHosts([{ host: "127.0.0.1", remotePort: remote.port, url: `http://127.0.0.1:${remote.port}/`, label: "Mini" }]);
    assert.equal(row.key, `http://127.0.0.1:${remote.port}`);
    await waitFor(() => hub.mergeThreads([]).length === 1);
    assert.equal(hub.ownerOf(["r1"]).key, row.key);
    // A host gone silent (sleep, network change) never closes the socket.
    for (const ws of remote.state.sockets) ws._socket.pause();
    await waitFor(() => hub.list()[0].status === "offline");
    assert.match(hub.list()[0].error, /stopped answering/);
    await waitFor(() => hub.list()[0].status === "online");
  });

  it("keeps linked computers connected but out of the window, and lets the sidebar win (#1832)", async () => {
    const remote = await fakeHost({ token: "peer-tok", threads: [{ id: "r1", projectId: "rp", title: "a" }], projects: [{ id: "rp" }] });
    const origin = `http://127.0.0.1:${remote.port}`;
    const seen = [];
    const { hub, pushes } = makeHub(remote, {
      openTunnel: async (input) => {
        seen.push(input);
        return { child: { backPort: null, kill() {} }, token: input.token || "tok", wsUrl: `ws://127.0.0.1:${remote.port}/ws` };
      },
    });
    cleanup.push(() => remote.close(), () => hub.close());
    const rows = hub.setPeers([{ url: `${origin}/`, label: "Mac", token: "peer-tok" }]);
    assert.deepEqual(rows.map((r) => [r.key, r.peer]), [[origin, true]]);
    assert.equal(seen[0].token, "peer-tok", "the link's own token, not the keychain");
    await waitFor(() => hub.list({ peers: true })[0].status === "online");
    await waitFor(() => hub.ownerOf(["r1"]) !== null);
    assert.deepEqual(hub.list(), [], "not a sidebar host");
    assert.deepEqual(hub.mergeThreads([]), [], "its threads stay out of the window");
    assert.ok(pushes.every((p) => p.channel !== "hosts:changed" || p.payload.length === 0));
    assert.equal(hub.threadsOf(origin).length, 1, "but delegation still sees them");

    // The same computer also saved with Show in sidebar: one socket, shown.
    hub.setHosts([{ host: "127.0.0.1", remotePort: remote.port, url: origin, label: "Mac" }]);
    await waitFor(() => hub.mergeThreads([]).length === 1);
    assert.equal(hub.list().length, 1);
    assert.equal(seen.length, 1, "no second connection");
    // Unlinked while still in the sidebar: stays.
    hub.setPeers([]);
    assert.equal(hub.list().length, 1);
  });
});

describe("applyListPush", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  it("replaces on full pushes and patches on the held base only", () => {
    assert.deepEqual(applyListPush([a], [b], null), [b]);
    assert.deepEqual(applyListPush([a], { seq: 2, threads: [b] }, null), [b]);
    assert.deepEqual(applyListPush([a, b], { seq: 3, base: 2, upserts: [{ id: "a", x: 1 }], removedIds: ["b"] }, 2), [{ id: "a", x: 1 }]);
    assert.equal(applyListPush([a], { seq: 3, base: 1, upserts: [], removedIds: [] }, 2), null);
    assert.equal(applyListPush([a], { seq: 3, base: 2, upserts: [{ id: "new" }], removedIds: [] }, 2), null);
  });
});
