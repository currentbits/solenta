const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");

/**
 * @param {Partial<object>} overrides
 */
function makeThread(overrides = {}) {
  return {
    id: "t1",
    projectId: "p1",
    title: "Hello",
    branch: null,
    prNumber: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 100,
    runStartedAt: null,
    archived: false,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    worktreePath: null,
    ...overrides,
  };
}

describe("threads summaries", () => {
  let tmpDir;
  let filePath;
  /** @type {Store} */
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-summaries-"));
    filePath = path.join(tmpDir, "coder-store.json");
    store = new Store(filePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns one row per thread with role fields and null lastActivity", () => {
    store.setThreads([
      makeThread({ id: "orch", title: "Plan", provider: "claude" }),
      makeThread({
        id: "work",
        title: "Fork: Plan",
        provider: "grok",
        status: "working",
        handoffFrom: "orch",
        orchWorker: true,
        runStartedAt: 90,
        awaitingInput: true,
      }),
    ]);
    const rows = services.threadSummaries(store);
    assert.equal(rows.length, 2);
    const work = rows.find((r) => r.id === "work");
    // runStartedAt + awaitingInput ride along so the Agents panel can render
    // "waiting on N · elapsed" and flag a blocked worker (issue #42).
    // orchWorker + projectId distinguish a true worker from an ordinary fork.
    assert.deepEqual(work, {
      id: "work",
      title: "Fork: Plan",
      provider: "grok",
      status: "working",
      handoffFrom: "orch",
      orchWorker: true,
      projectId: "p1",
      runStartedAt: 90,
      stoppedAt: null,
      awaitingInput: true,
      stalledAt: null,
      lastActivity: null,
    });
    const orch = rows.find((r) => r.id === "orch");
    assert.equal(orch.runStartedAt, null);
    assert.equal(orch.awaitingInput, false);
    assert.equal(orch.stalledAt, null);
    assert.equal(orch.orchWorker, false);
    assert.equal(orch.projectId, "p1");
  });

  it("does not treat an ordinary fork as an orchWorker", () => {
    store.setThreads([
      makeThread({ id: "src", projectId: "p1" }),
      makeThread({
        id: "fork",
        projectId: "p2",
        handoffFrom: "src",
      }),
      makeThread({
        id: "work",
        projectId: "p2",
        handoffFrom: "src",
        orchWorker: true,
      }),
    ]);
    const rows = Object.fromEntries(
      services.threadSummaries(store).map((r) => [r.id, r]),
    );
    assert.equal(rows.src.orchWorker, false);
    assert.equal(rows.fork.orchWorker, false);
    assert.equal(rows.fork.handoffFrom, "src");
    assert.equal(rows.fork.projectId, "p2");
    assert.equal(rows.work.orchWorker, true);
    assert.equal(rows.work.projectId, "p2");
  });

  it("mirrors stalledAt onto the summary row", () => {
    store.setThreads([
      makeThread({ id: "hung", status: "working", stalledAt: 1234 }),
    ]);
    const [row] = services.threadSummaries(store);
    assert.equal(row.stalledAt, 1234);
  });

  it("mirrors stoppedAt onto the summary row (issue #183)", () => {
    store.setThreads([
      makeThread({ id: "stopped", status: "idle", stoppedAt: 5678 }),
    ]);
    const [row] = services.threadSummaries(store);
    assert.equal(row.stoppedAt, 5678);
  });

  it("lastActivity is the first line of the LAST assistant message", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.setMessages("a", [
      { id: "m1", role: "user", text: "question", createdAt: 10 },
      {
        id: "m2",
        role: "assistant",
        text: "first answer\nwith detail",
        createdAt: 20,
      },
      { id: "m3", role: "assistant", text: "LAST\nsecond line", createdAt: 30 },
      { id: "m4", role: "user", text: "later user msg", createdAt: 40 },
    ]);
    const [row] = services.threadSummaries(store);
    assert.deepEqual(row.lastActivity, { text: "LAST", at: 30 });
  });

  it("skips blank assistant messages and falls back to updatedAt without createdAt", () => {
    store.setThreads([makeThread({ id: "a", updatedAt: 555 })]);
    store.setMessages("a", [
      { id: "m1", role: "assistant", text: "real answer", createdAt: 10 },
      { id: "m2", role: "assistant", text: "   ", createdAt: 20 },
      { id: "m3", role: "assistant", text: "no timestamp" },
    ]);
    const [row] = services.threadSummaries(store);
    assert.deepEqual(row.lastActivity, { text: "no timestamp", at: 555 });
  });

  it("summaries reflect an assistant message appended after a previous summaries call", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.setMessages("a", [
      { id: "m1", role: "assistant", text: "first", createdAt: 10 },
    ]);
    const [before] = services.threadSummaries(store);
    assert.deepEqual(before.lastActivity, { text: "first", at: 10 });

    store.appendMessage("a", {
      id: "m2",
      role: "assistant",
      text: "second\nmore",
      createdAt: 20,
    });
    const [after] = services.threadSummaries(store);
    assert.deepEqual(after.lastActivity, { text: "second", at: 20 });
  });

  it("summaries reflect a streamed assistant message edited via updateMessage", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.setMessages("a", [
      { id: "m1", role: "assistant", text: "partial", createdAt: 10 },
    ]);
    const [before] = services.threadSummaries(store);
    assert.deepEqual(before.lastActivity, { text: "partial", at: 10 });

    store.updateMessage("a", "m1", { text: "partial, then more" });
    const [after] = services.threadSummaries(store);
    assert.deepEqual(after.lastActivity, { text: "partial, then more", at: 10 });
  });

  it("summaries skip a last assistant message that is later blanked", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.setMessages("a", [
      { id: "m1", role: "assistant", text: "kept", createdAt: 10 },
      { id: "m2", role: "assistant", text: "will blank", createdAt: 20 },
    ]);
    const [before] = services.threadSummaries(store);
    assert.deepEqual(before.lastActivity, { text: "will blank", at: 20 });

    store.updateMessage("a", "m2", { text: "   " });
    const [after] = services.threadSummaries(store);
    assert.deepEqual(after.lastActivity, { text: "kept", at: 10 });
  });

  it("filters by projectId and threadIds before reading messages", () => {
    store.setThreads([
      makeThread({ id: "a", projectId: "p1" }),
      makeThread({ id: "b", projectId: "p1" }),
      makeThread({ id: "c", projectId: "p2" }),
    ]);
    const read = [];
    const orig = store.getLastAssistantMessage.bind(store);
    store.getLastAssistantMessage = (id) => {
      read.push(id);
      return orig(id);
    };
    assert.deepEqual(
      services.threadSummaries(store, { projectId: "p1" }).map((r) => r.id),
      ["a", "b"],
    );
    assert.deepEqual(read, ["a", "b"], "other projects' messages are not read");
    read.length = 0;
    assert.deepEqual(
      services.threadSummaries(store, { threadIds: ["c"] }).map((r) => r.id),
      ["c"],
    );
    assert.deepEqual(read, ["c"]);
    assert.equal(services.threadSummaries(store).length, 3, "no filter = all rows");
  });

  it("caps lastActivity text at 200 characters", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.getLastAssistantMessage = () => ({ text: "x".repeat(500), createdAt: 5 });
    const [row] = services.threadSummaries(store);
    assert.equal(row.lastActivity.text.length, 200);
  });
});

describe("threads summaries: persisted lastActivity (#1475)", () => {
  const {
    stampLastActivity,
    lastAssistantFromTail,
  } = require("../thread-last-activity.js");
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-summaries-la-"));
    filePath = path.join(tmpDir, "coder-store.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The pre-#1475 implementation, verbatim: reads every shard synchronously.
  function oldSummaries(store) {
    return store
      .getThreads()
      .filter((t) => !(t && t.memoryConsolidate === true))
      .map((t) => {
        const last = store.getLastAssistantMessage(t.id);
        return {
          id: t.id,
          title: t.title,
          provider: t.provider,
          status: t.status,
          handoffFrom: t.handoffFrom ?? null,
          orchWorker: t.orchWorker === true,
          projectId: t.projectId,
          runStartedAt: t.runStartedAt ?? null,
          stoppedAt: t.stoppedAt ?? null,
          awaitingInput: t.awaitingInput === true,
          stalledAt: t.stalledAt ?? null,
          lastActivity: last
            ? {
                text: String(last.text).split(/\r?\n/, 1)[0].trim().slice(0, 200),
                at: Number(last.createdAt) || t.updatedAt,
              }
            : null,
        };
      });
  }

  const big = "y".repeat(80 * 1024);
  const FIXTURE = {
    multi: [
      { id: "m1", role: "user", text: "q", createdAt: 10 },
      { id: "m2", role: "assistant", text: "  first line  \nsecond", createdAt: 20 },
      { id: "m3", role: "user", text: "later", createdAt: 30 },
    ],
    blank: [
      { id: "m1", role: "assistant", text: "real", createdAt: 10 },
      { id: "m2", role: "assistant", text: "   ", createdAt: 20 },
    ],
    noStamp: [{ id: "m1", role: "assistant", text: "no createdAt" }],
    none: [{ id: "m1", role: "user", text: "only user", createdAt: 5 }],
    long: [{ id: "m1", role: "assistant", text: "z".repeat(500), createdAt: 7 }],
    // > 64 KB: last assistant sits in the tail, behind a nested `,{` payload.
    bigTail: [
      { id: "m0", role: "user", text: big, createdAt: 1 },
      { id: "m1", role: "assistant", text: "tail hit ,{\"id\":\"x\"}]", createdAt: 2 },
      {
        id: "m2",
        role: "tool",
        text: "",
        createdAt: 3,
        tool: { id: "t", input: { items: [{ id: "a" }, { id: "b" }] } },
      },
    ],
    // > 64 KB: last assistant is BEFORE the tail; full-file fallback.
    bigHead: [
      { id: "m1", role: "assistant", text: "head hit", createdAt: 4 },
      { id: "m2", role: "tool", text: big, createdAt: 5 },
    ],
  };

  /** Persist FIXTURE as real shards, then return a cold Store over them. */
  function coldStore() {
    const s = new Store(filePath);
    s.setThreads(
      Object.keys(FIXTURE).map((id) => makeThread({ id, updatedAt: 999 })),
    );
    for (const [id, msgs] of Object.entries(FIXTURE)) s.setMessages(id, msgs);
    s.saveNow();
    // Drop the snippets the first store may have stamped: cold = unknown.
    const env = JSON.parse(fs.readFileSync(filePath, "utf8"));
    for (const t of env.threads) delete t.lastActivity;
    fs.writeFileSync(filePath, JSON.stringify(env));
    return new Store(filePath);
  }

  async function waitFor(fn) {
    for (let i = 0; i < 200; i++) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out");
  }

  /** Count sync + async opens/reads under messages/. */
  function spyShardReads() {
    const dir = path.join(tmpDir, "messages");
    const hits = [];
    const origSync = fs.readFileSync;
    const origOpen = fs.promises.open;
    fs.readFileSync = function (p, ...rest) {
      if (String(p).startsWith(dir)) hits.push(["sync", p]);
      return origSync.call(this, p, ...rest);
    };
    fs.promises.open = function (p, ...rest) {
      if (String(p).startsWith(dir)) hits.push(["async", p]);
      return origOpen.call(this, p, ...rest);
    };
    return {
      hits,
      restore() {
        fs.readFileSync = origSync;
        fs.promises.open = origOpen;
      },
    };
  }

  it("appending an assistant message updates the row snippet (runner pushDetail path)", () => {
    const store = new Store(filePath);
    store.setThreads([makeThread({ id: "a" })]);
    store.appendMessage("a", { id: "m1", role: "assistant", text: "one\nx", createdAt: 10 });
    stampLastActivity(store, "a");
    assert.deepEqual(store.getThread("a").lastActivity, { text: "one", at: 10 });
    store.appendMessage("a", { id: "m2", role: "assistant", text: "two", createdAt: 20 });
    stampLastActivity(store, "a");
    assert.deepEqual(store.getThread("a").lastActivity, { text: "two", at: 20 });
    // Persisted: a fresh store reads it straight off the row.
    store.saveNow();
    assert.deepEqual(new Store(filePath).getThread("a").lastActivity, {
      text: "two",
      at: 20,
    });
  });

  it("does zero shard reads once every row has a snippet", async () => {
    const store = coldStore();
    services.threadSummaries(store);
    await waitFor(() => store.getThreads().every((t) => t.lastActivity !== undefined));
    store.saveNow();
    const reloaded = new Store(filePath);
    const spy = spyShardReads();
    try {
      const rows = services.threadSummaries(reloaded);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(rows.length, Object.keys(FIXTURE).length);
      assert.deepEqual(spy.hits, []);
    } finally {
      spy.restore();
    }
  });

  it("backfills unknown rows once, asynchronously", async () => {
    const store = coldStore();
    const spy = spyShardReads();
    try {
      const first = services.threadSummaries(store);
      // Nothing known yet, and nothing read on the calling tick.
      assert.ok(first.every((r) => r.lastActivity === null));
      assert.deepEqual(spy.hits.filter(([k]) => k === "sync"), []);
      await waitFor(() => store.getThreads().every((t) => t.lastActivity !== undefined));
      const opened = spy.hits.length;
      assert.equal(spy.hits.filter(([k]) => k === "sync").length, 0);
      assert.equal(opened, Object.keys(FIXTURE).length, "one open per shard");
      services.threadSummaries(store);
      services.threadSummaries(store);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(spy.hits.length, opened, "never re-read");
    } finally {
      spy.restore();
    }
  });

  it("matches the old implementation's output for a fixture set", async () => {
    const expected = oldSummaries(coldStore());
    const store = coldStore();
    services.threadSummaries(store);
    await waitFor(() => store.getThreads().every((t) => t.lastActivity !== undefined));
    assert.deepEqual(services.threadSummaries(store), expected);
    // Sanity: the fixture exercises the tail and fallback paths.
    const byId = Object.fromEntries(expected.map((r) => [r.id, r]));
    assert.equal(byId.bigTail.lastActivity.text, 'tail hit ,{"id":"x"}]');
    assert.equal(byId.bigHead.lastActivity.text, "head hit");
    assert.equal(byId.noStamp.lastActivity.at, 999);
    assert.equal(byId.none.lastActivity, null);
  });

  it("lastAssistantFromTail ignores nested and in-string `,{` boundaries", () => {
    const msgs = [
      { id: "u", role: "user", text: "cut off by the tail" },
      { id: "a", role: "assistant", text: "pick me", createdAt: 1 },
      { id: "b", role: "tool", text: 'x,{"id":"q"}', tool: { l: [{ id: 1 }, { id: 2 }] } },
    ];
    const raw = JSON.stringify(msgs);
    assert.equal(lastAssistantFromTail(raw.slice(5)).text, "pick me");
    assert.equal(lastAssistantFromTail(JSON.stringify([msgs[2], msgs[2]]).slice(3)), undefined);
  });
});
