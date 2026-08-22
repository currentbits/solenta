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
const INPUT_TRUNCATE = 2000;
const OUTPUT_TRUNCATE = 4000;

/**
 * @param {string} s
 * @param {number} max
 */
function truncate(s, max) {
  const str = String(s ?? "");
  return str.length <= max ? str : str.slice(0, max);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asJson(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Join text blocks from an assistant message.content field.
 * @param {unknown} message
 * @returns {string}
 */
function textFromMessageContent(message) {
  if (!message || typeof message !== "object") return "";
  const c = /** @type {{ content?: unknown }} */ (message).content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts = [];
  for (const block of c) {
    if (!block || typeof block !== "object") continue;
    const b = /** @type {{ type?: string, text?: string }} */ (block);
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

/**
 * Assistant text from a Cursor stream-json event.
 *
 * We always run with --stream-partial-output. Cursor then emits three
 * assistant shapes (docs + live CLI 2026.07.09):
 *   timestamp_ms set, no model_call_id  -> streaming delta; use
 *   timestamp_ms set, model_call_id set -> buffered flush before a tool
 *                                         call; duplicate, skip
 *   neither field                       -> complete message (no stream)
 *                                         OR the end-of-turn flush
 *
 * The last two are the same shape. This helper is stateless, so a
 * non-empty body is returned (complete non-streamed messages still
 * render) and an empty body is skipped. result.result is the
 * concatenated final answer and is not assistant text; the runner
 * already accumulated the deltas.
 *
 * @param {object} obj
 * @returns {string | null}
 */
function extractAssistantText(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.type !== "assistant") return null;
  // Buffered flush before a tool call: duplicate of streamed deltas.
  if (obj.model_call_id) return null;

  const text = textFromMessageContent(obj.message);
  // End-of-turn flush with no new text, or an assistant event with no
  // content. Complete non-streamed messages carry text and fall through.
  if (obj.timestamp_ms == null && !text) return null;
  return text || null;
}

/**
 * @typedef {{ id: string, name: string, input: string, output: string | null, phase: "start" | "end" | "single", isError: boolean }} ToolEvent
 */

/**
 * readToolCall -> Read, writeToolCall -> Write. Keys that do not end in
 * ToolCall are title-cased as-is.
 * @param {string} key
 * @returns {string}
 */
function titleCaseToolName(key) {
  const raw = String(key || "");
  const base = raw.endsWith("ToolCall") ? raw.slice(0, -"ToolCall".length) : raw;
  if (!base) return raw;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Name + payload from a Cursor tool_call object. function.name wins when
 * the function-shaped form is present.
 * @param {Record<string, unknown>} toolCall
 * @returns {{ name: string, payload: Record<string, unknown> | null }}
 */
function cursorToolPayload(toolCall) {
  const fn = toolCall.function;
  if (fn && typeof fn === "object") {
    const rec = /** @type {Record<string, unknown>} */ (fn);
    return {
      name: typeof rec.name === "string" ? rec.name : "",
      payload: rec,
    };
  }
  const keys = Object.keys(toolCall);
  if (keys.length === 0) return { name: "", payload: null };
  const key = keys[0];
  const raw = toolCall[key];
  return {
    name: titleCaseToolName(key),
    payload: raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null,
  };
}

/**
 * Tool events on one Cursor stream-json line.
 *
 *   {"type":"tool_call","subtype":"started","call_id":"...","tool_call":{"readToolCall":{"args":{"path":"README.md"}}}}
 *   {"type":"tool_call","subtype":"completed","call_id":"...","tool_call":{"readToolCall":{"args":{...},"result":{"success":{...}}}}}
 *
 * @param {object} obj
 * @returns {ToolEvent[]}
 */
function extractToolEvents(obj) {
  if (!obj || typeof obj !== "object") return [];
  if (obj.type !== "tool_call") return [];
  if (obj.subtype !== "started" && obj.subtype !== "completed") return [];

  const toolCall =
    obj.tool_call && typeof obj.tool_call === "object"
      ? /** @type {Record<string, unknown>} */ (obj.tool_call)
      : null;
  if (!toolCall) return [];

  const { name, payload } = cursorToolPayload(toolCall);
  if (!name) return [];

  const args =
    payload && payload.args != null
      ? payload.args
      : payload && payload.arguments != null
        ? payload.arguments
        : null;
  const input = truncate(asJson(args), INPUT_TRUNCATE);
  const id = obj.call_id != null ? String(obj.call_id) : "";

  if (obj.subtype === "started") {
    return [
      {
        id,
        name,
        input,
        output: null,
        phase: "start",
        isError: false,
      },
    ];
  }

  const result =
    payload && payload.result && typeof payload.result === "object"
      ? /** @type {Record<string, unknown>} */ (payload.result)
      : null;
  const isError = Boolean(result && (result.error != null || result.failure != null));
  let outputRaw = null;
  if (result) {
    if (isError) {
      outputRaw = result.error != null ? result.error : result.failure;
    } else if (result.success != null) {
      outputRaw = result.success;
    }
  }
  let output = null;
  if (outputRaw != null) {
    output = truncate(asJson(outputRaw), OUTPUT_TRUNCATE);
  }

  return [
    {
      id,
      name,
      input,
      output,
      phase: "end",
      isError,
    },
  ];
}

/**
 * Real session id from system/init or the terminal result. Other events
 * also carry session_id; ignore those rather than inventing an id.
 * @param {object} obj
 * @returns {string | null}
 */
function extractSessionId(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.session_id !== "string" || !obj.session_id) return null;
  if (obj.type === "system" && obj.subtype === "init") return obj.session_id;
  if (obj.type === "result") return obj.session_id;
  return null;
}

/**
 * Usage from a Cursor result event. Cursor often omits it; return null
 * when no token fields are present. Same names as kimi.
 * @param {object} obj
 * @returns {{ inputTokens: number, outputTokens: number, costUsd?: number } | null}
 */
function extractUsage(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.type !== "result") return null;

  /** @type {Record<string, unknown> | null} */
  let usage = null;
  if (obj.usage && typeof obj.usage === "object") {
    usage = /** @type {Record<string, unknown>} */ (obj.usage);
  } else if (
    obj.input_tokens != null ||
    obj.output_tokens != null ||
    obj.prompt_tokens != null ||
    obj.completion_tokens != null
  ) {
    usage = /** @type {Record<string, unknown>} */ (obj);
  }

  if (!usage) return null;

  const hasField =
    usage.input_tokens != null ||
    usage.output_tokens != null ||
    usage.prompt_tokens != null ||
    usage.completion_tokens != null ||
    usage.inputTokens != null ||
    usage.outputTokens != null;

  if (!hasField) return null;

  const inputTokens =
    Number(
      usage.input_tokens ??
        usage.inputTokens ??
        usage.prompt_tokens ??
        0,
    ) || 0;
  const outputTokens =
    Number(
      usage.output_tokens ??
        usage.outputTokens ??
        usage.completion_tokens ??
        0,
    ) || 0;

  const costRaw =
    usage.total_cost_usd ??
    usage.cost_usd ??
    usage.costUsd ??
    usage.cost ??
    obj.total_cost_usd ??
    obj.cost_usd ??
    obj.cost;
  const costUsd = costRaw != null ? Number(costRaw) || 0 : 0;

  /** @type {{ inputTokens: number, outputTokens: number, costUsd?: number }} */
  const out = { inputTokens, outputTokens };
  if (costRaw != null) out.costUsd = costUsd;
  return out;
}

/**
 * Spawn the Cursor Agent CLI with stream-json (NDJSON) output.
 *
 * @param {object} opts
 * @param {string} [opts.binary]
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {(ev: object) => void} opts.onEvent - raw parsed NDJSON object
 * @param {(info: { code: number | null, stderr: string, fullStdout: string, gotJson: boolean }) => void} opts.onExit
 * @param {(err: Error) => void} [opts.onError]
 * @returns {{ kill: () => void }}
 */
function runCursor(opts) {
  const {
    binary = process.env.CODER_CURSOR_BIN || "cursor-agent",
    args = [],
    cwd,
    onEvent,
    onExit,
    onError,
  } = opts;

  let stderrText = "";
  let fullStdout = "";
  let lineBuf = "";
  let finished = false;
  let killTimer = null;
  let killed = false;
  let gotJson = false;

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
    gotJson = true;
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
      onExit({
        code,
        stderr: stderrText,
        fullStdout,
        gotJson,
      });
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
      }),
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (typeof onError === "function") onError(error);
    if (typeof onExit === "function") {
      onExit({
        code: 1,
        stderr: error.message,
        fullStdout: "",
        gotJson: false,
      });
    }
    return { kill() {} };
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    const str = String(chunk);
    fullStdout += str;
    lineBuf += str;
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

module.exports = {
  runCursor,
  extractAssistantText,
  extractToolEvents,
  extractSessionId,
  extractUsage,
  truncate,
  INPUT_TRUNCATE,
  OUTPUT_TRUNCATE,
  SIGKILL_AFTER_MS,
};
