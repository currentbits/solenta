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
 *
 * Each invoke is checked against the device's scopes (webScopes.js) here,
 * on the host, before the handler runs. A device with no scopes array gets
 * nothing but read. Pushes the device cannot see are not sent to it.
 */

const crypto = require("node:crypto");
const { isServerMaintenance, MAINTENANCE_MESSAGE } = require("./serverMaintenance.js");
const { WebSocketServer, WebSocket } = require("ws");
const { PUSH_SCOPE, allows, argsAllowed, scopeForChannel, narrowScopes } = require("./webScopes.js");

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
// Wrong or revoked token: the client stops retrying and asks for a new one.
const CLOSE_TOKEN_REJECTED = 4401;

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
 * Accept either an authorize(token) → {id, scopes}|null function or one
 * fixed token. The fixed token is the owner's own (--serve-web) and is full.
 *
 * @param {{ authorize?: (token: string) => { id: string, scopes?: string[] } | null, token?: string }} opts
 */
function resolveAuthorize(opts) {
  if (opts && typeof opts.authorize === "function") return opts.authorize;
  const token = opts && opts.token;
  if (!token) throw new Error("web auth requires a token or an authorize function");
  return (presented) =>
    tokensEqual(presented, token) ? { id: "token", scopes: ["full"] } : null;
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
  const handlers = opts.handlers || require("./ipc.js").IPC_HANDLERS;
  const path = opts.path || WS_PATH;
  const pingIntervalMs = opts.pingIntervalMs ?? 30000;
  const maxBufferedBytes = opts.maxBufferedBytes ?? 4 * 1024 * 1024;
  const now = opts.now || Date.now;

  /** Authed socket → device. @type {Map<import("ws").WebSocket, { id: string, scopes?: string[] }>} */
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
    let credential = null;
    let expiryTimer;
    function expireAt(expiresAt) {
      clearTimeout(expiryTimer);
      if (!Number.isFinite(expiresAt)) return;
      const remaining = expiresAt - now();
      if (remaining <= 0) {
        isAuthed = false;
        authed.delete(ws);
        ws.close(CLOSE_TOKEN_REJECTED, "Device session expired");
        return;
      }
      expiryTimer = setTimeout(() => expireAt(expiresAt), Math.min(remaining, 2147483647));
      expiryTimer.unref?.();
    }
    /** @type {string[] | undefined} */
    let scopes;
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
        if ((msg.computerId && msg.computerId !== opts.computer?.computerId) ||
            (msg.protocol !== undefined && msg.protocol !== 1)) {
          ws.close(4409, "Computer identity or protocol mismatch");
          return;
        }
        const device = authorize(msg.token);
        if (!device) {
          limiter.fail(remote);
          ws.close(CLOSE_TOKEN_REJECTED, "Token rejected");
          return;
        }
        isAuthed = true;
        credential = msg.token;
        scopes = device.scopes;
        authed.set(ws, device);
        expireAt(device.expiresAt);
        sendJson(ws, { kind: "auth-ok", deviceId: device.id, ...(opts.computer ? { computer: opts.computer } : {}) });
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

      if (msg?.kind === "auth-update") {
        const prior = authed.get(ws), next = typeof msg.token === "string" ? authorize(msg.token) : null;
        try {
          if (!prior || !next || prior.id !== next.id || !opts.computer || msg.computerId !== opts.computer.computerId) throw new Error();
          narrowScopes(prior.scopes, next.scopes);
        } catch { limiter.fail(remote); ws.close(CLOSE_TOKEN_REJECTED, "Device credential replacement rejected"); return; }
        credential = msg.token; scopes = next.scopes; authed.set(ws, next); expireAt(next.expiresAt);
        sendJson(ws, { kind: "auth-updated", deviceId: next.id, computer: opts.computer });
        return;
      }

      if (!msg || msg.kind !== "invoke") return;
      const current = credential && (opts.reauthorize ? opts.reauthorize(credential, authed.get(ws)) : authorize(credential));
      if (!current) {
        isAuthed = false;
        authed.delete(ws);
        ws.close(CLOSE_TOKEN_REJECTED, "Device session expired or revoked");
        return;
      }
      scopes = current.scopes;
      const id = msg.id;
      const channel = msg.channel;
      const args = Array.isArray(msg.args) ? msg.args : [];
      try {
        if (isServerMaintenance(ctx) && channel !== "app:status") {
          throw new Error(MAINTENANCE_MESSAGE);
        }
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
        const need = scopeForChannel(channel);
        if (!allows(scopes, need)) {
          throw new Error(`This device is not allowed to do that (needs ${need} access).`);
        }
        if (!argsAllowed(scopes, channel, ctx, args)) {
          throw new Error("This device is not allowed to do that (needs full access).");
        }
        // Web has no solenta-media protocol; image handlers reply with
        // async data URLs instead of a custom-scheme src (issue #145).
        const result = await fn({ ...ctx, serveDataUrls: true, transport: "web",
          cloudLocalAdmin: current.legacy === true && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) }, ...args);
        const frame = JSON.stringify({ kind: "reply", id, result });
        if (ws.readyState !== WebSocket.OPEN) return;
        // A big reply (Teleport back, #1702) legitimately sits over the
        // push buffer limit while it drains; skip pushes until it has.
        if (frame.length > maxBufferedBytes) ws.bulkReply = true;
        ws.send(frame, () => {
          ws.bulkReply = false;
        });
      } catch (err) {
        const error = err && err.message ? String(err.message) : String(err);
        sendJson(ws, { kind: "reply", id, error });
      }
    });

    ws.on("close", () => {
      clearTimeout(expiryTimer);
      credential = null;
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
    const need = PUSH_SCOPE.get(channel) || "read";
    for (const [client, device] of authed) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (Number.isFinite(device.expiresAt) && device.expiresAt <= now()) {
        authed.delete(client);
        client.close(CLOSE_TOKEN_REJECTED, "Device session expired");
        continue;
      }
      if (!allows(device.scopes, need)) continue;
      if (client.bulkReply) continue;
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
    for (const [client, device] of authed) {
      if (device.id !== deviceId) continue;
      authed.delete(client);
      client.close(CLOSE_TOKEN_REJECTED, "Device access revoked");
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
  CLOSE_TOKEN_REJECTED,
  WS_PATH,
};
