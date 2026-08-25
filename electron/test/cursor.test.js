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
const { getProvider, resolveBin } = require("../providers.js");
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

/**
 * Fake cursor CLI. Reads CODER_FAKE_CURSOR_SCENARIO and optional argv file.
 * Success emits documented stream-json (system init, assistant deltas,
 * writeToolCall start/complete, result).
 * @param {string} dir
 * @returns {string} script path
 */
async function writeFakeCursor(dir) {
  const scriptPath = path.join(dir, "fake-cursor.js");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

if (process.env.CODER_FAKE_CURSOR_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CURSOR_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}

const scenario = process.env.CODER_FAKE_CURSOR_SCENARIO || "success";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function main() {
  if (scenario === "fail-exit") {
    process.stderr.write("cursor-stderr-boom\\n");
    process.exit(2);
    return;
  }

  if (scenario === "hang-after-init") {
    emit({
      type: "system",
      subtype: "init",
      apiKeySource: "login",
      cwd: process.cwd(),
      session_id: "cursor-sess-1",
      model: "Composer",
      permissionMode: "default",
    });
    setInterval(() => {}, 60 * 60 * 1000);
    return;
  }

  if (scenario === "duplicate-started") {
    const packedId = "call_dup1\\nfc_second_line";
    emit({
      type: "system",
      subtype: "init",
      apiKeySource: "login",
      cwd: process.cwd(),
      session_id: "cursor-sess-1",
      model: "Composer",
      permissionMode: "default",
    });
    await delay(10);
    const started = {
      type: "tool_call",
      subtype: "started",
      call_id: packedId,
      tool_call: {
        writeToolCall: { args: { path: "probe.txt", fileText: "hello" } },
      },
      session_id: "cursor-sess-1",
    };
    emit(started);
    await delay(10);
    emit(started);
    await delay(10);
    emit({
      type: "tool_call",
      subtype: "completed",
      call_id: packedId,
      tool_call: {
        writeToolCall: {
          args: { path: "probe.txt", fileText: "hello" },
          result: { success: { path: "probe.txt", linesCreated: 1 } },
        },
      },
      session_id: "cursor-sess-1",
    });
    await delay(10);
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 40,
      result: "ok",
      session_id: "cursor-sess-1",
    });
    process.exit(0);
    return;
  }

  if (scenario === "success" || scenario === "resume-echo") {
    emit({
      type: "system",
      subtype: "init",
      apiKeySource: "login",
      cwd: process.cwd(),
      session_id: "cursor-sess-1",
      model: "Composer",
      permissionMode: "default",
    });
    await delay(20);
    emit({
      type: "assistant",
      timestamp_ms: 1,
      message: { content: [{ type: "text", text: "Hello " }] },
      session_id: "cursor-sess-1",
    });
    await delay(20);
    emit({
      type: "assistant",
      timestamp_ms: 2,
      message: { content: [{ type: "text", text: "from cursor!" }] },
      session_id: "cursor-sess-1",
    });
    await delay(20);
    // End-of-turn flush: same shape as a complete message, duplicate of
    // the streamed deltas. The runner must not concatenate it again.
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello from cursor!" }] },
      session_id: "cursor-sess-1",
    });
    await delay(20);
    emit({
      type: "tool_call",
      subtype: "started",
      call_id: "tool-1",
      tool_call: {
        writeToolCall: {
          args: {
            path: "probe.txt",
            fileText: "hello",
            toolCallId: "tool-1",
          },
        },
      },
      session_id: "cursor-sess-1",
    });
    await delay(20);
    emit({
      type: "tool_call",
      subtype: "completed",
      call_id: "tool-1",
      tool_call: {
        writeToolCall: {
          args: {
            path: "probe.txt",
            fileText: "hello",
            toolCallId: "tool-1",
          },
          result: {
            success: {
              path: "probe.txt",
              linesCreated: 1,
              fileSize: 5,
            },
          },
        },
      },
      session_id: "cursor-sess-1",
    });
    await delay(20);
    emit({
      type: "assistant",
      timestamp_ms: 3,
      message: { content: [{ type: "text", text: "Wrote probe.txt" }] },
      session_id: "cursor-sess-1",
    });
    await delay(20);
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 80,
      duration_api_ms: 80,
      result: "Hello from cursor!Wrote probe.txt",
      session_id: "cursor-sess-1",
    });
    process.exit(0);
    return;
  }

  if (scenario === "task-subagent") {
    emit({
      type: "system",
      subtype: "init",
      apiKeySource: "login",
      cwd: process.cwd(),
      session_id: "cursor-sess-1",
      model: "GPT-5.6 Sol High Fast",
      permissionMode: "default",
    });
    await delay(20);
    emit({
      type: "tool_call",
      subtype: "started",
      call_id: "task-1",
      tool_call: {
        taskToolCall: {
          args: {
            description: "Re-review operations docs",
            prompt: "Re-review Task 6 after fixes.",
            model: "claude-sonnet-5-thinking-high",
            subagentType: { unspecified: {} },
          },
        },
      },
      session_id: "cursor-sess-1",
    });
    await delay(20);
    emit({
      type: "tool_call",
      subtype: "completed",
      call_id: "task-1",
      tool_call: {
        taskToolCall: {
          args: {
            description: "Re-review operations docs",
            prompt: "Re-review Task 6 after fixes.",
            model: "claude-sonnet-5-thinking-high",
            subagentType: { unspecified: {} },
          },
          result: { success: { result: "looks good" } },
        },
      },
      session_id: "cursor-sess-1",
    });
    await delay(20);
    emit({
      type: "assistant",
      timestamp_ms: 1,
      message: { content: [{ type: "text", text: "Done." }] },
      session_id: "cursor-sess-1",
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 40,
      duration_api_ms: 40,
      result: "Done.",
      session_id: "cursor-sess-1",
    });
    process.exit(0);
    return;
  }

  if (scenario === "task-subagent-notification") {
    emit({
      type: "system",
      subtype: "init",
      apiKeySource: "login",
      cwd: process.cwd(),
      session_id: "cursor-sess-1",
      model: "GPT-5.6 Sol High Fast",
      permissionMode: "default",
    });
    await delay(20);
    emit({
      type: "tool_call",
      subtype: "started",
      call_id: "task-1",
      tool_call: {
        taskToolCall: {
          args: {
            description: "Background research",
            prompt: "Look around.",
            model: "composer-2.5",
            subagentType: { unspecified: {} },
          },
        },
      },
      session_id: "cursor-sess-1",
    });
    // Hold the background agent visibly running before its notification.
    await delay(150);
    emit({
      type: "user",
      message: {
        content: [
          {
            type: "text",
            text:
              "<task-notification>\\n<task-id>abc123</task-id>\\n" +
              "<tool-use-id>task-1</tool-use-id>\\n" +
              "<status>completed</status>\\n" +
              '<summary>Agent "Background research" finished</summary>\\n' +
              "</task-notification>",
          },
        ],
      },
      session_id: "cursor-sess-1",
    });
    // Stay alive so the test can observe done while the run is still working
    // (proves we did not wait for run-exit settle).
    setInterval(() => {}, 60 * 60 * 1000);
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
  return writeFakeBin(scriptPath, body);
}

describe("cursor runner integration", () => {
  let tmpDir;
  let store;
  let runner;
  let pushes;
  let fakeBin;
  let argvFile;
  let prevCursorBin;
  let prevScenario;
  let prevArgv;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cursor-"));
    const projectDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projectDir);
    git(projectDir, ["init"]);
    git(projectDir, ["config", "user.email", "t@t.com"]);
    git(projectDir, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(projectDir, "README.md"), "hi\n");
    git(projectDir, ["add", "."]);
    git(projectDir, ["commit", "-m", "init"]);

    fakeBin = await writeFakeCursor(tmpDir);
    argvFile = path.join(tmpDir, "argv.json");

    prevCursorBin = process.env.CODER_CURSOR_BIN;
    prevScenario = process.env.CODER_FAKE_CURSOR_SCENARIO;
    prevArgv = process.env.CODER_FAKE_CURSOR_ARGV_FILE;
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_CURSOR_BIN = fakeBin;
    process.env.CODER_FAKE_CURSOR_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_CURSOR_SCENARIO = "success";

    const storePath = path.join(tmpDir, "store.json");
    store = new Store(storePath);
    const project = await services.addProject(store, projectDir);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Cursor Thread",
    });
    services.setProvider(store, { threadId: thread.id, provider: "cursor" });
    store.saveNow();

    pushes = [];
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: (ch, payload) => pushes.push({ ch, payload }),
      tickMs: 50,
      userDataPath: tmpDir,
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    if (prevCursorBin === undefined) delete process.env.CODER_CURSOR_BIN;
    else process.env.CODER_CURSOR_BIN = prevCursorBin;
    if (prevScenario === undefined) {
      delete process.env.CODER_FAKE_CURSOR_SCENARIO;
    } else process.env.CODER_FAKE_CURSOR_SCENARIO = prevScenario;
    if (prevArgv === undefined) delete process.env.CODER_FAKE_CURSOR_ARGV_FILE;
    else process.env.CODER_FAKE_CURSOR_ARGV_FILE = prevArgv;
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("streams assistant text, tool card, and captures sessionId", async () => {
    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "do the thing",
    });

    await waitFor(() => store.getThread(thread.id).status === "done");

    assert.equal(store.getThread(thread.id).sessionId, "cursor-sess-1");

    const msgs = store.getMessages(thread.id);
    const assistants = msgs.filter((m) => m.role === "assistant");
    assert.ok(assistants.length >= 1);
    assert.equal(assistants[0].text, "Hello from cursor!");
    assert.equal(assistants[0].runId, runId);

    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.ok(tools[0].tool);
    assert.equal(tools[0].tool.name, "Write");
    assert.equal(tools[0].tool.done, true);
    assert.match(String(tools[0].tool.input || ""), /probe\.txt/);
  });

  it("argv has print/stream-json flags, prompt last, no --worktree", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({
      threadId: thread.id,
      prompt: "do the thing",
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("-p"), `expected -p: ${JSON.stringify(argv)}`);
    assert.ok(argv.includes("--output-format"));
    assert.ok(argv.includes("stream-json"));
    assert.ok(argv.includes("--stream-partial-output"));
    assert.ok(argv.includes("--trust"));
    assert.ok(argv.includes("--force"));
    assert.equal(argv[argv.length - 1], "do the thing");
    assert.ok(!argv.includes("--worktree"));
  });

  it("injects --plugin-dir for the pin-task-parent plugin and keeps prompt last", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({
      threadId: thread.id,
      prompt: "do the thing",
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const pIdx = argv.indexOf("--plugin-dir");
    assert.ok(pIdx >= 0, `expected --plugin-dir: ${JSON.stringify(argv)}`);
    const pluginDir = path.resolve(tmpDir, "cursor-pin-parent");
    assert.equal(argv[pIdx + 1], pluginDir);
    assert.ok(pIdx < argv.length - 1, "prompt must stay last");
    assert.equal(argv[argv.length - 1], "do the thing");
    assert.ok(
      fs.existsSync(path.join(pluginDir, ".cursor-plugin", "plugin.json")),
      "plugin must be materialized under userDataPath",
    );
    assert.ok(
      fs.existsSync(path.join(pluginDir, "scripts", "pin-task-parent.js")),
    );
  });

  it("falls back to tmpdir for --plugin-dir when userDataPath is unset", async () => {
    runner.stopAll();
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: (ch, payload) => pushes.push({ ch, payload }),
      tickMs: 50,
    });
    const thread = store.getThreads()[0];
    await runner.startRun({
      threadId: thread.id,
      prompt: "do the thing",
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const pIdx = argv.indexOf("--plugin-dir");
    assert.ok(pIdx >= 0, `expected --plugin-dir: ${JSON.stringify(argv)}`);
    assert.equal(
      argv[pIdx + 1],
      path.resolve(os.tmpdir(), "solenta-cursor-pin-parent"),
    );
    assert.equal(argv[argv.length - 1], "do the thing");
  });

  it("second turn with sessionId emits --resume cursor-sess-1", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "turn one" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(store.getThread(thread.id).sessionId, "cursor-sess-1");

    fs.unlinkSync(argvFile);

    await runner.startRun({ threadId: thread.id, prompt: "turn two" });
    await waitFor(() => store.getUsage(thread.id).turns === 2);
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const rIdx = argv.indexOf("--resume");
    assert.ok(rIdx >= 0, `expected --resume in ${JSON.stringify(argv)}`);
    assert.equal(argv[rIdx + 1], "cursor-sess-1");
    assert.equal(argv[argv.length - 1], "turn two");
  });

  it("stores sessionId from system/init before the process exits (issue #691)", async () => {
    process.env.CODER_FAKE_CURSOR_SCENARIO = "hang-after-init";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "stay up" });
    await waitFor(() => runner.isRunning(thread.id));
    // Longer than the success scenario's delays, so a wrong env cannot pass.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(
      store.getThread(thread.id).status,
      "working",
      "hang-after-init must still be running",
    );
    assert.equal(store.getThread(thread.id).sessionId, "cursor-sess-1");
    await runner.stopRun({ threadId: thread.id });
    assert.equal(store.getThread(thread.id).sessionId, "cursor-sess-1");
  });

  it("duplicate tool_call started with a packed call_id leaves one done card", async () => {
    process.env.CODER_FAKE_CURSOR_SCENARIO = "duplicate-started";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "write it" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    const tools = store.getMessages(thread.id).filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool.done, true);
    assert.equal(tools[0].tool.id, "call_dup1");
  });

  it("fail-exit sets failed + event message", async () => {
    process.env.CODER_FAKE_CURSOR_SCENARIO = "fail-exit";
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
          /cursor-stderr-boom/i.test(m.text) &&
          m.runId === runId,
      ),
    );
  });

  it("plan permissionMode emits --mode plan and omits --force", async () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { permissionMode: "plan" });
    store.saveNow();

    await runner.startRun({ threadId: thread.id, prompt: "plan it" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const mIdx = argv.indexOf("--mode");
    assert.ok(mIdx >= 0, `expected --mode in ${JSON.stringify(argv)}`);
    assert.equal(argv[mIdx + 1], "plan");
    assert.ok(
      !argv.includes("--force"),
      `plan must not emit --force: ${JSON.stringify(argv)}`,
    );
  });

  it("uses CODER_CURSOR_BIN over defaultBin", () => {
    const entry = getProvider("cursor");
    assert.ok(entry);
    assert.equal(entry.kind, "cursor-stream");
    assert.equal(entry.binEnv, "CODER_CURSOR_BIN");
    assert.ok(entry.defaultBin);
    assert.equal(resolveBin(entry), fakeBin);
  });

  it("passes thread.model as --model", async () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { model: "gpt-5.6-sol-high-fast" });
    store.saveNow();
    await runner.startRun({ threadId: thread.id, prompt: "do the thing" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const idx = argv.indexOf("--model");
    assert.ok(idx >= 0, `expected --model in ${JSON.stringify(argv)}`);
    assert.equal(argv[idx + 1], "gpt-5.6-sol-high-fast");
  });

  it("summarizes Cursor Task as description plus subagent model, not raw JSON", async () => {
    process.env.CODER_FAKE_CURSOR_SCENARIO = "task-subagent";
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { model: "gpt-5.6-sol-high-fast" });
    store.saveNow();
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const tools = store.getMessages(thread.id).filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool.name, "Task");
    assert.equal(
      tools[0].text,
      "Task: Re-review operations docs (claude-sonnet-5-thinking-high)",
    );
  });

  it("tracks Cursor Task calls on thread.subagents until the tool completes", async () => {
    process.env.CODER_FAKE_CURSOR_SCENARIO = "task-subagent";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const subs = store.getThread(thread.id).subagents;
    assert.ok(Array.isArray(subs));
    assert.equal(subs.length, 1);
    assert.equal(subs[0].id, "task-1");
    assert.equal(subs[0].description, "Re-review operations docs");
    assert.equal(subs[0].status, "done");
  });

  it("settles a Cursor background Task from a <task-notification> before run exit (issue #708)", async () => {
    process.env.CODER_FAKE_CURSOR_SCENARIO = "task-subagent-notification";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "go" });

    await waitFor(() => {
      const subs = store.getThread(thread.id).subagents || [];
      return subs.some((s) => s.id === "task-1" && s.status === "running");
    });

    await waitFor(() => {
      const t = store.getThread(thread.id);
      const subs = t.subagents || [];
      return (
        t.status === "working" &&
        subs.some((s) => s.id === "task-1" && s.status === "done")
      );
    });

    const subs = store.getThread(thread.id).subagents;
    assert.equal(subs.length, 1);
    assert.equal(subs[0].id, "task-1");
    assert.equal(subs[0].description, "Background research");
    assert.equal(subs[0].status, "done");
    assert.equal(store.getThread(thread.id).status, "working");

    await runner.stopRun({ threadId: thread.id });
  });
});
