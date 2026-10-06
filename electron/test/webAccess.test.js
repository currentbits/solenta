"use strict";

/**
 * Solenta Web access (#1512 I2) security properties, against a real server:
 * loopback unless asked, revoke mid-session, failed-auth rate limit,
 * constant-time token match, and the Tailscale Serve helper (fake CLI).
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const { WebSocket } = require("ws");

// webBridge → ipc.js requires("electron") at load.
{
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return {
        ipcMain: { handle() {} },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        shell: {},
        app: { getPath: () => os.tmpdir() },
      };
    }
    return origLoad.apply(this, arguments);
  };
}

const { startWebServer } = require("../webServer.js");
const { WS_PATH, CLOSE_RATE_LIMITED, createAuthLimiter } = require("../webBridge.js");
const { createWebDevices } = require("../webDevices.js");
const { createWebAccess, listenUrls } = require("../webAccess.js");

const IFACES = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [
    { address: "192.168.1.20", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
  ],
};

function socket(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Auth and resolve with "ok" or the close code. */
function auth(port, token) {
  return socket(port).then(
    (ws) =>
      new Promise((resolve) => {
        ws.once("message", (data) => {
          if (JSON.parse(String(data)).kind === "auth-ok") resolve({ ws, result: "ok" });
        });
        ws.once("close", (code) => resolve({ ws, result: code }));
        ws.send(JSON.stringify({ kind: "auth", token }));
      }),
  );
}

function closed(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) resolve();
    else ws.once("close", () => resolve());
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

describe("webAccess", () => {
  let tmp;
  let devices;
  let access;
  let calls;
  let tsState;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-web-access-"));
    const artifact = path.join(tmp, "a.txt");
    fs.writeFileSync(artifact, "hi");
    devices = createWebDevices(tmp);
    calls = [];
    tsState = { installed: true, backend: "Running", serve: {} };
    access = createWebAccess({
      devices,
      defaultPort: 0,
      networkInterfaces: () => IFACES,
      startServer: (opts) =>
        startWebServer({
          ...opts,
          ctx: {},
          handlers: { "echo:ping": async () => "pong" },
          artifactStore: {
            open: async () => ({ info: { mimeType: "text/plain" }, size: 2, path: artifact }),
          },
        }),
      exec: async (bin, args) => {
        calls.push([bin, ...args]);
        if (!tsState.installed) throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
        if (args[0] === "version") return { stdout: "1.0", stderr: "" };
        if (args[0] === "status") {
          return {
            stdout: JSON.stringify({
              BackendState: tsState.backend,
              Self: { DNSName: "mac.tail1.ts.net." },
            }),
            stderr: "",
          };
        }
        if (args[0] === "serve" && args[1] === "status") {
          return { stdout: JSON.stringify(tsState.serve), stderr: "" };
        }
        if (args[0] === "serve" && args.includes("off")) {
          tsState.serve = {};
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "serve") {
          tsState.serve = {
            Web: { "mac.tail1.ts.net:443": { Handlers: { "/": { Proxy: args.at(-1) } } } },
          };
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected ${args.join(" ")}`);
      },
    });
  });

  afterEach(async () => {
    await access.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("binds loopback unless the user turns on network access", async () => {
    let st = await access.setEnabled({ enabled: true });
    assert.equal(st.running, true);
    assert.equal(st.lan, false);
    assert.deepEqual(st.urls.map((u) => u.kind), ["local"]);
    assert.match(st.urls[0].url, /^http:\/\/127\.0\.0\.1:\d+$/);

    st = await access.setEnabled({ enabled: true, lan: true });
    assert.equal(st.lan, true);
    assert.deepEqual(
      st.urls.map((u) => u.url.replace(/:\d+$/, "")),
      ["http://127.0.0.1", "http://192.168.1.20"],
    );
    assert.deepEqual(devices.server(), { enabled: true, lan: true });

    st = await access.setEnabled({ enabled: false });
    assert.equal(st.running, false);
    assert.deepEqual(st.urls, []);
    assert.deepEqual(devices.server(), { enabled: false, lan: true });
  });

  it("restore() starts on loopback only when the switch was left on", async () => {
    await access.restore();
    assert.equal(access.isRunning(), false);
    devices.setServer({ enabled: true });
    await access.restore();
    const st = await access.status();
    assert.deepEqual(st.urls.map((u) => u.kind), ["local"]);
  });

  it("listenUrls never offers a LAN address for a loopback bind", () => {
    assert.deepEqual(listenUrls("127.0.0.1", 1, IFACES), [
      { kind: "local", url: "http://127.0.0.1:1" },
    ]);
    assert.deepEqual(listenUrls("10.0.0.4", 1, IFACES), [
      { kind: "lan", url: "http://10.0.0.4:1" },
    ]);
  });

  it("revoke disconnects that device's live sockets, and only those", async () => {
    const st = await access.setEnabled({ enabled: true });
    const port = Number(st.urls[0].url.split(":").at(-1));
    const phone = await access.addDevice({ name: "Phone" });
    const laptop = await access.addDevice({ name: "Laptop" });
    const a = await auth(port, phone.token);
    const b = await auth(port, laptop.token);
    assert.equal(a.result, "ok");
    assert.equal(b.result, "ok");
    const artifactUrl = (token) =>
      `http://127.0.0.1:${port}/api/run-artifacts/t1/a1?token=${encodeURIComponent(token)}`;
    assert.equal(await get(artifactUrl(phone.token)), 200);

    await access.revokeDevice({ id: phone.device.id });
    await closed(a.ws);
    assert.equal(b.ws.readyState, WebSocket.OPEN, "other devices stay connected");

    const again = await auth(port, phone.token);
    assert.notEqual(again.result, "ok", "revoked token cannot re-auth");
    assert.equal(await get(artifactUrl(phone.token)), 401, "revoked token loses artifact links");
    assert.equal(await get(artifactUrl(laptop.token)), 200);
    b.ws.close();
  });

  it("rate-limits failed auth per address, even a later correct token", async () => {
    const st = await access.setEnabled({ enabled: true });
    const port = Number(st.urls[0].url.split(":").at(-1));
    const { token } = await access.addDevice({ name: "Phone" });
    for (let i = 0; i < 10; i++) {
      const r = await auth(port, `wrong-${i}`);
      assert.notEqual(r.result, "ok");
      assert.notEqual(r.result, CLOSE_RATE_LIMITED);
    }
    const blocked = await auth(port, token);
    assert.equal(blocked.result, CLOSE_RATE_LIMITED);
    assert.equal(
      await get(`http://127.0.0.1:${port}/api/run-artifacts/t/a?token=${token}`),
      429,
      "the artifact route shares the limiter",
    );
  });

  it("the limiter forgets failures after its window", () => {
    let t = 0;
    const limiter = createAuthLimiter({ maxFailures: 2, windowMs: 1000, now: () => t });
    limiter.fail("ip");
    limiter.fail("ip");
    assert.equal(limiter.blocked("ip"), true);
    assert.equal(limiter.blocked("other"), false);
    t = 1001;
    assert.equal(limiter.blocked("ip"), false);
  });

  it("token match is constant-time: one timingSafeEqual per device, hit or miss", () => {
    const tokens = [1, 2, 3].map((i) => devices.add({ name: `D${i}` }).token);
    const orig = crypto.timingSafeEqual;
    let n = 0;
    crypto.timingSafeEqual = (a, b) => {
      n++;
      assert.equal(a.length, 32, "compares fixed-length digests, never raw tokens");
      return orig(a, b);
    };
    try {
      for (const presented of [tokens[0], tokens[2], "miss", "x".repeat(5000)]) {
        n = 0;
        devices.authorize(presented);
        assert.equal(n, 3, `scan does not stop early for ${presented.slice(0, 6)}`);
      }
    } finally {
      crypto.timingSafeEqual = orig;
    }
  });

  it("tailscale: reports not installed without trying to install", async () => {
    tsState.installed = false;
    const st = await access.status();
    assert.equal(st.tailscale.installed, false);
    assert.ok(calls.every((c) => c[1] === "version"), "only probes, never installs");
  });

  it("tailscale: needs a logged-in daemon and a running server", async () => {
    tsState.backend = "NeedsLogin";
    assert.equal((await access.status()).tailscale.loggedIn, false);
    await assert.rejects(access.setTailscale({ on: true }), /not running or not logged in/);
    tsState.backend = "Running";
    await assert.rejects(access.setTailscale({ on: true }), /Turn on Solenta Web first/);
  });

  it("tailscale: serves loopback over HTTPS, reports the URL, and stops", async () => {
    const st = await access.setEnabled({ enabled: true });
    const port = st.port;
    const on = await access.setTailscale({ on: true });
    assert.deepEqual(
      calls.find((c) => c.includes("--bg")).slice(1),
      ["serve", "--bg", "--yes", "--https=443", `http://127.0.0.1:${port}`],
    );
    assert.equal(on.serving, true);
    assert.equal(on.url, "https://mac.tail1.ts.net");
    assert.equal((await access.status()).lan, false, "Serve never needs the LAN bind");

    const off = await access.setTailscale({ on: false });
    assert.equal(off.serving, false);
  });

  it("tailscale: refuses to replace another HTTPS root, and turning Web off stops Serve", async () => {
    await access.setEnabled({ enabled: true });
    tsState.serve = {
      Web: { "mac.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
    };
    await assert.rejects(access.setTailscale({ on: true }), /already sends HTTPS to http:\/\/127\.0\.0\.1:3000/);

    tsState.serve = {};
    await access.setTailscale({ on: true });
    await access.setEnabled({ enabled: false });
    assert.deepEqual(tsState.serve, {}, "no tailnet URL left pointing at a closed port");
  });
});
