"use strict";

const { getClaudeMcpArgs } = require("./memory-sup.js");
const { runJsonLines, SIGKILL_AFTER_MS } = require("./agent.js");
const { flattenLooksHtml } = require("./tool-html.js");

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
          // Images are rendered from tool.images; stringifying the block here
          // would fill the output pane with truncated base64.
          if (b.type === "image") return "[image]";
          if (flattenLooksHtml(b)) return "[html]";
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
 *   ask for tool permission via control_request/control_response. Without
 *   keepAlive, stdin is closed on the result event so the one-turn-per-process
 *   lifecycle holds.
 * @param {boolean} [opts.keepAlive] - interactive only: do NOT close stdin on
 *   result. The process outlives the turn so harness background tasks survive
 *   settle and later turns reuse it via send() (issue #8).
 * @param {Record<string, string>} [opts.envExtra] - added to the inherited env
 * @param {boolean} [opts.contextSummaryAllowed] - false when a known override is absent from CLI summaries
 * @param {(ev: object) => void} opts.onEvent - raw parsed NDJSON event
 * @param {(info: { code: number | null, stderr: string, gotResult: boolean }) => void} opts.onExit
 * @param {(err: Error) => void} [opts.onError]
 * @returns {{ kill: () => void, send: (prompt: string) => boolean, respond: (requestId: string, response: object) => boolean, respondError: (requestId: string, message: string) => boolean, getStderr: () => string, child: import('node:child_process').ChildProcess | null }}
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
    keepAlive = false,
    envExtra,
    contextSummaryAllowed = true,
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

  let gotResult = false;
  let summarySupported = false;
  let contextRequest = null;
  let contextRequestId = 0;

  function finishContextRequest(value) {
    if (!contextRequest) return;
    const pending = contextRequest;
    contextRequest = null;
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  /** @type {ReturnType<typeof runJsonLines> | null} */
  let run = null;

  /** Write one NDJSON line to the CLI's stdin; false when stdin is gone. */
  function writeLine(obj) {
    const child = run && run.child;
    if (!child || !child.stdin || child.stdin.destroyed || run.isFinished()) {
      return false;
    }
    try {
      child.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  function handleEvent(obj) {
    if (obj.type === "system" && obj.subtype === "init") {
      // 2.1.219 ignores detail and makes token-count API calls. Only probe
      // versions verified to implement the local summary request (2.1.318).
      const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(obj.claude_code_version || "");
      summarySupported = Boolean(version && (
        Number(version[1]) > 2 || (Number(version[1]) === 2 && (
          Number(version[2]) > 1 || (Number(version[2]) === 1 && Number(version[3]) >= 318)
        ))
      ));
    }
    if (obj.type === "control_response" && contextRequest &&
        obj.response?.request_id === contextRequest.id) {
      const response = obj.response;
      if (response.subtype !== "success") summarySupported = false;
      finishContextRequest(response.subtype === "success" ? response.response : null);
      return;
    }

    if (obj.type === "result") {
      gotResult = true;
      // Interactive mode: the CLI waits for more stdin messages after a
      // result; end stdin so the process exits and the turn finishes.
      // keepAlive skips this so the process (and its background tasks)
      // survives the turn and can take the next one via send().
      const child = run && run.child;
      if (interactive && !keepAlive && child && child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.end();
        } catch {
          // already closed
        }
      }
    }
    if (typeof onEvent === "function") onEvent(obj);
  }

  /** Deliver one user turn on stdin; resets per-turn result tracking. */
  function sendUser(promptText) {
    // A response for the previous turn cannot describe this turn's settings.
    finishContextRequest(null);
    gotResult = false;
    return writeLine({
      type: "user",
      message: { role: "user", content: String(promptText ?? "") },
      parent_tool_use_id: null,
      session_id: "",
    });
  }

  run = runJsonLines({
    binary,
    args,
    cwd,
    stdin: interactive ? "pipe" : "ignore",
    env: envExtra ? { ...process.env, ...envExtra } : undefined,
    onEvent: handleEvent,
    onExit:
      typeof onExit === "function"
        ? ({ code, stderr }) => {
            finishContextRequest(null);
            onExit({ code, stderr, gotResult });
          }
        : () => finishContextRequest(null),
    onError,
  });
  const child = run.child;
  if (!child) {
    return {
      kill() {},
      send: () => false,
      respond: () => false,
      respondError: () => false,
      setModel: () => false,
      getContextUsage: () => Promise.resolve(null),
      getStderr: () => "",
      child: null,
    };
  }

  if (interactive) {
    // EPIPE from a dying CLI must not crash the main process.
    child.stdin.on("error", () => {});
    sendUser(prompt);
  }

  return {
    child,
    send: sendUser,
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
    /**
     * Switch the live process's model for its next API call, same session
     * (#1716; stream-json `set_model`, live-verified on 2.1.283). null asks
     * for the CLI default.
     * @param {string | null} model
     */
    setModel(model) {
      finishContextRequest(null);
      return writeLine({
        type: "control_request",
        request_id: `set-model-${Date.now()}`,
        request: { subtype: "set_model", ...(model ? { model } : {}) },
      });
    },
    /** Ask the existing CLI for its local estimate without counting tokens. */
    getContextUsage() {
      if (!interactive || !keepAlive || !summarySupported || !contextSummaryAllowed) {
        return Promise.resolve(null);
      }
      if (contextRequest) return contextRequest.promise;
      const id = `solenta-context-${++contextRequestId}`;
      const promise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          summarySupported = false;
          finishContextRequest(null);
        }, 3000);
        timer.unref?.();
        contextRequest = { id, resolve, timer };
      });
      contextRequest.promise = promise;
      if (!writeLine({ type: "control_request", request_id: id,
        request: { subtype: "get_context_usage", detail: "summary" } })) {
        finishContextRequest(null);
      }
      return promise;
    },
    kill() {
      finishContextRequest(null);
      run.kill();
    },
    getStderr: run.getStderr,
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
