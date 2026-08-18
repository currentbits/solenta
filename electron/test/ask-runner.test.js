/**
 * Issue #392: Ask startRun never touches a worktree, never trips the
 * daily budget, and never records usage. Completions are injected.
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

describe("ask startRun", () => {
  let tmpDir;
  let store;
  let runner;
  let thread;
  let completeCalls;
  let prevBudget;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-ask-run-"));
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
      title: "New Thread",
    });
    services.startAsk(store, { threadId: thread.id });
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
    if (prevBudget !== undefined) {
      delete process.env.CODER_DAILY_BUDGET_USD;
    }
  });

  it("answers without a worktree and without recording spend", async () => {
    store.setSettings({ dailyBudgetUsd: 0.01 });
    store.recordSpend(1);
    store.recordUsage({
      provider: "claude",
      model: "sonnet",
      costUsd: 1,
      inputTokens: 10,
      outputTokens: 10,
    });
    store.saveNow();

    await runner.startRun({
      threadId: thread.id,
      prompt: "where is createThread",
    });

    await waitFor(() => store.getThread(thread.id).status === "done");

    const live = store.getThread(thread.id);
    assert.equal(live.ask, true);
    assert.equal(live.worktreePath ?? null, null);
    assert.notEqual(live.pendingWorktree, true);
    assert.equal(live.title, "where is createThread");
    assert.equal(completeCalls.length, 1);
    assert.match(completeCalls[0].prompt, /no tools/i);
    assert.match(completeCalls[0].prompt, /createThread/);
    assert.match(completeCalls[0].prompt, /Thread create/);

    const msgs = store.getMessages(thread.id);
    assert.ok(msgs.some((m) => m.role === "user" && m.text === "where is createThread"));
    assert.ok(
      msgs.some(
        (m) =>
          m.role === "assistant" &&
          String(m.text).includes("electron/services.js"),
      ),
    );

    // The $1 we recorded above is still the only spend — Ask added none.
    assert.equal(store.getSpendToday(), 1);
  });

  it("falls back to retrieval when no model answers", async () => {
    runner.stopAll();
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 20,
      userDataPath: path.join(tmpDir, "ud"),
      askComplete: async () => null,
      searchMemory: async () => [],
    });

    await runner.startRun({
      threadId: thread.id,
      prompt: "what is this repo",
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const msgs = store.getMessages(thread.id);
    const assistant = msgs.find((m) => m.role === "assistant");
    assert.ok(assistant);
    assert.match(assistant.text, /don't have a model/i);
    assert.ok(msgs.some((m) => m.role === "event" && /no model/i.test(m.text)));
  });

  it("does not intercept a normal thread", async () => {
    const plain = services.createThread(store, {
      projectId: thread.projectId,
      title: "Work",
    });
    store.saveNow();
    process.env.CODER_SIMULATE = "1";
    try {
      await runner.startRun({
        threadId: plain.id,
        prompt: "do the work",
      });
      assert.equal(store.getThread(plain.id).status, "working");
      assert.equal(completeCalls.length, 0);
    } finally {
      delete process.env.CODER_SIMULATE;
    }
  });
});
