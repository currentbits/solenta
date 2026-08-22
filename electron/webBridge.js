"use strict";

/**
 * WebSocket transport for Solenta Web. Attaches to an existing http.Server;
 * does not listen on its own.
 *
 * First client message must be {kind:"auth", token}. Anything else closes.
 * An invoke before auth-ok gets an error reply, then the socket is dropped.
 * After auth-ok, invoke is dispatched through IPC_HANDLERS (the same object
 * ipcMain registration iterates).
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
 * @param {string} opts.token
 * @param {object} opts.ctx  ctx passed as first arg to IPC_HANDLERS[channel]
 * @param {typeof IPC_HANDLERS} [opts.handlers]  defaults to the exported map
 * @param {string} [opts.path]
 * @param {number} [opts.pingIntervalMs]  heartbeat interval; default 30000
 * @param {number} [opts.maxBufferedBytes]  terminate client past this; default 4MiB
 * @returns {{
 *   wss: import("ws").WebSocketServer,
 *   broadcast: (channel: string, payload: unknown) => void,
 *   close: () => Promise<void>,
 * }}
 */
function attachWebBridge(httpServer, opts) {
  const token = opts && opts.token;
  if (!token) throw new Error("attachWebBridge requires a token");
  const ctx = opts.ctx;
  const handlers = opts.handlers || IPC_HANDLERS;
  const path = opts.path || WS_PATH;
  const pingIntervalMs = opts.pingIntervalMs ?? 30000;
  const maxBufferedBytes = opts.maxBufferedBytes ?? 4 * 1024 * 1024;

  /** @type {Set<import("ws").WebSocket>} */
  const authed = new Set();

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

  wss.on("connection", (ws) => {
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
        if (!tokensEqual(msg.token, token)) {
          ws.close();
          return;
        }
        isAuthed = true;
        authed.add(ws);
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
        const fn = handlers[channel];
        if (typeof fn !== "function") {
          throw new Error(`No handler registered for '${channel}'`);
        }
        // Web has no solenta-media protocol; image handlers reply with
        // async data URLs instead of a custom-scheme src (issue #145).
        const result = await fn({ ...ctx, serveDataUrls: true }, ...args);
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
    const frame = JSON.stringify({ kind: "push", channel, payload });
    for (const client of authed) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > maxBufferedBytes) {
        authed.delete(client);
        client.terminate();
        continue;
      }
      client.send(frame);
    }
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

  return { wss, broadcast, close };
}

module.exports = {
  attachWebBridge,
  WS_PATH,
};
