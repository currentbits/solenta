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
 * Traps SIGTERM and lingers so stopRun + immediate restart races the late
 * onDone of the killed agent. No spaces (CODER_AGENT_CMD whitespace split).
 */
function fakeAgentSigtermTrapScript() {
  return "process.on('SIGTERM',()=>{setTimeout(()=>process.exit(0),700)});setInterval(()=>{},200)";
}

const FAKE_AGENT_OUTPUT = "Hello_from_agent";

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

  it("startRun full lifecycle reaches done with assistant summary", async () => {
    const thread = store.getThreads()[0];
    const { workflowId } = await runner.startRun({
      threadId: thread.id,
      prompt: "Fix the flaky login test\nmore detail",
    });
    assert.ok(workflowId);
    assert.match(workflowId, /.+/);

    const renamed = store.getThreads().find((t) => t.id === thread.id);
    assert.equal(renamed.title, "Fix the flaky login test");
    assert.equal(renamed.status, "working");

    const msgs = store.getMessages(thread.id);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].text, "Fix the flaky login test\nmore detail");
    assert.equal(msgs[0].runId, workflowId);

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

    assert.match(detail.workflow.name, /^[A-Z]+-[A-Z]+$/);

    assert.deepEqual(
      detail.workflow.phases.map((p) => p.name),
      ["seed", "analyze", "verify", "judge", "synthesize"],
    );
    assert.equal(
      detail.workflow.phases.find((p) => p.name === "verify").pipelined,
      true,
    );

    assertWorkLogShape(detail.workLog, workflowId);
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
    assert.equal(assistant[assistant.length - 1].runId, workflowId);

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
    const { workflowId } = await runner.startRun({
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

    await runner.stopRun({ threadId: thread.id });

    const detail = services.getThreadDetail(store, thread.id);
    assert.equal(detail.thread.status, "idle");
    assert.ok(
      detail.messages.some(
        (m) => m.role === "event" && /stopped/i.test(m.text) && m.runId === workflowId,
      ),
    );
    assert.ok(
      detail.workLog.some(
        (w) => /stop/i.test(w.label) && w.done === true && w.runId === workflowId,
      ),
    );
    assertWorkLogShape(detail.workLog, workflowId);

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
    const { workflowId } = await failRunner.startRun({
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
          m.runId === workflowId,
      ),
    );
    assert.ok(
      detailPush.payload.workLog.some(
        (w) => w.label === "Run error" && w.done === true && w.runId === workflowId,
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
    const { workflowId } = await runner.startRun({
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
    assertWorkLogShape(detail.workLog, workflowId);

    const starting = detail.workLog.filter((w) => w.label === "Starting agent");
    const responding = detail.workLog.filter((w) => w.label === "Agent responding");
    assert.equal(starting.length, 1);
    assert.equal(starting[0].done, true);
    assert.equal(responding.length, 1);
    assert.equal(responding[0].done, true);

    const assistants = detail.messages.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1, "exactly one assistant message for the run");
    assert.equal(assistants[0].runId, workflowId);
    assert.equal(assistants[0].text, FAKE_AGENT_OUTPUT);

    // Growing: at least one push should have had a shorter partial text
    const assistantPushes = pushes
      .filter((p) => p.channel === "thread:updated")
      .map((p) =>
        (p.payload.messages || []).find(
          (m) => m.role === "assistant" && m.runId === workflowId,
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
    const agent = detail.workflow.phases[0].agents[0];
    assert.equal(agent.id, "agent:0");
    assert.equal(agent.status, "settled");
    assert.equal(agent.tokensUsed, Math.ceil(FAKE_AGENT_OUTPUT.length / 4));
    assert.equal(detail.workflow.tokensTotal, agent.tokensUsed);
    // model is basename of the binary (node / node.exe)
    assert.equal(agent.model, path.basename(process.execPath));
  });

  it("nonzero exit sets failed with Run error event containing stderr", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentFailScript()}`;

    const thread = store.getThreads()[0];
    const { workflowId } = await runner.startRun({
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
          m.runId === workflowId,
      ),
    );
    assert.ok(
      detail.workLog.some(
        (w) => w.label === "Run error" && w.done === true && w.runId === workflowId,
      ),
    );
    assertWorkLogShape(detail.workLog, workflowId);

    const agent = detail.workflow.phases[0].agents[0];
    assert.equal(agent.status, "failed");
    assert.equal(detail.workflow.complete, true);
  });

  it("stopRun kills agent process and leaves idle + Run stopped", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSlowScript()}`;

    const thread = store.getThreads()[0];
    const { workflowId } = await runner.startRun({
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
          m.runId === workflowId,
      ),
    );
    assert.ok(
      detail.workLog.some(
        (w) => w.label === "Run stopped" && w.done === true && w.runId === workflowId,
      ),
    );

    // Must not flip to failed after the kill-induced exit
    await new Promise((r) => setTimeout(r, 150));
    const still = store.getThreads().find((t) => t.id === thread.id);
    assert.equal(still.status, "idle");
  });

  it("late exit from stopped run A does not hijack run B on same thread", async () => {
    // Run A: traps SIGTERM and dies ~700ms later (after stop clears its entry).
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSigtermTrapScript()}`;

    const thread = store.getThreads()[0];
    const { workflowId: runA } = await runner.startRun({
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
    const { workflowId: runB } = await runner.startRun({
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
});
