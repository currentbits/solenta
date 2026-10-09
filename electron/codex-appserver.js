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

const { isShuttingDown } = require("./proc.js");

const CLIENT_INFO = { name: "solenta", version: "1" };
// Per shutdown RPC; a live app-server answers in milliseconds.
const SHUTDOWN_RPC_TIMEOUT_MS = 1_000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("shutdown RPC timed out")), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
// Native goal (#1531): after a turn completes with the goal still active,
// codex starts its own continuation turn within ~100 ms (measured on
// 0.159.2). Wait this long for it before treating the run as finished.
const GOAL_CONTINUE_GRACE_MS = 2_000;
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

const UNLOADED_V2_SUBAGENT_RESUME =
  "cannot resume an unloaded multi-agent v2 sub-agent through its parent; resume the parent first, or use thread/read to inspect it";

function nonEmptyId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id || null;
}

function subagentThreadSpawn(thread) {
  if (!thread || typeof thread !== "object") return null;
  const source = thread.source;
  if (!source || typeof source !== "object") return null;
  const sub = source.subagent || source.subAgent;
  if (!sub || typeof sub !== "object") return null;
  const spawn = sub.thread_spawn || sub.threadSpawn;
  if (!spawn || typeof spawn !== "object") return null;
  return spawn;
}

function hasSubagentMetadata(thread) {
  if (subagentThreadSpawn(thread)) return true;
  const named = thread.threadSource;
  if (typeof named === "string") {
    if (/^subAgent/i.test(named) || /sub-agent|sub_agent/i.test(named)) {
      return true;
    }
  }
  return false;
}

/**
 * Parent of a multi-agent v2 child. Codex 0.154.0 stores it on
 * `source.subagent.thread_spawn.parent_thread_id`. `parentThreadId` is
 * accepted only when that subagent metadata is also present.
 * Never `forkedFromId` (ordinary forks are resume targets).
 * @param {object | null | undefined} thread
 * @returns {string | null}
 */
function parentIdOfThread(thread) {
  if (!thread || typeof thread !== "object") return null;
  const spawn = subagentThreadSpawn(thread);
  if (spawn) {
    const nested =
      nonEmptyId(spawn.parent_thread_id) || nonEmptyId(spawn.parentThreadId);
    if (nested) return nested;
  }
  if (hasSubagentMetadata(thread)) {
    return (
      nonEmptyId(thread.parentThreadId) || nonEmptyId(thread.parent_thread_id)
    );
  }
  return null;
}

/**
 * Multi-agent v2 children are not a Solenta resume target.
 * @param {object | null | undefined} thread
 */
function isCodexChildThread(thread) {
  if (!thread || typeof thread !== "object") return false;
  const id = nonEmptyId(thread.id) || "";
  const parent = parentIdOfThread(thread);
  if (parent && parent !== id) return true;
  return hasSubagentMetadata(thread);
}

function notificationThreadId(msg) {
  const p = msg && msg.params && typeof msg.params === "object" ? msg.params : {};
  if (typeof p.threadId === "string" && p.threadId) return p.threadId;
  const thread = p.thread && typeof p.thread === "object" ? p.thread : null;
  if (thread && typeof thread.id === "string" && thread.id) return thread.id;
  return null;
}

function isUnloadedV2SubagentResumeError(err) {
  const msg = err && err.message ? String(err.message) : String(err || "");
  return msg.includes(UNLOADED_V2_SUBAGENT_RESUME);
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
  if (method === "serverRequest/resolved") {
    return { type: "server_request.resolved", requestId: p.requestId };
  }
  if (method === "thread/started") {
    const thread = p.thread && typeof p.thread === "object" ? p.thread : null;
    const id = thread && typeof thread.id === "string" ? thread.id : null;
    if (!id) return null;
    if (isCodexChildThread(thread)) return null;
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
  if (method === "thread/goal/updated") {
    return p.goal && typeof p.goal === "object"
      ? { type: "goal.updated", goal: p.goal }
      : null;
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
 * `goal` (#1531): undefined leaves the native goal alone, null clears it,
 * `{ objective, status }` syncs it. An active goal on an idle thread makes
 * codex start a turn by itself (also right after thread/resume), which
 * races our turn/start. So the goal rests paused between runs, goes active
 * once our turn has started, and the run follows codex's continuation
 * turns until the goal leaves "active".
 *
 * @param {object} opts
 * @param {{ objective: string, status?: string } | null} [opts.goal]
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
    compact = false,
    goal,
  } = opts;

  let expectedTurnId = null;
  let threadId = null;
  let settled = false;
  let stopping = false;
  let turnCompleted = false;
  let terminalError = null;
  let client = null;
  /** Set active once our turn/started arrives (see syncGoal). */
  let activateGoal = false;
  /** Latest native goal status this run, from thread/goal/updated. */
  let goalStatus = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let continueTimer = null;

  /**
   * Bring the native goal in line with `goal` before turn/start. Returns
   * whether to activate it once the turn is running. Best-effort: a codex
   * without goals just runs the turn.
   */
  async function syncGoal() {
    try {
      const got = await withTimeout(
        client.send("thread/goal/get", { threadId }),
        SHUTDOWN_RPC_TIMEOUT_MS,
      );
      const cur = got && got.goal;
      if (!goal) {
        if (cur) await client.send("thread/goal/clear", { threadId });
        return false;
      }
      if (goal.status === "complete") return false;
      if (!cur || cur.objective !== goal.objective) {
        await client.send("thread/goal/set", {
          threadId,
          objective: goal.objective,
          status: "paused",
        });
      }
      return true;
    } catch {
      return false;
    }
  }

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
    if (!msg || msg.method === "thread/started") return;
    if (!threadId) return;
    const foreignId = notificationThreadId(msg);
    if (foreignId && foreignId !== threadId) return;
    if (msg.method === "turn/started") {
      const turn = msg.params && msg.params.turn;
      if (turn && typeof turn.id === "string" && turn.id) {
        expectedTurnId = turn.id;
      }
      // A goal continuation turn: the run goes on.
      if (continueTimer) {
        clearTimeout(continueTimer);
        continueTimer = null;
        turnCompleted = false;
      }
      if (activateGoal) {
        activateGoal = false;
        // Before the echo arrives: a turn that ends first must still
        // follow continuations and pause on shutdown.
        goalStatus = "active";
        client
          .send("thread/goal/set", { threadId, status: "active" })
          .catch(() => {});
      }
    }
    if (msg.method === "thread/goal/updated") {
      const g = msg.params && msg.params.goal;
      if (g && typeof g.status === "string") goalStatus = g.status;
      // Our own between-runs pause is bookkeeping, not a status change.
      if (stopping || goalStatus === "paused") return;
    }
    if (msg.method === "turn/completed") {
      turnCompleted = true;
      const mapped = notificationToJsonl(msg);
      emitEvent(mapped);
      if (mapped && mapped.type === "turn.failed") {
        terminalError =
          mapped.error && mapped.error.message
            ? `${mapped.error.code}: ${mapped.error.message}`
            : "turn failed";
      }
      if (!terminalError && goalStatus === "active" && !stopping) {
        continueTimer = setTimeout(() => {
          continueTimer = null;
          void shutdown(0);
        }, GOAL_CONTINUE_GRACE_MS);
        return;
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
    if (continueTimer) {
      clearTimeout(continueTimer);
      continueTimer = null;
    }
    // A wedged app-server may never answer these RPCs, and kill() below is
    // what arms killTree. Bound each one, and skip them during app quit so
    // the process is SIGKILLed before Electron exits (#1233).
    const graceful = !isShuttingDown();
    try {
      // Pause before the interrupt: an idle thread with an active goal
      // starts its own turn, here or on the next thread/resume.
      if (graceful && client && threadId && goalStatus === "active") {
        try {
          await withTimeout(
            client.send("thread/goal/set", { threadId, status: "paused" }),
            SHUTDOWN_RPC_TIMEOUT_MS,
          );
        } catch {
          // still interrupt
        }
      }
      if (graceful && client && threadId && expectedTurnId && !turnCompleted) {
        try {
          await withTimeout(
            client.send("turn/interrupt", {
              threadId,
              turnId: expectedTurnId,
            }),
            SHUTDOWN_RPC_TIMEOUT_MS,
          );
        } catch {
          // still unsubscribe
        }
      }
      if (graceful && client && threadId) {
        try {
          await withTimeout(
            client.send("thread/unsubscribe", { threadId }),
            SHUTDOWN_RPC_TIMEOUT_MS,
          );
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
      const resumeThread = (id) =>
        client.send("thread/resume", {
          threadId: String(id),
          excludeTurns: true,
          ...tparams,
        });

      async function resumeParentOnce(parentId, originalErr) {
        const parent = nonEmptyId(parentId);
        const child = nonEmptyId(
          sessionId != null ? String(sessionId) : "",
        );
        if (!parent || (child && parent === child)) throw originalErr;
        let parentResumed;
        try {
          parentResumed = await resumeThread(parent);
        } catch {
          throw originalErr;
        }
        const parentThread = parentResumed && parentResumed.thread;
        if (
          !parentThread ||
          typeof parentThread.id !== "string" ||
          !parentThread.id ||
          isCodexChildThread(parentThread)
        ) {
          throw originalErr;
        }
        return parentThread;
      }

      let thread;
      if (sessionId) {
        /** @type {Error | null} */
        let resumeErr = null;
        try {
          const resumed = await resumeThread(sessionId);
          thread = resumed && resumed.thread;
        } catch (err) {
          resumeErr = err instanceof Error ? err : new Error(String(err));
        }
        if (resumeErr) {
          if (!isUnloadedV2SubagentResumeError(resumeErr)) throw resumeErr;
          let inspected = null;
          try {
            const read = await client.send("thread/read", {
              threadId: String(sessionId),
            });
            inspected = read && (read.thread || read);
          } catch {
            throw resumeErr;
          }
          thread = await resumeParentOnce(parentIdOfThread(inspected), resumeErr);
        } else if (thread && isCodexChildThread(thread)) {
          thread = await resumeParentOnce(
            parentIdOfThread(thread),
            new Error(UNLOADED_V2_SUBAGENT_RESUME),
          );
        }
      } else {
        const started = await client.send("thread/start", tparams);
        thread = started && started.thread;
      }
      if (!thread || typeof thread.id !== "string" || !thread.id) {
        throw new Error("Codex app-server returned no thread");
      }
      threadId = thread.id;
      emitEvent({
        type: "thread.started",
        thread_id: thread.id,
        session_id: thread.id,
        thread,
      });
      if (compact) {
        // Native compaction runs as its own turn; turn/started supplies
        // expectedTurnId and turn/completed ends it like any other turn.
        await client.send("thread/compact/start", { threadId });
        return;
      }
      if (goal !== undefined) activateGoal = await syncGoal();
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
  isCodexChildThread,
  parentIdOfThread,
  isUnloadedV2SubagentResumeError,
  SIGKILL_AFTER_MS,
  THREAD_SOURCE,
};
