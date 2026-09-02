"use strict";

// cross-spawn, not child_process: on Windows the agent CLIs install as
// .cmd shims and Node refuses to exec those directly. cross-spawn routes
// them through cmd.exe with correct escaping, which matters because the
// prompt travels in argv (#442).
const spawn = require("cross-spawn");
const { killTree, agentSpawnOptions } = require("./proc.js");
const { harvestToolResult } = require("./tool-images.js");

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
 * Extract sessionID from an opencode NDJSON event (first non-empty wins for callers).
 * @param {object} obj
 * @returns {string | null}
 */
function extractSessionId(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.sessionID === "string" && obj.sessionID) return obj.sessionID;
  if (typeof obj.sessionId === "string" && obj.sessionId) return obj.sessionId;
  return null;
}

/**
 * Terminal OpenCode errors are NDJSON events on stdout.
 * @param {object} obj
 * @returns {string | null}
 */
function extractTerminalError(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = String(obj.type || "");
  if (type !== "error" && type !== "step_error" && type !== "step.error") {
    return null;
  }
  const error =
    obj.error && typeof obj.error === "object" ? obj.error : null;
  const data =
    error && error.data && typeof error.data === "object"
      ? error.data
      : null;
  const code = String(
    data?.code ?? error?.code ?? obj.code ?? error?.name ?? "",
  ).trim();
  const message = String(
    data?.message ??
      error?.message ??
      obj.message ??
      (typeof obj.error === "string" ? obj.error : ""),
  ).trim();
  if (!code) return message || null;
  if (!message || message === code) return code;
  return `${code}: ${message}`;
}

/**
 * Text from a text-type event: prefer part.text, fall back to any string field
 * named text on part.
 * @param {object} obj
 * @returns {{ id: string | null, text: string } | null}
 */
function extractTextPart(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = String(obj.type || "");
  if (type !== "text") return null;

  const part = obj.part && typeof obj.part === "object" ? obj.part : null;
  if (!part) {
    // Defensive: top-level text field
    if (typeof obj.text === "string") {
      return { id: null, text: obj.text };
    }
    return null;
  }

  let text = null;
  if (typeof part.text === "string") {
    text = part.text;
  } else {
    for (const key of Object.keys(part)) {
      if (key === "text" && typeof part[key] === "string") {
        text = part[key];
        break;
      }
    }
  }
  if (text == null) return null;

  const id =
    typeof part.id === "string" && part.id
      ? part.id
      : part.id != null
        ? String(part.id)
        : null;
  return { id, text };
}

/**
 * Reasoning/thinking part from `opencode run --format json --thinking`
 * (issue #751). Emitted as type "reasoning" (and sometimes "thinking").
 * @param {object} obj
 * @returns {{ id: string | null, text: string } | null}
 */
function extractThinkingPart(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = String(obj.type || "");
  if (type !== "reasoning" && type !== "thinking") return null;

  const part = obj.part && typeof obj.part === "object" ? obj.part : null;
  let text = null;
  if (part && typeof part.text === "string") text = part.text;
  else if (typeof obj.text === "string") text = obj.text;
  if (text == null) return null;

  const id =
    (part && typeof part.id === "string" && part.id) ||
    (part && part.id != null ? String(part.id) : null) ||
    (typeof obj.id === "string" && obj.id) ||
    (obj.id != null ? String(obj.id) : null);
  return { id, text };
}

/**
 * Tool-ish events: type contains "tool" and a name is present.
 * @param {object} obj
 * @returns {{ id: string, name: string, input: string, output: string | null, phase: "start" | "end" | "single", isError: boolean, images?: { mediaType: string, data: string }[] } | null}
 */
function extractToolEvent(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = String(obj.type || "");
  if (!/tool/i.test(type)) return null;

  const part = obj.part && typeof obj.part === "object" ? obj.part : null;
  const name =
    (part && typeof part.name === "string" && part.name) ||
    (typeof obj.name === "string" && obj.name) ||
    (obj.tool && typeof obj.tool === "object" && typeof obj.tool.name === "string"
      ? obj.tool.name
      : null);
  if (!name) return null;

  const id = String(
    (part && (part.id || part.tool_call_id)) ||
      obj.id ||
      obj.tool_call_id ||
      (obj.tool && obj.tool.id) ||
      "",
  );

  let inputRaw =
    (part && (part.input != null ? part.input : part.arguments != null ? part.arguments : null)) ??
    (obj.input != null
      ? obj.input
      : obj.arguments != null
        ? obj.arguments
        : obj.args != null
          ? obj.args
          : null);
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
    (part && (part.output != null || part.result != null)) ||
    obj.output != null ||
    obj.result != null;
  let output = null;
  /** @type {{ mediaType: string, data: string }[]} */
  let images = [];
  if (hasOutput) {
    const o =
      (part && (part.output != null ? part.output : part.result)) ??
      (obj.output != null ? obj.output : obj.result);
    const harvested = harvestToolResult(o);
    images = harvested.images;
    const redacted = harvested.redacted;
    output = truncate(
      typeof redacted === "string"
        ? redacted
        : (() => {
            try {
              return JSON.stringify(redacted);
            } catch {
              return String(redacted);
            }
          })(),
      OUTPUT_TRUNCATE,
    );
  }

  const isError = Boolean(
    (part && (part.is_error || part.isError || part.error)) ||
      obj.is_error ||
      obj.isError ||
      obj.error,
  );
  const typeLower = type.toLowerCase();
  const looksResult =
    /result|output|end|complete|response|finish/i.test(typeLower) || hasOutput;
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
    ...(images.length ? { images } : {}),
  };
}

/**
 * Spawn the OpenCode CLI with NDJSON (--format json) output.
 *
 * @param {object} opts
 * @param {string} [opts.binary]
 * @param {string[]} opts.args
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} [opts.env] - overlay env (OPENCODE_CONFIG_DIR)
 * @param {(ev: object) => void} opts.onEvent - raw parsed NDJSON object
 * @param {(info: { code: number | null, stderr: string, fullStdout: string, gotJson: boolean }) => void} opts.onExit
 * @param {(err: Error) => void} [opts.onError]
 * @returns {{ kill: () => void }}
 */
function runOpencode(opts) {
  const {
    binary = process.env.CODER_OPENCODE_BIN || "opencode",
    args = [],
    cwd,
    env: envOverride,
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
        env: envOverride
          ? { ...process.env, ...envOverride }
          : undefined,
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
  runOpencode,
  extractSessionId,
  extractTerminalError,
  extractTextPart,
  extractThinkingPart,
  extractToolEvent,
  truncate,
  INPUT_TRUNCATE,
  OUTPUT_TRUNCATE,
  SIGKILL_AFTER_MS,
};
