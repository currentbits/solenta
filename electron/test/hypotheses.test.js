const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store } = require("../store.js");
const {
  recordHypothesis,
  hypothesisNoteFor,
  HYPOTHESES_MAX,
  HYPOTHESIS_CLAIM_MAX,
  HYPOTHESIS_REASON_MAX,
} = require("../services.js");
const { createToolHandlers } = require("../orchServer.js");

/**
 * @param {Partial<object>} overrides
 */
function makeThread(overrides = {}) {
  return {
    id: "t1",
    projectId: "p1",
    title: "Hello",
    status: "idle",
    createdAt: 1,
    updatedAt: 1_700_000_000_000,
    handoffFrom: null,
    ...overrides,
  };
}

/** Fake store over plain data, matching the Store read/write API. */
function makeFakeStore(threads, projects) {
  const list = threads.slice();
  const proj = projects || {
    p1: { id: "p1", name: "Alpha" },
    p2: { id: "p2", name: "Beta" },
  };
  return {
    getThreads: () => list,
    getThread: (id) => list.find((t) => t.id === id) || null,
    getProject: (id) => proj[id] || null,
    getMessages: () => [],
    updateThread: (id, patch) => {
      const t = list.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
      return t || null;
    },
    save: () => {},
    threads: list,
  };
}

describe("recordHypothesis", () => {
  let tmpDir;
  /** @type {Store} */
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-hypo-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setThreads([makeThread()]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends a trimmed entry and returns it", () => {
    const entry = recordHypothesis(store, {
      threadId: "t1",
      claim: "  try the cache  ",
      status: "invalidated",
      reason: "  miss rate stayed high  ",
    });
    assert.equal(entry.claim, "try the cache");
    assert.equal(entry.status, "invalidated");
    assert.equal(entry.reason, "miss rate stayed high");
    assert.ok(typeof entry.id === "string" && entry.id.length > 0);
    assert.ok(typeof entry.at === "number" && entry.at > 0);
    const thread = store.getThread("t1");
    assert.equal(thread.hypotheses.length, 1);
    assert.deepEqual(thread.hypotheses[0], entry);
  });

  it("defaults a missing reason to an empty string", () => {
    const entry = recordHypothesis(store, {
      threadId: "t1",
      claim: "try A",
      status: "validated",
    });
    assert.equal(entry.reason, "");
  });

  it("rejects an unknown thread", () => {
    assert.throws(
      () =>
        recordHypothesis(store, {
          threadId: "ghost",
          claim: "x",
          status: "validated",
        }),
      /Unknown thread: ghost/,
    );
  });

  it("rejects a status outside the three allowed values", () => {
    assert.throws(
      () =>
        recordHypothesis(store, {
          threadId: "t1",
          claim: "x",
          status: "maybe",
        }),
      /validated, invalidated, inconclusive/,
    );
  });

  it("rejects a blank claim", () => {
    assert.throws(
      () =>
        recordHypothesis(store, {
          threadId: "t1",
          claim: "   ",
          status: "validated",
        }),
      /claim must not be empty/,
    );
  });

  it("truncates claim and reason to the contract caps", () => {
    const entry = recordHypothesis(store, {
      threadId: "t1",
      claim: "c".repeat(HYPOTHESIS_CLAIM_MAX + 20),
      status: "inconclusive",
      reason: "r".repeat(HYPOTHESIS_REASON_MAX + 20),
    });
    assert.equal(entry.claim.length, HYPOTHESIS_CLAIM_MAX);
    assert.equal(entry.reason.length, HYPOTHESIS_REASON_MAX);
  });

  it("caps the ledger at 50 and drops the oldest", () => {
    for (let i = 0; i < HYPOTHESES_MAX + 3; i++) {
      recordHypothesis(store, {
        threadId: "t1",
        claim: `claim-${i}`,
        status: "invalidated",
      });
    }
    const hyps = store.getThread("t1").hypotheses;
    assert.equal(hyps.length, HYPOTHESES_MAX);
    assert.equal(hyps[0].claim, "claim-3");
    assert.equal(hyps[hyps.length - 1].claim, `claim-${HYPOTHESES_MAX + 2}`);
  });

  it("does not bump updatedAt", () => {
    store.updateThread("t1", { updatedAt: 1_700_000_000_000 });
    recordHypothesis(store, {
      threadId: "t1",
      claim: "x",
      status: "validated",
    });
    assert.equal(store.getThread("t1").updatedAt, 1_700_000_000_000);
  });

  it("gives two same-millisecond writes distinct ids", () => {
    const a = recordHypothesis(store, {
      threadId: "t1",
      claim: "one",
      status: "invalidated",
    });
    const b = recordHypothesis(store, {
      threadId: "t1",
      claim: "two",
      status: "invalidated",
    });
    assert.notEqual(a.id, b.id);
    const ids = new Set(store.getThread("t1").hypotheses.map((h) => h.id));
    assert.equal(ids.size, 2);
  });
});

describe("hypothesisNoteFor", () => {
  it("returns empty when the thread has no hypotheses", () => {
    assert.equal(hypothesisNoteFor(makeThread(), () => null), "");
    assert.equal(hypothesisNoteFor(null, () => null), "");
  });

  it("returns empty when only validated or inconclusive entries exist", () => {
    const thread = makeThread({
      hypotheses: [
        { claim: "A", status: "validated", reason: "worked" },
        { claim: "B", status: "inconclusive", reason: "flaky" },
      ],
    });
    assert.equal(hypothesisNoteFor(thread, () => null), "");
  });

  it("lists invalidated entries newest first", () => {
    const thread = makeThread({
      hypotheses: [
        { claim: "old dead end", status: "invalidated", reason: "threw" },
        { claim: "winner", status: "validated", reason: "green" },
        { claim: "new dead end", status: "invalidated", reason: "timeout" },
      ],
    });
    const note = hypothesisNoteFor(thread, () => null);
    assert.match(note, /^(\n\n)?\[Ruled out\]/);
    assert.match(note, /hypothesis_record/);
    const first = note.indexOf("new dead end");
    const second = note.indexOf("old dead end");
    assert.ok(first >= 0 && second >= 0 && first < second);
    assert.match(note, /new dead end — timeout/);
    assert.match(note, /old dead end — threw/);
    assert.doesNotMatch(note, /winner/);
  });

  it("omits the reason tail when reason is empty", () => {
    const thread = makeThread({
      hypotheses: [{ claim: "bare", status: "invalidated", reason: "" }],
    });
    const note = hypothesisNoteFor(thread, () => null);
    assert.match(note, /- bare$/m);
    assert.doesNotMatch(note, /bare —/);
  });

  it("walks handoffFrom ancestors", () => {
    const parent = makeThread({
      id: "parent",
      hypotheses: [
        { claim: "ancestor fail", status: "invalidated", reason: "nope" },
      ],
    });
    const child = makeThread({
      id: "child",
      handoffFrom: "parent",
      hypotheses: [
        { claim: "child fail", status: "invalidated", reason: "also" },
      ],
    });
    const note = hypothesisNoteFor(child, (id) =>
      id === "parent" ? parent : null,
    );
    assert.match(note, /child fail — also/);
    assert.match(note, /ancestor fail — nope/);
    const childAt = note.indexOf("child fail");
    const parentAt = note.indexOf("ancestor fail");
    assert.ok(childAt >= 0 && parentAt >= 0 && childAt < parentAt);
  });

  it("de-duplicates by claim, keeping the newest", () => {
    const parent = makeThread({
      id: "parent",
      hypotheses: [
        { claim: "same idea", status: "invalidated", reason: "old reason" },
      ],
    });
    const child = makeThread({
      id: "child",
      handoffFrom: "parent",
      hypotheses: [
        { claim: "same idea", status: "invalidated", reason: "new reason" },
      ],
    });
    const note = hypothesisNoteFor(child, (id) =>
      id === "parent" ? parent : null,
    );
    assert.match(note, /same idea — new reason/);
    assert.doesNotMatch(note, /old reason/);
    assert.equal((note.match(/same idea/g) || []).length, 1);
  });

  it("caps the note at 10 lines", () => {
    const hyps = [];
    for (let i = 0; i < 15; i++) {
      hyps.push({
        claim: `claim-${i}`,
        status: "invalidated",
        reason: "x",
      });
    }
    const note = hypothesisNoteFor(makeThread({ hypotheses: hyps }), () => null);
    const bullets = note.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(bullets.length, 10);
    assert.match(note, /claim-14/);
    assert.doesNotMatch(note, /claim-4/);
  });

  it("does not hang on a handoffFrom cycle", () => {
    const a = makeThread({
      id: "a",
      handoffFrom: "b",
      hypotheses: [{ claim: "from-a", status: "invalidated", reason: "" }],
    });
    const b = makeThread({
      id: "b",
      handoffFrom: "a",
      hypotheses: [{ claim: "from-b", status: "invalidated", reason: "" }],
    });
    const byId = { a, b };
    const note = hypothesisNoteFor(a, (id) => byId[id] || null);
    assert.match(note, /from-a/);
    assert.match(note, /from-b/);
    assert.equal((note.match(/from-a/g) || []).length, 1);
  });
});

describe("hypothesis_record MCP tool", () => {
  function makeDeps() {
    const threads = [
      makeThread({ id: "t1", projectId: "p1", title: "First" }),
      makeThread({ id: "t3", projectId: "p2", title: "Other" }),
    ];
    return {
      store: makeFakeStore(threads),
      runner: { startRun: async () => ({}) },
      forkThread: () => ({ id: "fork-1" }),
      getProvider: () => null,
    };
  }

  it("writes the entry to the store", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.hypothesis_record({
      threadId: "t1",
      projectId: "p1",
      claim: "try the cache",
      status: "invalidated",
      reason: "missed",
    });
    assert.deepEqual(out, { recorded: true, total: 1 });
    const hyps = deps.store.getThread("t1").hypotheses;
    assert.equal(hyps.length, 1);
    assert.equal(hyps[0].claim, "try the cache");
    assert.equal(hyps[0].status, "invalidated");
    assert.equal(hyps[0].reason, "missed");
  });

  it("rejects a cross-project threadId", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.hypothesis_record({
          threadId: "t3",
          projectId: "p1",
          claim: "x",
          status: "validated",
        }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    assert.equal(deps.store.getThread("t3").hypotheses, undefined);
  });
});
