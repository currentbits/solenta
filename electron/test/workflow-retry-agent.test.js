"use strict";

/**
 * Issue #825: after a workflow phase agent has failed (auto-retry
 * exhausted or the user stopped), runs.retryWorkflowAgent re-spawns
 * that same slot. No persist/resume, no thread.sessionId, no transcript
 * event. Later unstarted phases continue when the retry succeeds.
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
const { writeFakeBin } = require("./support/fakeBin.js");

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

function readSpawnCount(spawnFile) {
  if (!fs.existsSync(spawnFile)) return 0;
  return Number(fs.readFileSync(spawnFile, "utf8").trim()) || 0;
}

function readCapture(captureFile) {
  if (!fs.existsSync(captureFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(captureFile, "utf8"));
  } catch {
    return [];
  }
}

function retryNotes(store, threadId) {
  return store
    .getWorkLog(threadId)
    .filter((w) => /agent \d+ retrying/i.test(w.label));
}

function lastWorkflow(pushes) {
  return [...pushes]
    .reverse()
    .find(
      (p) => p.channel === "thread:updated" && p.payload && p.payload.workflow,
    );
}

async function writeRetryFakeClaude(dir) {
  const scriptPath = path.join(dir, "workflow-retry-agent-fake-claude");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const modeFile = process.env.CODER_WF_MODE_FILE;
const spawnFile = process.env.CODER_WF_SPAWN_FILE;
const captureFile = process.env.CODER_WF_CAPTURE_FILE;
const retryOkFile = process.env.CODER_WF_RETRY_OK_FILE;
const holdMs = Number(process.env.CODER_WF_RETRY_HOLD_MS || 0);
const argv = process.argv.slice(1);

let mode = "happy";
if (modeFile && fs.existsSync(modeFile)) {
  mode = fs.readFileSync(modeFile, "utf8").trim() || "happy";
}

let n = 1;
if (spawnFile) {
  try {
    n = (Number(fs.readFileSync(spawnFile, "utf8").trim()) || 0) + 1;
  } catch { n = 1; }
  fs.writeFileSync(spawnFile, String(n), "utf8");
}

if (captureFile) {
  let prev = [];
  try {
    if (fs.existsSync(captureFile)) {
      prev = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    }
  } catch { prev = []; }
  prev.push({ n, argv, ts: Date.now() });
  fs.writeFileSync(captureFile, JSON.stringify(prev, null, 2), "utf8");
}

async function successResult(text) {
  emit({ type: "system", subtype: "init", session_id: "wf-retry-sess", model: "wf-model" });
  await delay(15);
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  await delay(15);
  emit({
    type: "result",
    subtype: "success",
    result: text,
    usage: { input_tokens: 10, output_tokens: 20 },
    total_cost_usd: 0.001,
    session_id: "wf-retry-sess",
  });
  process.exit(0);
}

async function failExit(msg) {
  process.stderr.write(msg + "\\n");
  process.exit(2);
}

function readPromptFromStdin() {
  return new Promise((resolve) => {
    let buf = "";
    const t = setTimeout(() => resolve(""), 3000);
    process.stdin.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\\n");
      if (nl < 0) return;
      clearTimeout(t);
      try { resolve(String(JSON.parse(buf.slice(0, nl)).message.content || "")); }
      catch { resolve(""); }
    });
    process.stdin.on("end", () => { clearTimeout(t); resolve(""); });
  });
}

(async () => {
  const prompt = await readPromptFromStdin();
  if (mode === "hang-first" && n === 1) {
    await delay(60000);
    process.exit(0);
    return;
  }
  const retryUnlocked = retryOkFile && fs.existsSync(retryOkFile);
  if (mode === "fail-until-retry" && !retryUnlocked) {
    await failExit("retry-first-boom");
    return;
  }
  if (mode === "fail-agent-2" && /You are agent 2 of 2/i.test(prompt)) {
    await failExit("retry-sibling-boom");
    return;
  }
  if (retryUnlocked && holdMs > 0) await delay(holdMs);
  await successResult(n === 1 ? "PLAN_OK" : "RETRY_OK");
})().catch((e) => {
  process.stderr.write(String(e) + "\\n");
  process.exit(1);
});
`;
  return writeFakeBin(scriptPath, body);
}

describe("workflow user-facing retry (#825)", () => {
  let tmpDir;
  let store;
  let runner;
  let pushes;
  let core;
  let prevSimulate;
  let prevAgentCmd;
  let prevClaudeBin;
  let prevModeFile;
  let prevSpawnFile;
  let prevCapture;
  let prevRetryOk;
  let prevHoldMs;
  let modeFile;
  let spawnFile;
  let captureFile;
  let retryOkFile;
  let planTemplateId;
  let twoPhaseTemplateId;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevModeFile = process.env.CODER_WF_MODE_FILE;
    prevSpawnFile = process.env.CODER_WF_SPAWN_FILE;
    prevCapture = process.env.CODER_WF_CAPTURE_FILE;
    prevRetryOk = process.env.CODER_WF_RETRY_OK_FILE;
    prevHoldMs = process.env.CODER_WF_RETRY_HOLD_MS;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_WF_RETRY_HOLD_MS;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-retry-agent-"));
    const fakeClaude = await writeRetryFakeClaude(tmpDir);
    modeFile = path.join(tmpDir, "mode.txt");
    spawnFile = path.join(tmpDir, "spawns.txt");
    captureFile = path.join(tmpDir, "capture.json");
    retryOkFile = path.join(tmpDir, "retry-ok");
    fs.writeFileSync(modeFile, "happy", "utf8");

    process.env.CODER_CLAUDE_BIN = fakeClaude;
    process.env.CODER_WF_MODE_FILE = modeFile;
    process.env.CODER_WF_SPAWN_FILE = spawnFile;
    process.env.CODER_WF_CAPTURE_FILE = captureFile;
    process.env.CODER_WF_RETRY_OK_FILE = retryOkFile;

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
    const project = await services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
    planTemplateId = services.saveTemplate(store, {
      name: "Retry plan",
      phases: [
        {
          name: "plan",
          agentCount: 1,
          instruction: "Produce a concise plan.",
          provider: "claude",
          model: null,
        },
      ],
    }).id;
    twoPhaseTemplateId = services.saveTemplate(store, {
      name: "Retry then finish",
      phases: [
        {
          name: "plan",
          agentCount: 1,
          instruction: "Produce a concise plan.",
          provider: "claude",
          model: null,
        },
        {
          name: "finish",
          agentCount: 1,
          instruction: "Write the final answer.",
          provider: "claude",
          model: null,
        },
      ],
    }).id;
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevClaudeBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevClaudeBin;
    if (prevModeFile === undefined) delete process.env.CODER_WF_MODE_FILE;
    else process.env.CODER_WF_MODE_FILE = prevModeFile;
    if (prevSpawnFile === undefined) delete process.env.CODER_WF_SPAWN_FILE;
    else process.env.CODER_WF_SPAWN_FILE = prevSpawnFile;
    if (prevCapture === undefined) delete process.env.CODER_WF_CAPTURE_FILE;
    else process.env.CODER_WF_CAPTURE_FILE = prevCapture;
    if (prevRetryOk === undefined) delete process.env.CODER_WF_RETRY_OK_FILE;
    else process.env.CODER_WF_RETRY_OK_FILE = prevRetryOk;
    if (prevHoldMs === undefined) delete process.env.CODER_WF_RETRY_HOLD_MS;
    else process.env.CODER_WF_RETRY_HOLD_MS = prevHoldMs;
  });

  function startPlan(prompt, templateId = planTemplateId) {
    return runner.startWorkflowRun({
      threadId: store.getThreads()[0].id,
      prompt,
      templateId,
    });
  }

  it("re-spawns the failed slot after the run ends and marks the retry note done", async () => {
    fs.writeFileSync(modeFile, "fail-until-retry", "utf8");
    const thread = store.getThreads()[0];
    const sessionBefore = thread.sessionId;
    await startPlan("fail then retry");

    await waitFor(() => store.getThread(thread.id).status === "failed");
    const before = readSpawnCount(spawnFile);
    assert.ok(before >= 1, "first run must have spawned");
    const notesBefore = retryNotes(store, thread.id).length;

    fs.writeFileSync(retryOkFile, "1", "utf8");
    process.env.CODER_WF_RETRY_HOLD_MS = "400";
    const { runId } = await runner.retryWorkflowAgent({
      threadId: thread.id,
      agentId: "0:plan:0",
    });
    assert.ok(runId);

    await waitFor(() => {
      const notes = retryNotes(store, thread.id);
      return notes.length > notesBefore && notes.some((n) => n.done === false);
    });
    const live = retryNotes(store, thread.id);
    assert.ok(
      live.some((n) => n.done === false),
      "retry note must be in-progress while the spawn is running",
    );

    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.equal(readSpawnCount(spawnFile), before + 1);
    assert.equal(store.getThread(thread.id).sessionId, sessionBefore);
    const wf = lastWorkflow(pushes);
    assert.ok(wf);
    assert.equal(wf.payload.workflow.phases[0].agents.length, 1);
    assert.equal(wf.payload.workflow.phases[0].agents[0].status, "settled");
    const notes = retryNotes(store, thread.id);
    assert.ok(notes.length > notesBefore);
    assert.ok(notes.every((n) => n.done === true));
    const events = store
      .getMessages(thread.id)
      .filter((m) => m.role === "event" && /agent \d+ retrying/i.test(m.text));
    assert.equal(events.length, 0, "work-log only; no transcript event");
    for (const row of readCapture(captureFile)) {
      assert.ok(!row.argv.includes("--resume"), "user retry must not --resume");
      assert.ok(!row.argv.includes("-S"), "kimi resume flags stay off");
      assert.ok(!row.argv.includes("-c"), "kimi resume flags stay off");
    }
  });

  it("retries a stopped agent on the same slot", async () => {
    fs.writeFileSync(modeFile, "hang-first", "utf8");
    const thread = store.getThreads()[0];
    const sessionBefore = thread.sessionId;
    await startPlan("stop then retry");

    await waitFor(() => readSpawnCount(spawnFile) === 1);
    await runner.stopRun({ threadId: thread.id });
    await waitFor(() => store.getThread(thread.id).status === "idle");
    assert.equal(readSpawnCount(spawnFile), 1);

    fs.writeFileSync(modeFile, "happy", "utf8");
    await runner.retryWorkflowAgent({
      threadId: thread.id,
      agentId: "0:plan:0",
    });

    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.equal(readSpawnCount(spawnFile), 2);
    assert.equal(store.getThread(thread.id).sessionId, sessionBefore);
    const wf = lastWorkflow(pushes);
    assert.equal(wf.payload.workflow.phases[0].agents[0].status, "settled");
  });

  it("continues later unstarted phases after a successful retry", async () => {
    fs.writeFileSync(modeFile, "fail-until-retry", "utf8");
    const thread = store.getThreads()[0];
    await startPlan("plan fails, finish waits", twoPhaseTemplateId);

    await waitFor(() => store.getThread(thread.id).status === "failed");
    const before = readSpawnCount(spawnFile);
    const wfFail = lastWorkflow(pushes);
    const finishBefore = wfFail.payload.workflow.phases.find(
      (p) => p.name === "finish",
    );
    assert.ok(finishBefore);
    assert.ok(
      finishBefore.agents.every((a) => a.status !== "settled"),
      "finish must not have settled before the retry",
    );

    fs.writeFileSync(retryOkFile, "1", "utf8");
    await runner.retryWorkflowAgent({
      threadId: thread.id,
      agentId: "0:plan:0",
    });

    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.ok(
      readSpawnCount(spawnFile) >= before + 2,
      "retry plus the later phase must both spawn",
    );
    const wf = lastWorkflow(pushes);
    assert.equal(wf.payload.workflow.phases[0].agents[0].status, "settled");
    const finish = wf.payload.workflow.phases.find((p) => p.name === "finish");
    assert.ok(finish);
    assert.equal(finish.agents[0].status, "settled");
    const assistant = store
      .getMessages(thread.id)
      .find((m) => m.role === "assistant");
    assert.ok(assistant, "final phase must write the assistant answer");
  });

  it("rejects while a run is active and does not spawn", async () => {
    fs.writeFileSync(modeFile, "hang-first", "utf8");
    const thread = store.getThreads()[0];
    await startPlan("busy");
    await waitFor(() => readSpawnCount(spawnFile) === 1);

    await assert.rejects(
      () =>
        runner.retryWorkflowAgent({
          threadId: thread.id,
          agentId: "0:plan:0",
        }),
      /already active/i,
    );
    assert.equal(readSpawnCount(spawnFile), 1);
    await runner.stopRun({ threadId: thread.id });
  });

  it("does not mark a finished workflow failed when a leftover sibling retry fails", async () => {
    const twoAgentPlan = services.saveTemplate(store, {
      name: "Two plan then finish",
      phases: [
        {
          name: "plan",
          agentCount: 2,
          instruction: "Produce a concise plan.",
          provider: "claude",
          model: null,
        },
        {
          name: "finish",
          agentCount: 1,
          instruction: "Write the final answer.",
          provider: "claude",
          model: null,
        },
      ],
    }).id;
    fs.writeFileSync(modeFile, "fail-agent-2", "utf8");
    const thread = store.getThreads()[0];
    await startPlan("one sibling fails, finish still lands", twoAgentPlan);

    await waitFor(() => store.getThread(thread.id).status === "done");
    const before = readSpawnCount(spawnFile);
    const wfDone = lastWorkflow(pushes);
    const failed = wfDone.payload.workflow.phases[0].agents.find(
      (a) => a.status === "failed",
    );
    assert.ok(failed, "one plan agent must have failed");

    await runner.retryWorkflowAgent({
      threadId: thread.id,
      agentId: failed.id,
    });
    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t.status !== "working" && readSpawnCount(spawnFile) > before;
    });

    assert.equal(store.getThread(thread.id).status, "done");
    assert.ok(
      store.getMessages(thread.id).some((m) => m.role === "assistant"),
      "original assistant answer must remain",
    );
  });

  it("rejects a settled agent and does not spawn again", async () => {
    const thread = store.getThreads()[0];
    await startPlan("already settled");
    await waitFor(() => store.getThread(thread.id).status === "done");
    const before = readSpawnCount(spawnFile);

    await assert.rejects(
      () =>
        runner.retryWorkflowAgent({
          threadId: thread.id,
          agentId: "0:plan:0",
        }),
      /failed/i,
    );
    assert.equal(readSpawnCount(spawnFile), before);
  });
});
