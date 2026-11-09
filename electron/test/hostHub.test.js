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
async function fakeHost({ token = "tok", threads = [], projects = [], computerId } = {}) {
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
        ws.send(JSON.stringify({ kind: "auth-ok", ...(computerId ? { computer: { kind: "solenta", computerId, protocol: { min: 1, max: 1 }, runtimeKind: "server" } } : {}) }));
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

  it("rejects unknown explicit owners with zero hosts and never calls local", async () => {
    const { hub } = makeHub({});
    cleanup.push(() => hub.close());
    for (const channel of ["settings:get", "providers:list", "threads:list", "projects:list"]) {
      await assert.rejects(hub.route(channel, [{ onHost: "missing" }], () => assert.fail("local fallback")), /no longer in the sidebar/);
    }
  });

  it("groups authenticated alternate routes with one live socket and routes their aliases", async () => {
    const remote = await fakeHost({ computerId: "computer-one", threads: [{ id: "same-thread", projectId: "rp" }], projects: [{ id: "rp" }] });
    const { hub } = makeHub(remote);
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST, { host: "other-route", remotePort: 4620, label: "Alternate" }]);
    await waitFor(() => hub.list().length === 1 && hub.mergeThreads([]).length === 1);
    await waitFor(() => remote.state.sockets.size === 1);
    assert.equal(hub.list()[0].computerId, "computer-one");
    assert.equal(hub.list()[0].routes.length, 2);
    const rows = await hub.route("projects:list", [{ onHost: "other-route:4620" }], () => assert.fail("local fallback"));
    assert.equal(rows.length, 1);
    assert.deepEqual(remote.state.calls.at(-1).args, [{}]);
    const detail = await hub.route("threads:get", ["same-thread"], () => assert.fail("local fallback"));
    assert.equal(detail.thread.host.computerId, "computer-one");
  });
  it("activates an authenticated alternate when the previous route is parked after token rejection", async () => {
    const remote = await fakeHost({ computerId: "computer-one", threads: [{ id: "r1", projectId: "rp" }] });
    let revoked = false;
    let finishOldAttempt;
    let staleClosed = 0;
    const { hub } = makeHub(remote, { openTunnel: async (input) => {
      if (revoked && input.host === HOST.host) return new Promise((resolve) => {
        finishOldAttempt = () => resolve({ child: { backPort: remote.port, kill() { staleClosed++; } }, token: "revoked-token" });
      });
      return { child: { backPort: remote.port, kill() {} }, token: "tok" };
    } });
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.mergeThreads([]).length === 1);
    const owner = hub.list()[0].key;
    revoked = true;
    for (const ws of remote.state.sockets) ws.close(4401);
    await waitFor(() => hub.list()[0].status === "offline");
    hub.setHosts([HOST, { host: "alternate", remotePort: 4620 }]);
    await waitFor(() => hub.list().length === 1 && hub.list()[0].status === "online" && hub.list()[0].activeRouteKey === "alternate:4620");
    assert.equal(hub.list()[0].key, owner);
    assert.equal((await hub.invoke(owner, "threads:get", ["r1"])).thread.id, "r1");
    assert.ok(finishOldAttempt, "the original route was also reconnecting");
    finishOldAttempt();
    await waitFor(() => staleClosed === 1);
    assert.equal(hub.list()[0].activeRouteKey, "alternate:4620", "a stale tunnel cannot replace the healthy route");
    await waitFor(() => remote.state.sockets.size === 1);
  });
  it("tries an already verified alternate after token rejection and parks after all credentials fail", async () => {
    const remote = await fakeHost({ computerId: "computer-one", threads: [{ id: "r1", projectId: "rp" }] });
    const rejected = new Set();
    const attempts = [];
    const { hub } = makeHub(remote, { openTunnel: async (input) => {
      attempts.push(input.host);
      return { child: { backPort: remote.port, kill() {} }, token: rejected.has(input.host) ? "revoked" : "tok" };
    } });
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.mergeThreads([]).length === 1);
    hub.setHosts([HOST, { host: "alternate", remotePort: 4620 }]);
    await waitFor(() => hub.list()[0].routes.length === 2 && remote.state.sockets.size === 1);
    rejected.add(HOST.host);
    for (const ws of remote.state.sockets) ws.close(4401);
    await waitFor(() => hub.list()[0].status === "online" && hub.list()[0].activeRouteKey === "alternate:4620");
    assert.equal((await hub.invoke(HOST.host + ":4620", "threads:get", ["r1"])).thread.id, "r1");
    rejected.add("alternate");
    for (const ws of remote.state.sockets) ws.close(4401);
    await waitFor(() => hub.list()[0].status === "offline");
    const parkedAttempts = attempts.length;
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(attempts.length, parkedAttempts, "refused routes cannot form a retry loop");
  });
  it("preserves persisted worker wakeups and crew replies through a route that becomes an alias", async () => {
    const { createRemoteWorkers } = require("../remoteWorkers.js");
    const remote = await fakeHost({ computerId: "computer-one", threads: [{ id: "r1", projectId: "rp", status: "done" }] });
    let lead = { id: "lead", projectId: "local-project", remoteWorkers: [{ hostKey: "alternate:4620", hostLabel: "Box", threadId: "r1", out: true, first: true }] };
    const store = { getThreads: () => [lead], getThread: (id) => id === lead.id ? lead : null, updateThread: (_id, patch) => { lead = { ...lead, ...patch }; }, saveNow() {} };
    const delivered = [];
    let workers;
    const { hub } = makeHub(remote, { onHostThreads: (key, rows) => workers?.onHostThreads(key, rows), onCrewCall: (key, payload) => workers?.onCrewCall(key, payload) });
    workers = createRemoteWorkers({ store, hub, deliver: (notice) => delivered.push(notice) });
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.mergeThreads([]).length === 1);
    assert.equal(delivered.length, 0, "ownership requires verified route identity");
    hub.setHosts([HOST, { host: "alternate", remotePort: 4620 }]);
    await waitFor(() => hub.list().length === 1 && hub.list()[0].routes.length === 2);
    await waitFor(() => delivered.length === 1);
    assert.equal(lead.remoteWorkers[0].out, false);
    remote.push("crew:call", { callId: "alias-call", workerId: "r1", tool: "thread_merge", args: {} });
    await waitFor(() => remote.state.calls.some((call) => call.channel === "threads:crewReply"));
    const reply = remote.state.calls.find((call) => call.channel === "threads:crewReply").args[0];
    assert.equal(reply.callId, "alias-call");
    assert.match(reply.error, /does not run on the lead's computer/);
  });

  it("uses newly explicit legacy compatibility when retrying a saved route", async () => {
    const remote = await fakeHost({ threads: [{ id: "legacy-thread", projectId: "rp" }] });
    const attempts = [];
    const { hub } = makeHub(remote, { openTunnel: async (input) => {
      attempts.push(input);
      if (!input.allowLegacy) throw new Error("Enable legacy compatibility for this unbound computer.");
      return { child: { backPort: remote.port, kill() {} }, token: "tok" };
    } });
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.list()[0].status === "offline");
    hub.setHosts([{ ...HOST, allowLegacy: true }]);
    await waitFor(() => hub.mergeThreads([]).length === 1);
    assert.deepEqual(attempts.map((a) => a.allowLegacy), [false, true]);
    assert.equal(hub.list()[0].status, "online");
  });

  it("keeps sidebar pushes on a peer-owned route after reapplying inputs, and hides them after removal", async () => {
    const remote = await fakeHost({ computerId: "computer-one", threads: [{ id: "r1", projectId: "rp" }] });
    const { hub, pushes } = makeHub(remote);
    cleanup.push(() => remote.close(), () => hub.close());
    const peer = { url: "https://peer.ts.net", token: "tok", label: "Linked" };
    hub.setPeers([peer]);
    await waitFor(() => hub.list({ peers: true })[0]?.status === "online");
    hub.setHosts([HOST]);
    await waitFor(() => hub.list().length === 1 && hub.list()[0].routes.length === 2);
    hub.setPeers([peer]);
    hub.setHosts([HOST]);
    const before = pushes.length;
    remote.push("thread:updated", { thread: { id: "r1", projectId: "rp", title: "latest" }, messages: [] });
    remote.push("terminal:data", { threadId: "r1", data: "fresh tail" });
    await waitFor(() => pushes.slice(before).some((p) => p.channel === "thread:updated") && pushes.slice(before).some((p) => p.channel === "terminal:data"));
    assert.equal(hub.list()[0].peer, undefined);
    assert.equal(hub.mergeThreads([]).length, 1);
    hub.setHosts([]);
    assert.equal(hub.list().length, 0);
    assert.equal(hub.list({ peers: true })[0].peer, true);
    assert.equal(hub.mergeThreads([]).length, 0);
    const removed = pushes.length;
    remote.push("thread:updated", { thread: { id: "r1", projectId: "rp" } });
    remote.push("terminal:data", { threadId: "r1", data: "private peer tail" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(pushes.slice(removed).some((p) => ["thread:updated", "terminal:data"].includes(p.channel)), false);
  });

  it("fails over through verified alternate routes without changing the computer owner", async () => {
    const remote = await fakeHost({ computerId: "computer-one", threads: [{ id: "r1", projectId: "rp" }] });
    let primaryFailed = false;
    const attempts = [];
    const { hub } = makeHub(remote, { openTunnel: async (input) => {
      attempts.push(input);
      if (input.host === HOST.host && primaryFailed) throw new Error("Network is unreachable");
      return { child: { backPort: remote.port, kill() {} }, token: "tok" };
    } });
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST, { host: "alternate", remotePort: 4620, token: "alternate-route-token" }]);
    await waitFor(() => hub.list().length === 1 && remote.state.sockets.size === 1);
    const owner = hub.list()[0].key;
    const alternate = hub.list()[0].routes.find((r) => r.key !== owner).key;
    primaryFailed = true;
    remote.dropAll();
    await waitFor(() => hub.list()[0].status === "online" && hub.list()[0].activeRouteKey === alternate);
    assert.equal(hub.list()[0].key, owner);
    assert.equal(hub.mergeThreads([]).length, 1);
    assert.equal(attempts.at(-1).computerId, "computer-one");
    const detail = await hub.route("threads:get", ["r1"], () => assert.fail("local fallback"));
    assert.equal(detail.thread.host.key, owner);
  });

  it("sends global provider and settings calls only to the explicit online owner", async () => {
    const remote = await fakeHost();
    const { hub } = makeHub(remote, { setTimer: (fn, ms) => setTimeout(fn, ms) });
    cleanup.push(() => remote.close(), () => hub.close());
    hub.setHosts([HOST]);
    await waitFor(() => hub.list()[0].status === "online");
    for (const channel of ["providers:list", "settings:get"]) {
      await hub.route(channel, [undefined, { onHost: "me@box:4620" }], () => assert.fail("local fallback"));
      assert.equal(remote.state.calls.at(-1).channel, channel);
      assert.deepEqual(remote.state.calls.at(-1).args, [null, {}]);
    }
    remote.dropAll();
    await waitFor(() => hub.list()[0].status === "offline");
    await assert.rejects(hub.route("providers:list", [undefined, { onHost: "me@box:4620" }], () => assert.fail("local fallback")), /offline/);
  });

  it("refuses ambiguous IDs from two computers instead of picking the first route", async () => {
    const remote = await fakeHost({ computerId: "computer-one", threads: [{ id: "collision", projectId: "rp" }] });
    const other = await fakeHost({ computerId: "computer-two", threads: [{ id: "collision", projectId: "rp" }] });
    const { hub } = makeHub(remote, { openTunnel: async ({ host }) => ({ child: { backPort: host === HOST.host ? remote.port : other.port, kill() {} }, token: "tok" }) });
    cleanup.push(() => remote.close(), () => other.close(), () => hub.close());
    hub.setHosts([HOST, { host: "second", remotePort: 4620 }]);
    await waitFor(() => hub.mergeThreads([]).length === 2);
    await assert.rejects(hub.route("runs:start", [{ threadId: "collision" }], () => assert.fail("local fallback")), /more than one computer/);
    const detail = await hub.route("threads:get", ["collision", { onHost: "second:4620" }], () => assert.fail("local fallback"));
    assert.equal(detail.thread.host.computerId, "computer-two");
    assert.equal(remote.state.calls.filter((c) => c.channel === "threads:get").length, 0);
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
    // Authentication precedes the initial list replies. Establish ownership
    // before dropping the connection whose cached rows this test exercises.
    await waitFor(() => hub.mergeThreads([]).some((row) => row.id === "r1"));
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
