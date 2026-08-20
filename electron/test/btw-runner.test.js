/**
 * Issue #471: `/btw` does not occupy the live turn, does not queue, and
 * does not write a worktree. Completions are injected.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const v = fn();
        if (v) return resolve(v);
      } catch {
        /* keep waiting */
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("timed out"));
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

describe("btw startRun", () => {
  let tmpDir;
  let store;
  let runner;
  let thread;
  let completeCalls;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-btw-run-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "Work",
    });
    store.updateThread(thread.id, { pendingWorktree: true });
    store.saveNow();

    completeCalls = [];
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 20,
      userDataPath: path.join(tmpDir, "ud"),
      askComplete: async (opts) => {
        completeCalls.push(opts);
        return { text: "createThread lives in electron/services.js", source: "fm" };
      },
      searchMemory: async () => [
        { title: "Thread create", body: "createThread is in services.js" },
      ],
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    runner = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("answers on a card without a worktree, transcript, or spend", async () => {
    store.setSettings({ dailyBudgetUsd: 0.01 });
    store.recordSpend(1);
    store.saveNow();

    const beforeStatus = store.getThread(thread.id).status;
    await runner.startRun({
      threadId: thread.id,
      prompt: "/btw where is createThread",
    });

    await waitFor(() => {
      const cards = store.getThread(thread.id).btw || [];
      return cards[0] && cards[0].status === "done";
    });

    const live = store.getThread(thread.id);
    assert.equal(live.status, beforeStatus);
    assert.equal(live.worktreePath ?? null, null);
    assert.equal(live.pendingWorktree, true);
    assert.equal(live.btw.length, 1);
    assert.equal(live.btw[0].question, "where is createThread");
    assert.match(live.btw[0].answer, /electron\/services\.js/);
    assert.equal(completeCalls.length, 1);
    assert.match(completeCalls[0].prompt, /Side question/);
    assert.match(completeCalls[0].prompt, /createThread/);

    const msgs = store.getMessages(thread.id);
    assert.equal(msgs.length, 0);
    assert.equal(store.getSpendToday(), 1);
    assert.equal(runner.isRunning(thread.id), false);
  });

  it("runs beside an active turn and does not throw already-active", async () => {
    process.env.CODER_SIMULATE = "1";
    try {
      await runner.startRun({
        threadId: thread.id,
        prompt: "do the work",
      });
      assert.equal(store.getThread(thread.id).status, "working");
      assert.equal(runner.isRunning(thread.id), true);

      await runner.startRun({
        threadId: thread.id,
        prompt: "/btw what file is that in",
      });
      await waitFor(() => {
        const cards = store.getThread(thread.id).btw || [];
        return cards[0] && cards[0].status === "done";
      });

      const live = store.getThread(thread.id);
      assert.equal(live.status, "working");
      assert.equal(runner.isRunning(thread.id), true);
      assert.equal(live.queued, null);
      assert.equal(live.btw[0].question, "what file is that in");
    } finally {
      delete process.env.CODER_SIMULATE;
    }
  });

  it("startBtw is the same path as the /btw intercept", async () => {
    await runner.startBtw({
      threadId: thread.id,
      question: "where is addBtw",
    });
    await waitFor(() => {
      const cards = store.getThread(thread.id).btw || [];
      return cards[0] && cards[0].status === "done";
    });
    assert.equal(store.getThread(thread.id).btw[0].question, "where is addBtw");
  });

  it("dismiss kills an in-flight complete", async () => {
    let resolveComplete;
    const pending = new Promise((resolve) => {
      resolveComplete = resolve;
    });
    runner.stopAll();
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 20,
      userDataPath: path.join(tmpDir, "ud"),
      askComplete: async () => {
        await pending;
        return { text: "too late", source: "fm" };
      },
      searchMemory: async () => [],
    });

    const opened = await runner.startBtw({
      threadId: thread.id,
      question: "where",
    });
    const id = opened.btw[0].id;
    const dismissed = runner.cancelBtw({ threadId: thread.id, id });
    assert.equal(dismissed.btw, undefined);
    resolveComplete();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(store.getThread(thread.id).btw, undefined);
  });
});
