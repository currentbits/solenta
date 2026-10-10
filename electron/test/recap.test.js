const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  RECAP_IDLE_MS,
  buildExtractiveRecap,
  refreshRecap,
} = require("../recap.js");
const { rmTree } = require("./support/rmTree.js");

const noFm = async () => null;

function seed(store, threadId) {
  const rows = [
    ["user", "Fix the flaky login test"],
    ["tool", "Edit: src/auth.spec.ts"],
    ["tool", "Bash: npm test"],
    ["tool", "Write: src/clock.ts"],
    ["user", "Also cover logout"],
    ["assistant", "Both tests pass now. Should I add a retry? It is cheap."],
  ];
  rows.forEach(([role, text], i) =>
    store.appendMessage(threadId, {
      id: `m${i}`,
      role,
      text,
      createdAt: i,
    }),
  );
}

describe("buildExtractiveRecap", () => {
  it("is empty without a user ask and an assistant reply", () => {
    assert.equal(buildExtractiveRecap([]), "");
    assert.equal(buildExtractiveRecap([{ role: "user", text: "hi" }]), "");
  });
});

describe("thread recap", () => {
  let tmpDir;
  let store;
  let thread;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-recap-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id });
    seed(store, thread.id);
  });

  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("caches an extractive recap when fm is unavailable", async () => {
    const recap = await refreshRecap(store, thread.id, { fmRun: noFm });
    assert.equal(
      recap.text,
      [
        "Asked: Fix the flaky login test",
        "Latest ask: Also cover logout",
        "Changed: src/auth.spec.ts, src/clock.ts",
        "Now: Both tests pass now. Should I add a retry? It is cheap.",
        "Open: Should I add a retry?",
      ].join("\n"),
    );
    assert.deepEqual(store.getThread(thread.id).recap, recap);
  });

  it("prefers fm prose when fm answers", async () => {
    const recap = await refreshRecap(store, thread.id, {
      fmRun: async () => "  Asked: fix login\nNow: done  ",
    });
    assert.equal(recap.text, "Asked: fix login\nNow: done");
  });

  it("drops a stale recap when a newer turn landed mid-build", async () => {
    const recap = await refreshRecap(store, thread.id, {
      fmRun: async () => {
        store.appendMessage(thread.id, {
          id: "late",
          role: "user",
          text: "more",
          createdAt: 99,
        });
        return null;
      },
    });
    assert.equal(recap, null);
    assert.equal(store.getThread(thread.id).recap, undefined);
  });

  it("threads.get shows the recap only after an idle gap", async () => {
    await refreshRecap(store, thread.id, { fmRun: noFm });
    store.updateThread(thread.id, { lastVisitedAt: Date.now() - 60_000 });
    assert.equal(services.getThreadDetail(store, thread.id).recap, undefined);

    store.updateThread(thread.id, {
      lastVisitedAt: Date.now() - RECAP_IDLE_MS - 1,
    });
    const visit = services.getThreadDetail(store, thread.id);
    assert.ok(visit.recap.text.startsWith("Asked:"));
    // That visit stamped lastVisitedAt; background pushes never carry it.
    assert.equal(services.getThreadDetail(store, thread.id).recap, undefined);
    assert.equal(
      services.getThreadDetail(store, thread.id, null, { markVisited: false })
        .recap,
      undefined,
    );
    // Sidebar rows stay lean.
    assert.ok(services.listThreads(store).every((t) => !("recap" in t)));
  });

  it("a fresh fork shows and is seeded with the source recap", async () => {
    await refreshRecap(store, thread.id, { fmRun: noFm });
    const fork = services.forkThread(store, { threadId: thread.id });
    const detail = services.getThreadDetail(store, fork.id);
    assert.equal(detail.recap.text, store.getThread(thread.id).recap.text);

    const prefix = services.buildHandoffPrefix(
      store.getThread(fork.id),
      (id) => store.getMessages(id),
      (id) => store.getThread(id),
    );
    assert.match(prefix, /Recap:\nAsked: Fix the flaky login test/);
  });
});
