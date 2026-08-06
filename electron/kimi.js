"use strict";

const { spawn } = require("node:child_process");

const SIGKILL_AFTER_MS = 3000;
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
 * Extract assistant text from defensive kimi stream-json shapes.
 * First match wins: type text|message|assistant with text|content|delta,
 * or nested message.content (string or text-block array).
 * @param {object} obj
 * @returns {string | null}
 */
function extractAssistantText(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = String(obj.type || "");
  if (type !== "text" && type !== "message" && type !== "assistant") {
    return null;
  }

  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.delta === "string") return obj.delta;

  if (obj.message && typeof obj.message === "object") {
    const c = obj.message.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const parts = [];
      for (const block of c) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
      if (parts.length > 0) return parts.join("");
    }
  }

  return null;
}

/**
 * Tool-call-ish events: type containing "tool" with a name field.
 * Best-effort start/end pairing by id when present.
 * @param {object} obj
 * @returns {{ id: string, name: string, input: string, output: string | null, phase: "start" | "end" | "single", isError: boolean } | null}
 */
function extractToolEvent(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = String(obj.type || "");
  if (!/tool/i.test(type)) return null;

  const name =
    typeof obj.name === "string" && obj.name
      ? obj.name
      : obj.tool && typeof obj.tool === "object" && typeof obj.tool.name === "string"
        ? obj.tool.name
        : null;
  if (!name) return null;

  const id = String(
    obj.id ||
      obj.tool_call_id ||
      obj.tool_use_id ||
      (obj.tool && obj.tool.id) ||
      "",
  );

  let inputRaw =
    obj.input != null
      ? obj.input
      : obj.arguments != null
        ? obj.arguments
        : obj.args != null
          ? obj.args
          : obj.tool && obj.tool.input != null
            ? obj.tool.input
            : null;
  let inputStr = "";
  if (inputRaw != null) {
    try {
      inputStr =
        typeof inputRaw === "string"
          ? inputRaw
          : JSON.stringify(inputRaw, null, 2);
    } catch {
      inputStr = String(inputRaw);
    }
  }
  inputStr = truncate(inputStr, INPUT_TRUNCATE);

  const hasOutput =
    obj.output != null ||
    obj.result != null ||
    obj.content != null ||
    (obj.tool && obj.tool.output != null);
  let output = null;
  if (hasOutput) {
    const o =
      obj.output != null
        ? obj.output
        : obj.result != null
          ? obj.result
          : obj.content != null
            ? obj.content
            : obj.tool.output;
    output = truncate(
      typeof o === "string" ? o : (() => {
        try {
          return JSON.stringify(o);
        } catch {
          return String(o);
        }
      })(),
      OUTPUT_TRUNCATE,
    );
  }

  const isError = Boolean(obj.is_error || obj.isError || obj.error);
  const typeLower = type.toLowerCase();
  const looksResult =
    /result|output|end|complete|response/i.test(typeLower) || hasOutput;
  const looksStart =
    /call|use|start|begin|request/i.test(typeLower) && !looksResult;

  let phase = "single";
  if (looksStart && !hasOutput) phase = "start";
  else if (looksResult && id) phase = "end";
  else if (!hasOutput && id) phase = "start";
  else phase = hasOutput && !looksStart ? "end" : "single";

  return {
    id: id || `tool-${name}`,
    name,
    input: inputStr,
    output,
    phase,
    isError,
  };
}

/**
 * Usage-ish fields: input_tokens/output_tokens or prompt_tokens/completion_tokens
 * at top level or under usage. Cost when the provider reports it.
 * @param {object} obj
 * @returns {{ inputTokens: number, outputTokens: number, costUsd: number } | null}
 */
function extractUsage(obj) {
  if (!obj || typeof obj !== "object") return null;

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
    obj.total_cost_usd ??
    obj.cost_usd;
  const costUsd = costRaw != null ? Number(costRaw) || 0 : 0;

  /** @type {{ inputTokens: number, outputTokens: number, costUsd?: number }} */
  const out = { inputTokens, outputTokens };
  if (costRaw != null) {
    out.costUsd = costUsd;
  }
  return out;
}

/**
 * Spawn the Kimi CLI with stream-json (or plain-text fallback) output.
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
function runKimi(opts) {
  const {
    binary = process.env.CODER_KIMI_BIN || "kimi",
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
    child = spawn(binary, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

module.exports = {
  runKimi,
  extractAssistantText,
  extractToolEvent,
  extractUsage,
  truncate,
  INPUT_TRUNCATE,
  OUTPUT_TRUNCATE,
  SIGKILL_AFTER_MS,
};
