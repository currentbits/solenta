// #1475: the hydrated-transcript LRU is capped by bytes as well as count.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");

// Hard-coded so the tests fail against a store.js without the byte budget.
const BUDGET = 16 * 1024 * 1024;
const MB = 1024 * 1024;

function thread(id, extra = {}) {
  return { id, projectId: "p1", title: id, status: "idle", createdAt: 1, updatedAt: 1, ...extra };
}

const hydratedBytes = (store) =>
  Object.keys(store._messagesHydrated).reduce(
    (n, id) => n + (store._hydratedReads.get(id) || 0),
    0,
  );

describe("Store hydrated transcript byte budget (#1475)", () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-store-budget-"));
    filePath = path.join(tmpDir, "coder-store.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 10 });
  });

  function seed(sizes) {
    const s = new Store(filePath);
    s.setThreads(sizes.map((_, i) => thread(`t${i}`)));
    sizes.forEach((size, i) => {
      s.setMessages(`t${i}`, [{ id: `m${i}`, role: "assistant", text: String(i % 10).repeat(size) }]);
    });
    s.saveNow();
  }

  it("evicts large clean threads past the byte budget under the count cap", () => {
    seed([5 * MB, 5 * MB, 5 * MB, 5 * MB, 5 * MB]);
    const store = new Store(filePath);
    for (let i = 0; i < 5; i++) store.getMessages(`t${i}`);
    const hydrated = Object.keys(store._messagesHydrated);
    assert.ok(hydratedBytes(store) <= BUDGET, `${hydratedBytes(store)} bytes hydrated`);
    assert.deepEqual(hydrated.sort(), ["t2", "t3", "t4"], "the three most recent reads stay");
    assert.equal(store.getMessages("t0")[0].text.length, 5 * MB, "evicted thread rehydrates");
  });

  it("keeps a single over-budget thread instead of re-parsing it per read", () => {
    seed([BUDGET + MB, 1000]);
    const store = new Store(filePath);
    store.getMessages("t1");
    const big = store.getMessages("t0");
    assert.equal(store.getMessages("t0"), big, "same array: not evicted and re-parsed");
    assert.deepEqual(Object.keys(store._messagesHydrated), ["t0"]);
  });

  it("refreshes a dirty thread's size on flush so growth counts against the budget", () => {
    seed([1000, 6 * MB, 6 * MB]);
    const store = new Store(filePath);
    store.getMessages("t0");
    store.setMessages("t0", [{ id: "big", role: "assistant", text: "x".repeat(6 * MB) }]);
    store.saveNow();
    assert.ok(store._hydratedReads.get("t0") > 6 * MB, "size tracks the flushed shard");
    store.getMessages("t1");
    store.getMessages("t2");
    assert.ok(!("t0" in store._messagesHydrated), "grown thread evicted once clean");
    assert.equal(store.getMessages("t0")[0].text.length, 6 * MB);
  });
});

describe("Store hydrated LRU randomized stress (#1475)", () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-store-stress-"));
    filePath = path.join(tmpDir, "coder-store.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 10 });
  });

  it("matches an in-memory model across appends, updates, reads, flushes and reloads", async () => {
    // mulberry32: reproducible; the seed is in the failure message.
    const seedVal = Number(process.env.STRESS_SEED) || 1475;
    let a = seedVal;
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (n) => Math.floor(rnd() * n);
    const N = 36;
    const ids = Array.from({ length: N }, (_, i) => `t${i}`);
    // A third of the threads are ~1.5 MB so the byte budget, not only the
    // count cap, drives eviction.
    const pad = (id, k) => (Number(id.slice(1)) % 3 === 0 ? "#".repeat(1.5 * MB) : "") + k;
    const model = new Map(ids.map((id) => [id, []]));

    let store = new Store(filePath);
    store.setThreads(ids.map((id) => thread(id)));
    for (const id of ids) {
      const list = [{ id: `${id}-0`, role: "user", text: pad(id, "seed") }];
      store.setMessages(id, list);
      model.set(id, list.map((m) => ({ ...m })));
    }
    store.saveNow();

    const check = (s, where) => {
      for (const id of ids) {
        const got = s.getMessages(id).map((m) => `${m.id}:${m.text.length}:${m.text.slice(-12)}`);
        const want = model.get(id).map((m) => `${m.id}:${m.text.length}:${m.text.slice(-12)}`);
        assert.deepEqual(got, want, `${id} diverged ${where} (STRESS_SEED=${seedVal})`);
      }
    };

    let evictions = 0;
    let seq = 0;
    for (let step = 0; step < 1500; step++) {
      const id = ids[pick(N)];
      const op = rnd();
      if (op < 0.35) {
        const msg = { id: `${id}-${++seq}`, role: "assistant", text: `a${seq}` };
        store.appendMessage(id, msg);
        model.get(id).push({ ...msg });
      } else if (op < 0.5) {
        const list = store.getMessages(id).slice();
        const k = pick(list.length);
        list[k] = { ...list[k], text: pad(id, `u${++seq}`) };
        store.setMessages(id, list);
        model.get(id)[k] = { ...list[k] };
      } else if (op < 0.85) {
        const miss = !(id in store._messagesHydrated);
        const before = Object.keys(store._messagesHydrated).length;
        const got = store.getMessages(id);
        assert.equal(got.length, model.get(id).length, `${id} read at step ${step}`);
        if (miss && Object.keys(store._messagesHydrated).length <= before) evictions += 1;
        if (miss) {
          // Eviction runs on a miss: past it only pinned threads may exceed the caps.
          const pinned = new Set([
            ...store._dirtyMessageIds,
            ...store.data.threads.filter((t) => t.status === "working").map((t) => t.id),
            id,
          ]);
          const loose = Object.keys(store._messagesHydrated).filter((t) => !pinned.has(t));
          const looseBytes = loose.reduce((n, t) => n + (store._hydratedReads.get(t) || 0), 0);
          assert.ok(loose.length <= 8, `${loose.length} unpinned hydrated at step ${step}`);
          assert.ok(looseBytes <= BUDGET, `${looseBytes} unpinned bytes at step ${step}`);
        }
      } else if (op < 0.9) {
        store.updateThread(id, { status: rnd() < 0.5 ? "working" : "idle" });
      } else if (op < 0.97) {
        store.save();
        if (rnd() < 0.5) await store.flushPending();
      } else {
        // Reload: every later read starts as a miss, so eviction re-parses.
        // Idle first, or crash recovery appends a "quit mid-run" notice.
        for (const t of ids) store.updateThread(t, { status: "idle" });
        await store.flushPending();
        store.saveNow();
        check(store, `live at step ${step}`);
        store = new Store(filePath);
      }
    }
    assert.ok(evictions > 50, `eviction barely ran (${evictions})`);
    for (const t of ids) store.updateThread(t, { status: "idle" });
    check(store, "live at end");
    await store.flushPending();
    store.saveNow();
    check(new Store(filePath), "after final reload");
  });
});
