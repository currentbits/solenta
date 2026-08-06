"use strict";

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

function waitFor(predicate, { timeoutMs = 20000, intervalMs = 20 } = {}) {
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

/**
 * Fake claude that branches on prompt content for workflow orchestration tests.
 * Marker file paths come from env so tests can assert concurrency and captures.
 */
function writeWorkflowFakeClaude(dir) {
  const scriptPath = path.join(dir, "workflow-fake-claude");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const argv = process.argv.slice(1);
const prompt = argv[argv.length - 1] || "";
const modeFile = process.env.CODER_WF_MODE_FILE;
const markerDir = process.env.CODER_WF_MARKER_DIR;
const captureFile = process.env.CODER_WF_CAPTURE_FILE;
const trapSigterm = process.env.CODER_WF_TRAP_SIGTERM === "1";

let mode = "happy";
if (modeFile && fs.existsSync(modeFile)) {
  mode = fs.readFileSync(modeFile, "utf8").trim() || "happy";
}

if (captureFile) {
  let prev = [];
  try {
    if (fs.existsSync(captureFile)) {
      prev = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    }
  } catch { prev = []; }
  prev.push({ argv, prompt, ts: Date.now() });
  fs.writeFileSync(captureFile, JSON.stringify(prev, null, 2), "utf8");
}

function classify(p) {
  // Synthesize first: its body embeds the analyze focus strings.
  if (/produce the final answer/i.test(p) || /ORIGINAL user prompt/i.test(p)) return "synthesize";
  if (/You are the planning agent/i.test(p)) return "seed";
  if (/You are analyze agent 1 of 2/i.test(p)) return "analyze1";
  if (/You are analyze agent 2 of 2/i.test(p)) return "analyze2";
  return "unknown";
}

const role = classify(prompt);

function writeMarker(name, phase) {
  if (!markerDir) return;
  try {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.appendFileSync(
      path.join(markerDir, name + ".log"),
      JSON.stringify({ role, phase, ts: Date.now(), pid: process.pid }) + "\\n",
    );
  } catch { /* ignore */ }
}

async function successResult(text, usage) {
  emit({ type: "system", subtype: "init", session_id: "wf-sess", model: "wf-model" });
  await delay(15);
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  await delay(15);
  emit({
    type: "result",
    subtype: "success",
    result: text,
    usage: usage || { input_tokens: 10, output_tokens: 20 },
    total_cost_usd: 0.001,
    session_id: "wf-sess",
  });
  process.exit(0);
}

async function failExit(msg) {
  process.stderr.write(msg + "\\n");
  process.exit(2);
}

(async () => {
  if (trapSigterm && (role === "analyze1" || role === "analyze2")) {
    writeMarker(role, "start");
    process.on("SIGTERM", () => {
      writeMarker(role, "sigterm");
      setTimeout(() => process.exit(0), 5000);
    });
    setInterval(() => {}, 200);
    await delay(60000);
    process.exit(0);
    return;
  }

  if (mode === "seed-fail" && role === "seed") {
    writeMarker("seed", "fail");
    await failExit("seed-stderr-boom");
    return;
  }

  if (mode === "analyze2-fail" && role === "analyze2") {
    writeMarker("analyze2", "fail");
    await failExit("analyze2-stderr-boom");
    return;
  }

  if (mode === "both-analyze-fail" && (role === "analyze1" || role === "analyze2")) {
    writeMarker(role, "fail");
    await failExit(role + "-stderr-boom");
    return;
  }

  if (mode === "synthesize-fail" && role === "synthesize") {
    writeMarker("synthesize", "fail");
    await failExit("synthesize-stderr-boom");
    return;
  }

  if (role === "seed") {
    writeMarker("seed", "start");
    await delay(30);
    writeMarker("seed", "end");
    await successResult("PLAN: do the thing in three steps.\\nQ: how to test?", {
      input_tokens: 11,
      output_tokens: 22,
    });
    return;
  }

  if (role === "analyze1") {
    writeMarker("analyze1", "start");
    // Hold open long enough for analyze2 to start concurrently
    await delay(180);
    writeMarker("analyze1", "end");
    await successResult("ANALYSIS_IMPL: concrete steps A B C", {
      input_tokens: 12,
      output_tokens: 24,
    });
    return;
  }

  if (role === "analyze2") {
    writeMarker("analyze2", "start");
    await delay(180);
    writeMarker("analyze2", "end");
    await successResult("ANALYSIS_RISK: edge cases X Y Z", {
      input_tokens: 13,
      output_tokens: 26,
    });
    return;
  }

  if (role === "synthesize") {
    writeMarker("synthesize", "start");
    await delay(20);
    writeMarker("synthesize", "end");
    await successResult("FINAL_SYNTH_ANSWER: ship it with tests", {
      input_tokens: 14,
      output_tokens: 28,
    });
    return;
  }

  await successResult("unknown-role-fallback", { input_tokens: 1, output_tokens: 1 });
})().catch((e) => {
  process.stderr.write(String(e) + "\\n");
  process.exit(1);
});
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

function lastWorkflowPush(pushes) {
  return [...pushes]
    .reverse()
    .find((p) => p.channel === "thread:updated" && p.payload && p.payload.workflow);
}

function readMarkers(markerDir, name) {
  const p = path.join(markerDir, name + ".log");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("workflow orchestration", () => {
  let tmpDir;
  let store;
  let runner;
  let pushes;
  let core;
  let prevSimulate;
  let prevAgentCmd;
  let prevClaudeBin;
  let prevModeFile;
  let prevMarkerDir;
  let prevCapture;
  let prevTrap;
  let modeFile;
  let markerDir;
  let captureFile;
  let fakeClaude;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevModeFile = process.env.CODER_WF_MODE_FILE;
    prevMarkerDir = process.env.CODER_WF_MARKER_DIR;
    prevCapture = process.env.CODER_WF_CAPTURE_FILE;
    prevTrap = process.env.CODER_WF_TRAP_SIGTERM;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_WF_TRAP_SIGTERM;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-"));
    fakeClaude = writeWorkflowFakeClaude(tmpDir);
    modeFile = path.join(tmpDir, "mode.txt");
    markerDir = path.join(tmpDir, "markers");
    captureFile = path.join(tmpDir, "capture.json");
    fs.writeFileSync(modeFile, "happy", "utf8");
    fs.mkdirSync(markerDir, { recursive: true });

    process.env.CODER_CLAUDE_BIN = fakeClaude;
    process.env.CODER_WF_MODE_FILE = modeFile;
    process.env.CODER_WF_MARKER_DIR = markerDir;
    process.env.CODER_WF_CAPTURE_FILE = captureFile;

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
    if (prevClaudeBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevClaudeBin;
    if (prevModeFile === undefined) delete process.env.CODER_WF_MODE_FILE;
    else process.env.CODER_WF_MODE_FILE = prevModeFile;
    if (prevMarkerDir === undefined) delete process.env.CODER_WF_MARKER_DIR;
    else process.env.CODER_WF_MARKER_DIR = prevMarkerDir;
    if (prevCapture === undefined) delete process.env.CODER_WF_CAPTURE_FILE;
    else process.env.CODER_WF_CAPTURE_FILE = prevCapture;
    if (prevTrap === undefined) delete process.env.CODER_WF_TRAP_SIGTERM;
    else process.env.CODER_WF_TRAP_SIGTERM = prevTrap;
  });

  it("happy path: phase order, concurrent analyze, synthesize input, usage, settled view", async () => {
    const thread = store.getThreads()[0];
    assert.equal(typeof runner.startWorkflowRun, "function");

    const { runId } = await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "Build a login form",
    });
    assert.ok(runId);

    const renamed = store.getThread(thread.id);
    assert.equal(renamed.title, "Build a login form");
    assert.equal(renamed.status, "working");
    assert.ok(typeof renamed.runStartedAt === "number" && renamed.runStartedAt > 0);

    const kick = store
      .getMessages(thread.id)
      .find((m) => m.role === "event" && /Kicked off 4 subagents/i.test(m.text));
    assert.ok(kick, "expected kickoff event");
    assert.match(kick.text, /seed 1: plan the task/);
    assert.match(kick.text, /analyze 2: parallel deep dives/);
    assert.match(kick.text, /synthesize 1: final answer/);

    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && t.status === "done";
    });

    const done = store.getThread(thread.id);
    assert.equal(done.runStartedAt, null);

    const push = lastWorkflowPush(pushes);
    assert.ok(push, "expected workflow on thread:updated");
    const wf = push.payload.workflow;
    assert.equal(wf.complete, true);
    assert.equal(wf.total, 4);
    assert.equal(wf.settled, 4);
    assert.ok(wf.tokensTotal > 0);
    assert.match(wf.name, /^[A-Z]+-[A-Z]+$/);
    assert.deepEqual(
      wf.phases.map((p) => p.name),
      ["seed", "analyze", "synthesize"],
    );
    assert.equal(wf.phases[0].agents.length, 1);
    assert.equal(wf.phases[1].agents.length, 2);
    assert.equal(wf.phases[2].agents.length, 1);
    for (const phase of wf.phases) {
      for (const agent of phase.agents) {
        assert.equal(agent.status, "settled");
        assert.ok(agent.tokensUsed > 0);
      }
    }

    const assistant = store
      .getMessages(thread.id)
      .find((m) => m.role === "assistant" && m.runId === runId);
    assert.ok(assistant);
    assert.equal(assistant.text, "FINAL_SYNTH_ANSWER: ship it with tests");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.turns, 1);
    // 11+12+13+14 input, 22+24+26+28 output
    assert.equal(usage.inputTokens, 11 + 12 + 13 + 14);
    assert.equal(usage.outputTokens, 22 + 24 + 26 + 28);

    // Phase ordering: analyze starts only after seed ends
    const seedEnd = readMarkers(markerDir, "seed").find((m) => m.phase === "end");
    const a1Start = readMarkers(markerDir, "analyze1").find((m) => m.phase === "start");
    const a2Start = readMarkers(markerDir, "analyze2").find((m) => m.phase === "start");
    assert.ok(seedEnd, "seed end marker");
    assert.ok(a1Start && a2Start, "analyze start markers");
    assert.ok(
      a1Start.ts >= seedEnd.ts && a2Start.ts >= seedEnd.ts,
      "analyze must start after seed ends",
    );

    // Concurrent analyze: overlapping lifetimes
    const a1End = readMarkers(markerDir, "analyze1").find((m) => m.phase === "end");
    const a2End = readMarkers(markerDir, "analyze2").find((m) => m.phase === "end");
    assert.ok(a1End && a2End);
    const overlap =
      a1Start.ts < a2End.ts && a2Start.ts < a1End.ts;
    assert.ok(overlap, "analyze agents must overlap in time");

    // Synthesize prompt contains both analyses
    const captures = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const synth = captures.find((c) => /produce the final answer|ORIGINAL user prompt/i.test(c.prompt));
    assert.ok(synth, "expected synthesize capture");
    assert.match(synth.prompt, /ANALYSIS_IMPL/);
    assert.match(synth.prompt, /ANALYSIS_RISK/);
    // No --resume in any call
    for (const c of captures) {
      assert.ok(!c.argv.includes("--resume"), "workflow agents must not pass --resume");
    }

    // Work log: one item per phase, all done
    const detail = push.payload;
    const labels = detail.workLog.map((w) => w.label.toLowerCase());
    for (const pl of ["seed", "analyze", "synthesize"]) {
      const items = detail.workLog.filter((w) => w.label.toLowerCase() === pl);
      assert.equal(items.length, 1, `expected one work log for ${pl}`);
      assert.equal(items[0].done, true);
      assert.equal(items[0].runId, runId);
    }
    void labels;
  });

  it("tolerates one analyze failure and continues", async () => {
    fs.writeFileSync(modeFile, "analyze2-fail", "utf8");
    const thread = store.getThreads()[0];
    const { runId } = await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "tolerate analyze fail",
    });

    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && (t.status === "done" || t.status === "failed");
    });

    const done = store.getThread(thread.id);
    assert.equal(done.status, "done");

    const note = store
      .getWorkLog(thread.id)
      .find((w) => /Analyze 2 failed, continuing/i.test(w.label));
    assert.ok(note, "expected work log note about analyze 2 failure");

    const assistant = store
      .getMessages(thread.id)
      .find((m) => m.role === "assistant" && m.runId === runId);
    assert.ok(assistant);
    assert.match(assistant.text, /FINAL_SYNTH/);

    const push = lastWorkflowPush(pushes);
    const analyzeAgents = push.payload.workflow.phases.find((p) => p.name === "analyze").agents;
    const statuses = analyzeAgents.map((a) => a.status).sort();
    assert.deepEqual(statuses, ["failed", "settled"]);
  });

  it("seed failure fails the run with Run error event", async () => {
    fs.writeFileSync(modeFile, "seed-fail", "utf8");
    const thread = store.getThreads()[0];
    const { runId } = await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "seed will fail",
    });

    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && t.status === "failed";
    });

    assert.equal(store.getThread(thread.id).runStartedAt, null);
    const errEv = store
      .getMessages(thread.id)
      .find((m) => m.role === "event" && /Run error/i.test(m.text) && m.runId === runId);
    assert.ok(errEv, "expected Run error event");
    assert.match(errEv.text, /seed/i);
    assert.match(errEv.text, /seed-stderr-boom|stderr/i);

    const push = lastWorkflowPush(pushes);
    assert.ok(push);
    assert.equal(push.payload.workflow.phases[0].agents[0].status, "failed");
    assert.equal(push.payload.workflow.complete, false);
  });

  it("stopRun mid-analyze kills children and marks agents failed", async () => {
    process.env.CODER_WF_TRAP_SIGTERM = "1";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "stop me mid analyze",
    });

    // Wait until both analyze agents have started
    await waitFor(() => {
      const a1 = readMarkers(markerDir, "analyze1").some((m) => m.phase === "start");
      const a2 = readMarkers(markerDir, "analyze2").some((m) => m.phase === "start");
      return a1 && a2;
    });

    await runner.stopRun({ threadId: thread.id });

    const idle = store.getThread(thread.id);
    assert.equal(idle.status, "idle");
    assert.equal(idle.runStartedAt, null);

    const stopped = store
      .getMessages(thread.id)
      .find((m) => m.role === "event" && /Run stopped/i.test(m.text) && m.runId === runId);
    assert.ok(stopped);

    // SIGTERM should have been delivered
    await waitFor(() => {
      const s1 = readMarkers(markerDir, "analyze1").some((m) => m.phase === "sigterm");
      const s2 = readMarkers(markerDir, "analyze2").some((m) => m.phase === "sigterm");
      return s1 || s2;
    }, { timeoutMs: 5000 });

    const push = [...pushes]
      .reverse()
      .find((p) => p.channel === "thread:updated");
    assert.ok(push);
    const analyze = push.payload.workflow.phases.find((p) => p.name === "analyze");
    assert.ok(analyze);
    for (const a of analyze.agents) {
      if (a.status === "running" || a.status === "pending") {
        assert.fail(`expected terminal agent status after stop, got ${a.status}`);
      }
      // running ones become failed; seed may be settled
    }
    const runningOrPending = analyze.agents.filter(
      (a) => a.status === "running" || a.status === "pending",
    );
    assert.equal(runningOrPending.length, 0);
    assert.ok(analyze.agents.some((a) => a.status === "failed"));
  });

  it("rejects non-claude provider", async () => {
    const thread = store.getThreads()[0];
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
    await assert.rejects(
      () =>
        runner.startWorkflowRun({
          threadId: thread.id,
          prompt: "nope",
        }),
      /Workflow runs currently require the Claude provider/,
    );
  });

  it("rejects while a run is already active", async () => {
    process.env.CODER_WF_TRAP_SIGTERM = "1";
    const thread = store.getThreads()[0];
    await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "first workflow",
    });
    await assert.rejects(
      () =>
        runner.startWorkflowRun({
          threadId: thread.id,
          prompt: "second",
        }),
      /already active/i,
    );
    // Also reject session start while workflow active
    await assert.rejects(
      () =>
        runner.startRun({
          threadId: thread.id,
          prompt: "session while wf",
        }),
      /already active/i,
    );
    await runner.stopRun({ threadId: thread.id });
  });
});
