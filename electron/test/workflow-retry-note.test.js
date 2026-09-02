"use strict";

/**
 * Issue #823 (follow-up to #819): the automatic same-slot retry must
 * leave one work-log line that is in-progress while the second spawn
 * runs, then done when that spawn finishes.
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

function retryNotes(store, threadId) {
  return store
    .getWorkLog(threadId)
    .filter((w) => /plan agent 1 retrying/i.test(w.label));
}

async function writeRetryFakeClaude(dir) {
  const scriptPath = path.join(dir, "workflow-retry-fake-claude");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const modeFile = process.env.CODER_WF_MODE_FILE;
const spawnFile = process.env.CODER_WF_SPAWN_FILE;
const holdMs = Number(process.env.CODER_WF_RETRY_HOLD_MS || 0);

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

(async () => {
  if (mode === "hang-first" && n === 1) {
    await delay(60000);
    process.exit(0);
    return;
  }
  if (mode === "fail-both" || (mode === "fail-first" && n === 1)) {
    await failExit("retry-first-boom");
    return;
  }
  if (n >= 2 && holdMs > 0) await delay(holdMs);
  await successResult("PLAN_RETRY_OK");
})().catch((e) => {
  process.stderr.write(String(e) + "\\n");
  process.exit(1);
});
`;
  return writeFakeBin(scriptPath, body);
}

function lastWorkflow(pushes) {
  return [...pushes]
    .reverse()
    .find((p) => p.channel === "thread:updated" && p.payload && p.payload.workflow);
}

describe("workflow retry work-log note (#823)", () => {
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
  let prevHoldMs;
  let modeFile;
  let spawnFile;
  let templateId;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevModeFile = process.env.CODER_WF_MODE_FILE;
    prevSpawnFile = process.env.CODER_WF_SPAWN_FILE;
    prevHoldMs = process.env.CODER_WF_RETRY_HOLD_MS;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_WF_RETRY_HOLD_MS;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-retry-"));
    const fakeClaude = await writeRetryFakeClaude(tmpDir);
    modeFile = path.join(tmpDir, "mode.txt");
    spawnFile = path.join(tmpDir, "spawns.txt");
    fs.writeFileSync(modeFile, "happy", "utf8");

    process.env.CODER_CLAUDE_BIN = fakeClaude;
    process.env.CODER_WF_MODE_FILE = modeFile;
    process.env.CODER_WF_SPAWN_FILE = spawnFile;

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
    const tmpl = services.saveTemplate(store, {
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
    });
    templateId = tmpl.id;
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
    if (prevHoldMs === undefined) delete process.env.CODER_WF_RETRY_HOLD_MS;
    else process.env.CODER_WF_RETRY_HOLD_MS = prevHoldMs;
  });

  function startPlan(prompt) {
    return runner.startWorkflowRun({
      threadId: store.getThreads()[0].id,
      prompt,
      templateId,
    });
  }

  it("does not write a retry note when the first spawn succeeds", async () => {
    const thread = store.getThreads()[0];
    const sessionBefore = thread.sessionId;
    await startPlan("first try ok");

    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.equal(readSpawnCount(spawnFile), 1);
    assert.equal(retryNotes(store, thread.id).length, 0);
    assert.equal(store.getThread(thread.id).sessionId, sessionBefore);
    const events = store
      .getMessages(thread.id)
      .filter((m) => m.role === "event" && /retry/i.test(m.text));
    assert.equal(events.length, 0);
    const wf = lastWorkflow(pushes);
    assert.ok(wf);
    assert.equal(wf.payload.workflow.phases[0].agents.length, 1);
  });

  it("shows one in-progress retry line only while the second spawn is running", async () => {
    fs.writeFileSync(modeFile, "fail-first", "utf8");
    process.env.CODER_WF_RETRY_HOLD_MS = "400";
    const thread = store.getThreads()[0];
    const sessionBefore = thread.sessionId;
    const { runId } = await startPlan("retry once");

    await waitFor(() => {
      const notes = retryNotes(store, thread.id);
      return (
        notes.length === 1 &&
        notes[0].done === false &&
        readSpawnCount(spawnFile) === 2
      );
    });
    assert.equal(readSpawnCount(spawnFile), 2, "second spawn must have started");
    const live = retryNotes(store, thread.id);
    assert.equal(live.length, 1);
    assert.equal(live[0].done, false);
    assert.equal(live[0].runId, runId);
    assert.equal(store.getThread(thread.id).sessionId, sessionBefore);
    const liveWf = lastWorkflow(pushes);
    assert.ok(liveWf);
    assert.equal(
      liveWf.payload.workflow.phases[0].agents.length,
      1,
      "retry stays on the same slot; no sibling",
    );

    await waitFor(() => store.getThread(thread.id).status === "done");

    const done = retryNotes(store, thread.id);
    assert.equal(done.length, 1, "still one line after the retry finishes");
    assert.equal(done[0].done, true);
    assert.equal(readSpawnCount(spawnFile), 2);
    const events = store
      .getMessages(thread.id)
      .filter((m) => m.role === "event" && /retry/i.test(m.text));
    assert.equal(events.length, 0, "work-log only; no transcript event");
  });

  it("keeps the note and fails the phase when the retry also fails", async () => {
    fs.writeFileSync(modeFile, "fail-both", "utf8");
    const thread = store.getThreads()[0];
    await startPlan("retry then fail");

    await waitFor(() => store.getThread(thread.id).status === "failed");

    assert.equal(readSpawnCount(spawnFile), 2);
    const notes = retryNotes(store, thread.id);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].done, true);
    const assistant = store
      .getMessages(thread.id)
      .find((m) => m.role === "assistant");
    assert.equal(assistant, undefined);
  });

  it("does not write a retry note when stop happens before the second spawn", async () => {
    fs.writeFileSync(modeFile, "hang-first", "utf8");
    const thread = store.getThreads()[0];
    await startPlan("stop before retry");

    await waitFor(() => readSpawnCount(spawnFile) === 1);

    await runner.stopRun({ threadId: thread.id });
    await waitFor(() => store.getThread(thread.id).status === "idle");

    assert.equal(readSpawnCount(spawnFile), 1);
    assert.equal(retryNotes(store, thread.id).length, 0);
  });
});
