"use strict";

const { spawn } = require("node:child_process");
const { killTree } = require("./proc.js");

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
 * Tool-ish events: type contains "tool" and a name is present.
 * @param {object} obj
 * @returns {{ id: string, name: string, input: string, output: string | null, phase: "start" | "end" | "single", isError: boolean } | null}
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
  if (hasOutput) {
    const o =
      (part && (part.output != null ? part.output : part.result)) ??
      (obj.output != null ? obj.output : obj.result);
    output = truncate(
      typeof o === "string"
        ? o
        : (() => {
            try {
              return JSON.stringify(o);
            } catch {
              return String(o);
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
  };
}

/**
 * Spawn the OpenCode CLI with NDJSON (--format json) output.
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
function runOpencode(opts) {
  const {
    binary = process.env.CODER_OPENCODE_BIN || "opencode",
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
      detached: true,
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
      killTimer = killTree(child, SIGKILL_AFTER_MS);
    },
  };
}

module.exports = {
  runOpencode,
  extractSessionId,
  extractTextPart,
  extractToolEvent,
  truncate,
  INPUT_TRUNCATE,
  OUTPUT_TRUNCATE,
  SIGKILL_AFTER_MS,
};
