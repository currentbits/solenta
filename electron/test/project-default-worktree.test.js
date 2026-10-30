/**
 * Per-project default-worktree override (#1775): ProjectInfo.defaultWorktree
 * wins over settings.defaultWorktree when set; null/absent falls through to
 * the global default. Covers persistence (updateProject / reload), the
 * shared resolveDefaultWorktree helper, and the one electron-side consumer
 * that decides this without a renderer in the loop: a chat-initiated thread
 * (electron/channels/index.js startThread).
 *
 * Run: node --test electron/test/project-default-worktree.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { resolveDefaultWorktree } = require("../services-shared.js");
const { createChannels } = require("../channels/index.js");

describe("resolveDefaultWorktree (#1775)", () => {
  it("falls through to the global setting when the project has no override", () => {
    assert.equal(resolveDefaultWorktree(null, { defaultWorktree: true }), true);
    assert.equal(resolveDefaultWorktree({}, { defaultWorktree: false }), false);
    assert.equal(
      resolveDefaultWorktree({ defaultWorktree: null }, { defaultWorktree: true }),
      true,
    );
  });

  it("a project override wins either direction", () => {
    assert.equal(
      resolveDefaultWorktree({ defaultWorktree: true }, { defaultWorktree: false }),
      true,
    );
    assert.equal(
      resolveDefaultWorktree({ defaultWorktree: false }, { defaultWorktree: true }),
      false,
    );
  });
});

describe("project.defaultWorktree persistence (#1775)", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-proj-worktree-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores true/false and survives a reload", () => {
    const updated = services.updateProject(store, project.id, {
      defaultWorktree: true,
    });
    assert.equal(updated.defaultWorktree, true);
    store.saveNow();
    const reloaded = new Store(store.filePath);
    assert.equal(reloaded.getProject(project.id).defaultWorktree, true);

    services.updateProject(store, project.id, { defaultWorktree: false });
    assert.equal(store.getProject(project.id).defaultWorktree, false);
  });

  it("null clears the override back to inherit", () => {
    services.updateProject(store, project.id, { defaultWorktree: true });
    const cleared = services.updateProject(store, project.id, {
      defaultWorktree: null,
    });
    assert.equal(cleared.defaultWorktree, undefined);
  });

  it("junk input is ignored, not an error", () => {
    const updated = services.updateProject(store, project.id, {
      defaultWorktree: "yes",
    });
    assert.equal(updated.defaultWorktree, undefined);
  });
});

/** Minimal in-memory Telegram Bot API: just enough to drive one message. */
function fakeTelegram() {
  let queue = [];
  let nextId = 1;
  let wake = null;
  async function fetch(url, init) {
    const method = String(url).split("/").pop();
    const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
    if (method === "getMe") return ok({ id: 1, username: "test_bot" });
    if (method === "sendMessage") return ok({ message_id: 1 });
    if (method === "getUpdates") {
      const body = JSON.parse(init.body || "{}");
      queue = queue.filter((u) => u.update_id >= (body.offset || 0));
      if (queue.length === 0) {
        await new Promise((resolve, reject) => {
          wake = resolve;
          init.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      const out = queue;
      queue = [];
      return ok(out);
    }
    throw new Error(`unexpected ${method}`);
  }
  return {
    fetch,
    message(from, text, chat = from) {
      queue.push({
        update_id: nextId++,
        message: { chat: { id: Number(chat), type: "private" }, from: { id: Number(from) }, text },
      });
      if (wake) wake();
      wake = null;
    },
  };
}

function fakeRunner() {
  const starts = [];
  return {
    starts,
    async startRun(input) {
      starts.push(input);
    },
    isRunning: () => false,
    async respondPermission() {},
    listPendingApprovals() {
      return [];
    },
  };
}

async function waitFor(cond, what = "condition") {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const ME = "111";
const TOKEN = "123456:secret-token-xyz";

describe("chat-initiated thread worktree default (#1775)", () => {
  let tmpDir;
  let store;
  let tg;
  let runner;
  let channels;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-chat-worktree-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    store.setProjects([
      { id: "p1", slug: "acme/app", name: "app", path: repo, defaultWorktree: true },
    ]);
    store.setSettings({
      telegram: { botToken: TOKEN, allowedSenderIds: [ME], projectId: "p1" },
      defaultWorktree: false,
    });
    store.saveNow();
    tg = fakeTelegram();
    runner = fakeRunner();
    channels = createChannels({ store, runner, fetch: tg.fetch, backoffMs: 60_000 });
    await channels.connect();
  });

  afterEach(async () => {
    await channels.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a project override of true arms pendingWorktree even though the global default is off", async () => {
    tg.message(ME, "do the thing");
    await waitFor(() => runner.starts.length === 1, "run start");
    const threads = store.getThreads().filter((t) => t.projectId === "p1");
    assert.equal(threads.length, 1);
    assert.equal(threads[0].pendingWorktree, true);
  });
});
