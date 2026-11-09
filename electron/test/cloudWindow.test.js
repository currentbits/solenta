"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createCloudWindowSessions } = require("../cloud/windowSessions");

async function fixture() {
  const handlers = new Map(), sent = [], requested = [], cookies = [];
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
  const win = new EventEmitter();
  win.webContents = { id: 7, mainFrame: { url: "https://host.example.com/" }, send: (channel, payload) => sent.push({ channel, payload }) };
  win.webContents.mainFrame.send = (channel, payload) => sent.push({ channel, payload });
  win.webContents.send = () => assert.fail("Credentials must be sent only to the verified main frame");
  win.webContents.session = { cookies: { set: async cookie => { cookies.push(cookie); }, remove: async () => { cookies.length = 0; } } };
  win.isDestroyed = () => win.destroyed === true;
  win.destroy = () => { win.destroyed = true; win.emit("closed"); };
  const initial = { computerId: "computer-123", deviceId: "device-123", accountId: "user_test", origin: "https://host.example.com", token: "short-host-token", refreshToken: "never-forward" };
  let callback;
  const client = { session: async id => { requested.push(id); return initial; }, subscribe: listener => { callback = listener; return () => { callback = null; }; } };
  const manager = createCloudWindowSessions({ ipcMain });
  await manager.track(win, client, initial);
  return { win, manager, sent, requested, cookies, handlers, initial, event: { sender: win.webContents, senderFrame: win.webContents.mainFrame }, emit: event => callback?.(event) };
}

test("remote windows receive only their pinned host credential, never a full native API or another account", async t => {
  const f = await fixture(); t.after(f.manager.close);
  const handler = f.handlers.get("cloud-window:session");
  const value = await handler(f.event, { computerId: "another-computer" });
  assert.deepEqual(value, { token: "short-host-token", deviceId: "device-123", computerId: "computer-123" });
  assert.deepEqual(f.requested, ["computer-123"]);
  await assert.rejects(handler({ ...f.event, senderFrame: { url: f.initial.origin } }), /window|frame|origin/i);
  f.win.webContents.mainFrame.url = "https://unrelated.example.com/";
  await assert.rejects(handler(f.event), /window|frame|origin/i);
});

test("renewal updates the same window without reload; account change closes only tracked cloud windows", async t => {
  const f = await fixture(); t.after(f.manager.close);
  f.emit({ type: "session", computerId: "other", session: f.initial });
  assert.equal(f.sent.length, 0);
  f.emit({ type: "session", computerId: f.initial.computerId, session: { ...f.initial, token: "rotated-host-token" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sent, [{ channel: "cloud-window:changed", payload: { token: "rotated-host-token", deviceId: f.initial.deviceId, computerId: f.initial.computerId } }]);
  assert.equal(f.win.destroyed, undefined);
  f.emit({ type: "account", signedIn: false });
  assert.equal(f.win.destroyed, true);
});

test("the sandboxed preload exposes only credential read/update and ignores renderer-selected computer arguments", async () => {
  const exposed = {}, listeners = new Map(), requests = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../cloud/windowPreload.js"), "utf8"), { require: name => {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer: {
      invoke: (...args) => { requests.push(args); return Promise.resolve({ token: "session" }); },
      on: (name, fn) => listeners.set(name, fn), removeListener: name => listeners.delete(name),
    } };
  } });
  assert.deepEqual(Object.keys(exposed), ["solentaCloudSession"]);
  await exposed.solentaCloudSession.getCredentials("another-computer");
  assert.deepEqual(requests, [["cloud-window:session"]]);
  const values = [];
  const unsubscribe = exposed.solentaCloudSession.subscribeCredentials(value => values.push(value));
  listeners.get("cloud-window:changed")({ privilegedNativeEvent: true }, { token: "rotated" });
  assert.deepEqual(values, [{ token: "rotated" }]);
  unsubscribe();
  assert.equal(listeners.size, 0);
});


test("renewal never sends a credential to a window that redirected off its pinned origin", async t => {
  const f = await fixture(); t.after(f.manager.close);
  f.win.webContents.mainFrame.url = "https://outside.example.com/";
  f.emit({ type: "session", computerId: f.initial.computerId, session: { ...f.initial, token: "renewed-secret" } });
  assert.equal(f.sent.length, 0);
  assert.equal(f.win.destroyed, true);
});


test("cloud media cookies are narrow, private, ephemeral and rotated before notifying the frame", async t => {
  const f = await fixture(); t.after(f.manager.close);
  assert.deepEqual(f.cookies[0], { url: f.initial.origin + "/api/run-artifacts/", name: "solenta-cloud-session", value: f.initial.token, path: "/api/run-artifacts", secure: true, httpOnly: true, sameSite: "strict" });
  f.emit({ type: "session", computerId: f.initial.computerId, session: { ...f.initial, token: "new-host-token", expiresAt: 2000000000000 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cookies.at(-1).value, "new-host-token");
  assert.equal(f.cookies.at(-1).expirationDate, 2000000000);
  assert.equal(f.sent.at(-1).payload.token, "new-host-token");
  f.win.destroy(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cookies.length, 0);
});
