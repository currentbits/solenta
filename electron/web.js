"use strict";

/**
 * Coder Web server (Tier 3 / round 51): the SAME CoderApi channel map as
 * preload.js, carried over one HTTP+WebSocket listener.
 *
 * Bind default is 127.0.0.1. --host widens it; there is no TLS in v1.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");

/** Keep in lockstep with preload.js PUSH_CHANNELS and src/shared/wire.ts. */
const PUSH_CHANNELS = ["threads:changed", "thread:updated"];

const TOKEN_FILENAME = "coder-web-token";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

/**
 * --host help text. Printed when the operator widens the bind.
 * No TLS in v1; LAN exposure is an informed choice.
 */
const HOST_FLAG_HELP =
  "Bind address (default 127.0.0.1). There is no TLS in v1. LAN exposure is the operator's informed choice.";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Parse serve-mode flags from an argv array (process.argv).
 * Unknown flags are ignored so Electron's own switches still work.
 *
 * @param {string[]} argv
 * @returns {{ enabled: boolean, host: string, port: number }}
 */
function parseServeArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let enabled = false;
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--serve") {
      enabled = true;
      continue;
    }
    if (a === "--host" || (typeof a === "string" && a.startsWith("--host="))) {
      const val = a === "--host" ? args[++i] : a.slice("--host=".length);
      if (!val) throw new Error("--host requires an address");
      host = val;
      continue;
    }
    if (a === "--port" || (typeof a === "string" && a.startsWith("--port="))) {
      const val = a === "--port" ? args[++i] : a.slice("--port=".length);
      const n = Number(val);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`Invalid --port: ${val}`);
      }
      port = n;
    }
  }
  return { enabled, host, port };
}

/**
 * Load the serve token from next to the store, or create one.
 * crypto-random, persisted at `{userDataPath}/coder-web-token`.
 *
 * @param {string} userDataPath
 * @returns {string}
 */
function loadOrCreateToken(userDataPath) {
  if (!userDataPath) {
    throw new Error("userDataPath is required to persist the web token");
  }
  const file = path.join(userDataPath, TOKEN_FILENAME);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  const token = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // mode is best-effort on some filesystems
  }
  return token;
}

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
 * @param {string} root
 * @param {string} urlPath
 * @returns {string | null}
 */
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^\/+/, "");
  const abs = path.normalize(path.join(root, rel));
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string | null} staticDir
 */
function serveStatic(req, res, staticDir) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  if (!staticDir) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  let file = safeJoin(staticDir, req.url || "/");
  if (!file) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }
  if (stat && stat.isDirectory()) {
    file = path.join(file, "index.html");
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
  }
  if (!stat || !stat.isFile()) {
    const index = path.join(staticDir, "index.html");
    try {
      const body = fs.readFileSync(index);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    } catch {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
  }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
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
 * Start the HTTP+WS server.
 *
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} opts.token
 * @param {(channel: string, args: unknown[]) => Promise<unknown>} opts.invoke
 * @param {string | null} [opts.staticDir]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{
 *   host: string,
 *   port: number,
 *   server: import("node:http").Server,
 *   wss: import("ws").WebSocketServer,
 *   broadcast: (channel: string, payload: unknown) => void,
 *   close: () => Promise<void>,
 * }>}
 */
function startWebServer(opts) {
  const host = opts.host || DEFAULT_HOST;
  const port = opts.port == null ? DEFAULT_PORT : opts.port;
  const token = opts.token;
  const invoke = opts.invoke;
  const staticDir = opts.staticDir || null;
  const log = opts.log || (() => {});

  if (!token) throw new Error("startWebServer requires a token");

  /** @type {Set<import("ws").WebSocket>} */
  const authed = new Set();

  const server = http.createServer((req, res) => {
    serveStatic(req, res, staticDir);
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    let sawFirst = false;
    let isAuthed = false;

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
        if (typeof invoke !== "function") {
          throw new Error(`No handler registered for '${channel}'`);
        }
        const result = await invoke(channel, args);
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
    if (!PUSH_CHANNELS.includes(channel)) return;
    const frame = JSON.stringify({ kind: "push", channel, payload });
    for (const client of authed) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(frame);
      }
    }
  }

  const listening = new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    server.once("error", onErr);
    server.listen(port, host, () => {
      server.off("error", onErr);
      const addr = server.address();
      resolve({
        host: addr && addr.address ? addr.address : host,
        port: addr && typeof addr.port === "number" ? addr.port : port,
      });
    });
  });

  async function close() {
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
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return listening.then((addr) => {
    log(`coder-web: listening on http://${host}:${addr.port}`);
    return {
      host,
      port: addr.port,
      server,
      wss,
      broadcast,
      close,
    };
  });
}

module.exports = {
  PUSH_CHANNELS,
  TOKEN_FILENAME,
  HOST_FLAG_HELP,
  DEFAULT_HOST,
  DEFAULT_PORT,
  parseServeArgs,
  loadOrCreateToken,
  startWebServer,
};
