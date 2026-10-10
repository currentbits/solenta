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
const { rmTree } = require("./support/rmTree.js");

async function waitFor(predicate, timeoutMs = 15000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Issue #166: global max-concurrent-runs with a FIFO run queue.
describe("run queue (maxConcurrentRuns)", () => {
  let tmpDir;
  let store;
  let runner;
  let ids;
  let prevSimulate;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-runq-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({ store, core, pushFn: () => {}, tickMs: 15 });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    ids = ["a", "b", "c"].map(
      (title) =>
        services.createThread(store, { projectId: project.id, title }).id,
    );
    store.setSettings({ maxConcurrentRuns: 1 });
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
  });

  it("defaults to 4 and validates", () => {
    assert.equal(new Store(path.join(tmpDir, "x.json")).getSettings().maxConcurrentRuns, 4);
    assert.throws(() => store.setSettings({ maxConcurrentRuns: 0 }));
    store.setSettings({ maxConcurrentRuns: null });
    assert.equal(store.getSettings().maxConcurrentRuns, null);
  });

  it("queues starts beyond the cap and admits them FIFO as runs settle", async () => {
    const [a, b, c] = ids;
    await runner.startRun({ threadId: a, prompt: "first" });
    assert.equal(store.getThread(a).status, "working");

    const rb = await runner.startRun({ threadId: b, prompt: "second" });
    const rc = await runner.startRun({ threadId: c, prompt: "third" });
    assert.equal(rb.queued, true);
    assert.equal(rc.queued, true);
    assert.ok(store.getThread(b).runQueue.at <= store.getThread(c).runQueue.at);
    assert.notEqual(store.getThread(b).status, "working");
    // The user's prompt is in the transcript even while waiting.
    assert.ok(
      store.getMessages(b).some((m) => m.role === "user" && m.text === "second"),
    );

    // a settles -> b (oldest) is admitted, c keeps waiting.
    await waitFor(() => store.getThread(b).status === "working");
    assert.equal(store.getThread(b).runQueue, null);
    assert.ok(store.getThread(c).runQueue);
    assert.equal(runner.listActiveThreadIds().length, 1);

    await waitFor(() => store.getThread(c).status === "done");
    // Admitted turns append the user message once, not twice.
    assert.equal(
      store.getMessages(b).filter((m) => m.role === "user").length,
      1,
    );
  });

  it("Stop on a queued thread leaves the queue without running it", async () => {
    const [a, b] = ids;
    await runner.startRun({ threadId: a, prompt: "first" });
    await runner.startRun({ threadId: b, prompt: "second" });
    assert.ok(store.getThread(b).runQueue);

    await runner.stopRun({ threadId: b });
    assert.equal(store.getThread(b).runQueue, null);
    await waitFor(() => store.getThread(a).status === "done");
    await new Promise((r) => setTimeout(r, 50));
    assert.notEqual(store.getThread(b).status, "working");
    assert.equal(store.getThread(b).status, "idle");
  });

  it("clearing the cap admits waiting turns", async () => {
    const [a, b] = ids;
    await runner.startRun({ threadId: a, prompt: "first" });
    await runner.startRun({ threadId: b, prompt: "second" });
    store.setSettings({ maxConcurrentRuns: null });
    runner.admitQueuedRuns();
    assert.equal(store.getThread(b).status, "working");
    assert.equal(runner.listActiveThreadIds().length, 2);
  });
});
