/**
 * #803: the host-filtering egress proxy and the unified-log denial parser.
 * Loopback only; nothing leaves the machine.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { createProxy } = require("../seatbeltProxy.js");
const { parseDenial } = require("../seatbeltWatch.js");

const auth = (threadId) =>
  `Basic ${Buffer.from(`${encodeURIComponent(threadId)}:x`).toString("base64")}`;

/** Raw CONNECT; resolves with the proxy's status line + whether the tunnel echoes. */
function connect(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`);
    });
    let buf = "";
    let tunneled = false;
    sock.on("data", (d) => {
      buf += d;
      if (!tunneled && buf.startsWith("HTTP/1.1 200")) {
        tunneled = true;
        buf = "";
        sock.write("ping");
      } else if (tunneled && buf === "ping") {
        sock.end();
        resolve({ status: 200, echoed: true });
      } else if (!tunneled && buf.includes("\r\n\r\n")) {
        sock.end();
        resolve({ status: Number(buf.split(" ")[1]), body: buf });
      }
    });
    sock.on("error", reject);
  });
}

describe("seatbelt egress proxy", () => {
  let proxy;
  let echo;
  let web;
  const decisions = [];
  before(async () => {
    echo = net.createServer((s) => s.pipe(s)).listen(0, "127.0.0.1");
    web = http.createServer((_req, res) => res.end("hello")).listen(0, "127.0.0.1");
    await Promise.all([echo, web].map((s) => new Promise((r) => s.once("listening", r))));
    proxy = await createProxy({
      decide: (threadId, host) =>
        threadId === "T1" && host === "127.0.0.1"
          ? { allow: true, rule: null, reason: "no network rule" }
          : { allow: false, rule: "network:*", reason: "deny by profile" },
      onDecision: (threadId, host, v) => decisions.push([threadId, host, v.allow]),
    });
  });
  after(() => {
    proxy.close();
    echo.close();
    web.close();
  });

  it("tunnels an allowed CONNECT for the identified thread", async () => {
    const r = await connect(proxy.port, `127.0.0.1:${echo.address().port}`, {
      "Proxy-Authorization": auth("T1"),
    });
    assert.deepEqual(r, { status: 200, echoed: true });
    assert.deepEqual(decisions.at(-1), ["T1", "127.0.0.1", true]);
  });

  it("refuses a denied host with 403 and the rule", async () => {
    const r = await connect(proxy.port, `localhost:${echo.address().port}`, {
      "Proxy-Authorization": auth("T1"),
    });
    assert.equal(r.status, 403);
    assert.match(r.body, /seatbelt: network:\*/);
    assert.deepEqual(decisions.at(-1), ["T1", "localhost", false]);
  });

  it("refuses a connection that names no thread", async () => {
    const before = decisions.length;
    const r = await connect(proxy.port, `127.0.0.1:${echo.address().port}`);
    assert.equal(r.status, 403);
    assert.match(r.body, /proxy\.identity/);
    assert.equal(decisions.length, before);
  });

  it("forwards plain HTTP and strips the proxy credentials", async () => {
    const body = await new Promise((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port: proxy.port,
            path: `http://127.0.0.1:${web.address().port}/x`,
            headers: { "Proxy-Authorization": auth("T1") },
          },
          (res) => {
            let b = "";
            res.on("data", (d) => (b += d));
            res.on("end", () => resolve(`${res.statusCode} ${b}`));
          },
        )
        .on("error", reject);
    });
    assert.equal(body, "200 hello");
  });

  it("survives a client that resets a refused tunnel", async () => {
    await new Promise((resolve) => {
      const sock = net.connect(proxy.port, "127.0.0.1", () => {
        sock.write("CONNECT evil.test:443 HTTP/1.1\r\n\r\n");
        sock.resetAndDestroy();
        setTimeout(resolve, 50);
      });
      sock.on("error", () => {});
    });
    const r = await connect(proxy.port, `127.0.0.1:${echo.address().port}`, {
      "Proxy-Authorization": auth("T1"),
    });
    assert.equal(r.status, 200);
  });
});

describe("seatbelt denial parser", () => {
  const line = (eventMessage) => JSON.stringify({ eventMessage });

  it("attributes a tagged denial", () => {
    assert.deepEqual(
      parseDenial(line("Sandbox: bash(40040) deny(1) file-write-create /Users/me/Desktop/x\nsolenta:thr-42")),
      {
        process: "bash",
        pid: 40040,
        op: "file-write-create",
        target: "/Users/me/Desktop/x",
        threadId: "thr-42",
      },
    );
    assert.equal(
      parseDenial(line("Sandbox: curl(7) deny(1) network-outbound remote:*:443\nsolenta:T")).target,
      "remote:*:443",
    );
    assert.equal(parseDenial(line("Sandbox: node(1) deny(1) network-outbound\nsolenta:T")).target, "");
  });

  it("ignores banners, other sandboxes, and untagged lines", () => {
    assert.equal(parseDenial("Filtering the log data using …"), null);
    assert.equal(parseDenial(line("Sandbox: mobileassetd(1) deny(1) file-read-data /x")), null);
    assert.equal(
      parseDenial(line("3 duplicate reports for Sandbox: curl(7) deny(1) network-outbound")),
      null,
    );
  });
});
