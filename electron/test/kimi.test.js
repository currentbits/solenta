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
  extractAssistantText,
  extractToolEvent,
  extractUsage,
} = require("../kimi.js");
const { getProvider } = require("../providers.js");

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
 * Fake kimi CLI. Reads CODER_FAKE_KIMI_SCENARIO and optional argv file.
 * @param {string} dir
 * @returns {string} script path
 */
function writeFakeKimi(dir) {
  const scriptPath = path.join(dir, "fake-kimi.js");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

if (process.env.CODER_FAKE_KIMI_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_KIMI_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}

const scenario = process.env.CODER_FAKE_KIMI_SCENARIO || "success";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function main() {
  if (scenario === "fail-exit") {
    process.stderr.write("kimi-stderr-boom\\n");
    process.exit(2);
    return;
  }

  if (scenario === "slow") {
    emit({ type: "text", text: "partial" });
    await delay(60000);
    process.exit(0);
    return;
  }

  if (scenario === "success") {
    emit({ type: "text", text: "Hello " });
    await delay(20);
    emit({ type: "message", content: "from " });
    await delay(20);
    emit({ type: "assistant", delta: "kimi" });
    await delay(20);
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "!" }],
      },
    });
    await delay(20);
    emit({
      type: "tool_call",
      id: "tool-1",
      name: "Bash",
      input: { command: "echo hi" },
    });
    await delay(20);
    emit({
      type: "tool_result",
      id: "tool-1",
      name: "Bash",
      output: "hi\\n",
    });
    await delay(20);
    emit({
      type: "usage",
      input_tokens: 12,
      output_tokens: 8,
    });
    process.exit(0);
    return;
  }

  if (scenario === "plain-text") {
    // No JSON at all: entire stdout is plain text.
    process.stdout.write("Plain kimi reply without JSON\\n");
    process.exit(0);
    return;
  }

  if (scenario === "continue-turn") {
    emit({ type: "text", text: "Continued reply" });
    emit({ usage: { prompt_tokens: 5, completion_tokens: 3 } });
    process.exit(0);
    return;
  }

  process.stderr.write("unknown scenario\\n");
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(String(e) + "\\n");
  process.exit(1);
});
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

describe("kimi extract helpers", () => {
  it("extracts assistant text from type text/message/assistant string fields", () => {
    assert.equal(extractAssistantText({ type: "text", text: "a" }), "a");
    assert.equal(extractAssistantText({ type: "message", content: "b" }), "b");
    assert.equal(extractAssistantText({ type: "assistant", delta: "c" }), "c");
    assert.equal(
      extractAssistantText({
        type: "assistant",
        message: { content: "nested-str" },
      }),
      "nested-str",
    );
    assert.equal(
      extractAssistantText({
        type: "assistant",
        message: { content: [{ type: "text", text: "arr" }] },
      }),
      "arr",
    );
    assert.equal(extractAssistantText({ type: "other", text: "x" }), null);
  });

  it("extracts tool events when type contains tool and name is set", () => {
    const start = extractToolEvent({
      type: "tool_call",
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
    });
    assert.ok(start);
    assert.equal(start.id, "t1");
    assert.equal(start.name, "Bash");
    assert.equal(start.phase, "start");

    const end = extractToolEvent({
      type: "tool_result",
      id: "t1",
      name: "Bash",
      output: "ok",
    });
    assert.ok(end);
    assert.equal(end.phase, "end");
    assert.equal(end.output, "ok");

    assert.equal(
      extractToolEvent({ type: "tool_call", id: "x" /* no name */ }),
      null,
    );
  });

  it("extracts usage from top-level and nested usage fields", () => {
    assert.deepEqual(extractUsage({ input_tokens: 1, output_tokens: 2 }), {
      inputTokens: 1,
      outputTokens: 2,
    });
    assert.deepEqual(
      extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } }),
      { inputTokens: 3, outputTokens: 4 },
    );
    assert.equal(extractUsage({ type: "text", text: "hi" }), null);
  });
});

describe("kimi provider buildArgs", () => {
  it("builds stream-json args with model, permission flags, and -c resume", () => {
    const entry = getProvider("kimi");
    assert.ok(entry);
    assert.equal(entry.kind, "kimi-stream");
    assert.equal(entry.supportsResume, true);
    assert.deepEqual(entry.models, [
      // Alias keys: bare model values fail -m with config.invalid.
      "kimi-code/k3",
      "kimi-code/k3-256k",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
    ]);

    const base = entry.buildArgs({ prompt: "hi", permissionMode: "default" });
    assert.ok(base.includes("-p"));
    assert.equal(base[base.indexOf("-p") + 1], "hi");
    assert.ok(base.includes("--output-format"));
    assert.ok(base.includes("stream-json"));
    assert.ok(!base.includes("-y"));
    assert.ok(!base.includes("--auto"));
    assert.ok(!base.includes("-c"));

    const withModel = entry.buildArgs({
      prompt: "p",
      model: "kimi-code/kimi-for-coding",
    });
    const mIdx = withModel.indexOf("-m");
    assert.ok(mIdx >= 0);
    assert.equal(withModel[mIdx + 1], "kimi-code/kimi-for-coding");

    const accept = entry.buildArgs({
      prompt: "p",
      permissionMode: "acceptEdits",
    });
    assert.ok(accept.includes("-y"));

    const bypass = entry.buildArgs({
      prompt: "p",
      permissionMode: "bypassPermissions",
    });
    assert.ok(bypass.includes("--auto"));

    const plan = entry.buildArgs({ prompt: "p", permissionMode: "plan" });
    assert.ok(!plan.includes("-y"));
    assert.ok(!plan.includes("--auto"));

    // Resume uses -c (continue), not a session id string.
    const cont = entry.buildArgs({
      prompt: "again",
      sessionId: "cwd",
    });
    assert.ok(cont.includes("-c"));
    assert.ok(!cont.includes("cwd"));
  });
});

describe("kimi runner integration", () => {
  let tmpDir;
  let store;
  let runner;
  let pushes;
  let fakeBin;
  let argvFile;
  let prevKimiBin;
  let prevScenario;
  let prevArgv;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-kimi-"));
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    git(projectDir, ["init"]);
    git(projectDir, ["config", "user.email", "t@t.com"]);
    git(projectDir, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
    git(projectDir, ["add", "."]);
    git(projectDir, ["commit", "-m", "init"]);

    fakeBin = writeFakeKimi(tmpDir);
    argvFile = path.join(tmpDir, "argv.json");

    prevKimiBin = process.env.CODER_KIMI_BIN;
    prevScenario = process.env.CODER_FAKE_KIMI_SCENARIO;
    prevArgv = process.env.CODER_FAKE_KIMI_ARGV_FILE;
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_KIMI_BIN = fakeBin;
    process.env.CODER_FAKE_KIMI_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_KIMI_SCENARIO = "success";

    const storePath = path.join(tmpDir, "store.json");
    store = new Store(storePath);
    const project = services.addProject(store, projectDir);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Kimi Thread",
    });
    services.setProvider(store, { threadId: thread.id, provider: "kimi" });
    store.save();

    pushes = [];
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: (ch, payload) => pushes.push({ ch, payload }),
      tickMs: 50,
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    if (prevKimiBin === undefined) delete process.env.CODER_KIMI_BIN;
    else process.env.CODER_KIMI_BIN = prevKimiBin;
    if (prevScenario === undefined) delete process.env.CODER_FAKE_KIMI_SCENARIO;
    else process.env.CODER_FAKE_KIMI_SCENARIO = prevScenario;
    if (prevArgv === undefined) delete process.env.CODER_FAKE_KIMI_ARGV_FILE;
    else process.env.CODER_FAKE_KIMI_ARGV_FILE = prevArgv;
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("streams text from multiple JSON shapes, tools, usage; sets sessionId cwd", async () => {
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "do the thing",
    });

    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.equal(store.getThread(thread.id).sessionId, "cwd");

    const msgs = store.getMessages(thread.id);
    const assistants = msgs.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, "Hello from kimi!");
    assert.equal(assistants[0].runId, runId);

    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool.name, "Bash");
    assert.equal(tools[0].tool.done, true);
    assert.match(tools[0].tool.input, /echo hi/);
    assert.match(String(tools[0].tool.output || ""), /hi/);

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.inputTokens, 12);
    assert.equal(usage.outputTokens, 8);
    assert.equal(usage.costUsd, 0);
    assert.equal(usage.turns, 1);

    const detail = services.getThreadDetail(store, thread.id);
    assert.equal(detail.workflow, null);

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("-p"));
    assert.ok(argv.includes("--output-format"));
    assert.ok(argv.includes("stream-json"));
    assert.equal(argv[argv.indexOf("-p") + 1], "do the thing");
    assert.ok(!argv.includes("-c"));
  });

  it("plain-text fallback when stdout has no JSON lines", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "plain-text";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "plain" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const assistants = store
      .getMessages(thread.id)
      .filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.match(assistants[0].text, /Plain kimi reply without JSON/);
  });

  it("second turn passes -c continue with sessionId sentinel cwd", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "success";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "turn one" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(store.getThread(thread.id).sessionId, "cwd");

    process.env.CODER_FAKE_KIMI_SCENARIO = "continue-turn";
    fs.unlinkSync(argvFile);

    await runner.startRun({ threadId: thread.id, prompt: "turn two" });
    await waitFor(() => {
      const msgs = store.getMessages(thread.id);
      return msgs.some(
        (m) => m.role === "assistant" && m.text === "Continued reply",
      );
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("-c"), `expected -c in ${JSON.stringify(argv)}`);
    assert.equal(argv[argv.indexOf("-p") + 1], "turn two");
    assert.equal(store.getThread(thread.id).sessionId, "cwd");

    const usage = store.getUsage(thread.id);
    assert.equal(usage.inputTokens, 17);
    assert.equal(usage.outputTokens, 11);
    assert.equal(usage.turns, 2);
  });

  it("maps permission flags and propagates -m model", async () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, {
      permissionMode: "acceptEdits",
      model: "kimi-code/kimi-for-coding-highspeed",
    });
    store.save();

    await runner.startRun({ threadId: thread.id, prompt: "flagged" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("-y"));
    const mIdx = argv.indexOf("-m");
    assert.ok(mIdx >= 0);
    assert.equal(argv[mIdx + 1], "kimi-code/kimi-for-coding-highspeed");
  });

  it("bypassPermissions maps to --auto", async () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { permissionMode: "bypassPermissions" });
    store.save();

    await runner.startRun({ threadId: thread.id, prompt: "auto" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("--auto"));
  });

  it("nonzero exit sets failed + stderr tail", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "fail-exit";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "boom",
    });
    await waitFor(() => store.getThread(thread.id).status === "failed");

    assert.ok(
      store.getMessages(thread.id).some(
        (m) =>
          m.role === "event" &&
          /Run error/i.test(m.text) &&
          /kimi-stderr-boom/i.test(m.text) &&
          m.runId === runId,
      ),
    );
  });

  it("stopRun kills kimi process and leaves idle", async () => {
    process.env.CODER_FAKE_KIMI_SCENARIO = "slow";
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "long",
    });
    await waitFor(() => store.getThread(thread.id).status === "working");
    await new Promise((r) => setTimeout(r, 80));

    await runner.stopRun({ threadId: thread.id });
    assert.equal(store.getThread(thread.id).status, "idle");
    assert.ok(
      store
        .getMessages(thread.id)
        .some(
          (m) =>
            m.role === "event" &&
            /Run stopped/i.test(m.text) &&
            m.runId === runId,
        ),
    );
  });
});
