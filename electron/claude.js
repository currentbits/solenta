"use strict";

const { spawn } = require("node:child_process");
const { getClaudeMcpArgs } = require("./memory-sup.js");

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
 * Best-effort one-line tool summary: "Name: description".
 * @param {string} name
 * @param {unknown} input
 */
function toolSummary(name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return name;
  }
  /** @type {Record<string, unknown>} */
  const obj = input;
  const prefer = [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "description",
    "url",
  ];
  for (const k of prefer) {
    if (typeof obj[k] === "string" && obj[k]) {
      const v = /** @type {string} */ (obj[k]);
      const short = v.length > 80 ? `${v.slice(0, 80)}…` : v;
      return `${name}: ${short}`;
    }
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v) {
      const short = v.length > 80 ? `${v.slice(0, 80)}…` : v;
      return `${name}: ${short}`;
    }
  }
  return name;
}

/**
 * Flatten tool_result content into a string.
 * @param {unknown} content
 */
function flattenContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = /** @type {{ type?: string, text?: string }} */ (block);
          if (b.type === "text" && typeof b.text === "string") return b.text;
          try {
            return JSON.stringify(block);
          } catch {
            return String(block);
          }
        }
        return String(block);
      })
      .join("\n");
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

/**
 * Spawn the Claude Code CLI with stream-json output.
 *
 * @param {object} opts
 * @param {string} [opts.binary]
 * @param {string[]} [opts.args] - full argv after binary; when omitted, built from prompt/session/mode/model
 * @param {string} [opts.prompt]
 * @param {string} opts.cwd
 * @param {string} [opts.permissionMode]
 * @param {string | null} [opts.sessionId]
 * @param {string | null} [opts.model]
 * @param {boolean} [opts.interactive] - stream-json INPUT mode: the prompt is
 *   delivered on stdin (args must NOT carry a trailing prompt) and the CLI can
 *   ask for tool permission via control_request/control_response. stdin is
 *   closed on the result event so the one-turn-per-process lifecycle holds.
 * @param {(ev: object) => void} opts.onEvent - raw parsed NDJSON event
 * @param {(info: { code: number | null, stderr: string, gotResult: boolean }) => void} opts.onExit
 * @param {(err: Error) => void} [opts.onError]
 * @returns {{ kill: () => void, respond: (requestId: string, response: object) => boolean, child: import('node:child_process').ChildProcess | null }}
 */
function runClaude(opts) {
  const {
    binary = process.env.CODER_CLAUDE_BIN || "claude",
    prompt,
    cwd,
    permissionMode = "default",
    sessionId = null,
    model = null,
    interactive = false,
    onEvent,
    onExit,
    onError,
  } = opts;

  const args = Array.isArray(opts.args)
    ? opts.args
    : (() => {
        const a = [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          String(permissionMode || "default"),
        ];
        if (model) {
          a.push("--model", String(model));
        }
        if (sessionId) {
          a.push("--resume", String(sessionId));
        }
        // Memory MCP injection when supervised server is healthy.
        a.push(...getClaudeMcpArgs());
        a.push(String(prompt ?? ""));
        return a;
      })();

  let stderrText = "";
  let lineBuf = "";
  let finished = false;
  let killTimer = null;
  let killed = false;
  let gotResult = false;

  /** Write one NDJSON line to the CLI's stdin; false when stdin is gone. */
  function writeLine(obj) {
    if (!child || !child.stdin || child.stdin.destroyed || finished) {
      return false;
    }
    try {
      child.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

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
    if (obj.type === "result") {
      gotResult = true;
      // Interactive mode: the CLI waits for more stdin messages after a
      // result; end stdin so the process exits and the turn finishes.
      if (interactive && child && child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.end();
        } catch {
          // already closed
        }
      }
    }
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
    // Flush incomplete line if it is valid JSON
    if (lineBuf.trim()) {
      handleLine(lineBuf);
      lineBuf = "";
    }
    if (typeof onExit === "function") {
      onExit({ code, stderr: stderrText, gotResult });
    }
  }

  let child;
  try {
    child = spawn(binary, args, {
      cwd,
      shell: false,
      stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (typeof onError === "function") onError(error);
    if (typeof onExit === "function") {
      onExit({ code: 1, stderr: error.message, gotResult: false });
    }
    return { kill() {}, child: null };
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  if (interactive) {
    // EPIPE from a dying CLI must not crash the main process.
    child.stdin.on("error", () => {});
    writeLine({
      type: "user",
      message: { role: "user", content: String(prompt ?? "") },
      parent_tool_use_id: null,
      session_id: "",
    });
  }

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
    child,
    /**
     * Answer a control_request (permission prompt). `response` is the inner
     * payload, e.g. { behavior: "allow", updatedInput } or
     * { behavior: "deny", message }.
     * @param {string} requestId
     * @param {object} response
     */
    respond(requestId, response) {
      return writeLine({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response,
        },
      });
    },
    /**
     * Reject a control_request we cannot handle (unknown subtype).
     * @param {string} requestId
     * @param {string} message
     */
    respondError(requestId, message) {
      return writeLine({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: String(message),
        },
      });
    },
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
  runClaude,
  truncate,
  toolSummary,
  flattenContent,
  INPUT_TRUNCATE,
  OUTPUT_TRUNCATE,
  SIGKILL_AFTER_MS,
};
