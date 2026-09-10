/**
 * Issue #1217: threads:setMessagePins — persist bookmarks without bumping updatedAt.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  THREAD_MESSAGE_PINS_MAX,
  THREAD_MESSAGE_PIN_EXCERPT_MAX,
  THREAD_MESSAGE_PIN_LABEL_MAX,
} = require("../messagePins.js");

describe("setMessagePins", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pins-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Worker",
    }).id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createThread starts with an empty pin list", () => {
    assert.deepEqual(store.getThread(threadId).messagePins, []);
  });

  it("persists, caps, dedupes, and never bumps updatedAt", () => {
    const before = store.getThread(threadId).updatedAt;
    const long = "x".repeat(THREAD_MESSAGE_PIN_EXCERPT_MAX + 40);
    const updated = services.setMessagePins(store, {
      threadId,
      pins: [
        {
          messageId: "m1",
          excerpt: long,
          label: "L".repeat(THREAD_MESSAGE_PIN_LABEL_MAX + 10),
          pinnedAt: 1,
        },
        { messageId: "m1", excerpt: "dup", pinnedAt: 2 },
        { messageId: "  ", excerpt: "blank" },
      ],
    });
    assert.equal(updated.messagePins.length, 1);
    assert.equal(updated.messagePins[0].messageId, "m1");
    assert.ok(updated.messagePins[0].excerpt.length <= THREAD_MESSAGE_PIN_EXCERPT_MAX);
    assert.equal(
      updated.messagePins[0].label.length,
      THREAD_MESSAGE_PIN_LABEL_MAX,
    );
    assert.equal(updated.updatedAt, before);
    assert.equal(store.getThread(threadId).updatedAt, before);
  });

  it("caps the list at THREAD_MESSAGE_PINS_MAX", () => {
    const pins = [];
    for (let i = 0; i < THREAD_MESSAGE_PINS_MAX + 8; i++) {
      pins.push({ messageId: `m-${i}`, excerpt: `e${i}`, pinnedAt: i });
    }
    const updated = services.setMessagePins(store, { threadId, pins });
    assert.equal(updated.messagePins.length, THREAD_MESSAGE_PINS_MAX);
    assert.equal(updated.messagePins[0].messageId, "m-0");
  });

  it("throws on an unknown thread or non-array", () => {
    assert.throws(
      () => services.setMessagePins(store, { threadId: "nope", pins: [] }),
      /Unknown thread/,
    );
    assert.throws(
      () => services.setMessagePins(store, { threadId, pins: "nope" }),
      /pins must be an array/,
    );
  });

  it("round-trips through the store; missing pins upgrade to empty", () => {
    services.setMessagePins(store, {
      threadId,
      pins: [{ messageId: "m1", excerpt: "keep", pinnedAt: 1 }],
    });
    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getThread(threadId).messagePins[0].messageId, "m1");

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "store.json"), "utf8"),
    );
    delete raw.threads[0].messagePins;
    fs.writeFileSync(
      path.join(tmpDir, "store.json"),
      JSON.stringify(raw),
      "utf8",
    );
    const upgraded = new Store(path.join(tmpDir, "store.json"));
    assert.deepEqual(upgraded.getThread(threadId).messagePins, []);
  });

  it("rewind does not retarget a pin onto another message", () => {
    const t = store.getThread(threadId);
    store.appendMessage(threadId, {
      id: "u1",
      role: "user",
      text: "first",
      createdAt: 1,
    });
    store.appendMessage(threadId, {
      id: "a1",
      role: "assistant",
      text: "answer",
      createdAt: 2,
    });
    store.appendMessage(threadId, {
      id: "u2",
      role: "user",
      text: "second",
      createdAt: 3,
    });
    services.setMessagePins(store, {
      threadId,
      pins: [{ messageId: "a1", excerpt: "answer", pinnedAt: 2 }],
    });
    return services
      .rewindThread(store, {
        threadId,
        messageId: "u1",
        prompt: "edited",
      })
      .then(() => {
        const pins = store.getThread(t.id).messagePins;
        assert.equal(pins.length, 1);
        assert.equal(pins[0].messageId, "a1");
        const ids = store.getMessages(threadId).map((m) => m.id);
        assert.equal(ids.includes("a1"), false);
        assert.equal(ids.includes("u1"), false);
      });
  });
});
