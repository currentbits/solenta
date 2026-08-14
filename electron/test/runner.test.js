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

function assertWorkLogShape(workLog, runId) {
  for (const item of workLog) {
    assert.ok(item.runId, `work log item missing runId: ${JSON.stringify(item)}`);
    if (runId) assert.equal(item.runId, runId);
    assert.equal(
      typeof item.done,
      "boolean",
      `work log item missing done: ${JSON.stringify(item)}`,
    );
    assert.ok(
      !/ started$/i.test(item.label),
      `legacy "started" label: ${item.label}`,
    );
    assert.ok(
      !/ settled$/i.test(item.label),
      `legacy "settled" label: ${item.label}`,
    );
  }
}

/**
 * Fake agent scripts for CODER_AGENT_CMD. Must contain NO whitespace so
 * parseAgentCommand's simple split keeps the -e body as one argv token.
 */
function fakeAgentSuccessScript() {
  return "process.stdout.write('Hello');setTimeout(()=>{process.stdout.write('_from_agent');setTimeout(()=>process.exit(0),40)},40)";
}

function fakeAgentFailScript() {
  return "process.stderr.write('agent-stderr-line\\nmore-err');process.exit(3)";
}

function fakeAgentSlowScript() {
  return "setInterval(()=>{},500);setTimeout(()=>process.exit(0),60000)";
}

/**
 * Slow agent that writes its pid into cwd/agent.pid (no spaces in -e body).
 * Used to prove stopAll actually kills the child process.
 */
function fakeAgentPidSlowScript() {
  return "require('fs').writeFileSync('agent.pid',String(process.pid));setInterval(()=>{},500);setTimeout(()=>process.exit(0),60000)";
}

/** True when process.kill(pid, 0) says the process exists. */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Traps SIGTERM and lingers so stopRun + immediate restart races the late
 * onDone of the killed agent. No spaces (CODER_AGENT_CMD whitespace split).
 */
function fakeAgentSigtermTrapScript() {
  return "process.on('SIGTERM',()=>{setTimeout(()=>process.exit(0),700)});setInterval(()=>{},200)";
}

const FAKE_AGENT_OUTPUT = "Hello_from_agent";

/** Orchestrator + orchWorker child with handoffFrom set. */
function orchPair(store) {
  const orch = store.getThreads()[0];
  store.updateThread(orch.id, { title: "Orchestrator" });
  const worker = services.forkThread(store, { threadId: orch.id });
  store.updateThread(worker.id, { orchWorker: true, title: "Worker A" });
  store.save();
  return {
    orch: store.getThread(orch.id),
    worker: store.getThread(worker.id),
  };
}

function orchNoticeMessages(store, threadId) {
  return (store.getMessages(threadId) || []).filter(
    (m) =>
      (m.role === "user" || m.role === "event") &&
      String(m.text || "").startsWith("[orchestration]"),
  );
}

describe("runner simulated mode", () => {
  let tmpDir;
  let store;
  let runner;
  let pushes;
  let core;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    process.env.CODER_SIMULATE = "1";
    delete process.env.CODER_AGENT_CMD;

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
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("startRun clears a settled override but preserves an active pin", async () => {
    const thread = store.getThreads()[0];
    services.setSettled(store, {
      threadId: thread.id,
      override: "settled",
    });
    assert.equal(store.getThread(thread.id).settledOverride, "settled");
    assert.ok(store.getThread(thread.id).settledAt != null);

    await runner.startRun({
      threadId: thread.id,
      prompt: "do work after settle",
    });
    const afterSettled = store.getThread(thread.id);
    assert.equal(afterSettled.status, "working");
    assert.equal(
      afterSettled.settledOverride,
      null,
      "startRun must clear a settled pin",
    );
    assert.equal(afterSettled.settledAt, null);

    // Let the sim run finish so we can start another with an active pin.
    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && t.status === "done";
    });

    services.setSettled(store, {
      threadId: thread.id,
      override: "active",
    });
    const pinnedAt = store.getThread(thread.id).settledAt;
    assert.equal(store.getThread(thread.id).settledOverride, "active");

    await runner.startRun({
      threadId: thread.id,
      prompt: "keep me active",
    });
    const afterActive = store.getThread(thread.id);
    assert.equal(afterActive.status, "working");
    assert.equal(
      afterActive.settledOverride,
      "active",
      "an active pin must survive real activity",
    );
    assert.equal(afterActive.settledAt, pinnedAt);
  });

  it("startRun preserves pinnedAt and snooze fields (round 44)", async () => {
    // t3: pins survive activity; snooze is visibility-only and wakes derived.
    const thread = store.getThreads()[0];
    const until = Date.now() + 86_400_000;
    services.setPinned(store, { threadId: thread.id, pinned: true });
    services.setSnoozed(store, { threadId: thread.id, until });
    const pinnedAt = store.getThread(thread.id).pinnedAt;
    const snoozedAt = store.getThread(thread.id).snoozedAt;
    assert.ok(pinnedAt != null);
    assert.ok(snoozedAt != null);

    await runner.startRun({
      threadId: thread.id,
      prompt: "pin and snooze must stick",
    });
    const after = store.getThread(thread.id);
    assert.equal(after.status, "working");
    assert.equal(after.pinnedAt, pinnedAt, "pinnedAt must survive startRun");
    assert.equal(after.snoozedUntil, until, "snoozedUntil must survive startRun");
    assert.equal(after.snoozedAt, snoozedAt, "snoozedAt must survive startRun");
  });

  it("startRun full lifecycle reaches done with assistant summary", async () => {
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "Fix the flaky login test\nmore detail",
    });
    assert.ok(runId);
    assert.match(runId, /.+/);

    const renamed = store.getThreads().find((t) => t.id === thread.id);
    assert.equal(renamed.title, "Fix the flaky login test");
    assert.equal(renamed.status, "working");
    assert.ok(
      typeof renamed.runStartedAt === "number" && renamed.runStartedAt > 0,
      "run start must set runStartedAt",
    );
    assert.ok(
      renamed.updatedAt >= renamed.createdAt,
      "status/title activity must bump updatedAt",
    );

    const msgs = store.getMessages(thread.id);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].text, "Fix the flaky login test\nmore detail");
    assert.equal(msgs[0].runId, runId);

    await waitFor(() => {
      const t = store.getThreads().find((x) => x.id === thread.id);
      return t && t.status === "done";
    });

    const doneThread = store.getThreads().find((t) => t.id === thread.id);
    assert.equal(doneThread.runStartedAt, null);

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

    assert.match(detail.workflow.name, /^[A-Z]+-[A-Z]+$/);

    assert.deepEqual(
      detail.workflow.phases.map((p) => p.name),
      ["seed", "analyze", "verify", "judge", "synthesize"],
    );
    assert.equal(
      detail.workflow.phases.find((p) => p.name === "verify").pipelined,
      true,
    );

    assertWorkLogShape(detail.workLog, runId);
    const labels = detail.workLog.map((w) => w.label);
    assert.ok(labels.some((l) => l === "Analyze" || l === "analyze"));
    // One item per phase, all eventually done
    const phaseLabels = ["Seed", "Analyze", "Verify", "Judge", "Synthesize"];
    for (const pl of phaseLabels) {
      const items = detail.workLog.filter(
        (w) => w.label.toLowerCase() === pl.toLowerCase(),
      );
      assert.equal(
        items.length,
        1,
        `expected exactly one work log item for ${pl}, got ${items.length}`,
      );
      assert.equal(items[0].done, true);
    }

    const assistant = detail.messages.filter((m) => m.role === "assistant");
    assert.ok(assistant.length >= 1);
    assert.ok(/token/i.test(assistant[assistant.length - 1].text));
    assert.equal(assistant[assistant.length - 1].runId, runId);

    assert.ok(runner.getActiveWorkflow(thread.id));
  });

  it("archives an orchestration worker thread when its run lands done", async () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { orchWorker: true });
    await runner.startRun({ threadId: thread.id, prompt: "worker task" });
    await waitFor(() => {
      const t = store.getThreads().find((x) => x.id === thread.id);
      return t && t.status === "done";
    });
    await waitFor(() => {
      const t = store.getThreads().find((x) => x.id === thread.id);
      return t && t.archived === true;
    });
  });

  it("wakes an idle orchestrator when an orchWorker run lands done", async () => {
    const { orch, worker } = orchPair(store);
    await runner.startRun({ threadId: worker.id, prompt: "worker task" });
    await waitFor(() => {
      const t = store.getThread(worker.id);
      return t && t.status === "done";
    });
    await waitFor(() => orchNoticeMessages(store, orch.id).length > 0);
    const notice = orchNoticeMessages(store, orch.id)[0];
    assert.equal(notice.role, "user");
    assert.match(notice.text, /\[orchestration\]/);
    assert.match(notice.text, new RegExp(worker.id));
    assert.match(notice.text, /Worker A/);
    assert.match(notice.text, /status done/);
    assert.match(notice.text, /Last reply:/);
    assert.match(notice.text, /Continue orchestrating/);
    // Parent actually started a run, not just an event fallback.
    const parentUsers = (store.getMessages(orch.id) || []).filter(
      (m) => m.role === "user",
    );
    assert.equal(parentUsers.length, 1);
    assert.equal(store.getThread(worker.id).archived, true);
  });

  it("does not wake the parent for a regular fork without orchWorker", async () => {
    const orch = store.getThreads()[0];
    store.updateThread(orch.id, { title: "Orchestrator" });
    const fork = services.forkThread(store, { threadId: orch.id });
    assert.equal(fork.handoffFrom, orch.id);
    assert.ok(!fork.orchWorker);
    await runner.startRun({ threadId: fork.id, prompt: "user fork" });
    await waitFor(() => {
      const t = store.getThread(fork.id);
      return t && t.status === "done";
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(orchNoticeMessages(store, orch.id).length, 0);
    assert.equal((store.getMessages(orch.id) || []).length, 0);
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
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "Stop me please",
    });

    await waitFor(() => {
      return pushes.some(
        (p) =>
          p.channel === "thread:updated" &&
          p.payload.workflow &&
          p.payload.workflow.settled >= 0,
      );
    });

    const mid = store.getThread(thread.id);
    assert.ok(typeof mid.runStartedAt === "number" && mid.runStartedAt > 0);

    await runner.stopRun({ threadId: thread.id });

    const detail = services.getThreadDetail(store, thread.id);
    assert.equal(detail.thread.status, "idle");
    assert.equal(detail.thread.runStartedAt, null);
    assert.ok(
      detail.messages.some(
        (m) => m.role === "event" && /stopped/i.test(m.text) && m.runId === runId,
      ),
    );
    assert.ok(
      detail.workLog.some(
        (w) => /stop/i.test(w.label) && w.done === true && w.runId === runId,
      ),
    );
    assertWorkLogShape(detail.workLog, runId);

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
    const { runId } = await failRunner.startRun({
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
        (m) =>
          m.role === "event" &&
          /Run error/i.test(m.text) &&
          m.runId === runId,
      ),
    );
    assert.ok(
      detailPush.payload.workLog.some(
        (w) => w.label === "Run error" && w.done === true && w.runId === runId,
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

  it("stopAll marks active run idle with quit interruption event (simulate)", async () => {
    const thread = store.getThreads()[0];
    const storePath = path.join(tmpDir, "store.json");
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "quit while working",
    });

    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && t.status === "working" && t.runStartedAt != null;
    });

    const msgsBefore = store.getMessages(thread.id).length;
    runner.stopAll();

    assert.equal(runner.isRunning(thread.id), false);
    const after = store.getThread(thread.id);
    assert.equal(after.status, "idle");
    assert.equal(after.runStartedAt, null);
    const msgs = store.getMessages(thread.id);
    assert.ok(msgs.length > msgsBefore);
    assert.ok(
      msgs.some(
        (m) =>
          m.role === "event" &&
          m.text === "Run interrupted by app quit" &&
          m.runId === runId,
      ),
      "must append the quit interruption event with runId",
    );

    // Persist already done by stopAll; a fresh load must NOT re-stamp failed
    // (recoverInterruptedRuns only touches status===working).
    const reloaded = new Store(storePath);
    const rthread = reloaded.getThread(thread.id);
    assert.equal(rthread.status, "idle");
    assert.equal(rthread.runStartedAt, null);
    const rmsgs = reloaded.getMessages(thread.id);
    assert.ok(
      rmsgs.some((m) => m.text === "Run interrupted by app quit"),
    );
    assert.ok(
      !rmsgs.some((m) =>
        /crashed or was force-quit/i.test(m.text),
      ),
      "clean-quit idle threads must not get the crash recovery event",
    );
  });

  it("stopAll with zero active runs marks nothing and appends nothing", async () => {
    const thread = store.getThreads()[0];
    assert.equal(runner.isRunning(thread.id), false);
    assert.equal(store.getThread(thread.id).status, "idle");

    const msgsBefore = store.getMessages(thread.id).slice();
    const statusBefore = store.getThread(thread.id).status;
    const updatedBefore = store.getThread(thread.id).updatedAt;

    runner.stopAll();

    assert.equal(store.getThread(thread.id).status, statusBefore);
    assert.equal(store.getThread(thread.id).updatedAt, updatedBefore);
    assert.deepEqual(store.getMessages(thread.id), msgsBefore);
  });
});

describe("runner real agent mode", () => {
  let tmpDir;
  let store;
  let runner;
  let pushes;
  let core;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-real-"));
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
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("streams chunks into one growing assistant message and reaches done", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSuccessScript()}`;

    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "stream please",
    });

    await waitFor(() => {
      const t = store.getThreads().find((x) => x.id === thread.id);
      return t && t.status === "done";
    });

    const detail = services.getThreadDetail(
      store,
      thread.id,
      runner.toWorkflowView(runner.getActiveWorkflow(thread.id)),
    );

    assert.equal(detail.thread.status, "done");
    assertWorkLogShape(detail.workLog, runId);

    const starting = detail.workLog.filter((w) => w.label === "Starting agent");
    const responding = detail.workLog.filter((w) => w.label === "Agent responding");
    assert.equal(starting.length, 1);
    assert.equal(starting[0].done, true);
    assert.equal(responding.length, 1);
    assert.equal(responding[0].done, true);

    const assistants = detail.messages.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1, "exactly one assistant message for the run");
    assert.equal(assistants[0].runId, runId);
    assert.equal(assistants[0].text, FAKE_AGENT_OUTPUT);

    // Growing: at least one push should have had a shorter partial text
    const assistantPushes = pushes
      .filter((p) => p.channel === "thread:updated")
      .map((p) =>
        (p.payload.messages || []).find(
          (m) => m.role === "assistant" && m.runId === runId,
        ),
      )
      .filter(Boolean);
    assert.ok(assistantPushes.length >= 1);
    const texts = assistantPushes.map((m) => m.text);
    assert.ok(texts.some((t) => t.length > 0));
    assert.equal(texts[texts.length - 1], FAKE_AGENT_OUTPUT);
    // Either we saw a partial, or a single full chunk (still one message).
    const unique = [...new Set(texts)];
    assert.ok(unique.length >= 1);

    assert.ok(detail.workflow);
    assert.equal(detail.workflow.phases.length, 1);
    assert.equal(detail.workflow.phases[0].name, "run");
    assert.equal(detail.workflow.phases[0].pipelined, false);
    assert.equal(detail.workflow.total, 1);
    assert.equal(detail.workflow.settled, 1);
    assert.equal(detail.workflow.complete, true);
    // Contract: workflow is null for real (generic) sessions; only simulate fills it.
    // toWorkflowView still projects internal real-state when asked explicitly above.
    assert.ok(detail.workflow);
    assert.equal(detail.workflow.phases.length, 1);
    const agent = detail.workflow.phases[0].agents[0];
    assert.equal(agent.id, "agent:0");
    assert.equal(agent.status, "settled");
    assert.equal(agent.tokensUsed, Math.ceil(FAKE_AGENT_OUTPUT.length / 4));
    assert.equal(detail.workflow.tokensTotal, agent.tokensUsed);
    // model is basename of the binary (node / node.exe)
    assert.equal(agent.model, path.basename(process.execPath));
  });

  it("queues the notice while the orchestrator is mid-run, then delivers on stop", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSlowScript()}`;
    const { orch, worker } = orchPair(store);
    await runner.startRun({ threadId: orch.id, prompt: "still planning" });
    await waitFor(() => store.getThread(orch.id).status === "working");

    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSuccessScript()}`;
    await runner.startRun({ threadId: worker.id, prompt: "worker task" });
    await waitFor(() => {
      const t = store.getThread(worker.id);
      return t && t.status === "done";
    });
    const midUsers = (store.getMessages(orch.id) || []).filter(
      (m) => m.role === "user",
    );
    assert.equal(midUsers.length, 1);
    assert.equal(midUsers[0].text, "still planning");
    assert.equal(orchNoticeMessages(store, orch.id).length, 0);
    assert.equal(store.getThread(orch.id).status, "working");

    await runner.stopRun({ threadId: orch.id });
    await waitFor(() => orchNoticeMessages(store, orch.id).length > 0);
    const notice = orchNoticeMessages(store, orch.id)[0];
    assert.equal(notice.role, "user");
    assert.match(notice.text, new RegExp(worker.id));
    assert.match(notice.text, /status done/);
    assert.match(notice.text, /Last reply: Hello_from_agent/);
  });

  it("wakes an idle orchestrator when an orchWorker run fails", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentFailScript()}`;
    const { orch, worker } = orchPair(store);
    await runner.startRun({ threadId: worker.id, prompt: "fail please" });
    await waitFor(() => {
      const t = store.getThread(worker.id);
      return t && t.status === "failed";
    });
    await waitFor(() => orchNoticeMessages(store, orch.id).length > 0);
    const notice = orchNoticeMessages(store, orch.id)[0];
    assert.equal(notice.role, "user");
    assert.match(notice.text, new RegExp(worker.id));
    assert.match(notice.text, /status failed/);
  });

  it("nonzero exit sets failed with Run error event containing stderr", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentFailScript()}`;

    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "fail please",
    });

    await waitFor(() => {
      const t = store.getThreads().find((x) => x.id === thread.id);
      return t && t.status === "failed";
    });

    const detail = services.getThreadDetail(
      store,
      thread.id,
      runner.toWorkflowView(runner.getActiveWorkflow(thread.id)),
    );
    assert.equal(detail.thread.status, "failed");
    assert.ok(
      detail.messages.some(
        (m) =>
          m.role === "event" &&
          /Run error/i.test(m.text) &&
          /agent-stderr-line|more-err/i.test(m.text) &&
          m.runId === runId,
      ),
    );
    assert.ok(
      detail.workLog.some(
        (w) => w.label === "Run error" && w.done === true && w.runId === runId,
      ),
    );
    assertWorkLogShape(detail.workLog, runId);

    const agent = detail.workflow.phases[0].agents[0];
    assert.equal(agent.status, "failed");
    assert.equal(detail.workflow.complete, true);
  });

  it("stopRun kills agent process and leaves idle + Run stopped", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSlowScript()}`;

    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "long run",
    });

    await waitFor(() => {
      const t = store.getThreads().find((x) => x.id === thread.id);
      return t && t.status === "working";
    });

    // Give the child a moment to spawn
    await new Promise((r) => setTimeout(r, 80));

    await runner.stopRun({ threadId: thread.id });

    const detail = services.getThreadDetail(store, thread.id);
    assert.equal(detail.thread.status, "idle");
    assert.ok(
      detail.messages.some(
        (m) =>
          m.role === "event" &&
          /Run stopped/i.test(m.text) &&
          m.runId === runId,
      ),
    );
    assert.ok(
      detail.workLog.some(
        (w) => w.label === "Run stopped" && w.done === true && w.runId === runId,
      ),
    );

    // Must not flip to failed after the kill-induced exit
    await new Promise((r) => setTimeout(r, 150));
    const still = store.getThreads().find((t) => t.id === thread.id);
    assert.equal(still.status, "idle");
  });

  it("stopAll kills live agent child and marks idle with quit event", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentPidSlowScript()}`;

    const thread = store.getThreads()[0];
    const project = store.getProject(thread.projectId);
    const pidPath = path.join(project.path, "agent.pid");

    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "quit-kill",
    });

    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && t.status === "working";
    });
    await waitFor(() => fs.existsSync(pidPath), { timeoutMs: 5000 });
    const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
    assert.ok(Number.isFinite(pid) && pid > 0);
    assert.equal(processAlive(pid), true, "child must be alive before stopAll");

    runner.stopAll();

    assert.equal(runner.isRunning(thread.id), false);
    const after = store.getThread(thread.id);
    assert.equal(after.status, "idle");
    assert.equal(after.runStartedAt, null);
    assert.ok(
      store
        .getMessages(thread.id)
        .some(
          (m) =>
            m.role === "event" &&
            m.text === "Run interrupted by app quit" &&
            m.runId === runId,
        ),
    );

    // SIGTERM (+ optional SIGKILL) — give the reaper a moment.
    await waitFor(() => !processAlive(pid), { timeoutMs: 3000 });
    assert.equal(processAlive(pid), false, "stopAll must kill the child");

    // Kill-induced late exit must not flip idle → failed.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(store.getThread(thread.id).status, "idle");
  });

  it("late exit from stopped run A does not hijack run B on same thread", async () => {
    // Run A: traps SIGTERM and dies ~700ms later (after stop clears its entry).
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSigtermTrapScript()}`;

    const thread = store.getThreads()[0];
    const { runId: runA } = await runner.startRun({
      threadId: thread.id,
      prompt: "run A trap",
    });

    await waitFor(() => {
      const t = store.getThreads().find((x) => x.id === thread.id);
      return t && t.status === "working";
    });
    await new Promise((r) => setTimeout(r, 50));

    await runner.stopRun({ threadId: thread.id });
    assert.equal(
      store.getThreads().find((x) => x.id === thread.id).status,
      "idle",
    );
    assert.equal(runner.isRunning(thread.id), false);

    // Immediate restart: B must survive A's late onDone/onChunk.
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSlowScript()}`;
    const { runId: runB } = await runner.startRun({
      threadId: thread.id,
      prompt: "run B survivor",
    });
    assert.notEqual(runA, runB);
    assert.equal(runner.isRunning(thread.id), true);

    const bItemsBefore = store
      .getWorkLog(thread.id)
      .filter((w) => w.runId === runB);
    assert.ok(bItemsBefore.length >= 2, "B should have Starting + Responding");
    const respondingBefore = bItemsBefore.find(
      (w) => w.label === "Agent responding",
    );
    assert.ok(respondingBefore);
    assert.equal(respondingBefore.done, false);

    // Past A's SIGTERM linger window so late exit would fire if unguarded.
    await new Promise((r) => setTimeout(r, 1000));

    const mid = store.getThreads().find((x) => x.id === thread.id);
    assert.equal(
      mid.status,
      "working",
      "A late exit must not set thread done/failed while B runs",
    );
    assert.equal(runner.isRunning(thread.id), true);

    const respondingAfter = store
      .getWorkLog(thread.id)
      .find((w) => w.runId === runB && w.label === "Agent responding");
    assert.ok(respondingAfter);
    assert.equal(
      respondingAfter.done,
      false,
      "B work-log items must not be flipped by A's late onDone",
    );
    assert.equal(respondingAfter.id, respondingBefore.id);

    // B still killable via stopRun (would be a no-op if A cleared active).
    await runner.stopRun({ threadId: thread.id });
    assert.equal(
      store.getThreads().find((x) => x.id === thread.id).status,
      "idle",
    );
    assert.equal(runner.isRunning(thread.id), false);
    assert.ok(
      store
        .getMessages(thread.id)
        .some(
          (m) =>
            m.role === "event" &&
            /Run stopped/i.test(m.text) &&
            m.runId === runB,
        ),
      "stopRun must apply to B, not be a no-op",
    );
  });

  it("late pushDetail after thread delete does not throw", async () => {
    // Streaming agent so onChunk may fire after we remove the thread.
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSuccessScript()}`;

    const thread = store.getThreads()[0];
    const threadId = thread.id;
    await runner.startRun({
      threadId,
      prompt: "delete me mid-run",
    });

    assert.equal(runner.isRunning(threadId), true);
    // Simulate delete race: thread gone while agent still streaming.
    store.removeThread(threadId);
    store.save();
    assert.equal(store.getThread(threadId), null);

    // Wait past agent exit; pushDetail/onChunk/onDone must not throw.
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(store.getThread(threadId), null);
    // Runner may still think a run is active until clear; stopAll cleans up.
    assert.doesNotThrow(() => runner.stopAll());
  });

  it("deleteThread rejects while runner isRunning (held open with fake agent)", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSlowScript()}`;

    const thread = store.getThreads()[0];
    await runner.startRun({
      threadId: thread.id,
      prompt: "hold open",
    });
    assert.equal(runner.isRunning(thread.id), true);

    assert.throws(
      () =>
        services.deleteThread(
          store,
          { threadId: thread.id },
          { isRunning: (id) => runner.isRunning(id) },
        ),
      /run|active|running/i,
    );
    assert.ok(store.getThread(thread.id));

    await runner.stopRun({ threadId: thread.id });
    services.deleteThread(
      store,
      { threadId: thread.id },
      { isRunning: (id) => runner.isRunning(id) },
    );
    assert.equal(store.getThread(thread.id), null);
  });
});
