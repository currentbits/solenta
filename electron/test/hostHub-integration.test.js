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
});
