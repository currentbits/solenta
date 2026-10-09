"use strict";

/** Solenta Web device scopes (#1530): the table, the bridge check, pushes. */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const { WebSocket } = require("ws");

// ipc.js requires("electron") at load; same stub as web.test.js.
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

const { IPC_HANDLERS } = require("../ipc.js");
const { BY_SCOPE, SCOPES, PRESETS, allows, sanitizeScopes, scopeForChannel } = require("../webScopes.js");
const { attachWebBridge, WS_PATH } = require("../webBridge.js");
const { createWebDevices } = require("../webDevices.js");

describe("scope table", () => {
  it("classifies every IPC handler exactly once and names no stale channel", () => {
    const seen = new Map();
    for (const [scope, channels] of Object.entries(BY_SCOPE)) {
      assert.ok(SCOPES.includes(scope), scope);
      for (const ch of channels) {
        assert.equal(seen.has(ch), false, `${ch} listed under ${seen.get(ch)} and ${scope}`);
        seen.set(ch, scope);
      }
    }
    // simulator:* is refused by the bridge before the scope check.
    const handlers = Object.keys(IPC_HANDLERS).filter((c) => !c.startsWith("simulator:"));
    const unclassified = handlers.filter((c) => !seen.has(c));
    assert.deepEqual(unclassified, [], "classify new channels in webScopes.js");
    const stale = [...seen.keys()].filter((c) => !(c in IPC_HANDLERS));
    assert.deepEqual(stale, []);
  });

  it("unknown channels need full; web:* settings never leave the desktop", () => {
    assert.equal(scopeForChannel("nope:nothing"), "full");
    assert.equal(scopeForChannel("web:addDevice"), "full");
    assert.equal(scopeForChannel("pairing:create"), "full");
    assert.equal(scopeForChannel("mcp:save"), "full");
  });

  it("allows: read always, full everything, type implies observe", () => {
    assert.equal(allows(undefined, "read"), true);
    assert.equal(allows(undefined, "steer"), false);
    assert.equal(allows(PRESETS.read, "steer"), false);
    assert.equal(allows(PRESETS.steer, "steer"), true);
    assert.equal(allows(PRESETS.steer, "git"), false);
    assert.equal(allows(PRESETS.full, "git"), true);
    assert.equal(allows(["read", "terminal:type"], "terminal:observe"), true);
    assert.equal(allows(["read", "terminal:observe"], "terminal:type"), false);
  });

  it("sanitizeScopes drops junk, keeps read, collapses full", () => {
    assert.deepEqual(sanitizeScopes(undefined), ["read"]);
    assert.deepEqual(sanitizeScopes(["steer", "root", "git"]), ["read", "steer", "git"]);
    assert.deepEqual(sanitizeScopes(["steer", "full"]), ["full"]);
  });
});

describe("device rows carry scopes", () => {
  function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "web-scopes-"));
  }

  it("new devices default to read only and authorize returns their scopes", () => {
    const devices = createWebDevices(tmpDir());
    const plain = devices.add({ name: "Phone" });
    assert.deepEqual(plain.device.scopes, ["read"]);
    const steer = devices.add({ name: "Tablet", scopes: ["read", "steer", "git"] });
    assert.deepEqual(devices.authorize(steer.token).scopes, ["read", "steer", "git"]);
  });

  it("rows saved before scopes existed, and the legacy token, stay full", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "web-access.json"),
      JSON.stringify({ devices: [{ id: "old", name: "Old", tokenHash: "a".repeat(64), createdAt: 1 }] }),
    );
    fs.writeFileSync(path.join(dir, "web-token"), "legacy-token");
    const devices = createWebDevices(dir);
    assert.deepEqual(devices.list().find((d) => d.id === "old").scopes, ["full"]);
    assert.deepEqual(devices.authorize("legacy-token").scopes, ["full"]);
  });
});

describe("bridge enforces scopes on the host", () => {
  const TOKENS = {
    "t-read": { id: "read", scopes: ["read"] },
    "t-steer": { id: "steer", scopes: ["read", "steer"] },
    "t-term": { id: "term", scopes: ["read", "terminal:type"] },
    "t-none": { id: "none" },
  };

  async function listen() {
    const called = [];
    const handlers = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string") return undefined;
          return async () => {
            called.push(prop);
            return "ok";
          };
        },
      },
    );
    const httpServer = http.createServer();
    await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
    const bridge = attachWebBridge(httpServer, {
      authorize: (t) => TOKENS[t] || null,
      ctx: {},
      handlers,
    });
    const { port } = httpServer.address();
    const close = async () => {
      await bridge.close();
      await new Promise((r) => httpServer.close(r));
    };
    return { bridge, called, close, url: `ws://127.0.0.1:${port}${WS_PATH}` };
  }

  async function client(url, token) {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    ws.on("message", (d) => {
      const msg = JSON.parse(String(d));
      const w = waiters.shift();
      if (w) w(msg);
      else inbox.push(msg);
    });
    await new Promise((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    const next = () =>
      inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r));
    ws.send(JSON.stringify({ kind: "auth", token }));
    assert.deepEqual(await next(), { kind: "auth-ok" });
    let id = 0;
    const invoke = async (channel) => {
      ws.send(JSON.stringify({ kind: "invoke", id: ++id, channel, args: [] }));
      return next();
    };
    return { ws, invoke, inbox };
  }

  it("read-only device reads but cannot start runs, mint pairings or commit", async () => {
    const s = await listen();
    try {
      const c = await client(s.url, "t-read");
      assert.equal((await c.invoke("threads:list")).result, "ok");
      for (const ch of ["runs:start", "pairing:create", "git:commit", "unknown:channel"]) {
        const reply = await c.invoke(ch);
        assert.match(reply.error, /not allowed/, ch);
      }
      assert.deepEqual(s.called, ["threads:list"]);
      c.ws.close();
    } finally {
      await s.close();
    }
  });

  it("steer may run threads but not push git; a scope-less device is read only", async () => {
    const s = await listen();
    try {
      const steer = await client(s.url, "t-steer");
      assert.equal((await steer.invoke("runs:start")).result, "ok");
      assert.match((await steer.invoke("git:push")).error, /needs git access/);
      const none = await client(s.url, "t-none");
      assert.equal((await none.invoke("threads:get")).result, "ok");
      assert.match((await none.invoke("runs:steer")).error, /not allowed/);
      steer.ws.close();
      none.ws.close();
    } finally {
      await s.close();
    }
  });

  it("terminal:data reaches only devices with terminal access", async () => {
    const s = await listen();
    try {
      const reader = await client(s.url, "t-read");
      const term = await client(s.url, "t-term");
      assert.equal((await term.invoke("terminal:write")).result, "ok");
      s.bridge.broadcast("terminal:data", { id: "x", data: "secret" });
      s.bridge.broadcast("threads:changed", []);
      await new Promise((r) => setTimeout(r, 40));
      assert.deepEqual(reader.inbox.map((m) => m.channel), ["threads:changed"]);
      assert.deepEqual(term.inbox.map((m) => m.channel), ["terminal:data", "threads:changed"]);
      reader.ws.close();
      term.ws.close();
    } finally {
      await s.close();
    }
  });
});
