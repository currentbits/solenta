"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCodexJsonRpcSession } = require("../codexJsonRpc.js");
const {
  METHOD_COMMAND,
  METHOD_FILE_CHANGE,
  DECISION_ACCEPT,
  DECISION_CANCEL,
  JSONRPC_METHOD_NOT_FOUND,
} = require("../codexApprovals.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function waitFor(predicate, { timeoutMs = 8000, intervalMs = 20 } = {}) {
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

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coder-codex-rpc-"));
}

/**
 * Fake `codex app-server --listen stdio://`: JSON-RPC over stdin/stdout.
 * Records every client message. After initialize, emits the ServerRequests
 * listed in CODER_FAKE_APP_SERVER_ASKS (JSON array).
 */
function writeFakeAppServer(dir) {
  return writeFakeBin(
    path.join(dir, "codex"),
    `
const fs = require("node:fs");
const replyFile = process.env.CODER_FAKE_APP_SERVER_REPLY_FILE;
function record(msg) {
  if (!replyFile) return;
  fs.appendFileSync(replyFile, JSON.stringify(msg) + "\\n");
}
const asks = (() => {
  try {
    return JSON.parse(process.env.CODER_FAKE_APP_SERVER_ASKS || "[]");
  } catch {
    return [];
  }
})();
const rl = require("node:readline").createInterface({ input: process.stdin });
let asked = false;
function emitAsks() {
  if (asked) return;
  asked = true;
  for (const req of asks) {
    process.stdout.write(JSON.stringify(req) + "\\n");
  }
}
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  record(msg);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: "1" },
    }) + "\\n");
    emitAsks();
  }
});
setTimeout(() => {}, 30000);
`,
  );
}

const sessions = [];
afterEach(() => {
  for (const s of sessions.splice(0)) {
    try {
      s.kill();
    } catch {
      // ignore
    }
  }
});

describe("createCodexJsonRpcSession (#1171)", () => {
  it("round-trips a client request and fail-closes unknown ServerRequests", async () => {
    const dir = tmp();
    const replyFile = path.join(dir, "replies.jsonl");
    const bin = writeFakeAppServer(dir);
    const asks = [
      {
        jsonrpc: "2.0",
        id: "srv-cmd",
        method: METHOD_COMMAND,
        params: {
          threadId: "t",
          turnId: "u",
          itemId: "i",
          startedAtMs: 1,
          command: "ls -la",
          kind: "command",
        },
      },
      {
        jsonrpc: "2.0",
        id: "srv-unknown",
        method: "account/chatgptAuthTokens/refresh",
        params: {},
      },
    ];
    const session = createCodexJsonRpcSession({
      binary: bin,
      args: ["app-server", "--listen", "stdio://"],
      cwd: dir,
      envExtra: {
        CODER_FAKE_APP_SERVER_REPLY_FILE: replyFile,
        CODER_FAKE_APP_SERVER_ASKS: JSON.stringify(asks),
      },
      onServerRequest(req) {
        if (req.method === METHOD_COMMAND) {
          session.respondJsonRpc(req.id, { decision: DECISION_ACCEPT });
          return true;
        }
        return false;
      },
    });
    sessions.push(session);

    const init = await session.request("initialize", {
      clientInfo: { name: "solenta", version: "1" },
    });
    assert.equal(init.protocolVersion, "1");

    await waitFor(() => {
      if (!fs.existsSync(replyFile)) return false;
      const lines = fs
        .readFileSync(replyFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      return (
        lines.some(
          (m) => m.id === "srv-cmd" && m.result && m.result.decision === "accept",
        ) &&
        lines.some(
          (m) =>
            m.id === "srv-unknown" &&
            m.error &&
            m.error.code === JSONRPC_METHOD_NOT_FOUND,
        )
      );
    });
  });

  it("cancels outstanding command asks on stop without a second reply", async () => {
    const dir = tmp();
    const replyFile = path.join(dir, "replies.jsonl");
    const bin = writeFakeAppServer(dir);
    const asks = [
      {
        jsonrpc: "2.0",
        id: 42,
        method: METHOD_COMMAND,
        params: {
          threadId: "t",
          turnId: "u",
          itemId: "i",
          startedAtMs: 1,
          command: "rm -rf dist",
          kind: "command",
        },
      },
    ];
    let seen = false;
    const session = createCodexJsonRpcSession({
      binary: bin,
      args: ["app-server", "--listen", "stdio://"],
      cwd: dir,
      envExtra: {
        CODER_FAKE_APP_SERVER_REPLY_FILE: replyFile,
        CODER_FAKE_APP_SERVER_ASKS: JSON.stringify(asks),
      },
      onServerRequest(req) {
        if (req.method === METHOD_COMMAND) {
          seen = true;
          return true;
        }
        return false;
      },
    });
    sessions.push(session);
    await session.request("initialize", {});
    await waitFor(() => seen);
    assert.deepEqual(session.outstandingIds(), [42]);
    session.cancelOutstanding(DECISION_CANCEL);
    assert.deepEqual(session.outstandingIds(), []);
    session.respondJsonRpc(42, { decision: DECISION_ACCEPT });

    await waitFor(() => {
      if (!fs.existsSync(replyFile)) return false;
      const lines = fs
        .readFileSync(replyFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const decisions = lines.filter((m) => m.id === 42);
      return (
        decisions.length === 1 &&
        decisions[0].result &&
        decisions[0].result.decision === DECISION_CANCEL
      );
    });
  });

  it("JSON-RPC-errors fileChange until a diff card exists", async () => {
    const dir = tmp();
    const replyFile = path.join(dir, "replies.jsonl");
    const bin = writeFakeAppServer(dir);
    const asks = [
      {
        jsonrpc: "2.0",
        id: "fc-1",
        method: METHOD_FILE_CHANGE,
        params: {
          threadId: "t",
          turnId: "u",
          itemId: "item-edit-1",
          startedAtMs: 1,
        },
      },
    ];
    const session = createCodexJsonRpcSession({
      binary: bin,
      args: ["app-server", "--listen", "stdio://"],
      cwd: dir,
      envExtra: {
        CODER_FAKE_APP_SERVER_REPLY_FILE: replyFile,
        CODER_FAKE_APP_SERVER_ASKS: JSON.stringify(asks),
      },
    });
    sessions.push(session);
    await session.request("initialize", {});
    await waitFor(() => {
      if (!fs.existsSync(replyFile)) return false;
      const lines = fs
        .readFileSync(replyFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      return lines.some(
        (m) =>
          m.id === "fc-1" &&
          m.error &&
          m.error.code === JSONRPC_METHOD_NOT_FOUND,
      );
    });
  });

  /**
   * In-process child. A real EPIPE needs the read end to close; this emitter
   * lets the test fire that error while the process is still open, and again
   * after kill.
   */
  function openPipeChild() {
    const stdin = new EventEmitter();
    stdin.destroyed = false;
    stdin.write = () => true;
    stdin.end = () => {};
    const stdout = new EventEmitter();
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter();
    stderr.setEncoding = () => {};
    const child = new EventEmitter();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {};
    return { child, stdin };
  }

  it("rejects the pending request when stdin EPIPE fires before the child exits", async () => {
    const { child, stdin } = openPipeChild();
    const errors = [];
    const exits = [];
    const session = createCodexJsonRpcSession({
      binary: "fake-codex",
      spawn: () => child,
      onError(err) {
        errors.push(err);
      },
      onExit(info) {
        exits.push(info);
      },
    });
    sessions.push(session);
    const pending = session.request("initialize", {});
    const epipe = new Error("write EPIPE");
    epipe.code = "EPIPE";
    stdin.emit("error", epipe);

    await assert.rejects(pending, (err) => {
      assert.equal(err.code, "EPIPE");
      return true;
    });
    await assert.rejects(
      session.request("thread/start", {}),
      /stdin closed/,
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "EPIPE");
    assert.equal(exits.length, 0);

    child.emit("close", 0);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].code, 0);
  });

  it("ignores stdin EPIPE after shutdown", async () => {
    const { child, stdin } = openPipeChild();
    const errors = [];
    const exits = [];
    const session = createCodexJsonRpcSession({
      binary: "fake-codex",
      spawn: () => child,
      onError(err) {
        errors.push(err);
      },
      onExit(info) {
        exits.push(info);
      },
    });
    sessions.push(session);
    session.kill();
    const epipe = new Error("write EPIPE");
    epipe.code = "EPIPE";
    stdin.emit("error", epipe);
    assert.equal(errors.length, 0);
    child.emit("close", null);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].code, null);
  });
});
