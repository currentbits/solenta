"use strict";

/**
 * Codex `app-server` JSON-RPC adapter for interactive turns (#1170).
 * Separate from `runCodex` (exec --json, one-shot, no send).
 * Transport is `createCodexJsonRpcSession` so ServerRequests can be
 * answered (#1171 / #1200). Interactive thread/start and turn/start
 * send approvalPolicy on-request (#1208). Do not spawn a second
 * JSON-RPC client.
 */

const {
  createCodexJsonRpcSession,
  SIGKILL_AFTER_MS,
} = require("./codexJsonRpc.js");

function sandboxFor(permissionMode) {
  const mode = String(permissionMode || "default");
  if (mode === "plan") return "read-only";
  if (mode === "bypassPermissions") return "danger-full-access";
  return "workspace-write";
}

const CLIENT_INFO = { name: "solenta", version: "1" };
const THREAD_SOURCE = "solenta";
// Interactive only (#1208). exec / workflow / ask / commitmsg stay never.
const APPROVAL_POLICY = "on-request";

const ITEM_TYPE_TO_JSONL = {
  agentMessage: "agent_message",
  commandExecution: "command_execution",
  fileChange: "file_change",
  mcpToolCall: "mcp_tool_call",
  webSearch: "web_search",
  todoList: "todo_list",
  userMessage: "user_message",
};

function userText(text) {
  return { type: "text", text: String(text ?? ""), text_elements: [] };
}

function userInputFromPrompt(prompt, images) {
  const input = [userText(prompt)];
  if (Array.isArray(images)) {
    for (const p of images) {
      if (typeof p === "string" && p) {
        input.push({ type: "localImage", path: p });
      }
    }
  }
  return input;
}

function snakeThreadItem(item) {
  if (!item || typeof item !== "object") return item;
  const out = { ...item };
  const mapped = ITEM_TYPE_TO_JSONL[item.type];
  if (mapped) out.type = mapped;
  if (item.aggregatedOutput != null) out.aggregated_output = item.aggregatedOutput;
  if (item.exitCode != null) out.exit_code = item.exitCode;
  if (out.type === "reasoning" && out.text == null) {
    const parts = [];
    if (Array.isArray(item.summary)) {
      for (const s of item.summary) {
        if (s) parts.push(String(s));
      }
    }
    if (Array.isArray(item.content)) {
      for (const s of item.content) {
        if (s) parts.push(String(s));
      }
    }
    if (parts.length) out.text = parts.join("\n");
  }
  return out;
}

function breakdownToJsonl(b) {
  if (!b || typeof b !== "object") return null;
  return {
    input_tokens: Number(b.inputTokens) || 0,
    output_tokens: Number(b.outputTokens) || 0,
    total_tokens: Number(b.totalTokens) || 0,
  };
}

/**
 * Map an app-server JSON-RPC notification onto the exec JSONL shapes
 * `electron/codex.js` extractors already understand.
 * @param {object} msg
 * @returns {object | null}
 */
function notificationToJsonl(msg) {
  if (!msg || typeof msg !== "object") return null;
  const method = String(msg.method || "");
  const p = msg.params && typeof msg.params === "object" ? msg.params : {};
  if (method === "thread/started") {
    const thread = p.thread && typeof p.thread === "object" ? p.thread : null;
    const id = thread && typeof thread.id === "string" ? thread.id : null;
    if (!id) return null;
    return {
      type: "thread.started",
      thread_id: id,
      session_id: id,
      thread,
    };
  }
  if (method === "turn/started") {
    return { type: "turn.started", threadId: p.threadId, turn: p.turn };
  }
  if (method === "item/started") {
    return { type: "item.started", item: snakeThreadItem(p.item) };
  }
  if (method === "item/completed") {
    return { type: "item.completed", item: snakeThreadItem(p.item) };
  }
  if (method === "item/agentMessage/delta") {
    const delta = typeof p.delta === "string" ? p.delta : "";
    return {
      type: "agent_message_delta",
      msg: { type: "agent_message_content_delta", delta, text: delta },
    };
  }
  if (
    method === "item/reasoning/textDelta" ||
    method === "item/reasoning/summaryTextDelta"
  ) {
    const delta = typeof p.delta === "string" ? p.delta : "";
    const id = typeof p.itemId === "string" ? p.itemId : "reasoning";
    return {
      type: "item.started",
      item: { type: "reasoning", id, text: delta },
    };
  }
  if (method === "thread/tokenUsage/updated") {
    const tu = p.tokenUsage && typeof p.tokenUsage === "object" ? p.tokenUsage : {};
    const last = breakdownToJsonl(tu.last);
    const total = breakdownToJsonl(tu.total);
    const window = Number(tu.modelContextWindow);
    return {
      type: "token_count",
      info: {
        last_token_usage: last,
        total_token_usage: total,
        model_context_window:
          Number.isFinite(window) && window > 0 ? window : null,
      },
    };
  }
  if (method === "turn/completed") {
    const turn = p.turn && typeof p.turn === "object" ? p.turn : {};
    const status = String(turn.status || "");
    if (status === "failed" || turn.error) {
      const error = turn.error && typeof turn.error === "object" ? turn.error : {};
      return {
        type: "turn.failed",
        error: {
          code: error.code || error.name || "turn_failed",
          message: error.message || status || "turn failed",
        },
      };
    }
    const ev = { type: "turn.completed", turn };
    if (p.usage && typeof p.usage === "object") ev.usage = p.usage;
    return ev;
  }
  if (method === "error") {
    return { type: "error", error: p };
  }
  return null;
}

/**
 * JSON-RPC client over newline-delimited stdio. Thin adapter over
 * `createCodexJsonRpcSession` so turn/steer (`send`) and ServerRequest
 * replies (`respondJsonRpc`) share one inbound-id set.
 * @param {object} opts
 */
function createCodexAppServerClient(opts) {
  const session = createCodexJsonRpcSession({
    binary: opts.binary,
    args: opts.args,
    cwd: opts.cwd,
    envExtra: opts.envExtra,
    onServerRequest: opts.onServerRequest,
    onNotification: opts.onNotification,
    onError: opts.onError,
    onExit: opts.onExit,
    spawn: opts.spawn,
  });
  return {
    send(method, params) {
      return session.request(method, params);
    },
    notify(method, params) {
      return session.notify(method, params);
    },
    respondJsonRpc: session.respondJsonRpc,
    respondJsonRpcError: session.respondJsonRpcError,
    cancelOutstanding: session.cancelOutstanding,
    outstandingIds: session.outstandingIds,
    pid: session.pid,
    kill: session.kill,
  };
}

function turnParams(opts, threadId, prompt, images) {
  /** @type {Record<string, unknown>} */
  const params = {
    threadId,
    input: userInputFromPrompt(prompt, images),
  };
  if (opts.model) params.model = String(opts.model);
  if (opts.reasoningEffort) params.effort = String(opts.reasoningEffort);
  if (opts.cwd) params.cwd = String(opts.cwd);
  params.approvalPolicy = APPROVAL_POLICY;
  return params;
}

function threadParams(opts) {
  const sandbox = sandboxFor(opts.permissionMode);
  /** @type {Record<string, unknown>} */
  const params = {
    approvalPolicy: APPROVAL_POLICY,
    sandbox,
    threadSource: THREAD_SOURCE,
    ephemeral: false,
  };
  if (opts.model) params.model = String(opts.model);
  if (opts.cwd) params.cwd = String(opts.cwd);
  return params;
}

/**
 * Per-turn private app-server: handshake → start/resume → turn → completed
 * → unsubscribe → kill. `send` is `turn/steer` once expectedTurnId exists.
 *
 * @param {object} opts
 * @param {(req: { id: unknown, method: string, params: unknown }) => boolean | void} [opts.onServerRequest]
 * @returns {{
 *   kill: () => void,
 *   send: (text: string) => boolean | Promise<boolean>,
 *   canSteer: () => boolean,
 *   respondJsonRpc: (id: unknown, result: unknown) => boolean,
 *   respondJsonRpcError: (id: unknown, error: unknown) => boolean,
 *   cancelOutstanding: (decision?: string) => void,
 * }}
 */
function runCodexAppServerTurn(opts) {
  const {
    binary,
    args = ["app-server", "--listen", "stdio://"],
    cwd,
    envExtra,
    prompt,
    images,
    sessionId,
    model,
    reasoningEffort,
    permissionMode,
    onEvent,
    onError,
    onExit,
    onServerRequest,
  } = opts;

  let expectedTurnId = null;
  let threadId = sessionId ? String(sessionId) : null;
  let settled = false;
  let stopping = false;
  let turnCompleted = false;
  let terminalError = null;
  let client = null;

  function emitEvent(ev) {
    if (!ev || typeof onEvent !== "function") return;
    try {
      onEvent(ev);
    } catch {
      // defensive
    }
  }

  function finishTurn(code, stderr) {
    if (settled) return;
    settled = true;
    if (typeof onExit === "function") {
      onExit({ code, stderr: stderr || "" });
    }
  }

  function onNotification(msg) {
    if (msg && msg.method === "turn/started") {
      const turn = msg.params && msg.params.turn;
      if (turn && typeof turn.id === "string" && turn.id) {
        expectedTurnId = turn.id;
      }
    }
    if (msg && msg.method === "thread/started") {
      const thread = msg.params && msg.params.thread;
      if (thread && typeof thread.id === "string" && thread.id) {
        threadId = thread.id;
      }
    }
    if (msg && msg.method === "turn/completed") {
      turnCompleted = true;
      const mapped = notificationToJsonl(msg);
      emitEvent(mapped);
      if (mapped && mapped.type === "turn.failed") {
        terminalError =
          mapped.error && mapped.error.message
            ? `${mapped.error.code}: ${mapped.error.message}`
            : "turn failed";
      }
      void shutdown(turnCompleted && !terminalError ? 0 : 1);
      return;
    }
    const mapped = notificationToJsonl(msg);
    if (mapped) emitEvent(mapped);
  }

  async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    try {
      if (client && threadId && expectedTurnId && !turnCompleted) {
        try {
          await client.send("turn/interrupt", {
            threadId,
            turnId: expectedTurnId,
          });
        } catch {
          // still unsubscribe
        }
      }
      if (client && threadId) {
        try {
          await client.send("thread/unsubscribe", { threadId });
        } catch {
          // kill anyway
        }
      }
    } finally {
      if (client) client.kill();
      finishTurn(
        turnCompleted && !terminalError ? 0 : code == null ? 1 : code,
        terminalError || "",
      );
    }
  }

  client = createCodexAppServerClient({
    binary,
    args,
    cwd,
    envExtra,
    onServerRequest,
    onNotification,
    onError: (err) => {
      if (typeof onError === "function") onError(err);
    },
    onExit: ({ code, stderr }) => {
      if (settled) return;
      if (turnCompleted && !terminalError) {
        finishTurn(0, stderr);
        return;
      }
      finishTurn(code, terminalError || stderr);
    },
  });

  void (async () => {
    try {
      await client.send("initialize", {
        clientInfo: CLIENT_INFO,
        capabilities: {},
      });
      client.notify("initialized", {});
      const tparams = threadParams({
        permissionMode,
        model,
        cwd,
      });
      let thread;
      if (sessionId) {
        const resumed = await client.send("thread/resume", {
          threadId: String(sessionId),
          excludeTurns: true,
          ...tparams,
        });
        thread = resumed && resumed.thread;
      } else {
        const started = await client.send("thread/start", tparams);
        thread = started && started.thread;
      }
      if (thread && typeof thread.id === "string" && thread.id) {
        threadId = thread.id;
        emitEvent({
          type: "thread.started",
          thread_id: thread.id,
          session_id: thread.id,
          thread,
        });
      }
      const startedTurn = await client.send(
        "turn/start",
        turnParams(
          { model, reasoningEffort, cwd, permissionMode },
          threadId,
          prompt,
          images,
        ),
      );
      const turn = startedTurn && startedTurn.turn;
      if (turn && typeof turn.id === "string" && turn.id) {
        expectedTurnId = turn.id;
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      terminalError = msg;
      if (typeof onError === "function") {
        try {
          onError(err instanceof Error ? err : new Error(msg));
        } catch {
          // ignore
        }
      }
      await shutdown(1);
    }
  })();

  return {
    canSteer() {
      return Boolean(!settled && !stopping && expectedTurnId && threadId && client);
    },
    send(text) {
      if (settled || stopping || !expectedTurnId || !threadId || !client) {
        return false;
      }
      const input = userInputFromPrompt(text);
      return client
        .send("turn/steer", {
          threadId,
          expectedTurnId,
          input,
        })
        .then(() => true)
        .catch(() => false);
    },
    respondJsonRpc(id, result) {
      return client ? client.respondJsonRpc(id, result) : false;
    },
    respondJsonRpcError(id, error) {
      return client ? client.respondJsonRpcError(id, error) : false;
    },
    cancelOutstanding(decision) {
      if (client) client.cancelOutstanding(decision);
    },
    kill() {
      void shutdown(1);
    },
    pid: client && client.pid,
  };
}

module.exports = {
  notificationToJsonl,
  snakeThreadItem,
  userInputFromPrompt,
  createCodexAppServerClient,
  runCodexAppServerTurn,
  SIGKILL_AFTER_MS,
  THREAD_SOURCE,
};
