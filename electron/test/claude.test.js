const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner, liveClaudeChildren } = require("../runner.js");

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
const path = require("path");

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

// Record everything received on stdin (interactive mode delivers the prompt
// and control responses there) for test assertions.
let stdinRaw = "";
if (process.env.CODER_FAKE_CLAUDE_STDIN_FILE) {
  process.stdin.on("data", (c) => {
    stdinRaw += c;
    fs.writeFileSync(process.env.CODER_FAKE_CLAUDE_STDIN_FILE, stdinRaw, "utf8");
  });
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

  if (scenario === "subagents") {
    emit({
      type: "system",
      subtype: "init",
      session_id: "sess-sub",
      model: "claude-opus-test",
    });
    await delay(20);
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_sub_sync",
            name: "Agent",
            input: { description: "Map the panel", subagent_type: "Explore" },
          },
          {
            type: "tool_use",
            id: "toolu_sub_bg",
            name: "Agent",
            input: {
              description: "Background research",
              subagent_type: "general-purpose",
            },
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
            tool_use_id: "toolu_sub_sync",
            content: [{ type: "text", text: "Findings: panel maps to store" }],
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_sub_bg",
            content: [
              {
                type: "text",
                text: "Async agent launched successfully. agentId: abc123 The agent is working in the background.",
              },
            ],
            is_error: false,
          },
        ],
      },
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
              "<tool-use-id>toolu_sub_bg</tool-use-id>\\n" +
              "<status>completed</status>\\n" +
              '<summary>Agent "Background research" finished</summary>\\n' +
              "</task-notification>",
          },
        ],
      },
    });
    await delay(20);
    emit({
      type: "result",
      subtype: "success",
      result: "Both agents done.",
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.001,
      num_turns: 1,
      session_id: "sess-sub",
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

  if (scenario === "session-lost") {
    // Real shape from --resume <id> when the session file lives under a
    // different cwd's project dir (verified live): no init event, instant
    // error result carrying the stale id and an errors array.
    process.stderr.write(
      "No conversation found with session ID: sess-stale-999\\n",
    );
    emit({
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 0,
      is_error: true,
      num_turns: 0,
      session_id: "sess-stale-999",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      errors: ["No conversation found with session ID: sess-stale-999"],
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

  // Issue #17: leftover empty success, then the real turn. The runner must
  // not finalize on the empty result or the real stream is dropped.
  if (scenario === "phantom-then-real") {
    emit({
      type: "system",
      subtype: "init",
      session_id: "sess-ph",
      model: "m",
    });
    await delay(20);
    emit({
      type: "result",
      subtype: "success",
      result: "",
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
      num_turns: 0,
      session_id: "sess-ph",
    });
    await delay(80);
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "real reply" }] },
    });
    await delay(20);
    emit({
      type: "result",
      subtype: "success",
      result: "real reply",
      usage: { input_tokens: 2, output_tokens: 3 },
      total_cost_usd: 0,
      num_turns: 1,
      session_id: "sess-ph",
    });
    process.exit(0);
    return;
  }

  // Issue #17: empty success and nothing else. Stay alive so a grace timer
  // (not process exit) is what decides the turn.
  if (scenario === "phantom-only") {
    emit({
      type: "system",
      subtype: "init",
      session_id: "sess-po",
      model: "m",
    });
    await delay(20);
    emit({
      type: "result",
      subtype: "success",
      result: "",
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
      num_turns: 0,
      session_id: "sess-po",
    });
    await delay(30000);
    process.exit(0);
    return;
  }

  // Emit result then linger, trapping SIGTERM briefly so stopAll reaper is needed.
  if (scenario === "result-then-hang") {
    const markerDir = process.env.CODER_FAKE_CLAUDE_MARKER_DIR || "";
    if (markerDir) {
      try {
        fs.mkdirSync(markerDir, { recursive: true });
        fs.writeFileSync(path.join(markerDir, "pid"), String(process.pid), "utf8");
      } catch { /* ignore */ }
    }
    emit({
      type: "system",
      subtype: "init",
      session_id: "sess-hang",
      model: "m",
    });
    await delay(20);
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "hang after result" }] },
    });
    await delay(20);
    emit({
      type: "result",
      subtype: "success",
      result: "hang after result",
      usage: { input_tokens: 1, output_tokens: 2 },
      total_cost_usd: 0,
      num_turns: 1,
      session_id: "sess-hang",
    });
    // Trap SIGTERM briefly so a naive kill without tracking would miss us if
    // the handle was already dropped; write a marker so tests can observe.
    let gotTerm = false;
    process.on("SIGTERM", () => {
      if (gotTerm) return;
      gotTerm = true;
      if (markerDir) {
        try {
          fs.writeFileSync(path.join(markerDir, "sigterm"), "1", "utf8");
        } catch { /* ignore */ }
      }
      setTimeout(() => process.exit(0), 200);
    });
    // Stay alive until reaped (or 30s safety).
    await delay(30000);
    process.exit(0);
    return;
  }

  // Ask permission for one Bash call, then finish according to the answer.
  if (scenario === "permission") {
    emit({ type: "system", subtype: "init", session_id: "sess-perm", model: "m" });
    await delay(20);
    emit({
      type: "control_request",
      request_id: "req-perm-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "npm test" },
      },
    });
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type !== "control_response") continue;
        if (process.env.CODER_FAKE_CLAUDE_CTRL_FILE) {
          fs.writeFileSync(process.env.CODER_FAKE_CLAUDE_CTRL_FILE, JSON.stringify(msg), "utf8");
        }
        const inner = (msg.response && msg.response.response) || {};
        emit({
          type: "result",
          subtype: "success",
          result: inner.behavior === "allow" ? "tool allowed" : "tool denied",
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          num_turns: 1,
          session_id: "sess-perm",
        });
        process.exit(0);
      }
    });
    await delay(30000);
    process.exit(1);
    return;
  }

  // Persistent interactive CLI: one turn per stdin user message, process
  // stays alive between turns (issue #8 keep-alive lifecycle).
  if (scenario === "multi-turn") {
    const markerDir = process.env.CODER_FAKE_CLAUDE_MARKER_DIR || "";
    if (markerDir) {
      try {
        fs.mkdirSync(markerDir, { recursive: true });
        fs.appendFileSync(path.join(markerDir, "spawns"), String(process.pid) + "\\n");
      } catch { /* ignore */ }
    }
    emit({ type: "system", subtype: "init", session_id: "sess-multi", model: "m" });
    let turn = 0;
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type !== "user") continue;
        turn += 1;
        const n = turn;
        emit({
          type: "assistant",
          message: { content: [{ type: "text", text: "reply " + n }] },
        });
        emit({
          type: "result",
          subtype: "success",
          result: "reply " + n,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          num_turns: n,
          session_id: "sess-multi",
        });
      }
    });
    await delay(30000);
    process.exit(0);
    return;
  }

  // Emit a result, then a control_request AFTER the turn settled (idle
  // window). Records the runner's control_response to CTRL_FILE.
  if (scenario === "late-permission") {
    emit({ type: "system", subtype: "init", session_id: "sess-late", model: "m" });
    let buf = "";
    let sentReq = false;
    process.stdin.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "user" && !sentReq) {
          sentReq = true;
          emit({
            type: "result",
            subtype: "success",
            result: "late done",
            usage: { input_tokens: 1, output_tokens: 1 },
            total_cost_usd: 0,
            num_turns: 1,
            session_id: "sess-late",
          });
          setTimeout(() => {
            emit({
              type: "control_request",
              request_id: "req-late-1",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                input: { command: "echo hi" },
              },
            });
          }, 150);
        } else if (msg.type === "control_response") {
          if (process.env.CODER_FAKE_CLAUDE_CTRL_FILE) {
            fs.writeFileSync(process.env.CODER_FAKE_CLAUDE_CTRL_FILE, JSON.stringify(msg), "utf8");
          }
          process.exit(0);
        }
      }
    });
    await delay(30000);
    process.exit(1);
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
  let prevMarkerDir;
  let prevPhantomGrace;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevScenario = process.env.CODER_FAKE_CLAUDE_SCENARIO;
    prevArgvFile = process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    prevGrokMcpDisable = process.env.CODER_GROK_MCP_DISABLE;
    prevGrokBin = process.env.CODER_GROK_BIN;
    prevMarkerDir = process.env.CODER_FAKE_CLAUDE_MARKER_DIR;
    prevPhantomGrace = process.env.CODER_PHANTOM_RESULT_GRACE_MS;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_FAKE_CLAUDE_MARKER_DIR;
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
    if (prevMarkerDir === undefined) delete process.env.CODER_FAKE_CLAUDE_MARKER_DIR;
    else process.env.CODER_FAKE_CLAUDE_MARKER_DIR = prevMarkerDir;
    if (prevGrokMcpDisable === undefined) delete process.env.CODER_GROK_MCP_DISABLE;
    else process.env.CODER_GROK_MCP_DISABLE = prevGrokMcpDisable;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
    if (prevPhantomGrace === undefined) delete process.env.CODER_PHANTOM_RESULT_GRACE_MS;
    else process.env.CODER_PHANTOM_RESULT_GRACE_MS = prevPhantomGrace;
  });

  it("captures session id on init, streams text, pairs tools, final answer lands after tools", async () => {
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
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0].text, "Hello world");
    assert.equal(assistants[0].runId, runId);
    // Final answer is its own message, appended after the tool call.
    assert.equal(assistants[1].text, "All done.");
    assert.ok(
      msgs.indexOf(assistants[1]) > msgs.findIndex((m) => m.role === "tool"),
    );

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

    // argv: -p, stream-json in AND out, permission prompt routed to stdio;
    // the prompt itself travels over stdin, never argv.
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("-p"));
    assert.ok(argv.includes("--output-format"));
    assert.ok(argv.includes("--input-format"));
    assert.ok(argv.includes("stream-json"));
    assert.ok(argv.includes("--permission-prompt-tool"));
    assert.ok(argv.includes("stdio"));
    assert.ok(argv.includes("--verbose"));
    assert.ok(argv.includes("--permission-mode"));
    assert.ok(argv.includes("default"));
    assert.ok(!argv.includes("do the thing"));
    assert.ok(!argv.includes("--resume"));
  });

  it("tracks Agent-tool subagents on the thread: sync → done, background runs until its task-notification (issue #21)", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "subagents";
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "spawn agents" });

    // After both tool_results: the sync agent is done, the background
    // launch ack keeps its agent running.
    await waitFor(() => {
      const subs = store.getThread(thread.id).subagents || [];
      return (
        subs.some((s) => s.id === "toolu_sub_sync" && s.status === "done") &&
        subs.some((s) => s.id === "toolu_sub_bg" && s.status === "running")
      );
    });

    // The task-notification settles the background agent.
    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t.status === "done";
    });
    const subs = store.getThread(thread.id).subagents;
    assert.equal(subs.length, 2);
    const sync = subs.find((s) => s.id === "toolu_sub_sync");
    assert.equal(sync.description, "Map the panel");
    assert.equal(sync.agentType, "Explore");
    assert.equal(sync.status, "done");
    const bg = subs.find((s) => s.id === "toolu_sub_bg");
    assert.equal(bg.description, "Background research");
    assert.equal(bg.agentType, "general-purpose");
    assert.equal(bg.status, "done");

    // The rows reached the renderer on a thread:updated push.
    assert.ok(
      pushes.some(
        (p) =>
          p.channel === "thread:updated" &&
          p.payload.thread &&
          p.payload.thread.id === thread.id &&
          Array.isArray(p.payload.thread.subagents) &&
          p.payload.thread.subagents.length === 2,
      ),
    );
  });

  it("surfaces permission prompts and answers them over the control protocol", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "permission";
    const ctrlFile = path.join(tmpDir, "ctrl.json");
    const stdinFile = path.join(tmpDir, "stdin.txt");
    process.env.CODER_FAKE_CLAUDE_CTRL_FILE = ctrlFile;
    process.env.CODER_FAKE_CLAUDE_STDIN_FILE = stdinFile;
    try {
      const thread = store.getThreads()[0];
      await runner.startRun({ threadId: thread.id, prompt: "guarded work" });

      await waitFor(() => runner.getPendingPermission(thread.id) != null);
      const pending = runner.getPendingPermission(thread.id);
      assert.equal(pending.toolName, "Bash");
      assert.equal(pending.summary, "Bash: npm test");
      assert.ok(pending.requestId);

      // The sidebar sees Waiting: awaitingInput set and threads:changed pushed.
      assert.equal(store.getThread(thread.id).awaitingInput, true);
      assert.equal(store.getThread(thread.id).status, "working");
      assert.ok(
        pushes.some(
          (p) =>
            p.channel === "threads:changed" &&
            p.payload.some((t) => t.id === thread.id && t.awaitingInput === true),
        ),
      );

      // The prompt reached the renderer via a thread:updated push.
      assert.ok(
        pushes.some(
          (p) =>
            p.channel === "thread:updated" &&
            p.payload.thread.id === thread.id &&
            p.payload.pendingPermission &&
            p.payload.pendingPermission.requestId === pending.requestId,
        ),
      );

      runner.respondPermission({
        threadId: thread.id,
        requestId: pending.requestId,
        decision: "allowAlways",
      });
      assert.equal(runner.getPendingPermission(thread.id), null);
      assert.equal(store.getThread(thread.id).awaitingInput, false);

      await waitFor(() => store.getThread(thread.id).status === "done");

      // The CLI received a well-formed allow with a session-scoped rule.
      const ctrl = JSON.parse(fs.readFileSync(ctrlFile, "utf8"));
      assert.equal(ctrl.type, "control_response");
      assert.equal(ctrl.response.subtype, "success");
      assert.equal(ctrl.response.request_id, pending.requestId);
      assert.equal(ctrl.response.response.behavior, "allow");
      assert.deepEqual(ctrl.response.response.updatedInput, {
        command: "npm test",
      });
      assert.deepEqual(ctrl.response.response.updatedPermissions, [
        {
          type: "addRules",
          rules: [{ toolName: "Bash" }],
          behavior: "allow",
          destination: "session",
        },
      ]);

      // The prompt was delivered on stdin, not argv.
      const firstStdinLine = JSON.parse(
        fs.readFileSync(stdinFile, "utf8").split("\n")[0],
      );
      assert.equal(firstStdinLine.type, "user");
      assert.equal(firstStdinLine.message.content, "guarded work");
      const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      assert.ok(!argv.includes("guarded work"));

      // The decision is recorded in the conversation.
      const msgs = store.getMessages(thread.id);
      assert.ok(
        msgs.some(
          (m) =>
            m.role === "event" &&
            m.text === "Allowed for session: Bash: npm test",
        ),
      );
    } finally {
      delete process.env.CODER_FAKE_CLAUDE_CTRL_FILE;
      delete process.env.CODER_FAKE_CLAUDE_STDIN_FILE;
    }
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
    assert.ok(!argv.includes("turn two"));
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

  it("stale --resume (session lost) fails with the CLI error surfaced and clears sessionId", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "session-lost";

    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { sessionId: "sess-stale-999" });

    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "follow-up after worktree cleanup",
    });

    await waitFor(() => store.getThread(thread.id).status === "failed");

    // Self-heal: the stale id is dropped so the next turn starts fresh
    // instead of failing forever on the same --resume.
    assert.equal(store.getThread(thread.id).sessionId, null);

    const msgs = store.getMessages(thread.id);
    const errEvent = msgs.find(
      (m) =>
        m.role === "event" &&
        /error_during_execution/.test(m.text) &&
        m.runId === runId,
    );
    assert.ok(errEvent, "expected Run error event");
    // The CLI's errors array must be visible, not just the subtype.
    assert.ok(/No conversation found/.test(errEvent.text), errEvent.text);
    assert.ok(/starts fresh/.test(errEvent.text), errEvent.text);
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

  it("does not finalize on an empty leftover result; the real turn still lands", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "phantom-then-real";

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "do work" });

    await waitFor(() =>
      store.getWorkLog(thread.id).some(
        (w) => w.label === "Starting agent" && w.done,
      ),
    );
    // Phantom empty success has already arrived (~20ms after init).
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(store.getThread(thread.id).status, "working");
    const working = store
      .getWorkLog(thread.id)
      .find((w) => w.label === "Agent working");
    assert.ok(working, "Agent working step must exist");
    assert.equal(working.done, false);
    assert.equal(
      store.getMessages(thread.id).filter((m) => m.role === "assistant").length,
      0,
    );

    await waitFor(() => store.getThread(thread.id).status === "done");
    const assistants = store
      .getMessages(thread.id)
      .filter((m) => m.role === "assistant");
    assert.ok(assistants.some((m) => m.text === "real reply"));
    assert.equal(store.getWorkLog(thread.id).find((w) => w.label === "Agent working").done, true);
  });

  it("fails a turn that only ever emits an empty leftover result", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "phantom-only";
    process.env.CODER_PHANTOM_RESULT_GRACE_MS = "80";

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "do work" });
    await waitFor(() => store.getThread(thread.id).status === "failed");

    const events = store
      .getMessages(thread.id)
      .filter((m) => m.role === "event");
    assert.ok(
      events.some((m) => /no output/i.test(m.text)),
      `expected a no-output event, got ${JSON.stringify(events.map((e) => e.text))}`,
    );
    assert.equal(
      store.getMessages(thread.id).filter((m) => m.role === "assistant").length,
      0,
    );
    const working = store
      .getWorkLog(thread.id)
      .find((w) => w.label === "Agent working");
    assert.ok(working && working.done);
  });

  it("stopAll reaps claude child that hung after result cleared the run slot", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "result-then-hang";
    const markerDir = path.join(tmpDir, "hang-markers");
    process.env.CODER_FAKE_CLAUDE_MARKER_DIR = markerDir;

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "hang please" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    // Result cleared active Map; child must still be tracked for reaping.
    assert.equal(runner.isRunning(thread.id), false);
    assert.ok(
      liveClaudeChildren.size >= 1,
      "hung post-result child must remain in liveClaudeChildren",
    );

    // stopRun cannot reach the handle (slot cleared); stopAll reaper must.
    await runner.stopRun({ threadId: thread.id });
    assert.ok(
      liveClaudeChildren.size >= 1,
      "stopRun must not clear the reaper set for already-done runs",
    );

    runner.stopAll();

    await waitFor(
      () => fs.existsSync(path.join(markerDir, "sigterm")),
      { timeoutMs: 5000 },
    );
    await waitFor(() => liveClaudeChildren.size === 0, { timeoutMs: 5000 });
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
    assert.ok(!argv.some((a) => String(a).startsWith("--mcp-config")));
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
      assert.ok(getClaudeMcpArgs().some((a) => a.startsWith("--mcp-config=")));

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
      const mcpArg = argv.find((a) => a.startsWith("--mcp-config="));
      assert.ok(mcpArg, `expected --mcp-config= in ${JSON.stringify(argv)}`);
      assert.ok(fs.existsSync(mcpArg.slice("--mcp-config=".length)));
      // Prompt travels over stdin; argv must never carry it.
      assert.ok(!argv.includes("with-mem"));
      sup.stop();
    } finally {
      await new Promise((r) => server.close(r));
      resetMemorySupForTests();
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });

  it("keeps the CLI alive across turns and reuses it for the next turn", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "multi-turn";
    const markerDir = path.join(tmpDir, "multi-markers");
    process.env.CODER_FAKE_CLAUDE_MARKER_DIR = markerDir;

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "turn one" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    // Turn settled but the CLI process must survive (background tasks live
    // inside it — killing it here is issue #8's symptom 1).
    const spawnsFile = path.join(markerDir, "spawns");
    const spawns = fs
      .readFileSync(spawnsFile, "utf8")
      .trim()
      .split("\n");
    assert.equal(spawns.length, 1);
    const pid = Number(spawns[0]);
    // Give any wrong-lifecycle teardown a beat to land, then probe liveness.
    await new Promise((r) => setTimeout(r, 200));
    assert.doesNotThrow(
      () => process.kill(pid, 0),
      "CLI process must survive turn settle",
    );

    await runner.startRun({ threadId: thread.id, prompt: "turn two" });
    await waitFor(() => {
      const msgs = store.getMessages(thread.id);
      return msgs.some((m) => m.role === "assistant" && m.text === "reply 2");
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    // Same process handled turn two: no second spawn.
    const spawns2 = fs
      .readFileSync(spawnsFile, "utf8")
      .trim()
      .split("\n");
    assert.equal(spawns2.length, 1);
  });

  it("answers a control_request arriving while settled with a retryable error, not silence", async () => {
    process.env.CODER_FAKE_CLAUDE_SCENARIO = "late-permission";
    const ctrlFile = path.join(tmpDir, "late-ctrl.json");
    process.env.CODER_FAKE_CLAUDE_CTRL_FILE = ctrlFile;
    try {
      const thread = store.getThreads()[0];
      await runner.startRun({ threadId: thread.id, prompt: "late perms" });
      await waitFor(() => store.getThread(thread.id).status === "done");

      // The CLI raises can_use_tool after the run slot cleared. The runner
      // must answer with an error response (retryable, distinguishable from
      // a user deny) instead of dropping it on the floor.
      await waitFor(() => fs.existsSync(ctrlFile), { timeoutMs: 5000 });
      const msg = JSON.parse(fs.readFileSync(ctrlFile, "utf8"));
      assert.equal(msg.type, "control_response");
      assert.equal(msg.response.subtype, "error");
      assert.equal(msg.response.request_id, "req-late-1");
      assert.match(String(msg.response.error), /retry/i);
    } finally {
      delete process.env.CODER_FAKE_CLAUDE_CTRL_FILE;
    }
  });
});
