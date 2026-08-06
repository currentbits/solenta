"use strict";

const { spawn } = require("node:child_process");

const SIGKILL_AFTER_MS = 3000;

/**
 * Spawn the Codex CLI with JSONL output.
 *
 * @param {object} opts
 * @param {string} [opts.binary]
 * @param {string[]} [opts.args] - full argv after binary (from providers.buildArgs)
 * @param {string} opts.cwd
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
    child = spawn(binary, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    stderrText += chunk;
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
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
      killTimer = setTimeout(() => {
        killTimer = null;
        try {
          if (!finished) child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, SIGKILL_AFTER_MS);
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
 * Extract token usage from completion / token_count events.
 * @param {object} ev
 * @returns {{ inputTokens: number, outputTokens: number, model: string | null } | null}
 */
function extractUsage(ev) {
  if (!ev || typeof ev !== "object") return null;
  const type = String(ev.type || "");

  let usage = null;
  if (ev.usage && typeof ev.usage === "object") {
    usage = ev.usage;
  } else if (type === "token_count" || type === "token.count") {
    usage = ev;
  } else if (ev.msg && typeof ev.msg === "object") {
    if (ev.msg.type === "token_count" || ev.msg.usage) {
      usage =
        ev.msg.usage ||
        ev.msg.info?.total_token_usage ||
        ev.msg.info ||
        ev.msg;
    }
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
    type === "token_count" ||
    type === "token.count" ||
    type === "turn.completed" ||
    type === "turn_completed";

  if (!hasField && inputTokens === 0 && outputTokens === 0) return null;

  const model =
    typeof usage.model === "string"
      ? usage.model
      : typeof ev.model === "string"
        ? ev.model
        : null;

  return { inputTokens, outputTokens, model };
}

module.exports = {
  runCodex,
  extractSessionId,
  isSessionStartEvent,
  extractAgentMessageText,
  isAgentMessageEvent,
  extractCommandItem,
  extractUsage,
  SIGKILL_AFTER_MS,
};
