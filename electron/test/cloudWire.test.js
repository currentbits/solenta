"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { setTimeout: wait } = require("node:timers/promises");
const { WebSocket } = require("ws");
const { startWebServer } = require("../webServer");
const { createWebDevices } = require("../webDevices");

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Wire event timed out"); await wait(5); }
}
const descriptor = () => ({ kind: "solenta", computerId: randomUUID(), protocol: { min: 1, max: 1 }, runtimeKind: "server" });

test("an established socket cannot use rotation to extend its original lease or survive device revocation", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-cloud-lease-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1000;
  const devices = createWebDevices(dir, { now: () => now });
  const cloud = { accountId: "user_test", linkId: randomUUID(), generation: 1, jkt: "a".repeat(43) };
  const grant = devices.createCloudEnrollment({ cloud, nonce: randomUUID(), name: "Cloud device", scopes: ["read"] });
  const first = devices.redeemCloudEnrollment({ grant: grant.grant, cloud });
  const prior = devices.authorize(first.token);
  now = 100_000;
  const renewal = devices.createCloudEnrollment({ cloud, nonce: randomUUID(), name: "Cloud device", deviceId: first.device.id });
  const second = devices.redeemCloudEnrollment({ grant: renewal.grant, cloud });
  assert.equal(devices.authorizeEstablished(prior).expiresAt, first.expiresAt);
  now = first.expiresAt;
  assert.equal(devices.authorizeEstablished(prior), null);
  const current = devices.authorize(second.token);
  assert.ok(current);
  devices.revoke(second.device.id);
  assert.equal(devices.authorizeEstablished(current), null);
});

test("a cloud credential rotates during terminal pushes without losing the socket or rejecting calls in transit", { timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-cloud-wire-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const computer = descriptor(), devices = createWebDevices(dir);
  const cloud = { accountId: "user_test", linkId: randomUUID(), generation: 1, jkt: "a".repeat(43) };
  function enroll(deviceId) {
    const grant = devices.createCloudEnrollment({ cloud, nonce: randomUUID(), name: "Cloud desktop", scopes: ["read", "terminal:observe"], ...(deviceId ? { deviceId } : {}) });
    return devices.redeemCloudEnrollment({ grant: grant.grant, cloud });
  }
  const first = enroll();
  const server = await startWebServer({ host: "127.0.0.1", port: 0, computer, authorize: token => devices.authorize(token),
    reauthorize: (token, prior) => devices.authorize(token) || devices.authorizeEstablished(prior),
    handlers: { "threads:list": async () => [] }, ctx: {} });
  t.after(server.close);
  let connections = 0, update;
  server.bridge.wss.on("connection", () => connections++);
  const { createWireCoder } = await import("../../src/wireClient.ts");
  const api = createWireCoder({ url: `ws://127.0.0.1:${server.port}/ws`, token: first.token, expectedComputerId: computer.computerId, WebSocket,
    getCredentials: async () => ({ token: first.token, deviceId: first.device.id, computerId: computer.computerId }),
    subscribeCredentials: listener => { update = listener; return () => {}; },
    setTimeout: () => ({ unref() {} }),
  });
  const output = [];
  api.on("terminal:data", value => output.push(value.data));
  await api.threads.list();
  server.broadcast("terminal:data", { threadId: "thread", termId: "term", data: "before" });
  await until(() => output.length === 1);
  const second = enroll(first.device.id);
  assert.equal(devices.authorize(first.token), null, "rotated token cannot authenticate a new connection");
  await api.threads.list();
  assert.equal(typeof update, "function");
  update({ token: second.token, deviceId: second.device.id, computerId: computer.computerId });
  server.broadcast("terminal:data", { threadId: "thread", termId: "term", data: "during" });
  await api.threads.list();
  server.broadcast("terminal:data", { threadId: "thread", termId: "term", data: "after" });
  await until(() => output.length === 3);
  assert.deepEqual(output, ["before", "during", "after"]);
  assert.equal(connections, 1);
});

async function socket(t, authorize) {
  const computer = descriptor();
  const server = await startWebServer({ host: "127.0.0.1", port: 0, computer, authorize, handlers: {}, ctx: {} });
  t.after(server.close);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const read = () => new Promise(resolve => ws.once("message", raw => resolve(JSON.parse(String(raw)))));
  const pending = read(); ws.send(JSON.stringify({ kind: "auth", token: "old", computerId: computer.computerId, protocol: 1 }));
  assert.equal((await pending).kind, "auth-ok");
  return { ws, computer, read };
}

test("credential replacement cannot change device identity or widen access", { timeout: 5000 }, async t => {
  for (const replacement of [{ id: "different", scopes: ["read"] }, { id: "same", scopes: ["full"] }]) {
    const f = await socket(t, token => token === "old" ? { id: "same", scopes: ["read"] } : replacement);
    const closed = new Promise(resolve => f.ws.once("close", resolve));
    f.ws.send(JSON.stringify({ kind: "auth-update", token: "new", computerId: f.computer.computerId }));
    assert.equal(await closed, 4401);
  }
});

test("successful credential replacement replaces the old expiry timer, while actual revocation still closes access", { timeout: 5000 }, async t => {
  const now = Date.now(), tokens = new Map([["old", { id: "same", scopes: ["read"], expiresAt: now + 250 }], ["new", { id: "same", scopes: ["read"], expiresAt: now + 1500 }]]);
  const f = await socket(t, token => tokens.get(token) ?? null);
  const updated = f.read(); f.ws.send(JSON.stringify({ kind: "auth-update", token: "new", computerId: f.computer.computerId }));
  assert.equal((await updated).kind, "auth-updated");
  await wait(300);
  assert.equal(f.ws.readyState, WebSocket.OPEN);
  tokens.delete("new");
  const closed = new Promise(resolve => f.ws.once("close", resolve));
  f.ws.send(JSON.stringify({ kind: "invoke", id: 1, channel: "threads:list", args: [] }));
  assert.equal(await closed, 4401);
});
