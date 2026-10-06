"use strict";

/**
 * WebSocket transport for Solenta Web. Attaches to an existing http.Server;
 * does not listen on its own.
 *
 * First client message must be {kind:"auth", token}. Anything else closes.
 * An invoke before auth-ok gets an error reply, then the socket is dropped.
 * After auth-ok, invoke is dispatched through IPC_HANDLERS (the same object
 * ipcMain registration iterates).
 *
 * Failed auth is rate-limited per remote address: past the limit the socket
 * is closed before the token is even compared. Each authed socket remembers
 * its device, so revoking a device drops its live sockets at once.
 */

const crypto = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { IPC_HANDLERS } = require("./ipc.js");

const WS_PATH = "/ws";

/**
 * @param {string} a
 * @param {string} b
 */
function tokensEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const AUTH_MAX_FAILURES = 10;
const AUTH_WINDOW_MS = 60 * 1000;
// Close code for "too many failed attempts" (4000-4999 is app-defined).
const CLOSE_RATE_LIMITED = 4429;

/**
 * Failed-auth counter per key (remote address), sliding window.
 *
 * @param {{ maxFailures?: number, windowMs?: number, now?: () => number }} [opts]
 */
function createAuthLimiter(opts = {}) {
  const maxFailures = opts.maxFailures ?? AUTH_MAX_FAILURES;
  const windowMs = opts.windowMs ?? AUTH_WINDOW_MS;
  const now = opts.now || Date.now;
  /** @type {Map<string, number[]>} */
  const fails = new Map();
  function recent(key) {
    const t = now();
    const list = (fails.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length) fails.set(key, list);
    else fails.delete(key);
    return list;
  }
  return {
    blocked(key) {
      return recent(String(key)).length >= maxFailures;
    },
    fail(key) {
      const k = String(key);
      // ponytail: crude cap so a spray of addresses cannot grow the map forever
      if (!fails.has(k) && fails.size >= 1000) fails.delete(fails.keys().next().value);
      const list = recent(k);
      list.push(now());
      fails.set(k, list);
    },
  };
}

/**
 * Accept either an authorize(token) → {id}|null function or one fixed token.
 *
 * @param {{ authorize?: (token: string) => { id: string } | null, token?: string }} opts
 */
function resolveAuthorize(opts) {
  if (opts && typeof opts.authorize === "function") return opts.authorize;
  const token = opts && opts.token;
  if (!token) throw new Error("web auth requires a token or an authorize function");
  return (presented) => (tokensEqual(presented, token) ? { id: "token" } : null);
}

/**
 * @param {import("ws").WebSocket} ws
 * @param {object} obj
 */
function sendJson(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/**
 * Attach a WS server to `httpServer` at /ws.
 *
 * @param {import("node:http").Server} httpServer
 * @param {object} opts
 * @param {string} [opts.token]  one fixed token (tests, legacy callers)
 * @param {(token: string) => ({ id: string } | null)} [opts.authorize]
 * @param {ReturnType<typeof createAuthLimiter>} [opts.limiter]
 * @param {object} opts.ctx  ctx passed as first arg to IPC_HANDLERS[channel]
 * @param {typeof IPC_HANDLERS} [opts.handlers]  defaults to the exported map
 * @param {string} [opts.path]
 * @param {number} [opts.pingIntervalMs]  heartbeat interval; default 30000
 * @param {number} [opts.maxBufferedBytes]  terminate client past this; default 4MiB
 * @returns {{
 *   wss: import("ws").WebSocketServer,
 *   broadcast: (channel: string, payload: unknown) => void,
 *   disconnect: (deviceId: string) => number,
 *   close: () => Promise<void>,
 * }}
 */
function attachWebBridge(httpServer, opts) {
  const authorize = resolveAuthorize(opts);
  const limiter = opts.limiter || createAuthLimiter();
  const ctx = opts.ctx;
  const handlers = opts.handlers || IPC_HANDLERS;
  const path = opts.path || WS_PATH;
  const pingIntervalMs = opts.pingIntervalMs ?? 30000;
  const maxBufferedBytes = opts.maxBufferedBytes ?? 4 * 1024 * 1024;

  /** Authed socket → device id. @type {Map<import("ws").WebSocket, string>} */
  const authed = new Map();

  const wss = new WebSocketServer({ server: httpServer, path });

  // ponytail: one shared ping interval for all sockets; terminate (reconnect + refetch) over per-client drop-and-resync
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, pingIntervalMs);
  interval.unref?.();

  wss.on("close", () => {
    clearInterval(interval);
  });

  wss.on("connection", (ws, req) => {
    const remote = (req && req.socket && req.socket.remoteAddress) || "unknown";
    let sawFirst = false;
    let isAuthed = false;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.close();
        return;
      }

      if (!sawFirst) {
        sawFirst = true;
        if (!msg || msg.kind !== "auth" || typeof msg.token !== "string") {
          if (msg && msg.kind === "invoke" && msg.id != null) {
            sendJson(ws, {
              kind: "reply",
              id: msg.id,
              error: "Not authenticated",
            });
          }
          ws.close();
          return;
        }
        if (limiter.blocked(remote)) {
          ws.close(CLOSE_RATE_LIMITED, "Too many failed attempts");
          return;
        }
        const device = authorize(msg.token);
        if (!device) {
          limiter.fail(remote);
          ws.close();
          return;
        }
        isAuthed = true;
        authed.set(ws, device.id);
        sendJson(ws, { kind: "auth-ok" });
        return;
      }

      if (!isAuthed) {
        if (msg && msg.kind === "invoke" && msg.id != null) {
          sendJson(ws, {
            kind: "reply",
            id: msg.id,
            error: "Not authenticated",
          });
        }
        return;
      }

      if (!msg || msg.kind !== "invoke") return;
      const id = msg.id;
      const channel = msg.channel;
      const args = Array.isArray(msg.args) ? msg.args : [];
      try {
        if (typeof channel === "string" && channel.startsWith("simulator:")) {
          sendJson(ws, {
            kind: "reply",
            id,
            error: "iOS Simulator controls require the desktop app",
          });
          return;
        }
        const fn = handlers[channel];
        if (typeof fn !== "function") {
          throw new Error(`No handler registered for '${channel}'`);
        }
        // Web has no solenta-media protocol; image handlers reply with
        // async data URLs instead of a custom-scheme src (issue #145).
        const result = await fn({ ...ctx, serveDataUrls: true, transport: "web" }, ...args);
        sendJson(ws, { kind: "reply", id, result });
      } catch (err) {
        const error = err && err.message ? String(err.message) : String(err);
        sendJson(ws, { kind: "reply", id, error });
      }
    });

    ws.on("close", () => {
      authed.delete(ws);
    });
  });

  function broadcast(channel, payload) {
    if (
      channel === "simulator:changed" ||
      channel === "simulator:focus" ||
      (typeof channel === "string" && channel.startsWith("simulator:"))
    ) {
      return;
    }
    const frame = JSON.stringify({ kind: "push", channel, payload });
    for (const client of authed.keys()) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > maxBufferedBytes) {
        authed.delete(client);
        client.terminate();
        continue;
      }
      client.send(frame);
    }
  }

  /** Terminate every socket a device authed with. Returns how many. */
  function disconnect(deviceId) {
    let n = 0;
    for (const [client, id] of authed) {
      if (id !== deviceId) continue;
      authed.delete(client);
      client.terminate();
      n++;
    }
    return n;
  }

  async function close() {
    clearInterval(interval);
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => {
      wss.close(() => resolve());
    });
  }

  return { wss, broadcast, disconnect, close };
}

module.exports = {
  attachWebBridge,
  createAuthLimiter,
  resolveAuthorize,
  tokensEqual,
  CLOSE_RATE_LIMITED,
  WS_PATH,
};
