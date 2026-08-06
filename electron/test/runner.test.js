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

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("runner", () => {
  let tmpDir;
  let store;
  let runner;
  let pushes;
  let core;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-run-"));
    store = new Store(path.join(tmpDir, "store.json"));
    pushes = [];
    core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: (channel, payload) => {
        pushes.push({ channel, payload });
      },
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("startRun full lifecycle reaches done with assistant summary", async () => {
    const thread = store.getThreads()[0];
    const { workflowId } = await runner.startRun({
      threadId: thread.id,
      prompt: "Fix the flaky login test\nmore detail",
    });
    assert.ok(workflowId);
    assert.match(workflowId, /.+/);

    // title renamed from first line
    const renamed = store.getThreads().find((t) => t.id === thread.id);
    assert.equal(renamed.title, "Fix the flaky login test");
    assert.equal(renamed.status, "working");

    // user message appended
    const msgs = store.getMessages(thread.id);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].text, "Fix the flaky login test\nmore detail");

    await waitFor(() => {
      const t = store.getThreads().find((x) => x.id === thread.id);
      return t && t.status === "done";
    });

    const lastPush = [...pushes]
      .reverse()
      .find((p) => p.channel === "thread:updated");
    assert.ok(lastPush, "expected thread:updated push");
    const detail = lastPush.payload;
    assert.equal(detail.thread.status, "done");
    assert.ok(detail.workflow);
    assert.equal(detail.workflow.complete, true);
    assert.ok(detail.workflow.settled >= detail.workflow.total);
    assert.ok(detail.workflow.tokensTotal > 0);

    // name is ADJECTIVE-NOUN uppercase
    assert.match(detail.workflow.name, /^[A-Z]+-[A-Z]+$/);

    // phases: seed, analyze, verify, judge, synthesize
    assert.deepEqual(
      detail.workflow.phases.map((p) => p.name),
      ["seed", "analyze", "verify", "judge", "synthesize"],
    );
    assert.equal(
      detail.workflow.phases.find((p) => p.name === "verify").pipelined,
      true,
    );

    // work log has phase start and settle entries
    const labels = detail.workLog.map((w) => w.label);
    assert.ok(labels.some((l) => /Analyze started/i.test(l)));
    assert.ok(labels.some((l) => /settled|complete|done|finished/i.test(l)));

    // assistant summary message
    const assistant = detail.messages.filter((m) => m.role === "assistant");
    assert.ok(assistant.length >= 1);
    assert.ok(/token/i.test(assistant[assistant.length - 1].text));

    // runner still exposes completed workflow for threads:get
    assert.ok(runner.getActiveWorkflow(thread.id));
  });

  it("rejects startRun while a run is already active", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "first" });
    await assert.rejects(
      () => runner.startRun({ threadId: thread.id, prompt: "second" }),
      /already|running|active/i,
    );
    runner.stopRun({ threadId: thread.id });
  });

  it("stopRun mid-flight sets idle and appends event", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({
      threadId: thread.id,
      prompt: "Stop me please",
    });

    // wait until at least one tick has updated workflow
    await waitFor(() => {
      return pushes.some(
        (p) =>
          p.channel === "thread:updated" &&
          p.payload.workflow &&
          p.payload.workflow.settled >= 0,
      );
    });

    await runner.stopRun({ threadId: thread.id });

    const detail = services.getThreadDetail(store, thread.id);
    assert.equal(detail.thread.status, "idle");
    assert.ok(
      detail.messages.some(
        (m) => m.role === "event" && /stopped/i.test(m.text),
      ),
    );
    assert.ok(detail.workLog.some((w) => /stop/i.test(w.label)));

    // further ticks should not keep running
    const pushCount = pushes.length;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pushes.length, pushCount);
  });

  it("stopRun push detail workflow matches getActiveWorkflow / threads.get projection", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({
      threadId: thread.id,
      prompt: "Consistency check",
    });

    await waitFor(() =>
      pushes.some(
        (p) =>
          p.channel === "thread:updated" &&
          p.payload.workflow &&
          p.payload.thread.status === "working",
      ),
    );

    await runner.stopRun({ threadId: thread.id });

    const stopPush = [...pushes]
      .reverse()
      .find(
        (p) =>
          p.channel === "thread:updated" &&
          p.payload.thread.status === "idle",
      );
    assert.ok(stopPush, "expected thread:updated with idle status after stop");

    const fromGet = runner.getActiveWorkflow(thread.id);
    const pushWorkflow = stopPush.payload.workflow;

    // Both paths must agree: either both null, or same workflow id.
    if (pushWorkflow === null) {
      assert.equal(fromGet, null);
    } else {
      assert.ok(fromGet, "getActiveWorkflow must not return null if push had workflow");
      assert.equal(fromGet.id, pushWorkflow.id);
      const projected = runner.toWorkflowView(fromGet);
      assert.equal(projected.id, pushWorkflow.id);
      assert.equal(projected.name, pushWorkflow.name);
      assert.equal(projected.total, pushWorkflow.total);
    }

    assert.ok(
      stopPush.payload.messages.some(
        (m) => m.role === "event" && /stopped/i.test(m.text),
      ),
    );
  });

  it("tick error path pushes thread detail with failed status and Run error event", async () => {
    const failingCore = {
      ...core,
      tick() {
        throw new Error("simulated tick boom");
      },
    };
    const failPushes = [];
    const failRunner = createRunner({
      store,
      core: failingCore,
      pushFn: (channel, payload) => {
        failPushes.push({ channel, payload });
      },
      tickMs: 15,
    });

    const thread = store.getThreads()[0];
    // startRun uses createWorkflow from failingCore (same as real); first tick throws
    await failRunner.startRun({
      threadId: thread.id,
      prompt: "will error",
    });

    await waitFor(() => {
      const t = store.getThreads().find((x) => x.id === thread.id);
      return t && t.status === "failed";
    });

    const detailPush = [...failPushes]
      .reverse()
      .find((p) => p.channel === "thread:updated");
    assert.ok(detailPush, "expected thread:updated on tick error");
    assert.equal(detailPush.payload.thread.status, "failed");
    assert.ok(
      detailPush.payload.messages.some(
        (m) => m.role === "event" && /Run error/i.test(m.text),
      ),
    );
    assert.ok(
      failPushes.some((p) => p.channel === "threads:changed"),
      "still broadcast threads:changed",
    );

    failRunner.stopAll();
  });

  it("workflow name is deterministic for the same threadId", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "a" });
    await waitFor(() =>
      pushes.some((p) => p.channel === "thread:updated" && p.payload.workflow),
    );
    const name1 = pushes.find(
      (p) => p.channel === "thread:updated" && p.payload.workflow,
    ).payload.workflow.name;
    await runner.stopRun({ threadId: thread.id });

    // second run same thread should pick same name from hash of threadId
    pushes.length = 0;
    await runner.startRun({ threadId: thread.id, prompt: "b" });
    await waitFor(() =>
      pushes.some((p) => p.channel === "thread:updated" && p.payload.workflow),
    );
    const name2 = pushes.find(
      (p) => p.channel === "thread:updated" && p.payload.workflow,
    ).payload.workflow.name;
    assert.equal(name1, name2);
    await runner.stopRun({ threadId: thread.id });
  });
});
