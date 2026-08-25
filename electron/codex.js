"use strict";

// cross-spawn, not child_process: on Windows the agent CLIs install as
// .cmd shims and Node refuses to exec those directly. cross-spawn routes
// them through cmd.exe with correct escaping, which matters because the
// prompt travels in argv (#442).
const spawn = require("cross-spawn");
const { killTree, agentSpawnOptions } = require("./proc.js");

const SIGKILL_AFTER_MS = 3000;
// Max stderr retained per child process (tail), for error reporting.
const STDERR_TAIL_CHARS = 64 * 1024;

/**
 * Spawn the Codex CLI with JSONL output.
 *
 * @param {object} opts
 * @param {string} [opts.binary]
 * @param {string[]} [opts.args] - full argv after binary (from providers.buildArgs)
 * @param {string} opts.cwd
 * @param {Record<string, string>} [opts.envExtra] - added to the inherited env
 *   (MCP bearer tokens: env is per-process, argv is world-readable via ps)
 * @param {(ev: object) => void} opts.onEvent - raw parsed JSONL event
 * @param {(info: { code: number | null, stderr: string }) => void} opts.onExit
 * @param {(err: Error) => void} [opts.onError]
 * @returns {{ kill: () => void }}
 */
function runCodex(opts) {
  const {
    binary = process.env.CODER_CODEX_BIN || "codex",
    args = [],
    cwd,
    envExtra,
    onEvent,
    onExit,
    onError,
  } = opts;

  let stderrText = "";
  let lineBuf = "";
  let finished = false;
  let killTimer = null;
  let killed = false;

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!obj || typeof obj !== "object") return;
    if (typeof onEvent === "function") {
      try {
        onEvent(obj);
      } catch {
        // defensive: never crash the parser
      }
    }
  }

  function finish(code) {
    if (finished) return;
    finished = true;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (lineBuf.trim()) {
      handleLine(lineBuf);
      lineBuf = "";
    }
    if (typeof onExit === "function") {
      onExit({ code, stderr: stderrText });
    }
  }

  let child;
  try {
    child = spawn(
      binary,
      args,
      agentSpawnOptions({
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: envExtra ? { ...process.env, ...envExtra } : undefined,
      }),
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (typeof onError === "function") onError(error);
    if (typeof onExit === "function") {
      onExit({ code: 1, stderr: error.message });
    }
    return { kill() {} };
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    lineBuf += chunk;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      handleLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    // Tail-keep: stderr feeds error reporting, and a noisy CLI would
    // otherwise grow this buffer for the life of a long-lived process.
    stderrText = (stderrText + chunk).slice(-STDERR_TAIL_CHARS);
  });

  child.on("error", (err) => {
    if (typeof onError === "function") onError(err);
    finish(1);
  });

  child.on("close", (code) => {
    finish(code);
  });

  return {
    kill() {
      if (killed || finished) return;
      killed = true;
      killTimer = killTree(child, SIGKILL_AFTER_MS);
    },
  };
}

/**
 * Extract a session/thread id from a codex event, if present.
 * @param {object} ev
 * @returns {string | null}
 */
function extractSessionId(ev) {
  if (!ev || typeof ev !== "object") return null;
  const candidates = [
    ev.session_id,
    ev.sessionId,
    ev.thread_id,
    ev.threadId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  if (ev.thread && typeof ev.thread === "object") {
    const t = ev.thread;
    if (typeof t.id === "string" && t.id) return t.id;
  }
  if (ev.session && typeof ev.session === "object") {
    const s = ev.session;
    if (typeof s.id === "string" && s.id) return s.id;
  }
  return null;
}

/**
 * True if this event looks like a session/thread start.
 * @param {object} ev
 */
function isSessionStartEvent(ev) {
  if (!ev || typeof ev !== "object") return false;
  const type = String(ev.type || "");
  if (
    type === "thread.started" ||
    type === "thread_started" ||
    type === "session.created" ||
    type === "session_created" ||
    type === "session.started" ||
    type === "session_started"
  ) {
    return true;
  }
  // Tolerant: any event with a session/thread id and a start-ish type
  if (extractSessionId(ev) && /start|creat|init/i.test(type)) {
    return true;
  }
  return false;
}

/**
 * Terminal Codex JSONL failures are written to stdout, not necessarily stderr.
 * @param {object} ev
 * @returns {string | null}
 */
function extractTerminalError(ev) {
  if (!ev || typeof ev !== "object") return null;
  const type = String(ev.type || "");
  if (type !== "turn.failed" && type !== "turn_failed" && type !== "error") {
    return null;
  }
  const error =
    ev.error && typeof ev.error === "object" ? ev.error : null;
  const data =
    error && error.data && typeof error.data === "object"
      ? error.data
      : null;
  const code = String(
    error?.code ?? data?.code ?? ev.code ?? error?.name ?? "",
  ).trim();
  const message = String(
    error?.message ??
      data?.message ??
      ev.message ??
      (typeof ev.error === "string" ? ev.error : ""),
  ).trim();
  if (!code) return message || null;
  if (!message || message === code) return code;
  return `${code}: ${message}`;
}

/**
 * Pull agent message text from various codex shapes.
 * @param {object} ev
 * @returns {string | null}
 */
function extractAgentMessageText(ev) {
  if (!ev || typeof ev !== "object") return null;

  // item.completed / item.updated with item.type agent_message
  if (ev.item && typeof ev.item === "object") {
    const item = ev.item;
    const itemType = String(item.type || "");
    if (itemType === "agent_message" || itemType === "message") {
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      if (typeof item.message === "string") return item.message;
    }
  }

  // msg.type agent_message variants
  if (ev.msg && typeof ev.msg === "object") {
    const msg = ev.msg;
    if (
      msg.type === "agent_message" ||
      msg.type === "agent_message_content_delta"
    ) {
      if (typeof msg.message === "string") return msg.message;
      if (typeof msg.text === "string") return msg.text;
      if (typeof msg.delta === "string") return msg.delta;
    }
  }

  if (ev.type === "agent_message") {
    if (typeof ev.text === "string") return ev.text;
    if (typeof ev.message === "string") return ev.message;
  }

  return null;
}

/**
 * True when event completes (or fully carries) an agent message.
 * Delta-only events still return text via extractAgentMessageText; callers
 * decide whether to replace or append.
 * @param {object} ev
 */
function isAgentMessageEvent(ev) {
  return extractAgentMessageText(ev) != null;
}

/**
 * Extract command execution item start/complete info.
 * @param {object} ev
 * @returns {{ id: string, command: string, output: string | null, exitCode: number | null, phase: "started" | "completed" } | null}
 */
function extractCommandItem(ev) {
  if (!ev || typeof ev !== "object") return null;
  const type = String(ev.type || "");
  const item = ev.item && typeof ev.item === "object" ? ev.item : null;

  if (item) {
    const itemType = String(item.type || "");
    if (
      itemType !== "command_execution" &&
      itemType !== "command" &&
      itemType !== "bash"
    ) {
      // fall through to msg variants
    } else {
      const id = String(item.id || item.item_id || "");
      const command = String(
        item.command || item.cmd || item.input || item.command_line || "",
      );
      if (!id && !command) return null;
      const toolId = id || `cmd-${command.slice(0, 32)}`;
      if (type === "item.started" || type === "item_started") {
        return {
          id: toolId,
          command,
          output: null,
          exitCode: null,
          phase: "started",
        };
      }
      if (
        type === "item.completed" ||
        type === "item_completed" ||
        type === "item.updated"
      ) {
        const output =
          item.aggregated_output != null
            ? String(item.aggregated_output)
            : item.output != null
              ? String(item.output)
              : item.stdout != null
                ? String(item.stdout)
                : "";
        let exitCode = null;
        if (item.exit_code != null) exitCode = Number(item.exit_code);
        else if (item.exitCode != null) exitCode = Number(item.exitCode);
        else if (item.status === "failed") exitCode = 1;
        return {
          id: toolId,
          command,
          output,
          exitCode: Number.isFinite(exitCode) ? exitCode : null,
          phase: "completed",
        };
      }
    }
  }

  // msg.type command_execution variants
  if (ev.msg && typeof ev.msg === "object") {
    const msg = ev.msg;
    if (
      msg.type === "command_execution" ||
      msg.type === "exec_command_begin" ||
      msg.type === "exec_command_end"
    ) {
      const id = String(msg.id || msg.call_id || msg.item_id || "");
      const command = String(msg.command || msg.cmd || "");
      const toolId = id || `cmd-${command.slice(0, 32)}`;
      if (msg.type === "exec_command_begin") {
        return {
          id: toolId,
          command,
          output: null,
          exitCode: null,
          phase: "started",
        };
      }
      const output =
        msg.aggregated_output != null
          ? String(msg.aggregated_output)
          : msg.output != null
            ? String(msg.output)
            : "";
      let exitCode = null;
      if (msg.exit_code != null) exitCode = Number(msg.exit_code);
      return {
        id: toolId,
        command,
        output,
        exitCode: Number.isFinite(exitCode) ? exitCode : null,
        phase: "completed",
      };
    }
  }

  return null;
}

/**
 * token_count.info from exec JSONL, app-server `msg`, or session `payload`.
 * @param {object} ev
 * @returns {object | null}
 */
function tokenCountInfo(ev) {
  if (!ev || typeof ev !== "object") return null;
  const type = String(ev.type || "");
  const payload = ev.payload && typeof ev.payload === "object" ? ev.payload : null;
  const msg = ev.msg && typeof ev.msg === "object" ? ev.msg : null;
  if (
    ev.info &&
    typeof ev.info === "object" &&
    (type === "token_count" ||
      type === "token.count" ||
      ev.info.last_token_usage ||
      ev.info.total_token_usage ||
      ev.info.model_context_window != null)
  ) {
    return ev.info;
  }
  if (payload && (payload.type === "token_count" || payload.type === "token.count")) {
    return payload.info && typeof payload.info === "object" ? payload.info : null;
  }
  if (msg && (msg.type === "token_count" || msg.type === "token.count")) {
    return msg.info && typeof msg.info === "object" ? msg.info : null;
  }
  return null;
}

/**
 * Codex input_tokens already includes cached_input_tokens (session logs:
 * input + output === total_tokens). Prefer total_tokens when present.
 * @param {object | null | undefined} usage
 * @returns {number | undefined}
 */
function codexPromptTokens(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total) && total > 0) return total;
  const input =
    Number(
      usage.input_tokens ??
        usage.inputTokens ??
        usage.prompt_tokens ??
        usage.total_input_tokens ??
        0,
    ) || 0;
  const output =
    Number(
      usage.output_tokens ??
        usage.outputTokens ??
        usage.completion_tokens ??
        usage.total_output_tokens ??
        0,
    ) || 0;
  return input + output > 0 ? input + output : undefined;
}

/**
 * Extract token usage from completion / token_count events.
 * token_count.last_token_usage is the per-request delta; total_token_usage
 * is session-cumulative — never treat the latter as a turn delta (#317).
 * @param {object} ev
 * @returns {{ inputTokens: number, outputTokens: number, model: string | null, costUsd?: number, contextTokens?: number, contextWindow?: number, snapshot?: boolean } | null}
 */
function extractUsage(ev) {
  if (!ev || typeof ev !== "object") return null;
  const type = String(ev.type || "");

  const info = tokenCountInfo(ev);
  if (info) {
    const last =
      info.last_token_usage && typeof info.last_token_usage === "object"
        ? info.last_token_usage
        : null;
    const total =
      info.total_token_usage && typeof info.total_token_usage === "object"
        ? info.total_token_usage
        : null;
    const src = last || total;
    if (!src && info.model_context_window == null) return null;
    const inputTokens = Number(src?.input_tokens) || 0;
    const outputTokens = Number(src?.output_tokens) || 0;
    const window = Number(info.model_context_window);
    /** @type {{ inputTokens: number, outputTokens: number, model: string | null, contextTokens?: number, contextWindow?: number, snapshot?: boolean }} */
    const counted = { inputTokens, outputTokens, model: null };
    const ctx = codexPromptTokens(src);
    if (ctx != null) counted.contextTokens = ctx;
    if (Number.isFinite(window) && window > 0) counted.contextWindow = window;
    // No last_token_usage: totals are a snapshot, not a delta.
    if (!last && total) counted.snapshot = true;
    if (!src && counted.contextWindow == null) return null;
    return counted;
  }

  let usage = null;
  if (ev.usage && typeof ev.usage === "object") {
    usage = ev.usage;
  } else if (ev.msg && typeof ev.msg === "object" && ev.msg.usage) {
    usage = ev.msg.usage;
  }

  if (
    !usage &&
    (type === "turn.completed" ||
      type === "turn_completed" ||
      type === "result")
  ) {
    if (ev.usage) usage = ev.usage;
  }

  if (!usage || typeof usage !== "object") return null;

  const inputTokens =
    Number(
      usage.input_tokens ??
        usage.inputTokens ??
        usage.prompt_tokens ??
        usage.total_input_tokens ??
        0,
    ) || 0;
  const outputTokens =
    Number(
      usage.output_tokens ??
        usage.outputTokens ??
        usage.completion_tokens ??
        usage.total_output_tokens ??
        0,
    ) || 0;

  // Only treat as usage if at least one field is present
  const hasField =
    usage.input_tokens != null ||
    usage.inputTokens != null ||
    usage.output_tokens != null ||
    usage.outputTokens != null ||
    usage.prompt_tokens != null ||
    usage.completion_tokens != null ||
    type === "turn.completed" ||
    type === "turn_completed";

  if (!hasField && inputTokens === 0 && outputTokens === 0) return null;

  const model =
    typeof usage.model === "string"
      ? usage.model
      : typeof ev.model === "string"
        ? ev.model
        : null;

  const costRaw =
    usage.total_cost_usd ??
    usage.cost_usd ??
    usage.costUsd ??
    ev.total_cost_usd ??
    ev.cost_usd;
  const costUsd = costRaw != null ? Number(costRaw) || 0 : 0;

  /** @type {{ inputTokens: number, outputTokens: number, model: string | null, costUsd?: number, contextTokens?: number }} */
  const out = { inputTokens, outputTokens, model };
  if (costRaw != null) {
    out.costUsd = costUsd;
  }
  // exec --json turn.completed: input already includes cached_input_tokens.
  const ctx = codexPromptTokens(usage);
  if (ctx != null) out.contextTokens = ctx;
  return out;
}

module.exports = {
  runCodex,
  extractSessionId,
  isSessionStartEvent,
  extractTerminalError,
  extractAgentMessageText,
  isAgentMessageEvent,
  extractCommandItem,
  extractUsage,
  SIGKILL_AFTER_MS,
};
