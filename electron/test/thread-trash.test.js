"use strict";

/**
 * Recently deleted threads (#940): manual delete moves an eligible thread
 * to a 7-day trash window instead of purging it. Restore keeps the same
 * identity. Expiry and explicit purge reuse purgeThread.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { pruneImageStores } = require("../image-store.js");
const { saveToolImages, extractImages } = require("../tool-images.js");
const attachments = require("../attachments.js");
const { decideCrossThreadSend } = require("../crossThread.js");
const ipc = require("../ipc.js");

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BLOCK = [
  {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: PNG_B64 },
  },
];

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function dayMs(n) {
  return n * 24 * 60 * 60 * 1000;
}

describe("recently deleted threads (#940)", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-trash-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedThread(title = "Keep me") {
    const thread = services.createThread(store, {
      projectId: project.id,
      title,
    });
    store.appendMessage(thread.id, {
      id: "m1",
      role: "user",
      text: "hello transcript",
      createdAt: Date.now(),
    });
    store.appendWorkLog(thread.id, {
      id: "w1",
      runId: "r1",
      label: "Step",
      done: true,
      timestamp: Date.now(),
    });
    services.setNotes(store, { threadId: thread.id, notes: "scratch pad" });
    return store.getThread(thread.id);
  }

  it("exports a seven-day restore window", () => {
    assert.equal(services.TRASH_TTL_MS, dayMs(7));
  });

  it("trashThread keeps the row, transcript, notes, and work log", async () => {
    const thread = await seedThread();
    const now = 1_700_000_000_000;
    const result = services.trashThread(store, { threadId: thread.id }, { now });

    const row = store.getThread(thread.id);
    assert.ok(row, "trashed thread stays in the store");
    assert.equal(row.trashedAt, now);
    assert.equal(row.id, thread.id);
    assert.equal(row.title, thread.title);
    assert.equal(row.notes, "scratch pad");
    assert.equal(store.getMessages(thread.id)[0].text, "hello transcript");
    assert.equal(store.getWorkLog(thread.id)[0].id, "w1");
    assert.equal(result.expiresAt, now + services.TRASH_TTL_MS);
    assert.equal(store.getThreads().length, 1);
  });

  it("listThreads, summaries, and search hide trashed threads", async () => {
    const live = await seedThread("Live");
    const gone = await seedThread("Secret notes about auth");
    services.trashThread(store, { threadId: gone.id }, { now: Date.now() });

    const listed = services.listThreads(store);
    assert.deepEqual(
      listed.map((t) => t.id),
      [live.id],
    );
    assert.equal(
      services.threadSummaries(store).some((t) => t.id === gone.id),
      false,
    );
    const hits = await services.searchThreads(store, { query: "auth" });
    assert.equal(hits.some((t) => t.id === gone.id), false);
  });

  it("restoreThread recovers the same identity after a store reload", async () => {
    const thread = await seedThread("Restore me");
    services.trashThread(store, { threadId: thread.id }, { now: Date.now() });
    store.saveNow();

    const reopened = new Store(path.join(tmpDir, "store.json"));
    assert.equal(services.listThreads(reopened).length, 0);
    const restored = services.restoreThread(reopened, { threadId: thread.id });
    assert.equal(restored.id, thread.id);
    assert.equal(restored.title, "Restore me");
    assert.equal(restored.notes, "scratch pad");
    assert.ok(!restored.trashedAt);
    assert.equal(reopened.getMessages(thread.id)[0].text, "hello transcript");
    assert.equal(services.listThreads(reopened).some((t) => t.id === thread.id), true);
  });

  it("restoreThread refuses a missing parent project and does not retarget", async () => {
    const thread = await seedThread();
    services.trashThread(store, { threadId: thread.id }, { now: Date.now() });
    store.setProjects([]);
    store.saveNow();

    assert.throws(
      () => services.restoreThread(store, { threadId: thread.id }),
      /project is no longer available/i,
    );
    const still = store.getThread(thread.id);
    assert.ok(still.trashedAt, "failed restore stays in Recently deleted");
    assert.equal(still.projectId, project.id);
  });

  it("restoreThread leaves queued work idle and clears an expired quota timer", async () => {
    const thread = await seedThread();
    store.updateThread(thread.id, {
      queued: { prompt: "do the next thing", attachments: [] },
      status: "quota-wait",
      lastError: "quota exhausted",
      quotaWaitUntil: Date.now() - 60_000,
    });
    services.trashThread(store, { threadId: thread.id }, { now: Date.now() });

    const restored = services.restoreThread(store, { threadId: thread.id });
    assert.equal(restored.status, "idle");
    assert.equal(restored.quotaWaitUntil, null);
    assert.equal(restored.queued.prompt, "do the next thing");
    assert.equal(store.getThread(thread.id).status, "idle");
  });

  it("trashThread keeps the existing active-run and worktree guards", async () => {
    const running = await seedThread("Running");
    assert.throws(
      () =>
        services.trashThread(
          store,
          { threadId: running.id },
          { isRunning: () => true },
        ),
      /Cannot delete thread while a run is active/,
    );
    assert.equal(store.getThread(running.id).trashedAt, undefined);

    const rooted = await seedThread("Rooted");
    store.updateThread(rooted.id, {
      worktreePath: path.join(tmpDir, "wt"),
    });
    assert.throws(
      () => services.trashThread(store, { threadId: rooted.id }),
      /Thread still has a worktree\. Merge or delete it in the Git tab first\./,
    );
    assert.ok(store.getThread(rooted.id));
  });

  it("listTrashed returns unexpired rows with expiry and project availability", async () => {
    const ok = await seedThread("Ok");
    const missing = await seedThread("Orphan");
    const now = 1_700_000_000_000;
    services.trashThread(store, { threadId: ok.id }, { now });
    services.trashThread(store, { threadId: missing.id }, { now: now + 1 });
    store.setProjects(store.getProjects().filter((p) => p.id === project.id));
    store.updateThread(missing.id, { projectId: "gone-project" });

    const listed = services.listTrashed(store, { now });
    assert.equal(listed.length, 2);
    assert.equal(listed[0].id, missing.id, "newest trashed first");
    assert.equal(listed[0].projectMissing, true);
    assert.equal(listed[0].projectSlug, null);
    assert.equal(listed[1].id, ok.id);
    assert.equal(listed[1].projectMissing, false);
    assert.equal(listed[1].projectSlug, project.slug);
    assert.equal(listed[1].expiresAt, now + services.TRASH_TTL_MS);
  });

  it("expireTrashedThreads purges once, including after restart", async () => {
    const thread = await seedThread("Stale");
    const now = 1_700_000_000_000;
    services.trashThread(store, { threadId: thread.id }, { now });
    store.saveNow();

    const reopened = new Store(path.join(tmpDir, "store.json"));
    assert.ok(reopened.getThread(thread.id));
    const n = services.expireTrashedThreads(reopened, {
      now: now + services.TRASH_TTL_MS,
    });
    assert.equal(n, 1);
    assert.equal(reopened.getThread(thread.id), null);
    assert.deepEqual(reopened.getMessages(thread.id), []);
    assert.deepEqual(reopened.getWorkLog(thread.id), []);

    const again = services.expireTrashedThreads(reopened, {
      now: now + services.TRASH_TTL_MS + 1,
    });
    assert.equal(again, 0);
  });

  it("explicit purge of a trashed thread reclaims data", async () => {
    const thread = await seedThread("Purge me");
    services.trashThread(store, { threadId: thread.id }, { now: Date.now() });
    services.deleteThread(store, { threadId: thread.id });
    assert.equal(store.getThread(thread.id), null);
    assert.deepEqual(store.getMessages(thread.id), []);
  });

  it("image prune keeps files for an unexpired trashed thread", async () => {
    const thread = await seedThread("Pics");
    const [kept] = saveToolImages(
      tmpDir,
      extractImages(PNG_BLOCK),
      thread.id,
    );
    const paste = attachments.saveImage(
      tmpDir,
      thread.id,
      `data:image/png;base64,${Buffer.from("paste").toString("base64")}`,
    );
    services.trashThread(store, { threadId: thread.id }, { now: Date.now() });

    await pruneImageStores({ userDataPath: tmpDir, store });
    assert.equal(fs.existsSync(path.join(tmpDir, "tool-images", kept)), true);
    assert.equal(fs.existsSync(paste.path), true);
  });

  it("image prune drops files after trash expiry purges the thread", async () => {
    const thread = await seedThread("Old pics");
    saveToolImages(tmpDir, extractImages(PNG_BLOCK), thread.id);
    attachments.saveImage(
      tmpDir,
      thread.id,
      `data:image/png;base64,${Buffer.from("paste").toString("base64")}`,
    );
    const now = 1_700_000_000_000;
    services.trashThread(store, { threadId: thread.id }, { now });
    services.expireTrashedThreads(store, { now: now + services.TRASH_TTL_MS });
    await pruneImageStores({ userDataPath: tmpDir, store });
    assert.equal(fs.existsSync(path.join(tmpDir, "tool-images", thread.id)), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "attachments", thread.id)), false);
  });
});

describe("cross-thread send skips trashed receivers (#940)", () => {
  it("reports trashed threads as undeliverable", () => {
    const out = decideCrossThreadSend({
      target: { id: "t2", archived: false, trashedAt: Date.now() },
      running: false,
    });
    assert.equal(out.outcome, "undeliverable");
    assert.equal(out.reason, "deleted");
  });
});

describe("threads:delete IPC trashes instead of purging (#940)", () => {
  let tmpDir;
  let store;
  let thread;
  let ctx;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-trash-ipc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "IPC",
    });
    store.appendMessage(thread.id, {
      id: "m1",
      role: "user",
      text: "keep",
      createdAt: Date.now(),
    });
    ctx = ipc.makeCtx({
      dialog: {},
      store,
      runner: { isRunning: () => false, disposeClaudeSession: () => {} },
      broadcast: () => {},
      userDataPath: tmpDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("threads:delete keeps the transcript for restore", async () => {
    await ipc.IPC_HANDLERS["threads:delete"](ctx, { threadId: thread.id });
    const row = store.getThread(thread.id);
    assert.ok(row);
    assert.ok(Number.isFinite(row.trashedAt));
    assert.equal(store.getMessages(thread.id)[0].text, "keep");
    assert.equal(services.listThreads(store).length, 0);
  });

  it("threads:restore and threads:purge round-trip the same id", async () => {
    await ipc.IPC_HANDLERS["threads:delete"](ctx, { threadId: thread.id });
    const restored = await ipc.IPC_HANDLERS["threads:restore"](ctx, {
      threadId: thread.id,
    });
    assert.equal(restored.id, thread.id);
    assert.ok(!restored.trashedAt);
    await ipc.IPC_HANDLERS["threads:delete"](ctx, { threadId: thread.id });
    await ipc.IPC_HANDLERS["threads:purge"](ctx, { threadId: thread.id });
    assert.equal(store.getThread(thread.id), null);
  });

  it("threads:list expires trash after restart", async () => {
    const now = Date.now() - services.TRASH_TTL_MS - 1000;
    services.trashThread(store, { threadId: thread.id }, { now });
    store.saveNow();
    const reopened = new Store(path.join(tmpDir, "store.json"));
    const listCtx = ipc.makeCtx({
      dialog: {},
      store: reopened,
      runner: { isRunning: () => false, disposeClaudeSession: () => {} },
      broadcast: () => {},
      userDataPath: tmpDir,
    });
    const listed = await ipc.IPC_HANDLERS["threads:list"](listCtx);
    assert.equal(listed.some((t) => t.id === thread.id), false);
    assert.equal(reopened.getThread(thread.id), null);
  });
});
