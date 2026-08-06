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

/**
 * Write a fake claude CLI script. Reads CODER_FAKE_CLAUDE_SCENARIO and optional
 * CODER_FAKE_CLAUDE_ARGV_FILE. Emits stream-json NDJSON on stdout.
 * @param {string} dir
 * @returns {string} path to the fake binary script
 */
function writeFakeClaude(dir) {
  const scriptPath = path.join(dir, "fake-claude.js");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

if (process.env.CODER_FAKE_CLAUDE_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}

const scenario = process.env.CODER_FAKE_CLAUDE_SCENARIO || "success";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function main() {
  if (scenario === "fail-exit") {
    process.stderr.write("claude-stderr-boom\\n");
    process.exit(2);
    return;
  }

  if (scenario === "slow") {
    emit({ type: "system", subtype: "init", session_id: "sess-slow", model: "claude-test" });
    await delay(60000);
    process.exit(0);
    return;
  }

  if (scenario === "success") {
    emit({
      type: "system",
      subtype: "init",
      session_id: "sess-abc-001",
      model: "claude-opus-test",
    });
    await delay(30);
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello " }],
      },
    });
    await delay(30);
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "world" }],
      },
    });
    await delay(30);
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
      },
    });
    await delay(30);
    emit({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "tests passed" }],
            is_error: false,
          },
        ],
      },
    });
    await delay(30);
    emit({
      type: "result",
      subtype: "success",
      result: "All done.",
      usage: { input_tokens: 100, output_tokens: 50 },
      total_cost_usd: 0.01,
      num_turns: 1,
      session_id: "sess-abc-001",
    });
    process.exit(0);
    return;
  }

  if (scenario === "tool-error") {
    emit({
      type: "system",
      subtype: "init",
      session_id: "sess-err",
      model: "claude-opus-test",
    });
    await delay(20);
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_err",
            name: "Bash",
            input: { command: "false" },
          },
        ],
      },
    });
    await delay(20);
    emit({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_err",
            content: "command failed",
            is_error: true,
          },
        ],
      },
    });
    await delay(20);
    emit({
      type: "result",
      subtype: "success",
      result: "handled error",
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.001,
      num_turns: 1,
      session_id: "sess-err",
    });
    process.exit(0);
    return;
  }

  if (scenario === "resume-turn") {
    // Second turn: expect --resume in argv (asserted by test via argv file).
    emit({
      type: "system",
      subtype: "init",
      session_id: "sess-abc-001",
      model: "claude-opus-test",
    });
    await delay(20);
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Second turn reply" }],
      },
    });
    await delay(20);
    emit({
      type: "result",
      subtype: "success",
      result: "Second done.",
      usage: { input_tokens: 40, output_tokens: 20 },
      total_cost_usd: 0.005,
      num_turns: 2,
      session_id: "sess-abc-001",
    });
    process.exit(0);
    return;
  }

  if (scenario === "result-only") {
    emit({
      type: "system",
      subtype: "init",
      session_id: "sess-ro",
      model: "m",
    });
    await delay(20);
    emit({
      type: "result",
      subtype: "success",
      result: "Only result text",
      usage: { input_tokens: 1, output_tokens: 2 },
      total_cost_usd: 0,
      num_turns: 1,
      session_id: "sess-ro",
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
  fs.writeFileSync(scriptPath, body, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  // Wrapper shell-free: use node as CODER_CLAUDE_BIN pointing at this script
  // via: node fake-claude.js ... but contract wants binary. Use node + script
  // by setting CODER_CLAUDE_BIN to a small launcher.
  const launcher = path.join(dir, "fake-claude");
  // On macOS we can use a node shebang script directly as the binary.
  fs.writeFileSync(launcher, body, "utf8");
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

describe("runner claude provider", () => {
  let tmpDir;
  let store;
  let runner;
  let pushes;
  let core;
  let prevSimulate;
  let prevAgentCmd;
  let prevClaudeBin;
  let prevScenario;
  let prevArgvFile;
  let fakeClaude;
  let argvFile;

  let prevGrokMcpDisable;
  let prevGrokBin;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevScenario = process.env.CODER_FAKE_CLAUDE_SCENARIO;
    prevArgvFile = process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    prevGrokMcpDisable = process.env.CODER_GROK_MCP_DISABLE;
    prevGrokBin = process.env.CODER_GROK_BIN;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    // Structural kill switch + fake bin: supervisor tests must never touch
    // ~/.grok/config.toml via real `grok mcp add -s user`.
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-claude-"));
    fakeClaude = writeFakeClaude(tmpDir);
    argvFile = path.join(tmpDir, "argv.json");
    process.env.CODER_CLAUDE_BIN = fakeClaude;
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE = argvFile;

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
      title: "Claude Thread",
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
    if (prevScenario === undefined) delete process.env.CODER_FAKE_CLAUDE_SCENARIO;
    else process.env.CODER_FAKE_CLAUDE_SCENARIO = prevScenario;
    if (prevArgvFile === undefined) delete process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    else process.env.CODER_FAKE_CLAUDE_ARGV_FILE = prevArgvFile;
    if (prevGrokMcpDisable === undefined) delete process.env.CODER_GROK_MCP_DISABLE;
    else process.env.CODER_GROK_MCP_DISABLE = prevGrokMcpDisable;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
  });

  it("captures session id on init, streams text into one assistant message, pairs tools", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "success";

    const thread = store.getThreads()[0];
    assert.equal(thread.provider, "claude");
    assert.equal(thread.sessionId, null);

    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "do the thing",
    });
    assert.ok(runId);

    await waitFor(() => {
      const t = store.getThreads().find((x) => x.id === thread.id);
      return t && t.status === "done";
    });

    const updated = store.getThread(thread.id);
    assert.equal(updated.sessionId, "sess-abc-001");

    const msgs = store.getMessages(thread.id);
    const assistants = msgs.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, "Hello world");
    assert.equal(assistants[0].runId, runId);

    const tools = msgs.filter((m) => m.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool.id, "toolu_1");
    assert.equal(tools[0].tool.name, "Bash");
    assert.match(tools[0].tool.input, /npm test/);
    assert.equal(tools[0].tool.done, true);
    assert.equal(tools[0].tool.isError, false);
    assert.match(tools[0].tool.output, /tests passed/);
    assert.match(tools[0].text, /Bash/i);

    const workLog = store.getWorkLog(thread.id);
    const starting = workLog.filter((w) => w.label === "Starting agent");
    const working = workLog.filter((w) => w.label === "Agent working");
    assert.equal(starting.length, 1);
    assert.equal(starting[0].done, true);
    assert.equal(starting[0].runId, runId);
    assert.equal(working.length, 1);
    assert.equal(working[0].done, true);

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.model, "claude-opus-test");
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 50);
    assert.equal(usage.costUsd, 0.01);
    assert.equal(usage.turns, 1);

    const detail = services.getThreadDetail(store, thread.id);
    assert.equal(detail.usage.inputTokens, 100);
    assert.equal(detail.workflow, null);

    // argv should include -p, stream-json, permission-mode, prompt last
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("-p"));
    assert.ok(argv.includes("--output-format"));
    assert.ok(argv.includes("stream-json"));
    assert.ok(argv.includes("--verbose"));
    assert.ok(argv.includes("--permission-mode"));
    assert.ok(argv.includes("default"));
    assert.equal(argv[argv.length - 1], "do the thing");
    assert.ok(!argv.includes("--resume"));
  });

  it("pairs tool_result is_error into tool message", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "tool-error";

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "fail tool" });

    await waitFor(() => {
      const t = store.getThreads().find((x) => x.id === thread.id);
      return t && t.status === "done";
    });

    const tool = store.getMessages(thread.id).find((m) => m.role === "tool");
    assert.ok(tool);
    assert.equal(tool.tool.done, true);
    assert.equal(tool.tool.isError, true);
    assert.match(tool.tool.output, /command failed/);
  });

  it("accumulates usage across two turns and passes --resume", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "success";

    const thread = store.getThreads()[0];
    const first = await runner.startRun({
      threadId: thread.id,
      prompt: "turn one",
    });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(store.getThread(thread.id).sessionId, "sess-abc-001");

    const usage1 = store.getUsage(thread.id);
    assert.equal(usage1.inputTokens, 100);
    assert.equal(usage1.turns, 1);

    // Second turn with resume
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "resume-turn";
    fs.unlinkSync(argvFile);

    const second = await runner.startRun({
      threadId: thread.id,
      prompt: "turn two",
    });
    assert.notEqual(first.runId, second.runId);

    await waitFor(() => {
      const msgs = store.getMessages(thread.id);
      return msgs.some(
        (m) => m.role === "assistant" && m.text === "Second turn reply",
      );
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const usage2 = store.getUsage(thread.id);
    assert.equal(usage2.inputTokens, 140);
    assert.equal(usage2.outputTokens, 70);
    assert.ok(Math.abs(usage2.costUsd - 0.015) < 1e-9);
    assert.equal(usage2.turns, 2);
    assert.equal(usage2.model, "claude-opus-test");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const resumeIdx = argv.indexOf("--resume");
    assert.ok(resumeIdx >= 0, `expected --resume in ${JSON.stringify(argv)}`);
    assert.equal(argv[resumeIdx + 1], "sess-abc-001");
    assert.equal(argv[argv.length - 1], "turn two");
  });

  it("nonzero exit without result sets failed + Run error", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "fail-exit";

    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "boom",
    });

    await waitFor(() => store.getThread(thread.id).status === "failed");

    const msgs = store.getMessages(thread.id);
    assert.ok(
      msgs.some(
        (m) =>
          m.role === "event" &&
          /Run error/i.test(m.text) &&
          /claude-stderr-boom/i.test(m.text) &&
          m.runId === runId,
      ),
    );
  });

  it("stopRun kills claude process and leaves idle + Run stopped", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "slow";

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

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(store.getThread(thread.id).status, "idle");
  });

  it("uses result text when no assistant text was streamed", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "result-only";

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "quiet" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const assistants = store
      .getMessages(thread.id)
      .filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, "Only result text");
  });

  it("adds --mcp-config to claude argv only when memory server is healthy", async () => {
    const {
      resetMemorySupForTests,
      createMemorySupervisor,
      getClaudeMcpArgs,
    } = require("../memory-sup.js");
    const http = require("node:http");

    resetMemorySupForTests();
    // Unhealthy: no --mcp-config
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "success";
    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "no-mem" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    let argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(!argv.includes("--mcp-config"));
    assert.equal(getClaudeMcpArgs().length, 0);

    // Healthy: adopt fake health server and expect --mcp-config
    const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-claude-mem-"));
    const freePort = await new Promise((resolve, reject) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close((err) => (err ? reject(err) : resolve(port)));
      });
      s.on("error", reject);
    });
    fs.writeFileSync(
      path.join(memDir, "memory-server.json"),
      JSON.stringify({
        port: freePort,
        token: "mcp-test-token",
        dbPath: path.join(memDir, "db"),
      }),
      "utf8",
    );
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(freePort, "127.0.0.1", r));
    try {
      const sup = createMemorySupervisor({
        userDataPath: memDir,
        appPath: memDir,
        log: () => {},
        env: {
          ...process.env,
          // Defense in depth: never run real `grok mcp add` during tests
          // (-s user writes ~/.grok/config.toml with no path override).
          CODER_GROK_MCP_DISABLE: "1",
          CODER_GROK_BIN: path.join(memDir, "no-grok-not-a-real-binary"),
          CODER_KIMI_BIN: path.join(memDir, "no-kimi"),
        },
      });
      await sup.start();
      assert.equal(sup.getStatus().running, true);
      assert.ok(getClaudeMcpArgs().includes("--mcp-config"));

      // Fresh thread for second run
      const project = store.getProjects()[0];
      const t2 = services.createThread(store, {
        projectId: project.id,
        title: "Claude Mem",
      });
      fs.unlinkSync(argvFile);
      await runner.startRun({ threadId: t2.id, prompt: "with-mem" });
      await waitFor(() => store.getThread(t2.id).status === "done");
      argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      const idx = argv.indexOf("--mcp-config");
      assert.ok(idx >= 0, `expected --mcp-config in ${JSON.stringify(argv)}`);
      assert.ok(fs.existsSync(argv[idx + 1]));
      sup.stop();
    } finally {
      await new Promise((r) => server.close(r));
      resetMemorySupForTests();
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });
});
