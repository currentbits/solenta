"use strict";

/**
 * Long-lived JSON-RPC 2.0 over stdio for `codex app-server --listen stdio://`
 * (issue #1171). Bidirectional: client-initiated requests are matched by
 * id; inbound ServerRequests go to `onServerRequest`. Unknown methods
 * fail closed with JSON-RPC -32601. This is the reply path #1170 will
 * attach; it does not implement turn/steer.
 *
 * Distinct from `providerUsage.runStdioJsonRpc`, which only matches
 * handshake/match ids and always kills the child.
 */

const spawn = require("cross-spawn");
const { killTree, agentSpawnOptions } = require("./proc.js");
const { JSONRPC_METHOD_NOT_FOUND } = require("./codexApprovals.js");

const SIGKILL_AFTER_MS = 3000;
const STDERR_TAIL_CHARS = 64 * 1024;

function parseJsonLine(line) {
  const s = String(line || "").trim();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.binary
 * @param {string[]} [opts.args]
 * @param {string} [opts.cwd]
 * @param {Record<string, string>} [opts.envExtra]
 * @param {(req: { id: unknown, method: string, params: unknown }) => boolean | void} [opts.onServerRequest]
 *   Return true if this request is handled (replied now, or will be).
 *   False/void → method-not-found.
 * @param {(note: { method: string, params: unknown }) => void} [opts.onNotification]
 * @param {(err: Error) => void} [opts.onError]
 * @param {(info: { code: number | null, stderr: string }) => void} [opts.onExit]
 * @param {typeof spawn} [opts.spawn]
 * @returns {{
 *   request: (method: string, params?: unknown) => Promise<unknown>,
 *   notify: (method: string, params?: unknown) => void,
 *   respondJsonRpc: (id: unknown, result: unknown) => boolean,
 *   respondJsonRpcError: (id: unknown, error: { code?: number, message?: string }) => boolean,
 *   cancelOutstanding: (decision?: string) => void,
 *   outstandingIds: () => unknown[],
 *   kill: () => void,
 * }}
 */
function createCodexJsonRpcSession(opts) {
  const {
    binary = process.env.CODER_CODEX_BIN || "codex",
    args = ["app-server", "--listen", "stdio://"],
    cwd,
    envExtra,
    onServerRequest,
    onNotification,
    onError,
    onExit,
  } = opts;
  const spawnFn = opts.spawn || spawn;

  let stderrText = "";
  let lineBuf = "";
  let finished = false;
  let killed = false;
  let stdinFailed = false;
  let killTimer = null;
  let nextId = 1;
  /** @type {Map<unknown, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  /** Inbound ServerRequest ids we have not answered yet. */
  /** @type {Set<unknown>} */
  const inbound = new Set();

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
    const err = new Error("Codex app-server closed");
    for (const waiter of pending.values()) {
      try {
        waiter.reject(err);
      } catch {
        // ignore
      }
    }
    pending.clear();
    inbound.clear();
    if (typeof onExit === "function") {
      onExit({ code, stderr: stderrText });
    }
  }

  /**
   * Stdin died while the child is still up. Reject in-flight requests now
   * and report the error. Exit stays the child's real close. After
   * kill/finish the same EPIPE is expected and must not surface.
   * @param {Error | { message?: string, code?: string }} err
   */
  function noteStdinError(err) {
    if (killed || finished || stdinFailed) return;
    stdinFailed = true;
    const error =
      err instanceof Error
        ? err
        : new Error(
            String((err && err.message) || "Codex app-server stdin closed"),
          );
    const waiters = [...pending.values()];
    pending.clear();
    for (const waiter of waiters) {
      try {
        waiter.reject(error);
      } catch {
        // ignore
      }
    }
    if (typeof onError === "function") {
      try {
        onError(error);
      } catch {
        // ignore
      }
    }
  }

  function write(obj) {
    if (
      killed ||
      finished ||
      stdinFailed ||
      !child ||
      !child.stdin ||
      child.stdin.destroyed
    ) {
      return false;
    }
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch (err) {
      noteStdinError(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  function respondJsonRpc(id, result) {
    if (id === undefined || id === null) return false;
    if (!inbound.has(id)) return false;
    inbound.delete(id);
    return write({ jsonrpc: "2.0", id, result });
  }

  function respondJsonRpcError(id, error) {
    if (id === undefined || id === null) return false;
    if (!inbound.has(id)) return false;
    inbound.delete(id);
    const err =
      error && typeof error === "object"
        ? {
            code:
              typeof error.code === "number"
                ? error.code
                : JSONRPC_METHOD_NOT_FOUND,
            message:
              typeof error.message === "string"
                ? error.message
                : "Unsupported ServerRequest",
          }
        : {
            code: JSONRPC_METHOD_NOT_FOUND,
            message: String(error || "Unsupported ServerRequest"),
          };
    return write({ jsonrpc: "2.0", id, error: err });
  }

  function failClosed(id, method) {
    respondJsonRpcError(id, {
      code: JSONRPC_METHOD_NOT_FOUND,
      message: `Unsupported ServerRequest: ${method || "unknown"}`,
    });
  }

  function handleLine(line) {
    const msg = parseJsonLine(line);
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;

    const id = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;
    const method = typeof msg.method === "string" ? msg.method : "";

    if (id !== undefined && id !== null && pending.has(id)) {
      const waiter = pending.get(id);
      pending.delete(id);
      if (msg.error) {
        const text =
          msg.error && typeof msg.error === "object" && msg.error.message
            ? String(msg.error.message)
            : "JSON-RPC error";
        waiter.reject(new Error(text));
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    if (method && (id === undefined || id === null)) {
      if (typeof onNotification === "function") {
        try {
          onNotification({ method, params: msg.params });
        } catch {
          // defensive
        }
      }
      return;
    }

    if (method && id !== undefined && id !== null) {
      inbound.add(id);
      let handled = false;
      if (typeof onServerRequest === "function") {
        try {
          handled = onServerRequest({ id, method, params: msg.params }) === true;
        } catch {
          handled = false;
        }
      }
      if (!handled && inbound.has(id)) failClosed(id, method);
      return;
    }
  }

  let child;
  try {
    child = spawnFn(
      binary,
      args,
      agentSpawnOptions({
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: envExtra ? { ...process.env, ...envExtra } : undefined,
      }),
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (typeof onError === "function") onError(error);
    if (typeof onExit === "function") {
      onExit({ code: 1, stderr: error.message });
    }
    return {
      request() {
        return Promise.reject(error);
      },
      notify() {},
      respondJsonRpc() {
        return false;
      },
      respondJsonRpcError() {
        return false;
      },
      cancelOutstanding() {},
      outstandingIds() {
        return [];
      },
      kill() {},
    };
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  // Async EPIPE. A no-op listener keeps the process alive but leaves the
  // in-flight request pending until the child eventually closes.
  if (child.stdin) {
    child.stdin.on("error", (err) => {
      noteStdinError(err);
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
    request(method, params) {
      if (finished || killed) {
        return Promise.reject(new Error("Codex app-server closed"));
      }
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        if (
          !write({
            jsonrpc: "2.0",
            id,
            method: String(method),
            params: params === undefined ? {} : params,
          })
        ) {
          pending.delete(id);
          reject(new Error("Codex app-server stdin closed"));
        }
      });
    },
    notify(method, params) {
      write({
        jsonrpc: "2.0",
        method: String(method),
        params: params === undefined ? {} : params,
      });
    },
    respondJsonRpc,
    respondJsonRpcError,
    cancelOutstanding(decision) {
      const ids = [...inbound];
      inbound.clear();
      const result = { decision: decision || "cancel" };
      for (const id of ids) {
        write({ jsonrpc: "2.0", id, result });
      }
    },
    outstandingIds() {
      return [...inbound];
    },
    pid: child && child.pid,
    kill() {
      if (killed || finished) return;
      killed = true;
      try {
        if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      } catch {
        // ignore
      }
      killTimer = killTree(child, SIGKILL_AFTER_MS);
    },
  };
}

module.exports = {
  createCodexJsonRpcSession,
  parseJsonLine,
  SIGKILL_AFTER_MS,
};
