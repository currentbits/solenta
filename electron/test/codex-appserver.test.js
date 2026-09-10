"use strict";

/**
 * Codex app-server JSON-RPC client + turn host (#1170).
 * Fake server only — no live model.
 *
 * Run: node --test electron/test/codex-appserver.test.js
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFakeBin } = require("./support/fakeBin.js");
const {
  notificationToJsonl,
  snakeThreadItem,
  runCodexAppServerTurn,
  createCodexAppServerClient,
} = require("../codex-appserver.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coder-appserver-"));
}

function waitFor(predicate, { timeoutMs = 8000, intervalMs = 15 } = {}) {
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

describe("notificationToJsonl", () => {
  it("maps thread/started to thread.started with session id", () => {
    const ev = notificationToJsonl({
      method: "thread/started",
      params: { thread: { id: "01abc" } },
    });
    assert.equal(ev.type, "thread.started");
    assert.equal(ev.thread_id, "01abc");
    assert.equal(ev.session_id, "01abc");
  });

  it("maps camelCase commandExecution onto extractCommandItem JSONL", () => {
    const ev = notificationToJsonl({
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "c1",
          command: "echo hi",
          aggregatedOutput: null,
          exitCode: null,
        },
      },
    });
    assert.equal(ev.type, "item.started");
    assert.equal(ev.item.type, "command_execution");
    assert.equal(ev.item.command, "echo hi");
  });

  it("maps commandExecution completion fields to snake_case", () => {
    const ev = notificationToJsonl({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "c1",
          command: "echo hi",
          aggregatedOutput: "hi\n",
          exitCode: 0,
        },
      },
    });
    assert.equal(ev.type, "item.completed");
    assert.equal(ev.item.type, "command_execution");
    assert.equal(ev.item.aggregated_output, "hi\n");
    assert.equal(ev.item.exit_code, 0);
  });

  it("maps agentMessage and agentMessage delta", () => {
    const done = notificationToJsonl({
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "m1", text: "Hello" } },
    });
    assert.equal(done.item.type, "agent_message");
    assert.equal(done.item.text, "Hello");

    const delta = notificationToJsonl({
      method: "item/agentMessage/delta",
      params: { itemId: "m1", delta: "Hel" },
    });
    assert.equal(delta.msg.type, "agent_message_content_delta");
    assert.equal(delta.msg.delta, "Hel");
  });

  it("maps reasoning content/summary to item text", () => {
    const item = snakeThreadItem({
      type: "reasoning",
      id: "r1",
      summary: ["patch foo.ts"],
      content: [],
    });
    assert.equal(item.type, "reasoning");
    assert.equal(item.text, "patch foo.ts");
  });

  it("maps thread/tokenUsage/updated last vs total so the ring does not double-count", () => {
    const ev = notificationToJsonl({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          last: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          total: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
          modelContextWindow: 272000,
        },
      },
    });
    assert.equal(ev.type, "token_count");
    assert.equal(ev.info.last_token_usage.input_tokens, 10);
    assert.equal(ev.info.last_token_usage.output_tokens, 4);
    assert.equal(ev.info.total_token_usage.input_tokens, 100);
    assert.equal(ev.info.model_context_window, 272000);
  });

  it("maps a failed turn to turn.failed", () => {
    const ev = notificationToJsonl({
      method: "turn/completed",
      params: {
        turn: {
          id: "t1",
          status: "failed",
          error: { message: "boom", code: "other" },
        },
      },
    });
    assert.equal(ev.type, "turn.failed");
    assert.equal(ev.error.message, "boom");
  });
});

function writeRpcFake(dir, body) {
  return writeFakeBin(path.join(dir, "codex"), body);
}

const RPC_FAKE_CORE = `
const fs = require("node:fs");
const readline = require("node:readline");
function dumpArgv() {
  if (!process.env.CODER_FAKE_CODEX_ARGV_FILE) return;
  fs.writeFileSync(
    process.env.CODER_FAKE_CODEX_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
  );
}
function dumpRpc(msg) {
  const f = process.env.CODER_FAKE_CODEX_RPC_FILE;
  if (!f) return;
  fs.appendFileSync(f, JSON.stringify(msg) + "\\n");
}
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, error) { send({ jsonrpc: "2.0", id, error }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
dumpArgv();
`;

describe("ssh wrap keeps stdio for app-server RPC", () => {
  it("does not pass ssh -n so stdin stays a live RPC pipe", () => {
    const { wrapCommand } = require("../ssh.js");
    const wrapped = wrapCommand(
      { remoteHost: "dev@box", remotePath: "/srv/app" },
      "codex",
      ["app-server", "--listen", "stdio://"],
    );
    assert.equal(wrapped.bin, "ssh");
    assert.equal(wrapped.args.includes("-n"), false);
    assert.match(wrapped.args.at(-1), /app-server/);
  });
});

describe("createCodexAppServerClient", () => {
  it("handshakes initialize, sends requests, and dispatches notifications", async () => {
    const dir = tmp();
    const rpcFile = path.join(dir, "rpc.jsonl");
    const bin = writeRpcFake(
      dir,
      RPC_FAKE_CORE +
        `
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  dumpRpc(msg);
  if (msg.method === "initialize") {
    reply(msg.id, { userAgent: "fake" });
    notify("thread/started", { thread: { id: "tid-1" } });
  }
  if (msg.method === "thread/start") {
    reply(msg.id, { thread: { id: "tid-1" } });
  }
});
`,
    );
    const notes = [];
    const client = createCodexAppServerClient({
      binary: bin,
      args: ["app-server", "--listen", "stdio://"],
      cwd: dir,
      envExtra: { CODER_FAKE_CODEX_RPC_FILE: rpcFile },
      onNotification: (msg) => notes.push(msg),
    });
    const init = await client.send("initialize", {
      clientInfo: { name: "solenta", version: "1" },
      capabilities: {},
    });
    assert.equal(init.userAgent, "fake");
    const started = await client.send("thread/start", {
      approvalPolicy: "never",
      sandbox: "read-only",
      threadSource: "solenta",
    });
    assert.equal(started.thread.id, "tid-1");
    await waitFor(() => notes.some((n) => n.method === "thread/started"));
    client.kill();
    const rpc = fs
      .readFileSync(rpcFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(rpc[0].method, "initialize");
    assert.equal(rpc[1].method, "thread/start");
    assert.equal(rpc[1].params.threadSource, "solenta");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("runCodexAppServerTurn", () => {
  function writeTurnFake(dir, extra = "") {
    return writeRpcFake(
      dir,
      RPC_FAKE_CORE +
        `
let threadId = "codex-sess-001";
let turnId = "turn-1";
let turnKind = process.env.CODER_FAKE_CODEX_TURN_KIND || "agent";
const scenario = process.env.CODER_FAKE_CODEX_SCENARIO || "success";
const delayMs = Number(process.env.CODER_FAKE_CODEX_TURN_DELAY_MS || 0);
function emitSuccess() {
  notify("item/completed", {
    item: { type: "agentMessage", id: "m1", text: "Hello from codex" },
    threadId, turnId,
  });
  notify("item/started", {
    item: { type: "commandExecution", id: "c1", command: "echo hi" },
    threadId, turnId,
  });
  notify("item/completed", {
    item: {
      type: "commandExecution", id: "c1", command: "echo hi",
      aggregatedOutput: "hi\\n", exitCode: 0,
    },
    threadId, turnId,
  });
  notify("thread/tokenUsage/updated", {
    threadId, turnId,
    tokenUsage: {
      last: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
      total: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
      modelContextWindow: 272000,
    },
  });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  dumpRpc(msg);
  if (msg.method === "initialize") {
    reply(msg.id, { userAgent: "fake" });
    return;
  }
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") {
    reply(msg.id, { thread: { id: threadId } });
    notify("thread/started", { thread: { id: threadId } });
    return;
  }
  if (msg.method === "thread/resume") {
    threadId = msg.params.threadId;
    reply(msg.id, { thread: { id: threadId, source: "exec" } });
    notify("thread/started", { thread: { id: threadId } });
    return;
  }
  if (msg.method === "turn/start") {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    reply(msg.id, { turn: { id: turnId, status: "inProgress", items: [] } });
    notify("turn/started", { threadId, turn: { id: turnId } });
    if (scenario === "hang" || scenario === "steer-wait") return;
    emitSuccess();
    return;
  }
  if (msg.method === "turn/steer") {
    if (turnKind === "review" || turnKind === "compact") {
      replyError(msg.id, {
        code: -32600,
        message: "activeTurnNotSteerable",
        data: { activeTurnNotSteerable: { turnKind } },
      });
      return;
    }
    if (msg.params.expectedTurnId !== turnId) {
      replyError(msg.id, { code: -32600, message: "expectedTurnId mismatch" });
      return;
    }
    reply(msg.id, { turnId });
    notify("item/completed", {
      item: { type: "agentMessage", id: "steer-1", text: "redirected" },
      threadId, turnId,
    });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
    return;
  }
  if (msg.method === "turn/interrupt") {
    reply(msg.id, {});
    return;
  }
  if (msg.method === "thread/unsubscribe") {
    reply(msg.id, { status: "unsubscribed" });
    process.exit(0);
  }
});
` + extra,
    );
  }

  it("drives assistant/tool/usage from notifications and ends on turn/completed", async () => {
    const dir = tmp();
    const rpcFile = path.join(dir, "rpc.jsonl");
    const bin = writeTurnFake(dir);
    const events = [];
    let exitInfo = null;
    const handle = runCodexAppServerTurn({
      binary: bin,
      args: ["app-server", "--listen", "stdio://"],
      cwd: dir,
      envExtra: { CODER_FAKE_CODEX_RPC_FILE: rpcFile },
      prompt: "hello",
      onEvent: (ev) => events.push(ev),
      onExit: (info) => {
        exitInfo = info;
      },
    });
    await waitFor(() => exitInfo != null);
    assert.equal(exitInfo.code, 0, exitInfo.stderr);
    assert.ok(events.some((e) => e.type === "thread.started" && e.thread_id === "codex-sess-001"));
    assert.ok(
      events.some(
        (e) => e.item && e.item.type === "agent_message" && e.item.text === "Hello from codex",
      ),
    );
    assert.ok(
      events.some(
        (e) =>
          e.type === "item.started" &&
          e.item &&
          e.item.type === "command_execution" &&
          e.item.command === "echo hi",
      ),
    );
    assert.ok(events.some((e) => e.type === "token_count" && e.info.last_token_usage.input_tokens === 30));
    const rpc = fs
      .readFileSync(rpcFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(rpc.some((m) => m.method === "initialize"));
    assert.ok(rpc.some((m) => m.method === "initialized"));
    const start = rpc.find((m) => m.method === "thread/start");
    assert.ok(start);
    assert.equal(start.params.threadSource, "solenta");
    assert.equal(start.params.approvalPolicy, "on-request");
    const turnStart = rpc.find((m) => m.method === "turn/start");
    assert.ok(turnStart);
    assert.equal(turnStart.params.approvalPolicy, "on-request");
    assert.ok(rpc.some((m) => m.method === "thread/unsubscribe"));
    assert.equal(typeof handle.send, "function");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resumes an exec session id via thread/resume, not a new thread", async () => {
    const dir = tmp();
    const rpcFile = path.join(dir, "rpc.jsonl");
    const bin = writeTurnFake(dir);
    let exitInfo = null;
    runCodexAppServerTurn({
      binary: bin,
      args: ["app-server", "--listen", "stdio://"],
      cwd: dir,
      envExtra: { CODER_FAKE_CODEX_RPC_FILE: rpcFile },
      prompt: "again",
      sessionId: "01a085eb-14f7-71f3-a715-f96593249ad6",
      onEvent: () => {},
      onExit: (info) => {
        exitInfo = info;
      },
    });
    await waitFor(() => exitInfo != null);
    assert.equal(exitInfo.code, 0);
    const rpc = fs
      .readFileSync(rpcFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(
      rpc.some((m) => m.method === "thread/start"),
      false,
    );
    const resume = rpc.find((m) => m.method === "thread/resume");
    assert.ok(resume);
    assert.equal(resume.params.threadId, "01a085eb-14f7-71f3-a715-f96593249ad6");
    assert.equal(resume.params.excludeTurns, true);
    assert.equal(resume.params.approvalPolicy, "on-request");
    const resumeTurn = rpc.find((m) => m.method === "turn/start");
    assert.ok(resumeTurn);
    assert.equal(resumeTurn.params.approvalPolicy, "on-request");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("send() is false until turn/start returns a turn id", async () => {
    const dir = tmp();
    const bin = writeTurnFake(dir);
    const handle = runCodexAppServerTurn({
      binary: bin,
      args: ["app-server", "--listen", "stdio://"],
      cwd: dir,
      envExtra: { CODER_FAKE_CODEX_TURN_DELAY_MS: "250" },
      prompt: "hello",
      onEvent: () => {},
      onExit: () => {},
    });
    assert.equal(handle.send("nudge"), false);
    handle.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("steer writes turn/steer with expectedTurnId on the same process", async () => {
    const dir = tmp();
    const rpcFile = path.join(dir, "rpc.jsonl");
    const bin = writeTurnFake(dir);
    const events = [];
    let exitInfo = null;
    const handle = runCodexAppServerTurn({
      binary: bin,
      args: ["app-server", "--listen", "stdio://"],
      cwd: dir,
      envExtra: {
        CODER_FAKE_CODEX_RPC_FILE: rpcFile,
        CODER_FAKE_CODEX_SCENARIO: "steer-wait",
      },
      prompt: "work",
      onEvent: (ev) => events.push(ev),
      onExit: (info) => {
        exitInfo = info;
      },
    });
    await waitFor(() => handle.canSteer());
    const sent = await Promise.resolve(handle.send("stop that, do X instead"));
    assert.equal(sent, true);
    await waitFor(() => exitInfo != null);
    assert.equal(exitInfo.code, 0);
    const rpc = fs
      .readFileSync(rpcFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const steer = rpc.find((m) => m.method === "turn/steer");
    assert.ok(steer);
    assert.equal(steer.params.expectedTurnId, "turn-1");
    assert.equal(steer.params.threadId, "codex-sess-001");
    assert.equal(steer.params.input[0].text, "stop that, do X instead");
    assert.equal(
      rpc.filter((m) => m.method === "thread/start" || m.method === "thread/resume").length,
      1,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects steer on review/compact turns", async () => {
    const dir = tmp();
    const bin = writeTurnFake(dir);
    const handle = runCodexAppServerTurn({
      binary: bin,
      args: ["app-server", "--listen", "stdio://"],
      cwd: dir,
      envExtra: {
        CODER_FAKE_CODEX_SCENARIO: "steer-wait",
        CODER_FAKE_CODEX_TURN_KIND: "review",
      },
      prompt: "review this",
      onEvent: () => {},
      onExit: () => {},
    });
    await waitFor(() => handle.canSteer());
    const sent = await Promise.resolve(handle.send("nudge"));
    assert.equal(sent, false);
    handle.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stop interrupts, unsubscribes, then kills", async () => {
    const dir = tmp();
    const rpcFile = path.join(dir, "rpc.jsonl");
    const bin = writeTurnFake(dir);
    let exitInfo = null;
    const handle = runCodexAppServerTurn({
      binary: bin,
      args: ["app-server", "--listen", "stdio://"],
      cwd: dir,
      envExtra: {
        CODER_FAKE_CODEX_RPC_FILE: rpcFile,
        CODER_FAKE_CODEX_SCENARIO: "hang",
      },
      prompt: "hang",
      onEvent: () => {},
      onExit: (info) => {
        exitInfo = info;
      },
    });
    await waitFor(() => handle.canSteer());
    handle.kill();
    await waitFor(() => exitInfo != null);
    const rpc = fs
      .readFileSync(rpcFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const methods = rpc.map((m) => m.method);
    assert.ok(methods.includes("turn/interrupt"));
    assert.ok(methods.includes("thread/unsubscribe"));
    const interruptAt = methods.indexOf("turn/interrupt");
    const unsubAt = methods.indexOf("thread/unsubscribe");
    assert.ok(interruptAt >= 0 && unsubAt > interruptAt);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
