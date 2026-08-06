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
 * Fake claude that branches on phase instruction / agent angle lines.
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
const markerName = process.env.CODER_WF_CLAUDE_MARKER || "claude-hit";

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
  prev.push({ provider: "claude", argv, prompt, ts: Date.now() });
  fs.writeFileSync(captureFile, JSON.stringify(prev, null, 2), "utf8");
}

function classify(p) {
  if (/Using the plan and analyses/i.test(p) || /final self-contained answer/i.test(p)) {
    return "synthesize";
  }
  if (/Produce a concise plan/i.test(p) || /key questions/i.test(p)) return "seed";
  if (/Deep-dive the task/i.test(p) || /implementation approach versus risks/i.test(p)) {
    if (/You are agent 1 of 2/i.test(p)) return "analyze1";
    if (/You are agent 2 of 2/i.test(p)) return "analyze2";
    return "analyze";
  }
  if (/You are agent 1 of 2/i.test(p)) return "analyze1";
  if (/You are agent 2 of 2/i.test(p)) return "analyze2";
  return "generic";
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

// Always leave a provider hit marker for mixed-provider tests.
if (markerDir) {
  try {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, markerName), "1", "utf8");
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
  if (trapSigterm && (role === "analyze1" || role === "analyze2" || role === "analyze")) {
    writeMarker(role === "analyze" ? "analyze1" : role, "start");
    process.on("SIGTERM", () => {
      writeMarker(role === "analyze" ? "analyze1" : role, "sigterm");
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

  if (mode === "both-analyze-fail" && (role === "analyze1" || role === "analyze2" || role === "analyze")) {
    writeMarker(role === "analyze" ? "analyze1" : role, "fail");
    await failExit(role + "-stderr-boom");
    return;
  }

  if (mode === "synthesize-fail" && role === "synthesize") {
    writeMarker("synthesize", "fail");
    await failExit("synthesize-stderr-boom");
    return;
  }

  if (mode === "final-all-fail" && role === "synthesize") {
    writeMarker("synthesize", "fail");
    await failExit("final-fail-boom");
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

  if (role === "analyze1" || (role === "analyze" && /agent 1 of/i.test(prompt))) {
    writeMarker("analyze1", "start");
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

  writeMarker("generic", "start");
  await successResult("CLAUDE_GENERIC_OK", { input_tokens: 5, output_tokens: 6 });
})().catch((e) => {
  process.stderr.write(String(e) + "\\n");
  process.exit(1);
});
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

/**
 * Fake codex JSONL one-shot for mixed-provider tests.
 */
function writeWorkflowFakeCodex(dir) {
  const scriptPath = path.join(dir, "workflow-fake-codex");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] || "";
const markerDir = process.env.CODER_WF_MARKER_DIR;
const captureFile = process.env.CODER_WF_CAPTURE_FILE;
if (captureFile) {
  let prev = [];
  try {
    if (fs.existsSync(captureFile)) prev = JSON.parse(fs.readFileSync(captureFile, "utf8"));
  } catch { prev = []; }
  prev.push({ provider: "codex", argv: process.argv.slice(1), prompt, ts: Date.now() });
  fs.writeFileSync(captureFile, JSON.stringify(prev, null, 2), "utf8");
}
if (markerDir) {
  try {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, "codex-hit"), "1", "utf8");
  } catch { /* ignore */ }
}
(async () => {
  emit({ type: "thread.started", thread_id: "wf-codex-sess" });
  await delay(10);
  emit({
    type: "item.completed",
    item: { id: "m1", type: "agent_message", text: "CODEX_PHASE_OK" },
  });
  await delay(10);
  emit({ type: "turn.completed", usage: { input_tokens: 8, output_tokens: 9 } });
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

/**
 * Fake text-kind binary (stdout plain text).
 */
function writeWorkflowFakeText(dir, name = "workflow-fake-text") {
  const scriptPath = path.join(dir, name);
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const prompt = process.argv.slice(2).join(" ") || process.argv[process.argv.length - 1] || "";
const markerDir = process.env.CODER_WF_MARKER_DIR;
const captureFile = process.env.CODER_WF_CAPTURE_FILE;
if (captureFile) {
  let prev = [];
  try {
    if (fs.existsSync(captureFile)) prev = JSON.parse(fs.readFileSync(captureFile, "utf8"));
  } catch { prev = []; }
  prev.push({ provider: "text", argv: process.argv.slice(1), prompt, ts: Date.now() });
  fs.writeFileSync(captureFile, JSON.stringify(prev, null, 2), "utf8");
}
if (markerDir) {
  try {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, "text-hit"), "1", "utf8");
  } catch { /* ignore */ }
}
process.stdout.write("TEXT_FINAL_ANSWER: done via text provider\\n");
process.exit(0);
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
  let prevCodexBin;
  let prevGrokBin;
  let prevOpencodeBin;
  let prevModeFile;
  let prevMarkerDir;
  let prevCapture;
  let prevTrap;
  let modeFile;
  let markerDir;
  let captureFile;
  let fakeClaude;
  let fakeCodex;
  let fakeText;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevCodexBin = process.env.CODER_CODEX_BIN;
    prevGrokBin = process.env.CODER_GROK_BIN;
    prevOpencodeBin = process.env.CODER_OPENCODE_BIN;
    prevModeFile = process.env.CODER_WF_MODE_FILE;
    prevMarkerDir = process.env.CODER_WF_MARKER_DIR;
    prevCapture = process.env.CODER_WF_CAPTURE_FILE;
    prevTrap = process.env.CODER_WF_TRAP_SIGTERM;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_WF_TRAP_SIGTERM;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-"));
    fakeClaude = writeWorkflowFakeClaude(tmpDir);
    fakeCodex = writeWorkflowFakeCodex(tmpDir);
    fakeText = writeWorkflowFakeText(tmpDir);
    modeFile = path.join(tmpDir, "mode.txt");
    markerDir = path.join(tmpDir, "markers");
    captureFile = path.join(tmpDir, "capture.json");
    fs.writeFileSync(modeFile, "happy", "utf8");
    fs.mkdirSync(markerDir, { recursive: true });

    process.env.CODER_CLAUDE_BIN = fakeClaude;
    process.env.CODER_CODEX_BIN = fakeCodex;
    process.env.CODER_GROK_BIN = fakeText;
    process.env.CODER_OPENCODE_BIN = fakeText;
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
    if (prevCodexBin === undefined) delete process.env.CODER_CODEX_BIN;
    else process.env.CODER_CODEX_BIN = prevCodexBin;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
    if (prevOpencodeBin === undefined) delete process.env.CODER_OPENCODE_BIN;
    else process.env.CODER_OPENCODE_BIN = prevOpencodeBin;
    if (prevModeFile === undefined) delete process.env.CODER_WF_MODE_FILE;
    else process.env.CODER_WF_MODE_FILE = prevModeFile;
    if (prevMarkerDir === undefined) delete process.env.CODER_WF_MARKER_DIR;
    else process.env.CODER_WF_MARKER_DIR = prevMarkerDir;
    if (prevCapture === undefined) delete process.env.CODER_WF_CAPTURE_FILE;
    else process.env.CODER_WF_CAPTURE_FILE = prevCapture;
    if (prevTrap === undefined) delete process.env.CODER_WF_TRAP_SIGTERM;
    else process.env.CODER_WF_TRAP_SIGTERM = prevTrap;
  });

  it("happy path (standard template): phase order, concurrent analyze, dossiers, usage", async () => {
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
    assert.match(kick.text, /seed 1/);
    assert.match(kick.text, /analyze 2/);
    assert.match(kick.text, /synthesize 1/);

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

    // Dossiers: one tool message per agent
    const dossiers = store
      .getMessages(thread.id)
      .filter((m) => m.role === "tool" && m.runId === runId);
    assert.equal(dossiers.length, 4, "expected 4 dossier tool messages");
    for (const d of dossiers) {
      assert.ok(d.tool);
      assert.equal(d.tool.done, true);
      assert.equal(d.tool.isError, false);
      assert.ok(d.tool.id.startsWith(runId + ":"));
      assert.ok(typeof d.tool.input === "string" && d.tool.input.length > 0);
      assert.ok(typeof d.tool.output === "string" && d.tool.output.length > 0);
      assert.match(d.text, /finished$/);
    }
    assert.ok(dossiers.some((d) => d.tool.name === "seed agent 0"));
    assert.ok(dossiers.some((d) => d.tool.name === "analyze agent 0"));
    assert.ok(dossiers.some((d) => d.tool.name === "analyze agent 1"));
    assert.ok(dossiers.some((d) => d.tool.name === "synthesize agent 0"));

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.turns, 1);
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

    const a1End = readMarkers(markerDir, "analyze1").find((m) => m.phase === "end");
    const a2End = readMarkers(markerDir, "analyze2").find((m) => m.phase === "end");
    assert.ok(a1End && a2End);
    const overlap = a1Start.ts < a2End.ts && a2Start.ts < a1End.ts;
    assert.ok(overlap, "analyze agents must overlap in time");

    // Synthesize prompt contains both analyses
    const captures = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const synth = captures.find((c) =>
      /Using the plan and analyses|final self-contained answer/i.test(c.prompt),
    );
    assert.ok(synth, "expected synthesize capture");
    assert.match(synth.prompt, /ANALYSIS_IMPL/);
    assert.match(synth.prompt, /ANALYSIS_RISK/);
    for (const c of captures) {
      assert.ok(!c.argv.includes("--resume"), "workflow agents must not pass --resume");
    }

    const detail = push.payload;
    for (const pl of ["seed", "analyze", "synthesize"]) {
      const items = detail.workLog.filter((w) => w.label.toLowerCase() === pl);
      assert.equal(items.length, 1, `expected one work log for ${pl}`);
      assert.equal(items[0].done, true);
      assert.equal(items[0].runId, runId);
    }
  });

  it("mixed-provider template hits claude, codex, and text binaries", async () => {
    const tmpl = services.saveTemplate(store, {
      name: "Mixed three",
      phases: [
        {
          name: "plan",
          agentCount: 1,
          instruction: "Claude plans briefly.",
          provider: "claude",
          model: null,
        },
        {
          name: "review",
          agentCount: 1,
          instruction: "Codex reviews the plan.",
          provider: "codex",
          model: null,
        },
        {
          name: "finalize",
          agentCount: 1,
          instruction: "Grok finalizes in plain text.",
          provider: "grok",
          model: null,
        },
      ],
    });

    const thread = store.getThreads()[0];
    const { runId } = await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "mixed provider task",
      templateId: tmpl.id,
    });

    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && (t.status === "done" || t.status === "failed");
    });

    assert.equal(store.getThread(thread.id).status, "done");
    assert.ok(fs.existsSync(path.join(markerDir, "claude-hit")), "claude binary hit");
    assert.ok(fs.existsSync(path.join(markerDir, "codex-hit")), "codex binary hit");
    assert.ok(fs.existsSync(path.join(markerDir, "text-hit")), "text binary hit");

    const captures = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.ok(captures.some((c) => c.provider === "claude"));
    assert.ok(captures.some((c) => c.provider === "codex"));
    assert.ok(captures.some((c) => c.provider === "text"));

    const assistant = store
      .getMessages(thread.id)
      .find((m) => m.role === "assistant" && m.runId === runId);
    assert.ok(assistant);
    assert.match(assistant.text, /TEXT_FINAL_ANSWER/);

    const dossiers = store
      .getMessages(thread.id)
      .filter((m) => m.role === "tool" && m.runId === runId);
    assert.equal(dossiers.length, 3);
  });

  it("final phase multi-agent concatenates successful outputs", async () => {
    const tmpl = services.saveTemplate(store, {
      name: "Multi final",
      phases: [
        {
          name: "draft",
          agentCount: 1,
          instruction: "Claude plans briefly.",
          provider: "claude",
          model: null,
        },
        {
          name: "answers",
          agentCount: 2,
          instruction: "Produce a distinct final answer.",
          provider: "grok",
          model: null,
        },
      ],
    });

    const thread = store.getThreads()[0];
    const { runId } = await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "multi final",
      templateId: tmpl.id,
    });

    await waitFor(() => store.getThread(thread.id).status === "done");

    const assistant = store
      .getMessages(thread.id)
      .find((m) => m.role === "assistant" && m.runId === runId);
    assert.ok(assistant);
    assert.match(assistant.text, /## answers agent 1/);
    assert.match(assistant.text, /## answers agent 2/);
    assert.match(assistant.text, /TEXT_FINAL_ANSWER/);
  });

  it("tolerates mid-phase partial failure and continues", async () => {
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
      .find((w) => /Analyze agent 2 failed, continuing/i.test(w.label));
    assert.ok(note, "expected work log note about analyze agent 2 failure");

    const assistant = store
      .getMessages(thread.id)
      .find((m) => m.role === "assistant" && m.runId === runId);
    assert.ok(assistant);
    assert.match(assistant.text, /FINAL_SYNTH/);

    const failDossier = store
      .getMessages(thread.id)
      .find(
        (m) =>
          m.role === "tool" &&
          m.runId === runId &&
          m.tool &&
          m.tool.name === "analyze agent 1" &&
          m.tool.isError,
      );
    assert.ok(failDossier, "expected isError dossier for failed analyze agent");

    const push = lastWorkflowPush(pushes);
    const analyzeAgents = push.payload.workflow.phases.find(
      (p) => p.name === "analyze",
    ).agents;
    const statuses = analyzeAgents.map((a) => a.status).sort();
    assert.deepEqual(statuses, ["failed", "settled"]);
  });

  it("all agents failing in a mid phase fails the run", async () => {
    fs.writeFileSync(modeFile, "both-analyze-fail", "utf8");
    const thread = store.getThreads()[0];
    const { runId } = await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "both analyze fail",
    });

    await waitFor(() => store.getThread(thread.id).status === "failed");
    assert.equal(store.getThread(thread.id).runStartedAt, null);

    const errEv = store
      .getMessages(thread.id)
      .find((m) => m.role === "event" && /Run error/i.test(m.text) && m.runId === runId);
    assert.ok(errEv);
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

    const dossier = store
      .getMessages(thread.id)
      .find(
        (m) =>
          m.role === "tool" &&
          m.runId === runId &&
          m.tool &&
          m.tool.name === "seed agent 0",
      );
    assert.ok(dossier);
    assert.equal(dossier.tool.isError, true);
    assert.match(dossier.text, /failed$/);

    const push = lastWorkflowPush(pushes);
    assert.ok(push);
    assert.equal(push.payload.workflow.phases[0].agents[0].status, "failed");
    assert.equal(push.payload.workflow.complete, false);
  });

  it("final phase all-fail fails the run", async () => {
    fs.writeFileSync(modeFile, "synthesize-fail", "utf8");
    const thread = store.getThreads()[0];
    const { runId } = await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "final will fail",
    });

    await waitFor(() => store.getThread(thread.id).status === "failed");
    const errEv = store
      .getMessages(thread.id)
      .find((m) => m.role === "event" && /Run error/i.test(m.text) && m.runId === runId);
    assert.ok(errEv);
    assert.match(errEv.text, /synthesize/i);
    const assistant = store
      .getMessages(thread.id)
      .find((m) => m.role === "assistant" && m.runId === runId);
    assert.equal(assistant, undefined);
  });

  it("stopRun mid-analyze kills children and marks agents failed", async () => {
    process.env.CODER_WF_TRAP_SIGTERM = "1";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "stop me mid analyze",
    });

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
    const runningOrPending = analyze.agents.filter(
      (a) => a.status === "running" || a.status === "pending",
    );
    assert.equal(runningOrPending.length, 0);
    assert.ok(analyze.agents.some((a) => a.status === "failed"));
  });

  it("stop mid-phase still records spendByDay from settled agents", async () => {
    const { localDayKey } = require("../store.js");
    process.env.CODER_WF_TRAP_SIGTERM = "1";
    const thread = store.getThreads()[0];
    const day = localDayKey();
    const before = store.getSpendToday();

    await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "stop after seed so spend sticks",
    });

    // Wait until analyze has started: seed (with cost) has already settled.
    await waitFor(() => {
      const a1 = readMarkers(markerDir, "analyze1").some((m) => m.phase === "start");
      const a2 = readMarkers(markerDir, "analyze2").some((m) => m.phase === "start");
      return a1 && a2;
    });

    await runner.stopRun({ threadId: thread.id });

    await waitFor(() => store.getThread(thread.id).status === "idle");

    // Seed agent emits total_cost_usd 0.001; per-agent recordSpend must have
    // landed even though the run never reached isFinal success.
    const today = store.data.spendByDay[day] || 0;
    assert.ok(
      today > before,
      `expected spendByDay[${day}] > ${before}, got ${today}`,
    );
    assert.ok(store.getSpendToday() > before);
  });

  it("rejects unavailable phase provider naming the binary", async () => {
    const missing = path.join(tmpDir, "no-such-claude-binary");
    process.env.CODER_CLAUDE_BIN = missing;
    const thread = store.getThreads()[0];
    await assert.rejects(
      () =>
        runner.startWorkflowRun({
          threadId: thread.id,
          prompt: "nope",
        }),
      (err) => {
        assert.match(String(err && err.message), /Provider binary not found/);
        assert.match(String(err && err.message), /no-such-claude-binary/);
        return true;
      },
    );
  });

  it("allows non-claude thread provider when template providers are available", async () => {
    services.setProvider(store, { threadId: store.getThreads()[0].id, provider: "codex" });
    const thread = store.getThreads()[0];
    const { runId } = await runner.startWorkflowRun({
      threadId: thread.id,
      prompt: "thread is codex, template is claude",
    });
    assert.ok(runId);
    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && (t.status === "done" || t.status === "failed");
    });
    assert.equal(store.getThread(thread.id).status, "done");
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
