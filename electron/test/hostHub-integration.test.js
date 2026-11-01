"use strict";

/**
 * Host hub (#1819) against a REAL remote: Store + runner + startWebServer
 * with the real IPC handlers, its threads:changed pushes row-encoded the way
 * main.js sends them. Only the SSH tunnel is skipped (the hub dials the
 * web port directly).
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");

{
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return {
        ipcMain: { handle() {} },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        shell: {},
        app: { getPath: () => os.tmpdir() },
      };
    }
    return origLoad.apply(this, arguments);
  };
}

const { startWebServer } = require("../webServer.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { createThreadListEncoder } = require("../threadListPush.js");
const { createHostHub } = require("../hostHub.js");
const { openHostTunnel, openRemoteConnection, invokeRemote, closeRemoteConnections } = require("../remoteConnections.js");

function memoryTokens() {
  const m = new Map();
  return {
    map: m,
    get: (k) => m.get(k) || "",
    set: (k, v) => { m.set(k, v); return true; },
    delete: (k) => { m.delete(k); },
  };
}

// Records the window remoteConnections would open; loads nothing.
function fakeElectron(loaded) {
  class BrowserWindow {
    constructor() {
      this.webContents = { setWindowOpenHandler() {}, on() {} };
      this.destroyed = false;
    }
    on() {}
    loadURL(url) { loaded.push(url); return Promise.resolve(); }
    show() {}
    focus() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  return { BrowserWindow, shell: {}, dialog: {} };
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("hostHub × real remote Solenta Web host", () => {
  let tmp, store, runner, server, hub, project, prevSimulate;
  const windowPushes = [];
  let windowLists = 0;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    windowPushes.length = 0;
    windowLists = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-hub-int-"));
    store = new Store(path.join(tmp, "store.json"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    project = await services.addProject(store, repo);
    services.createThread(store, { projectId: project.id, title: "alpha" });

    const encode = createThreadListEncoder();
    const broadcast = (channel, payload) => {
      if (!server) return;
      if (channel === "threads:changed" && Array.isArray(payload)) payload = encode(payload);
      server.broadcast(channel, payload);
    };
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({ store, core, pushFn: broadcast, tickMs: 15, userDataPath: tmp });
    const ipc = require("../ipc.js");
    const ctx = ipc.makeCtx({ dialog: {}, store, runner, broadcast, worktreeBase: "", userDataPath: tmp });
    server = await startWebServer({ host: "127.0.0.1", port: 0, token: "remote-token", ctx, handlers: ipc.IPC_HANDLERS });

    hub = createHostHub({
      openTunnel: async () => ({ child: { backPort: server.port, kill() {} }, token: "remote-token" }),
      pushWindows: (channel, payload) => windowPushes.push({ channel, payload }),
      onThreadsChanged: () => { windowLists += 1; },
    });
  });

  afterEach(async () => {
    hub?.close();
    try { runner?.stopAll(); } catch { /* ignore */ }
    await server?.close();
    server = null;
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
  });

  it("lists the remote's rows, creates and runs a thread there, and relays its pushes", async () => {
    hub.setHosts([{ host: "me@box", remotePort: 4620, label: "Box" }]);
    await waitFor(() => hub.mergeThreads([]).some((t) => t.title === "alpha"));
    const projects = await hub.route("projects:list", [], async () => []);
    assert.deepEqual(projects.map((p) => [p.id, p.host.label]), [[project.id, "Box"]]);

    // Starting work in a remote project runs it on the remote store.
    const created = await hub.route("threads:create", [{ projectId: project.id, title: "on box" }], () => assert.fail("ran locally"));
    assert.equal(created.host.label, "Box");
    assert.ok(store.getThread(created.id), "thread lives in the remote store");
    const { runId } = await hub.route("runs:start", [{ threadId: created.id, prompt: "hello there" }], () => assert.fail("ran locally"));
    assert.ok(runId);
    await waitFor(() => windowPushes.some((p) => p.channel === "thread:updated" && p.payload.thread.id === created.id && p.payload.thread.status === "done"));
    const update = windowPushes.find((p) => p.channel === "thread:updated");
    assert.equal(update.payload.thread.host.key, "me@box:4620");

    // The remote's row-patch pushes keep the merged list current.
    await waitFor(() => hub.mergeThreads([]).find((t) => t.id === created.id)?.status === "done");
    assert.ok(windowLists > 0);
    const detail = await hub.route("threads:get", [created.id], () => assert.fail("ran locally"));
    assert.ok(detail.messages.some((m) => m.role === "user" && /hello there/.test(m.text)));
    assert.equal(detail.thread.host.label, "Box");
  });

  it("reaches a host directly by address and device token, no SSH (#1824)", async () => {
    const origin = `http://127.0.0.1:${server.port}`;
    const tokens = memoryTokens();
    const loaded = [];
    // Pasting Add device's link: the token comes out of it, the window
    // loads the origin, and only the origin keys the keychain copy.
    const opened = await openRemoteConnection(
      { host: "", url: `${origin}/?token=remote-token`, label: "Direct" },
      { tokens, electron: fakeElectron(loaded), inspectHost: async () => null, localVersion: "1.0.0" },
    );
    assert.deepEqual(
      { url: opened.url, host: opened.host, remotePort: opened.remotePort, tokenSaved: opened.tokenSaved },
      { url: origin, host: "127.0.0.1", remotePort: server.port, tokenSaved: true },
    );
    assert.deepEqual(loaded, [`${origin}/?token=remote-token`]);
    assert.deepEqual([...tokens.map.entries()], [[origin, "remote-token"]]);
    closeRemoteConnections();

    // One-off invoke (Teleport's path) with the saved token.
    const rows = await invokeRemote({ url: origin }, "projects:list", [], { tokens });
    assert.deepEqual(rows.map((p) => p.id), [project.id]);

    // The sidebar hub through the real openHostTunnel.
    hub.close();
    hub = createHostHub({
      openTunnel: (input, onClose) => openHostTunnel(input, { tokens }, onClose),
      pushWindows: (channel, payload) => windowPushes.push({ channel, payload }),
      onThreadsChanged: () => { windowLists += 1; },
    });
    const listed = hub.setHosts([{ host: "127.0.0.1", remotePort: server.port, url: `${origin}/`, label: "Direct" }]);
    assert.equal(listed[0].key, origin);
    await waitFor(() => hub.mergeThreads([]).some((t) => t.title === "alpha"));
    const created = await hub.route("threads:create", [{ projectId: project.id, title: "direct" }], () => assert.fail("ran locally"));
    assert.equal(created.host.key, origin);
    assert.ok(store.getThread(created.id), "thread lives in the remote store");

    // A token the host does not know: the hub parks instead of retrying.
    hub.close();
    tokens.set(origin, "wrong");
    hub = createHostHub({
      openTunnel: (input, onClose) => openHostTunnel(input, { tokens }, onClose),
      pushWindows: () => {},
      onThreadsChanged: () => {},
    });
    hub.setHosts([{ host: "127.0.0.1", remotePort: server.port, url: origin }]);
    await waitFor(() => hub.list()[0].status === "offline");
    assert.match(hub.list()[0].error, /rejected this token/);
  });
  it("thread_fork with host starts the worker there and wakes the lead when it ends (#1821)", async () => {
    const { createRemoteWorkers } = require("../remoteWorkers.js");
    const { createToolHandlers } = require("../orchServer.js");
    // The lead's computer: its own store, same repo name as the remote's.
    const leadDir = path.join(tmp, "lead");
    fs.mkdirSync(path.join(leadDir, "repo"), { recursive: true });
    git(path.join(leadDir, "repo"), ["init", "-q"]);
    const leadStore = new Store(path.join(leadDir, "store.json"));
    const leadProject = await services.addProject(leadStore, path.join(leadDir, "repo"));
    assert.equal(leadProject.slug.toLowerCase(), project.slug.toLowerCase());
    const lead = services.createThread(leadStore, { projectId: leadProject.id, title: "lead" });

    const delivered = [];
    let workers = null;
    const leadHub = createHostHub({
      openTunnel: async () => ({ child: { backPort: server.port, kill() {} }, token: "remote-token" }),
      pushWindows: () => {},
      onThreadsChanged: () => {},
      onHostThreads: (key, rows) => workers?.onHostThreads(key, rows),
    });
    workers = createRemoteWorkers({ store: leadStore, hub: leadHub, deliver: (input) => delivered.push(input) });
    try {
      leadHub.setHosts([{ host: "me@box", remotePort: 4620, label: "Box" }]);
      await waitFor(() => leadHub.list()[0].status === "online" && leadHub.projectsOf("me@box:4620").length > 0);

      const handlers = createToolHandlers({
        store: leadStore,
        runner: { startRun: () => assert.fail("ran locally") },
        forkThread: () => assert.fail("forked locally"),
        getProvider: () => ({}),
        forkRemote: (input) => workers.fork(input),
      });
      await assert.rejects(
        handlers.thread_fork({ threadId: lead.id, projectId: leadProject.id, host: "Nowhere", prompt: "x" }),
        /No computer called "Nowhere".*"Box"/,
      );
      const res = await handlers.thread_fork({
        threadId: lead.id, projectId: leadProject.id, host: "box", prompt: "count the files", title: "Counter", worktree: false,
      });
      assert.equal(res.host, "Box");
      const remote = store.getThread(res.threadId);
      assert.ok(remote, "worker lives in the remote store");
      assert.equal(remote.projectId, project.id);
      assert.equal(remote.title, "Counter");
      assert.ok(!leadStore.getThread(res.threadId), "not in the lead store");

      await waitFor(() => delivered.length > 0);
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].threadId, lead.id);
      assert.match(delivered[0].line, new RegExp(`Worker thread ${res.threadId} \\("Counter"\\) on Box finished with status done`));
      assert.match(delivered[0].line, /Last reply: /);
      assert.equal(leadStore.getThread(lead.id).remoteWorkers, null);

      // Later pushes for the same thread do not wake the lead again.
      await leadHub.invoke("me@box:4620", "threads:rename", [{ threadId: res.threadId, title: "renamed" }]).catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(delivered.length, 1);
    } finally {
      leadHub.close();
    }
  });
});
