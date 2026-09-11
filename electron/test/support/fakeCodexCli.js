"use strict";

/**
 * Dual-mode fake Codex CLI for tests (#1170).
 * `exec --json` still emits JSONL (workflow / ask / commitmsg).
 * `app-server --listen stdio://` speaks newline JSON-RPC.
 */

const fs = require("node:fs");
const readline = require("node:readline");

function dumpArgv() {
  if (!process.env.CODER_FAKE_CODEX_ARGV_FILE) return;
  fs.writeFileSync(
    process.env.CODER_FAKE_CODEX_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
  fs.writeFileSync(
    process.env.CODER_FAKE_CODEX_ARGV_FILE + ".env.json",
    JSON.stringify(
      Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) =>
            k.startsWith("CODER_MCP_TOKEN_") ||
            k === "CODEX_HOME" ||
            k === "SOLENTA_WORKTREE",
        ),
      ),
    ),
    "utf8",
  );
}

function dumpRpc(msg) {
  const f = process.env.CODER_FAKE_CODEX_RPC_FILE;
  if (!f) return;
  fs.appendFileSync(f, JSON.stringify(msg) + "\n");
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, error) {
  send({ jsonrpc: "2.0", id, error });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function camelItem(item) {
  if (!item || typeof item !== "object") return item;
  const typeMap = {
    agent_message: "agentMessage",
    command_execution: "commandExecution",
    file_change: "fileChange",
    mcp_tool_call: "mcpToolCall",
    web_search: "webSearch",
    todo_list: "todoList",
  };
  const out = { ...item };
  if (typeMap[item.type]) out.type = typeMap[item.type];
  if (item.aggregated_output != null) out.aggregatedOutput = item.aggregated_output;
  if (item.exit_code != null) out.exitCode = item.exit_code;
  if (item.type === "reasoning" && item.text && !item.content) {
    out.summary = [item.text];
    out.content = [item.text];
  }
  return out;
}

function jsonlToNotifications(ev, threadId, turnId) {
  if (!ev || typeof ev !== "object") return [];
  const type = String(ev.type || "");
  if (type === "thread.started" || type === "thread_started") {
    const id = ev.thread_id || ev.session_id || threadId;
    return [{ method: "thread/started", params: { thread: { id } } }];
  }
  if (type === "item.started" || type === "item_started") {
    return [
      {
        method: "item/started",
        params: { item: camelItem(ev.item), threadId, turnId },
      },
    ];
  }
  if (type === "item.updated" || type === "item_updated") {
    return [
      {
        method: "item/started",
        params: { item: camelItem(ev.item), threadId, turnId },
      },
    ];
  }
  if (type === "item.completed" || type === "item_completed") {
    return [
      {
        method: "item/completed",
        params: { item: camelItem(ev.item), threadId, turnId },
      },
    ];
  }
  if (type === "token_count") {
    const info = ev.info && typeof ev.info === "object" ? ev.info : {};
    const toBreak = (u) =>
      u && typeof u === "object"
        ? {
            inputTokens: Number(u.input_tokens) || 0,
            outputTokens: Number(u.output_tokens) || 0,
            totalTokens: Number(u.total_tokens) || 0,
          }
        : null;
    return [
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            last: toBreak(info.last_token_usage),
            total: toBreak(info.total_token_usage),
            modelContextWindow: info.model_context_window ?? null,
          },
        },
      },
    ];
  }
  if (type === "turn.completed" || type === "turn_completed") {
    return [
      {
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turnId, status: "completed" },
          usage: ev.usage,
        },
      },
    ];
  }
  if (type === "turn.failed" || type === "turn_failed" || type === "error") {
    return [
      {
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: "failed",
            error: ev.error || { message: ev.message || "error" },
          },
        },
      },
    ];
  }
  return [];
}

const WRITER_LOCK_STDERR =
  "2026-09-06T06:26:58.016879Z ERROR codex_core::session::session: " +
  "failed to initialize thread persistence: thread-store conflict: " +
  "thread 01a072f7-10e0-7fd2-b691-7d481327516f already has an active writer";

async function emitScenario(scenario, threadId, turnId) {
  const emit = (ev) => {
    for (const n of jsonlToNotifications(ev, threadId, turnId)) {
      notify(n.method, n.params);
    }
  };
  const eventsFile = process.env.CODER_FAKE_CODEX_EVENTS_FILE;
  if (eventsFile && fs.existsSync(eventsFile)) {
    const raw = fs.readFileSync(eventsFile, "utf8");
    let sawComplete = false;
    for (const line of raw.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const ev = JSON.parse(trimmed);
      if (
        ev.type === "turn.completed" ||
        ev.type === "turn_completed" ||
        ev.type === "turn.failed" ||
        ev.type === "turn_failed"
      ) {
        sawComplete = true;
      }
      emit(ev);
    }
    if (!sawComplete) {
      emit({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } });
    }
    return;
  }

  if (scenario === "structured-overflow") {
    emit({
      type: "turn.failed",
      error: {
        code: "context_length_exceeded",
        message:
          "Codex ran out of room in the model's context window. Start a new conversation.",
      },
    });
    return;
  }

  if (scenario === "thinking-then-tool") {
    emit({
      type: "item.started",
      item: {
        id: "item-reason-1",
        type: "reasoning",
        text: "I should patch src/foo.ts first.",
      },
    });
    await delay(150);
    emit({
      type: "item.completed",
      item: {
        id: "item-reason-1",
        type: "reasoning",
        text: "I should patch src/foo.ts first.",
      },
    });
    emit({
      type: "item.started",
      item: {
        id: "item-edit-1",
        type: "file_change",
        changes: [{ path: "src/foo.ts", kind: "update" }],
        status: "in_progress",
      },
    });
    await delay(20);
    emit({
      type: "item.completed",
      item: {
        id: "item-edit-1",
        type: "file_change",
        changes: [{ path: "src/foo.ts", kind: "update" }],
        status: "completed",
      },
    });
    emit({
      type: "item.completed",
      item: { id: "item-msg-1", type: "agent_message", text: "Patched foo.ts." },
    });
    emit({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 8 } });
    return;
  }

  if (scenario === "dropped-items") {
    emit({
      type: "item.started",
      item: {
        id: "item-todo-1",
        type: "todo_list",
        items: [
          { text: "Patch foo", completed: false },
          { text: "Run tests", completed: false },
        ],
      },
    });
    await delay(10);
    emit({
      type: "item.updated",
      item: {
        id: "item-todo-1",
        type: "todo_list",
        items: [
          { text: "Patch foo", completed: true },
          { text: "Run tests", completed: false },
        ],
      },
    });
    emit({
      type: "item.started",
      item: {
        id: "item-mcp-1",
        type: "mcp_tool_call",
        server: "github",
        tool: "get_issue",
        arguments: { number: 171 },
        status: "in_progress",
      },
    });
    await delay(10);
    emit({
      type: "item.completed",
      item: {
        id: "item-mcp-1",
        type: "mcp_tool_call",
        server: "github",
        tool: "get_issue",
        arguments: { number: 171 },
        result: {
          content: [{ type: "text", text: "open" }],
          structured_content: null,
        },
        status: "completed",
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item-edit-1",
        type: "file_change",
        changes: [{ path: "src/foo.ts", kind: "update" }],
        status: "completed",
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item-search-1",
        type: "web_search",
        query: "codex exec json",
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item-todo-1",
        type: "todo_list",
        items: [
          { text: "Patch foo", completed: true },
          { text: "Run tests", completed: true },
        ],
      },
    });
    emit({
      type: "item.completed",
      item: { id: "item-msg-1", type: "agent_message", text: "Done." },
    });
    emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } });
    return;
  }

  // success / resume-turn / default
  emit({
    type: "item.completed",
    item: { id: "item-msg-1", type: "agent_message", text: "Hello from codex" },
  });
  await delay(10);
  emit({
    type: "item.started",
    item: { id: "item-cmd-1", type: "command_execution", command: "echo hi" },
  });
  await delay(10);
  emit({
    type: "item.completed",
    item: {
      id: "item-cmd-1",
      type: "command_execution",
      command: "echo hi",
      aggregated_output: "hi\n",
      exit_code: 0,
    },
  });
  emit({ type: "turn.completed", usage: { input_tokens: 30, output_tokens: 12 } });
}

async function runAppServer() {
  const scenario = process.env.CODER_FAKE_CODEX_SCENARIO || "success";
  const turnKind = process.env.CODER_FAKE_CODEX_TURN_KIND || "agent";
  if (scenario === "writer-lock") {
    process.stderr.write(WRITER_LOCK_STDERR + "\n");
    process.exit(1);
    return;
  }
  if (scenario === "fail-exit") {
    process.stderr.write("codex-stderr-boom\n");
    process.exit(2);
    return;
  }

  let threadId = "codex-sess-001";
  let turnId = "turn-1";
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    dumpRpc(msg);
    if (msg && msg.id === "ask-1" && msg.result) {
      notify("item/started", {
        item: {
          type: "commandExecution",
          id: "item-cmd-ask",
          command: "npm test",
        },
        threadId,
        turnId,
      });
      notify("item/completed", {
        item: {
          type: "commandExecution",
          id: "item-cmd-ask",
          command: "npm test",
          aggregatedOutput: "ok\n",
          exitCode: 0,
        },
        threadId,
        turnId,
      });
      notify("turn/completed", {
        threadId,
        turn: { id: turnId, status: "completed" },
      });
      return;
    }
    if (!msg || typeof msg.method !== "string") return;
    if (msg.method === "initialize") {
      reply(msg.id, { userAgent: "fake-codex-appserver" });
      return;
    }
    if (msg.method === "initialized") return;
    if (msg.method === "thread/start") {
      reply(msg.id, { thread: { id: threadId } });
      notify("thread/started", { thread: { id: threadId } });
      return;
    }
    if (msg.method === "thread/resume") {
      threadId = String(msg.params.threadId || threadId);
      reply(msg.id, { thread: { id: threadId, source: "exec" } });
      notify("thread/started", { thread: { id: threadId } });
      return;
    }
    if (msg.method === "turn/start") {
      const delayMs = Number(process.env.CODER_FAKE_CODEX_TURN_DELAY_MS || 0);
      if (delayMs > 0) await delay(delayMs);
      reply(msg.id, { turn: { id: turnId, status: "inProgress", items: [] } });
      notify("turn/started", { threadId, turn: { id: turnId } });
      if (scenario === "hang" || scenario === "steer-wait") return;
      if (scenario === "ask-command") {
        send({
          jsonrpc: "2.0",
          id: "ask-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "item-cmd-ask",
            startedAtMs: 1,
            command: "npm test",
            cwd: process.cwd(),
            kind: "command",
            availableDecisions: [
              "accept",
              "acceptForSession",
              "decline",
              "cancel",
            ],
          },
        });
        return;
      }
      await emitScenario(scenario, threadId, turnId);
      return;
    }
    if (msg.method === "turn/steer") {
      if (turnKind === "review" || turnKind === "compact") {
        replyError(msg.id, {
          code: -32600,
          message: `cannot steer a ${turnKind} turn`,
          data: {
            message: `cannot steer a ${turnKind} turn`,
            codexErrorInfo: { activeTurnNotSteerable: { turnKind } },
          },
        });
        return;
      }
      if (msg.params.expectedTurnId !== turnId) {
        replyError(msg.id, {
          code: -32600,
          message: `expected active turn id \`${msg.params.expectedTurnId}\` but found \`${turnId}\``,
        });
        return;
      }
      reply(msg.id, { turnId });
      notify("item/completed", {
        item: { type: "agentMessage", id: "steer-1", text: "redirected" },
        threadId,
        turnId,
      });
      notify("turn/completed", {
        threadId,
        turn: { id: turnId, status: "completed" },
      });
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
}

async function runExecJsonl() {
  const scenario = process.env.CODER_FAKE_CODEX_SCENARIO || "success";
  const emit = (obj) => {
    process.stdout.write(JSON.stringify(obj) + "\n");
  };
  if (scenario === "fail-exit") {
    process.stderr.write("codex-stderr-boom\n");
    process.exit(2);
    return;
  }
  if (scenario === "hang") {
    emit({ type: "thread.started", thread_id: "codex-sess-hang" });
    await delay(30000);
    process.exit(1);
    return;
  }
  if (scenario === "writer-lock") {
    process.stderr.write(WRITER_LOCK_STDERR + "\n");
    process.exit(1);
    return;
  }
  if (scenario === "structured-overflow") {
    emit({
      type: "turn.failed",
      error: {
        code: "context_length_exceeded",
        message:
          "Codex ran out of room in the model's context window. Start a new conversation.",
      },
    });
    process.exit(1);
    return;
  }
  emit({ type: "thread.started", thread_id: "codex-sess-001" });
  await delay(10);
  emit({
    type: "item.completed",
    item: { id: "item-msg-1", type: "agent_message", text: "Hello from codex" },
  });
  emit({ type: "turn.completed", usage: { input_tokens: 30, output_tokens: 12 } });
  process.exit(0);
}

function isAppServer(argv) {
  return argv.includes("app-server");
}

function main() {
  dumpArgv();
  const argv = process.argv.slice(2);
  if (isAppServer(argv) || argv.includes("--listen")) {
    // Live Codex 0.153.4: this flag is exec-only. Match that so a
    // regression cannot hide behind a permissive fake (#1309).
    if (argv.includes("--dangerously-bypass-hook-trust")) {
      process.stderr.write(
        "error: unexpected argument '--dangerously-bypass-hook-trust' found\n" +
          "Usage: codex app-server --listen <URL> --config <key=value>\n",
      );
      process.exit(2);
      return;
    }
    return runAppServer();
  }
  return runExecJsonl();
}

function writeFakeCodexBin(dir, writeFakeBin) {
  return writeFakeBin(
    require("node:path").join(dir, "fake-codex"),
    `"use strict";
require(${JSON.stringify(__filename)}).main();
`,
  );
}

module.exports = {
  main,
  jsonlToNotifications,
  camelItem,
  WRITER_LOCK_STDERR,
  writeFakeCodexBin,
};

if (require.main === module) {
  Promise.resolve(main()).catch((err) => {
    process.stderr.write(String(err) + "\n");
    process.exit(1);
  });
}
