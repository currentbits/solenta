// #1475: envelope throttle and bounded transcript cache.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, SAVE_DEBOUNCE_MS } = require("../store.js");

// Hard-coded rather than imported so the tests also run against a store.js
// that predates these constants (they must fail there).
const THROTTLE_MS = 2000;
const MAX_HYDRATED = 8;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function thread(id, extra = {}) {
  return { id, projectId: "p1", title: id, status: "idle", createdAt: 1, updatedAt: 1, ...extra };
}

describe("Store envelope throttle (#1475)", () => {
  let tmpDir;
  let filePath;
  let envelopeWrites;
  let realRename;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-store-throttle-"));
    filePath = path.join(tmpDir, "coder-store.json");
    envelopeWrites = 0;
    realRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === filePath) envelopeWrites += 1;
      return realRename(from, to);
    };
  });

  afterEach(() => {
    fs.renameSync = realRename;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 10 });
  });

  /** A store whose envelope a debounced flush just wrote: the window is running. */
  async function freshStore() {
    const store = new Store(filePath);
    store.setThreads([thread("t1")]);
    store.save();
    await wait(SAVE_DEBOUNCE_MS + 100);
    await store.flushPending();
    assert.equal(envelopeWrites, 1, "first debounced write is not throttled");
    envelopeWrites = 0;
    return store;
  }

  const onDisk = () => JSON.parse(fs.readFileSync(filePath, "utf8"));
  const shardOnDisk = (id) =>
    JSON.parse(fs.readFileSync(path.join(tmpDir, "messages", `${id}.json`), "utf8"));

  it("a flush of message appends inside the window writes the shard, not the envelope", async () => {
    const store = await freshStore();
    for (let i = 0; i < 3; i++) {
      store.setMessages("t1", [...store.getMessages("t1"), { id: `m${i}`, role: "assistant", text: `x${i}` }]);
      store.save();
      await wait(SAVE_DEBOUNCE_MS + 100);
      await store.flushPending();
    }
    assert.equal(shardOnDisk("t1").length, 3, "every append reached its shard");
    assert.equal(envelopeWrites, 0, "no envelope rewrite inside the window");
    store.saveNow();
  });

  it("envelope changes inside the window coalesce into one write", async () => {
    const store = await freshStore();
    for (let i = 0; i < 5; i++) {
      store.updateThread("t1", { title: `title ${i}` });
      store.save();
      await wait(100);
    }
    await wait(SAVE_DEBOUNCE_MS + 100);
    await store.flushPending();
    assert.equal(envelopeWrites, 0, "still inside the window");
    assert.equal(onDisk().threads[0].title, "t1");
    await wait(THROTTLE_MS);
    await store.flushPending();
    assert.equal(envelopeWrites, 1, "one coalesced write when the window opens");
    assert.equal(onDisk().threads[0].title, "title 4");
  });

  it("saveNow and the exit hook still write a deferred envelope immediately", async () => {
    const store = await freshStore();
    store.updateThread("t1", { title: "deferred" });
    store.save();
    await wait(SAVE_DEBOUNCE_MS + 100);
    await store.flushPending();
    assert.equal(onDisk().threads[0].title, "t1", "deferred by the throttle");
    store.saveNow();
    assert.equal(onDisk().threads[0].title, "deferred");

    store.updateThread("t1", { title: "on exit" });
    store.save();
    await wait(SAVE_DEBOUNCE_MS + 100);
    await store.flushPending();
    assert.equal(onDisk().threads[0].title, "deferred", "deferred again");
    store._flushOnExit();
    assert.equal(onDisk().threads[0].title, "on exit");
  });

  it("a crash between flushes loses at most the throttle window of envelope changes", async () => {
    const store = await freshStore();
    store.updateThread("t1", { title: "renamed" });
    store.setMessages("t1", [{ id: "m1", role: "assistant", text: "hi" }]);
    store.save();
    await wait(SAVE_DEBOUNCE_MS + 100);
    await store.flushPending();

    // "Crash" now: whatever is on disk is all a restart gets.
    const crash1 = fs.mkdtempSync(path.join(os.tmpdir(), "coder-store-crash-"));
    fs.cpSync(tmpDir, crash1, { recursive: true });
    const early = new Store(path.join(crash1, "coder-store.json"));
    assert.equal(early.getMessages("t1").length, 1, "transcripts are not throttled");
    assert.equal(early.getThread("t1").title, "t1", "envelope change still inside the window");
    fs.rmSync(crash1, { recursive: true, force: true });

    await wait(THROTTLE_MS);
    await store.flushPending();
    const crash2 = fs.mkdtempSync(path.join(os.tmpdir(), "coder-store-crash-"));
    fs.cpSync(tmpDir, crash2, { recursive: true });
    const late = new Store(path.join(crash2, "coder-store.json"));
    assert.equal(late.getThread("t1").title, "renamed", "on disk once the window passed");
    fs.rmSync(crash2, { recursive: true, force: true });
  });

  it("a shard delete is not held back: it commits together with the envelope", async () => {
    const store = await freshStore();
    store.setMessages("t1", [{ id: "m1", role: "assistant", text: "hi" }]);
    store.saveNow();
    envelopeWrites = 0;
    store.removeThread("t1");
    store.save();
    await wait(SAVE_DEBOUNCE_MS + 100);
    await store.flushPending();
    assert.equal(onDisk().threads.length, 0);
    assert.equal(fs.existsSync(path.join(tmpDir, "messages", "t1.json")), false);
    assert.equal(envelopeWrites, 1);
  });
});

describe("Store hydrated transcript cache (#1475)", () => {
  let tmpDir;
  let filePath;
  const N = MAX_HYDRATED + 4;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-store-lru-"));
    filePath = path.join(tmpDir, "coder-store.json");
    const seed = new Store(filePath);
    const threads = [];
    for (let i = 0; i < N; i++) threads.push(thread(`t${i}`, i === 0 ? { status: "working" } : {}));
    seed.setThreads(threads);
    for (let i = 0; i < N; i++) {
      seed.setMessages(`t${i}`, [{ id: `m${i}`, role: "assistant", text: `body ${i}` }]);
    }
    seed.saveNow();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 10 });
  });

  it("caps hydrated threads, keeps running and dirty ones, and rehydrates evicted ones", () => {
    const store = new Store(filePath);
    // Load turned the working t0 into failed (crash recovery); make it run again.
    store.updateThread("t0", { status: "working" });
    store.getMessages("t0");
    // t1 has unflushed changes.
    store.setMessages("t1", [{ id: "dirty", role: "user", text: "unsaved" }]);
    for (let i = 2; i < N; i++) store.getMessages(`t${i}`);

    const hydrated = Object.keys(store._messagesHydrated);
    assert.ok(hydrated.length <= MAX_HYDRATED, `hydrated ${hydrated.length} > ${MAX_HYDRATED}`);
    assert.ok(hydrated.includes("t0"), "running thread kept");
    assert.ok(hydrated.includes("t1"), "dirty thread kept");
    assert.ok(hydrated.includes(`t${N - 1}`), "most recent read kept");
    assert.ok(!hydrated.includes("t2"), "least recently read clean thread evicted");

    // Evicted thread reads back from its shard, still listed as a key.
    assert.ok(Object.keys(store.data.messagesByThread).includes("t2"));
    assert.deepEqual(
      store.getMessages("t2").map((m) => m.text),
      ["body 2"],
    );
    assert.deepEqual(store.data.messagesByThread.t1.map((m) => m.text), ["unsaved"]);
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.deepEqual(reloaded.getMessages("t1").map((m) => m.text), ["unsaved"]);
  });
});
