"use strict";

/**
 * Host-filtering egress proxy for Seatbelt-wrapped CLIs (#803).
 *
 * Seatbelt cannot match hostnames, so a wrapped CLI with network rules gets
 * outbound IP denied except loopback, and HTTP(S)_PROXY pointing here. This
 * proxy applies the matrix's network rules per host: block/deny refuse,
 * everything else tunnels (ask cannot prompt mid-connection; the tool layer
 * already asked). A tool that ignores the proxy env hits the kernel deny.
 *
 * One proxy for the app, bound to 127.0.0.1 on an ephemeral port and
 * started when the runner is created (spawn paths are synchronous, so the
 * port must already be known). The thread rides the proxy URL's userinfo
 * (`http://<threadId>@127.0.0.1:port` → Proxy-Authorization); a connection
 * without one is refused. The policy is read per connection, so a profile
 * edit applies without a respawn.
 */

const http = require("node:http");
const net = require("node:net");

/** @type {{ port: number, close: () => void } | null} */
let shared = null;

/** "host:port" (CONNECT target) → host, port. IPv6 in brackets. */
function splitTarget(target, defaultPort) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(target) || /^([^:]+)(?::(\d+))?$/.exec(target);
  if (!m) return null;
  return { host: m[1].toLowerCase(), port: Number(m[2] || defaultPort) };
}

/** Thread id from `Proxy-Authorization: Basic base64(threadId:)`. */
function threadOf(req) {
  const m = /^Basic\s+(\S+)/i.exec(String(req.headers["proxy-authorization"] || ""));
  if (!m) return null;
  const user = Buffer.from(m[1], "base64").toString("utf8").split(":")[0];
  return user ? decodeURIComponent(user) : null;
}

/**
 * @param {{
 *   decide: (threadId: string, host: string) => { allow: boolean, rule: string | null, reason: string },
 *   onDecision?: (threadId: string, host: string, verdict: { allow: boolean, rule: string | null, reason: string }) => void,
 * }} opts
 * @returns {Promise<{ port: number, close: () => void }>}
 */
function createProxy(opts) {
  const judge = (req, host) => {
    const threadId = threadOf(req);
    let verdict;
    try {
      verdict = threadId
        ? opts.decide(threadId, host)
        : { allow: false, rule: "proxy.identity", reason: "no thread on the proxy URL" };
    } catch (err) {
      // Fail closed: a policy bug must not open egress.
      verdict = { allow: false, rule: "governance.error", reason: String(err && err.message) };
    }
    if (opts.onDecision) {
      try {
        if (threadId) opts.onDecision(threadId, host, verdict);
      } catch {
        /* audit must never break the tunnel */
      }
    }
    return verdict;
  };

  const server = http.createServer((req, res) => {
    req.on("error", () => res.destroy());
    // Plain-HTTP proxying: absolute-form request line.
    let url;
    try {
      url = new URL(req.url || "");
    } catch {
      res.writeHead(400).end("Solenta proxy: absolute URL required\n");
      return;
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const verdict = judge(req, host);
    if (!verdict.allow) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`Blocked by Solenta policy (seatbelt: ${verdict.rule}): ${host}\n`);
      return;
    }
    const headers = { ...req.headers, host: url.host };
    delete headers["proxy-authorization"];
    const upstream = http.request(
      {
        host,
        port: Number(url.port || 80),
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on("clientError", (_err, socket) => socket.destroy());

  server.on("connect", (req, socket, head) => {
    // First: a client reset on a refused tunnel must not throw in main.
    socket.on("error", () => socket.destroy());
    const target = splitTarget(String(req.url || ""), 443);
    if (!target) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const verdict = judge(req, target.host);
    if (!verdict.allow) {
      socket.end(
        `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBlocked by Solenta policy (seatbelt: ${verdict.rule}): ${target.host}\n`,
      );
      return;
    }
    const upstream = net.connect(target.port, target.host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => {
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => server.close(),
      });
    });
  });
}

let starting = null;
/** Latest runner's handlers: the proxy outlives a test's runner. */
let handlers = null;

/**
 * Start the app's proxy once. Idempotent; resolves to its port.
 * @param {Parameters<typeof createProxy>[0]} opts
 */
function startSharedProxy(opts) {
  handlers = opts;
  if (!starting) {
    starting = createProxy({
      decide: (t, h) => handlers.decide(t, h),
      onDecision: (t, h, v) => handlers.onDecision && handlers.onDecision(t, h, v),
    }).then((p) => {
      shared = p;
      return p.port;
    });
    starting.catch(() => {
      starting = null;
    });
  }
  return starting;
}

/** Port of the running shared proxy, or null before it is listening. */
function sharedProxyPort() {
  return shared ? shared.port : null;
}

function stopSharedProxy() {
  if (shared) shared.close();
  shared = null;
  starting = null;
}

module.exports = {
  createProxy,
  startSharedProxy,
  sharedProxyPort,
  stopSharedProxy,
};
