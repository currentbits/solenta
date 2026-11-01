"use strict";

/**
 * Teleport (#1702) through the IPC handlers: the desktop's threads:teleport
 * and threads:teleportBack drive the other host's threads:teleportIn /
 * teleportOut / setArchived. invokeRemote is faked as a direct dispatch
 * into a second store, so everything but SSH runs for real.
 * Run: node --test electron/test/teleport-ipc.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return "electron";
  return origResolve.call(this, request, ...rest);
};
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      ipcMain: { handle() {} },
      app: { getPath: () => os.tmpdir(), getVersion: () => "0.0.0-test" },
      dialog: {},
      shell: {},
      nativeTheme: { themeSource: "system" },
      BrowserWindow: class {
        static getAllWindows() {
          return [];
        }
      },
    };
  }
  return origLoad.call(this, request, ...rest);
};

const { Store } = require("../store.js");
const { IPC_HANDLERS } = require("../ipc.js");
const services = require("../services.js");
const { setupWorktree } = require("../worktrees.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function side(root, name, origin) {
  const repo = path.join(root, name, "demo");
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  git(root, ["clone", "-q", origin, repo]);
  const store = new Store(path.join(root, name, "store.json"));
  store.setProjects([{ id: `p-${name}`, slug: "demo", name: "demo", path: repo }]);
  const pushes = [];
  const ctx = {
    store,
    broadcast: (channel) => pushes.push(channel),
    worktreeBase: path.join(root, name, "worktrees"),
    runner: { isRunning: () => false },
    transport: "desktop",
  };
  return { store, repo, ctx, pushes };
}

describe("teleport IPC", () => {
  let root;
  let laptop;
  let remote;
  let threadId;
  let calls;
  let prevList;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-teleport-ipc-"));
    const origin = path.join(root, "acme", "demo.git");
    git(root, ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = path.join(root, "seed");
    git(root, ["clone", "-q", origin, seed]);
    fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
    git(seed, ["add", "-A"]);
    git(seed, ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "seed"]);
    git(seed, ["push", "-q", "origin", "HEAD:main"]);
    laptop = side(root, "laptop", origin);
    remote = side(root, "remote", origin);

    calls = [];
    laptop.ctx.invokeRemote = async (target, channel, args) => {
      calls.push({ target, channel });
      // Through JSON, like the WebSocket, and with the web transport.
      const wire = JSON.parse(JSON.stringify(args));
      const out = await IPC_HANDLERS[channel]({ ...remote.ctx, transport: "web" }, ...wire);
      return JSON.parse(JSON.stringify(out ?? null));
    };
    prevList = services.listProvidersForApi;
    services.listProvidersForApi = async () => [{ id: "claude", available: true }];

    const t = services.createThread(laptop.store, {
      projectId: "p-laptop",
      title: "Go remote",
      provider: "claude",
      projectDefaults: false,
    });
    const ready = setupWorktree({ store: laptop.store, threadId: t.id, worktreeBase: laptop.ctx.worktreeBase });
    fs.writeFileSync(path.join(ready.worktreePath, "a.txt"), "edited on the laptop\n");
    threadId = t.id;
  });

  afterEach(() => {
    services.listProvidersForApi = prevList;
    laptop.store.saveNow();
    remote.store.saveNow();
    rmTree(root);
  });

  it("teleports, locks the local thread, then comes back and archives the remote copy", async () => {
    const target = { host: "box", remotePort: 4620, label: "Box" };
    const sent = await IPC_HANDLERS["threads:teleport"](laptop.ctx, { threadId, ...target });
    assert.equal(sent.teleportedTo.label, "Box");
    assert.equal(sent.teleportedTo.pending, undefined);
    const remoteId = sent.teleportedTo.threadId;
    const there = remote.store.getThread(remoteId);
    assert.equal(fs.readFileSync(path.join(there.worktreePath, "a.txt"), "utf8"), "edited on the laptop\n");
    assert.ok(laptop.pushes.includes("thread:updated"));
    assert.ok(remote.pushes.includes("threads:changed"));

    await assert.rejects(
      IPC_HANDLERS["threads:teleport"](laptop.ctx, { threadId, ...target }),
      /already on Box/,
    );

    fs.writeFileSync(path.join(there.worktreePath, "a.txt"), "edited on the box\n");
    const back = await IPC_HANDLERS["threads:teleportBack"](laptop.ctx, { threadId });
    assert.equal(back.teleportedTo, null);
    assert.equal(fs.readFileSync(path.join(back.worktreePath, "a.txt"), "utf8"), "edited on the box\n");
    assert.deepEqual(calls.map((c) => c.channel), [
      "threads:teleportIn",
      "threads:teleportOut",
      "threads:setArchived",
    ]);
    assert.equal(remote.store.getThread(remoteId).archived, true);
  });

  it("unlocks the local thread when the send fails", async () => {
    // No project there, and a local-path origin is not a URL it may clone.
    remote.store.setProjects([]);
    await assert.rejects(
      IPC_HANDLERS["threads:teleport"](laptop.ctx, { threadId, host: "box", remotePort: 4620, label: "box" }),
      /Use owner\/repo/,
    );
    assert.equal(laptop.store.getThread(threadId).teleportedTo, null);
  });

  it("refuses a running thread unless asked to stop it, then stops, waits and sends", async () => {
    let running = true;
    const stops = [];
    laptop.ctx.runner = {
      isRunning: () => running,
      stopRun: async (input) => {
        stops.push(input.threadId);
        setTimeout(() => (running = false), 50);
      },
    };
    const target = { host: "box", remotePort: 4620, label: "Box" };
    await assert.rejects(IPC_HANDLERS["threads:teleport"](laptop.ctx, { threadId, ...target }), /Stop and teleport/);
    assert.deepEqual(stops, []);
    const sent = await IPC_HANDLERS["threads:teleport"](laptop.ctx, { threadId, ...target, stop: true });
    assert.deepEqual(stops, [threadId]);
    assert.ok(sent.teleportedTo.threadId);
  });

  it("is desktop only for the driving side", async () => {
    await assert.rejects(
      IPC_HANDLERS["threads:teleport"]({ ...laptop.ctx, transport: "web" }, { threadId, host: "box" }),
      /requires the desktop app/,
    );
  });
});
