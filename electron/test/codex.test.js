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
const {
  extractSessionId,
  isSessionStartEvent,
  extractAgentMessageText,
  extractCommandItem,
  extractUsage,
} = require("../codex.js");

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

/**
 * Fake codex CLI emitting representative JSONL.
 * @param {string} dir
 */
function writeFakeCodex(dir) {
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

if (process.env.CODER_FAKE_CODEX_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CODEX_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}

const scenario = process.env.CODER_FAKE_CODEX_SCENARIO || "success";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function main() {
  if (scenario === "fail-exit") {
    process.stderr.write("codex-stderr-boom\\n");
    process.exit(2);
    return;
  }

  if (scenario === "success" || scenario === "resume-turn") {
    emit({ type: "thread.started", thread_id: "codex-sess-001" });
    await delay(20);
    emit({
      type: "item.completed",
      item: {
        id: "item-msg-1",
        type: "agent_message",
        text: "Hello from codex",
      },
    });
    await delay(20);
    emit({
      type: "item.started",
      item: {
        id: "item-cmd-1",
        type: "command_execution",
        command: "echo hi",
      },
    });
    await delay(20);
    emit({
      type: "item.completed",
      item: {
        id: "item-cmd-1",
        type: "command_execution",
        command: "echo hi",
        aggregated_output: "hi\\n",
        exit_code: 0,
      },
    });
    await delay(20);
    emit({
      type: "turn.completed",
      usage: { input_tokens: 30, output_tokens: 12 },
    });
    process.exit(0);
    return;
  }

  process.stderr.write("unknown scenario " + scenario + "\\n");
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(String(e) + "\\n");
  process.exit(1);
});
`;
  const launcher = path.join(dir, "fake-codex");
  fs.writeFileSync(launcher, body, { mode: 0o755 });
  return launcher;
}

describe("codex event parse helpers", () => {
  it("extracts session id from thread.started", () => {
    const ev = { type: "thread.started", thread_id: "t-1" };
    assert.equal(isSessionStartEvent(ev), true);
    assert.equal(extractSessionId(ev), "t-1");
  });

  it("extracts agent message text from item.completed", () => {
    assert.equal(
      extractAgentMessageText({
        type: "item.completed",
        item: { type: "agent_message", text: "hi" },
      }),
      "hi",
    );
  });

  it("extracts command items start/complete", () => {
    const start = extractCommandItem({
      type: "item.started",
      item: { id: "c1", type: "command_execution", command: "ls" },
    });
    assert.equal(start.phase, "started");
    assert.equal(start.command, "ls");

    const done = extractCommandItem({
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "ls",
        aggregated_output: "a\\nb",
        exit_code: 1,
      },
    });
    assert.equal(done.phase, "completed");
    assert.equal(done.exitCode, 1);
    assert.match(done.output, /a/);
  });

  it("extracts usage from turn.completed", () => {
    const u = extractUsage({
      type: "turn.completed",
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    assert.equal(u.inputTokens, 5);
    assert.equal(u.outputTokens, 7);
  });

  it("ignores unknown event types", () => {
    assert.equal(extractAgentMessageText({ type: "mystery", foo: 1 }), null);
    assert.equal(extractCommandItem({ type: "mystery" }), null);
  });
});

describe("runner codex provider", () => {
  let tmpDir;
  let store;
  let runner;
  let pushes;
  let core;
  let prevSimulate;
  let prevAgentCmd;
  let prevCodexBin;
  let prevScenario;
  let prevArgvFile;
  let fakeCodex;
  let argvFile;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevCodexBin = process.env.CODER_CODEX_BIN;
    prevScenario = process.env.CODER_FAKE_CODEX_SCENARIO;
    prevArgvFile = process.env.CODER_FAKE_CODEX_ARGV_FILE;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-codex-"));
    fakeCodex = writeFakeCodex(tmpDir);
    argvFile = path.join(tmpDir, "argv.json");
    process.env.CODER_CODEX_BIN = fakeCodex;
    process.env.CODER_FAKE_CODEX_ARGV_FILE = argvFile;

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
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Codex Thread",
    });
    services.setProvider(store, { threadId: thread.id, provider: "codex" });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevCodexBin === undefined) delete process.env.CODER_CODEX_BIN;
    else process.env.CODER_CODEX_BIN = prevCodexBin;
    if (prevScenario === undefined) delete process.env.CODER_FAKE_CODEX_SCENARIO;
    else process.env.CODER_FAKE_CODEX_SCENARIO = prevScenario;
    if (prevArgvFile === undefined) delete process.env.CODER_FAKE_CODEX_ARGV_FILE;
    else process.env.CODER_FAKE_CODEX_ARGV_FILE = prevArgvFile;
  });

  it("full lifecycle: sessionId, assistant, tool Command, usage, done", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const thread = store.getThreads()[0];
    assert.equal(thread.provider, "codex");

    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "codex please",
    });

    await waitFor(() => store.getThread(thread.id).status === "done");

    const updated = store.getThread(thread.id);
    assert.equal(updated.sessionId, "codex-sess-001");
    assert.equal(updated.status, "done");

    const msgs = store.getMessages(thread.id);
    const assistants = msgs.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, "Hello from codex");
    assert.equal(assistants[0].runId, runId);

    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool.name, "Command");
    assert.match(tools[0].tool.input, /echo hi/);
    assert.equal(tools[0].tool.done, true);
    assert.equal(tools[0].tool.isError, false);
    assert.match(tools[0].tool.output, /hi/);

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 30);
    assert.equal(usage.outputTokens, 12);
    assert.equal(usage.costUsd, 0);
    assert.equal(usage.turns, 1);

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    // Shebang scripts include the script path as argv[0]; flags follow.
    const execIdx = argv.indexOf("exec");
    assert.ok(execIdx >= 0, `expected exec in ${JSON.stringify(argv)}`);
    assert.ok(argv.includes("--json"));
    assert.ok(argv.includes("--skip-git-repo-check"));
    assert.equal(argv[argv.length - 1], "codex please");
    assert.ok(!argv.includes("resume"));
  });

  it("resume pass uses exec resume <sessionId>", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "first" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(store.getThread(thread.id).sessionId, "codex-sess-001");

    process.env.CODER_FAKE_CODEX_SCENARIO = "resume-turn";
    fs.unlinkSync(argvFile);

    await runner.startRun({ threadId: thread.id, prompt: "second" });
    await waitFor(() => {
      const msgs = store.getMessages(thread.id);
      return msgs.filter((m) => m.role === "assistant").length >= 2;
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const execIdx = argv.indexOf("exec");
    assert.ok(execIdx >= 0, `expected exec in ${JSON.stringify(argv)}`);
    assert.equal(argv[execIdx + 1], "resume");
    assert.equal(argv[execIdx + 2], "codex-sess-001");
    assert.ok(argv.includes("--json"));
    assert.equal(argv[argv.length - 1], "second");
  });

  it("nonzero exit without stream sets failed + stderr", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "fail-exit";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "boom",
    });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    assert.ok(
      store
        .getMessages(thread.id)
        .some(
          (m) =>
            m.role === "event" &&
            /Run error/i.test(m.text) &&
            /codex-stderr-boom/i.test(m.text) &&
            m.runId === runId,
        ),
    );
  });
});
