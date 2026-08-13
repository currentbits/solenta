"use strict";

/**
 * HTTP static server for Solenta Web, plus the --serve-web flag parser.
 *
 * Binding: 127.0.0.1 by default. --serve-host widens it.
 * There is no TLS in v1. Opening the bind beyond loopback puts the
 * token-gated API on the LAN; that is the operator's informed choice.
 *
 * Requiring this module creates ZERO listeners. Listeners exist only
 * after startWebServer() is called (main.js does that solely when
 * --serve-web is present).
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { attachWebBridge, WS_PATH } = require("./webBridge.js");

const TOKEN_FILENAME = "web-token";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4620;

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
 * @param {string[]} argv
 * @returns {{ enabled: boolean, host: string, port: number }}
 */
function parseServeWebArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let enabled = false;
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--serve-web") {
      enabled = true;
      continue;
    }
    if (typeof a === "string" && a.startsWith("--serve-web=")) {
      enabled = true;
      port = parsePort(a.slice("--serve-web=".length));
      continue;
    }
    if (a === "--serve-host" || (typeof a === "string" && a.startsWith("--serve-host="))) {
      const val = a === "--serve-host" ? args[++i] : a.slice("--serve-host=".length);
      if (!val) throw new Error("--serve-host requires an address");
      host = val;
    }
  }
  return { enabled, host, port };
}

/**
 * @param {string} raw
 */
function parsePort(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid --serve-web port: ${raw}`);
  }
  return n;
}

/**
 * Load or create `{userDataPath}/web-token` (mode 0600).
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
 * Start HTTP (static dist/) + WS at /ws on the same port.
 * Does nothing unless the caller invokes this function.
 *
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} opts.token
 * @param {object} opts.ctx
 * @param {object} [opts.handlers]
 * @param {string | null} [opts.staticDir]
 * @param {(msg: string) => void} [opts.log]
 */
function startWebServer(opts) {
  const host = (opts && opts.host) || DEFAULT_HOST;
  const port = opts && opts.port != null ? opts.port : DEFAULT_PORT;
  const token = opts && opts.token;
  const ctx = opts && opts.ctx;
  const staticDir = (opts && opts.staticDir) || null;
  const log = (opts && opts.log) || (() => {});

  if (!token) throw new Error("startWebServer requires a token");

  // No TLS. Default bind is loopback. --serve-host is an informed LAN choice.
  const server = http.createServer((req, res) => {
    serveStatic(req, res, staticDir);
  });

  const bridge = attachWebBridge(server, {
    token,
    ctx,
    handlers: opts.handlers,
    path: WS_PATH,
  });

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
    await bridge.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return listening.then((addr) => {
    log(`solenta-web: listening on http://${host}:${addr.port}`);
    return {
      host,
      port: addr.port,
      server,
      bridge,
      broadcast: bridge.broadcast,
      close,
    };
  });
}

module.exports = {
  TOKEN_FILENAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
  HOST_FLAG_HELP,
  parseServeWebArgs,
  loadOrCreateToken,
  startWebServer,
};
