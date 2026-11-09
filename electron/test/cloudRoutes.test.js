"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { openRemoteConnection, openHostTunnel, invokeRemote, closeRemoteConnections } = require("../remoteConnections");

function fixture(t) {
  const windows = [], tracked = [], probes = [], requests = [];
  const computer = { kind: "solenta", computerId: "cloud-computer-123", runtimeKind: "server", protocol: { min: 1, max: 1 }, version: "0.29.0" };
  const session = { computerId: computer.computerId, deviceId: "device-123", accountId: "user_test", origin: "https://fresh.host.example.com", token: "short-lived-host-token", scopes: ["read"], computer };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; windows.push(this);
      this.webContents = new EventEmitter(); this.webContents.id = windows.length;
      this.webContents.setWindowOpenHandler = () => {};
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed === true; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    show() {}
    focus() {}
  }
  let listener;
  const client = { status: () => ({ signedIn: true, accountId: "user_test" }), session: async id => { requests.push(id); return session; }, subscribe: callback => { listener = callback; return () => { listener = null; }; } };
  const deps = { cloudClient: client, cloudWindows: { track: (...args) => tracked.push(args) }, electron: { BrowserWindow: Window, shell: { openExternal() {} } },
    tokens: { get: () => assert.fail("cloud credentials never use the direct-token store"), set: () => assert.fail("cloud credentials never reach the direct-token store"), delete: () => assert.fail("cloud setup must not delete direct credentials") },
    probeToken: async (url, token) => { probes.push([url, token]); return computer; }, inspectHost: async () => ({ version: "0.29.0" }), localVersion: "0.29.0",
    spawn: () => assert.fail("cloud connections must not launch SSH"),
  };
  t.after(closeRemoteConnections);
  return { deps, client, session, windows, tracked, probes, requests, emit: event => listener?.(event), cloud: { accountId: "user_test", computerId: computer.computerId, scopes: ["read"] } };
}

test("cloud desktop windows receive credentials through the private preload, with no token URL or keychain write", async t => {
  const f = fixture(t);
  const result = await openRemoteConnection({ cloud: f.cloud, host: "", token: "", label: "Cloud host" }, f.deps);
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].url, `${f.session.origin}/`);
  assert.match(f.windows[0].options.webPreferences.preload, /cloud[/\\]windowPreload\.js$/);
  assert.equal(f.windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(f.tracked[0][1], f.client);
  assert.equal(f.tracked[0][2].deviceId, f.session.deviceId);
  assert.equal(result.computerId, f.cloud.computerId);
  assert.deepEqual(result.cloud, f.cloud);
  assert.equal(result.tokenSaved, false);
});

test("cloud tunnels resolve the current account session rather than trusting a saved URL or token", async t => {
  const f = fixture(t);
  const tunnel = await openHostTunnel({ cloud: f.cloud, host: "ignored", remotePort: 4620, url: "https://stale.example.com", token: "never-use" }, f.deps);
  assert.equal(tunnel.wsUrl, "wss://fresh.host.example.com/ws");
  assert.deepEqual(f.requests, [f.cloud.computerId]);
  assert.deepEqual(f.probes, [[f.session.origin, f.session.token]]);
  const updates = [], unsubscribe = tunnel.subscribeCredentials(value => updates.push(value));
  t.after(unsubscribe);
  f.emit({ type: "session", computerId: f.cloud.computerId, session: { ...f.session, token: "rotated-token" } });
  assert.equal(updates[0].token, "rotated-token");
  f.emit({ type: "expired", computerId: f.cloud.computerId });
  assert.equal(updates[1], null);
});

test("a saved cloud route cannot request credentials from a different signed-in account", async t => {
  const f = fixture(t);
  await assert.rejects(openHostTunnel({ cloud: { ...f.cloud, accountId: "different-user" }, host: "ignored", remotePort: 443 }, f.deps), /account|sign in/i);
  assert.equal(f.requests.length, 0);
  assert.equal(f.probes.length, 0);
});

test("a long cloud RPC refreshes its socket credential before receiving its original reply", async t => {
  const f = fixture(t), messages = [];
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.emit("open")); }
    send(raw) {
      const msg = JSON.parse(raw); messages.push(msg.kind);
      if (msg.kind === "auth") queueMicrotask(() => this.emit("message", JSON.stringify({ kind: "auth-ok", computer: f.session.computer })));
      if (msg.kind === "invoke") f.emit({ type: "session", computerId: f.cloud.computerId, session: { ...f.session, token: "rotated" } });
      if (msg.kind === "auth-update") {
        assert.equal(msg.token, "rotated");
        queueMicrotask(() => this.emit("message", JSON.stringify({ kind: "reply", id: 1, result: "completed" })));
      }
    }
    terminate() {}
  }
  const value = await invokeRemote({ cloud: f.cloud }, "threads:list", [], { ...f.deps, WebSocketImpl: Socket, timeoutMs: 500 });
  assert.equal(value, "completed");
  assert.deepEqual(messages, ["auth", "invoke", "auth-update"]);
});


test("focusing an existing cloud window returns its current narrowed access metadata", async t => {
  const f = fixture(t);
  f.session.scopes = ["full"];
  const first = await openRemoteConnection({ cloud: { ...f.cloud, scopes: ["full"] } }, f.deps);
  assert.deepEqual(first.cloud.scopes, ["full"]);
  f.session.scopes = ["read"];
  const next = await openRemoteConnection({ cloud: f.cloud }, f.deps);
  assert.equal(f.windows.length, 1);
  assert.deepEqual(next.cloud.scopes, ["read"]);
});

test("remote cloud windows block cross-origin HTTP redirects", async t => {
  const f = fixture(t);
  await openRemoteConnection({ cloud: f.cloud }, f.deps);
  let prevented = false;
  f.windows[0].webContents.emit("will-redirect", { preventDefault: () => { prevented = true; } }, "https://outside.example.com/");
  assert.equal(prevented, true);
});


test("cloud RPC flushes a rotation received during initial authentication before invoking", async t => {
  const f = fixture(t), messages = [];
  class Socket extends EventEmitter {
    static OPEN = 1; readyState = 1;
    constructor() { super(); queueMicrotask(() => this.emit("open")); }
    send(raw) {
      const msg = JSON.parse(raw); messages.push(msg.kind);
      if (msg.kind === "auth") {
        f.emit({ type: "session", computerId: f.cloud.computerId, session: { ...f.session, token: "rotated" } });
        queueMicrotask(() => this.emit("message", JSON.stringify({ kind: "auth-ok", computer: f.session.computer })));
      }
      if (msg.kind === "invoke") queueMicrotask(() => this.emit("message", JSON.stringify({ kind: "reply", id: 1, result: "done" })));
    }
    terminate() {}
  }
  assert.equal(await invokeRemote({ cloud: f.cloud }, "threads:list", [], { ...f.deps, WebSocketImpl: Socket, timeoutMs: 500 }), "done");
  assert.deepEqual(messages, ["auth", "auth-update", "invoke"]);
});
