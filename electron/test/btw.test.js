/**
 * Issue #471: `/btw` parse, cards, promote, crash-heal.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  parseBtwCommand,
  normalizeBtwQuestion,
  buildBtwPrompt,
  normalizeBtwCards,
  BTW_RUNNING_MAX,
} = require("../btw.js");

describe("parseBtwCommand", () => {
  it("returns the question after /btw", () => {
    assert.equal(
      parseBtwCommand("/btw where is createThread"),
      "where is createThread",
    );
  });

  it("returns null for a bare /btw and for other commands", () => {
    assert.equal(parseBtwCommand("/btw"), null);
    assert.equal(parseBtwCommand("/advisor why"), null);
  });
});

describe("normalizeBtwQuestion", () => {
  it("strips a leading /btw", () => {
    assert.equal(
      normalizeBtwQuestion("/btw which file"),
      "which file",
    );
  });

  it("accepts a bare question", () => {
    assert.equal(normalizeBtwQuestion("which file"), "which file");
  });

  it("rejects empty", () => {
    assert.equal(normalizeBtwQuestion(""), null);
    assert.equal(normalizeBtwQuestion("/btw"), null);
  });
});

describe("buildBtwPrompt", () => {
  it("names the side-question contract", () => {
    const text = buildBtwPrompt({ question: "where is createThread" });
    assert.match(text, /Side question/);
    assert.match(text, /do not continue/i);
    assert.match(text, /where is createThread/);
    assert.match(text, /no tools/i);
  });
});

describe("normalizeBtwCards", () => {
  it("heals a running card after crash", () => {
    const out = normalizeBtwCards([
      {
        id: "b1",
        question: "where",
        status: "running",
        createdAt: 1,
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "error");
    assert.equal(out[0].error, "Interrupted");
  });

  it("drops junk and empty", () => {
    assert.equal(normalizeBtwCards(null), undefined);
    assert.equal(normalizeBtwCards([{ id: "x" }]), undefined);
  });
});

describe("btw cards on the store", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-btw-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([{ id: "p1", path: tmpDir, name: "app", slug: "app" }]);
    const thread = services.createThread(store, {
      projectId: "p1",
      title: "Work",
    });
    threadId = thread.id;
    store.saveNow();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("addBtw opens a running card without bumping updatedAt", () => {
    const before = store.getThread(threadId).updatedAt;
    const { thread, card } = services.addBtw(store, {
      threadId,
      question: "where is createThread",
    });
    assert.equal(card.status, "running");
    assert.equal(card.question, "where is createThread");
    assert.equal(thread.btw.length, 1);
    assert.equal(store.getThread(threadId).updatedAt, before);
    assert.equal(store.getThread(threadId).status, "idle");
  });

  it("finishBtw writes the answer", () => {
    const { card } = services.addBtw(store, {
      threadId,
      question: "where",
    });
    const next = services.finishBtw(store, {
      threadId,
      id: card.id,
      answer: "electron/services.js",
      source: "fm",
    });
    assert.equal(next.btw[0].status, "done");
    assert.equal(next.btw[0].answer, "electron/services.js");
    assert.equal(next.btw[0].source, "fm");
  });

  it("dismissBtw drops the card", () => {
    const { card } = services.addBtw(store, {
      threadId,
      question: "where",
    });
    const next = services.dismissBtw(store, { threadId, id: card.id });
    assert.equal(next.btw, undefined);
  });

  it("promoteBtw queues the question and drops the card", () => {
    const { card } = services.addBtw(store, {
      threadId,
      question: "where is it",
    });
    services.finishBtw(store, {
      threadId,
      id: card.id,
      answer: "in services.js",
    });
    const next = services.promoteBtw(store, { threadId, id: card.id });
    assert.equal(next.btw, undefined);
    assert.match(next.queued.prompt, /where is it/);
    assert.match(next.queued.prompt, /in services.js/);
  });

  it("rejects a fourth in-flight card", () => {
    for (let i = 0; i < BTW_RUNNING_MAX; i += 1) {
      services.addBtw(store, { threadId, question: `q${i}` });
    }
    assert.throws(
      () => services.addBtw(store, { threadId, question: "too many" }),
      /in flight/,
    );
  });

  it("heals running cards on store load", () => {
    const { card } = services.addBtw(store, {
      threadId,
      question: "where",
    });
    store.saveNow();
    const reloaded = new Store(store.filePath);
    const live = reloaded.getThread(threadId);
    const healed = (live.btw || []).find((c) => c.id === card.id);
    assert.ok(healed);
    assert.equal(healed.status, "error");
    assert.equal(healed.error, "Interrupted");
  });
});
