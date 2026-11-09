"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { randomUUID, createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { fork } = require("node:child_process");
const { setTimeout: wait } = require("node:timers/promises");
const { createCloudHost } = require("../cloud/host");
const { createConnector, ensureBinary } = require("../cloud/connector");
const { createCredentials } = require("../cloud/credentials");
const { createKeyPair, signProof, verifyProof, thumbprint } = require("../cloud/protocol");
const { createWebDevices } = require("../webDevices");
const { invokeLocal } = require("../server/localRpc");
const { createCloudAdmin } = require("../cloud/admin");
const { main: connectCommand } = require("../server/connect");
const { startWebServer } = require("../webServer");

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-cloud-host-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const brokerKey = await createKeyPair(), clientKey = await createKeyPair();
  const origin = "https://connect.example.com", computerId = randomUUID();
  const descriptor = { kind: "solenta", computerId, protocol: { min: 1, max: 1 }, runtimeKind: "server" };
  const devices = createWebDevices(dir), disconnected = [], actions = [];
  const credentials = createCredentials({ file: path.join(dir, "host.json"), allowPlaintext: true });
  let linked = true, offline = false, active = true, cleanupPending = false, registration;
  const connector = { async start(input) { assert.equal(actions.at(-1), "reconciled"); assert.equal(input.token, "connector-secret"); actions.push("connector"); }, async close() { actions.push("stopped"); }, status: () => ({ state: "running" }) };
  const account = { status: () => ({ signedIn: true, accountId: "user_test" }), async registerHost(input, key) {
    assert.equal(input.port, 4621);
    registration = { computerId, accountId: "user_test", publicKey: key.publicJwk, linkId: randomUUID(), generation: 1, origin: "https://c-test.hosts.example.com", connectorToken: "connector-secret", brokerKey: brokerKey.publicJwk };
    return registration;
  }, async deregister() { if (offline) throw new Error("Broker offline"); linked = false; return { revoked: true, cleanupPending }; } };
  const fetchBroker = async (url, options) => {
    assert.equal(options.redirect, "error");
    if (offline) throw new Error("Broker offline");
    const state = credentials.read();
    const claims = await verifyProof(JSON.parse(options.body).proof, state.publicJwk, { purpose: "heartbeat", audience: origin });
    assert.equal(claims.probe, false);
    actions.push("reconciled");
    return Response.json({ proof: await signProof(brokerKey.privateJwk, { computerId, linkId: claims.linkId, generation: claims.generation, nonce: claims.nonce, linked }, "heartbeat-response", computerId) });
  };
  const make = () => createCloudHost({ dataDir: dir, devices, descriptor, port: () => 4621, credentials, config: { origin }, account, connector, fetch: fetchBroker, disconnect: id => disconnected.push(id), isActive: () => active });
  const host = make();
  t.after(host.close);
  const server = http.createServer(async (req, res) => { if (!await host.handleRequest(req, res)) { res.statusCode = 404; res.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const claims = async () => ({ computerId, accountId: "user_test", linkId: registration.linkId, generation: registration.generation, jkt: await thumbprint(clientKey.publicJwk), nonce: randomUUID(), scopes: ["read"] });
  async function enroll() {
    const binding = await claims();
    const minted = await request("/api/cloud/mint", { proof: await signProof(brokerKey.privateJwk, binding, "mint", computerId) });
    assert.equal(minted.status, 200);
    const grant = await verifyProof(minted.body.proof, credentials.read().publicJwk, { purpose: "mint-response", audience: origin });
    const exchange = { ...binding, grantHash: createHash("sha256").update(grant.grant).digest("base64url"), nonce: randomUUID() };
    const body = { grant: grant.grant, publicKey: clientKey.publicJwk, proof: await signProof(clientKey.privateJwk, exchange, "exchange", computerId) };
    const result = await request("/api/cloud/exchange", body);
    assert.equal(result.status, 200);
    return { result: result.body, exchange: body };
  }
  return { host, devices, credentials, request, brokerKey, clientKey, claims, enroll, actions, disconnected, make, setLinked: value => { linked = value; }, setOffline: value => { offline = value; }, setActive: value => { active = value; }, setCleanupPending: value => { cleanupPending = value; }, descriptor };
}

test("host links its exact port, reconciles before starting the connector and signs a one-use exchange", async t => {
  const f = await fixture(t);
  await f.host.link();
  assert.deepEqual(f.actions.slice(-2), ["reconciled", "connector"]);
  const { result, exchange } = await f.enroll();
  assert.equal(f.devices.authorize(result.token).id, result.deviceId);
  assert.deepEqual(result.scopes, ["read"]);
  assert.equal((await f.request("/api/cloud/exchange", exchange)).status, 400);
  const proof = await verifyProof(result.proof, f.credentials.read().publicJwk, { purpose: "session-response", audience: await thumbprint(f.clientKey.publicJwk) });
  assert.equal(proof.tokenHash, createHash("sha256").update(result.token).digest("base64url"));
  assert.equal(JSON.stringify(f.host.status()).includes("connector-secret"), false);
});

test("host refuses wrong account, generation and signing key without issuing devices", async t => {
  const f = await fixture(t);
  await f.host.link();
  for (const change of [{ accountId: "other" }, { generation: 100 }, { computerId: randomUUID() }]) {
    const claims = { ...await f.claims(), ...change };
    assert.equal((await f.request("/api/cloud/mint", { proof: await signProof(f.brokerKey.privateJwk, claims, "mint", f.descriptor.computerId) })).status, 400);
  }
  const forged = await signProof(f.clientKey.privateJwk, await f.claims(), "mint", f.descriptor.computerId);
  assert.equal((await f.request("/api/cloud/mint", { proof: forged })).status, 400);
  assert.equal(f.devices.list().length, 0);
});

test("session-only desktop storage cannot permanently register a signing key it will lose on exit", async t => {
  const f = await fixture(t);
  f.credentials.storage = () => "session";
  await assert.rejects(f.host.link(), /persistent secure storage/i);
  assert.equal(f.actions.includes("connector"), false);
  assert.equal(f.credentials.read(), null);
});

test("a maintenance or inactive runtime refuses cloud enrollment without consuming its signed mint", async t => {
  const f = await fixture(t);
  await f.host.link();
  const proof = await signProof(f.brokerKey.privateJwk, await f.claims(), "mint", f.descriptor.computerId);
  f.setActive(false);
  assert.equal((await f.request("/api/cloud/mint", { proof })).status, 503);
  f.setActive(true);
  assert.equal((await f.request("/api/cloud/mint", { proof })).status, 200);
});

test("offline unlink revokes only cloud sessions locally, preserves signing identity and retries broker cleanup", async t => {
  const f = await fixture(t);
  await f.host.link();
  const direct = f.devices.add({ name: "Direct", scopes: ["full"] });
  const cloud = (await f.enroll()).result;
  const publicKey = f.credentials.read().publicJwk;
  f.setOffline(true);
  assert.equal((await f.host.unlink()).revocationPending, true);
  assert.equal(f.devices.authorize(cloud.token), null);
  assert.ok(f.devices.authorize(direct.token));
  assert.ok(f.disconnected.includes(cloud.deviceId));
  assert.deepEqual(f.credentials.read().publicJwk, publicKey);
  assert.equal(f.host.status().enabled, false);
  f.setOffline(false);
  assert.equal((await f.host.unlink()).revocationPending, false);
});

test("unlink remains disabled after restart when secure credential storage becomes unavailable", async t => {
  const f = await fixture(t);
  await f.host.link();
  const count = f.actions.filter(action => action === "connector").length;
  f.credentials.write = () => false;
  f.setOffline(true);
  await f.host.unlink();
  await f.host.close();
  f.setOffline(false);
  const restarted = f.make(); t.after(restarted.close);
  await restarted.start();
  assert.equal(restarted.status().enabled, false);
  assert.equal(f.actions.filter(action => action === "connector").length, count);
});

test("a restarted host never starts its connector before a signed reconciliation; revoked state removes old cloud devices", async t => {
  const f = await fixture(t);
  await f.host.link();
  const cloud = (await f.enroll()).result;
  await f.host.close();
  const count = f.actions.filter(action => action === "connector").length;
  f.setOffline(true);
  const restarted = f.make(); t.after(restarted.close);
  await restarted.start();
  assert.equal(f.actions.filter(action => action === "connector").length, count);
  f.setOffline(false); f.setLinked(false);
  await restarted.start();
  assert.equal(f.devices.authorize(cloud.token), null);
  assert.equal(restarted.status().enabled, false);
});

test("connector refuses an unverified download and never writes inside its signed application", async t => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-connector-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  await assert.rejects(ensureBinary({ cacheDir, platform: "linux", arch: "x64", fetch: async () => new Response("wrong-binary") }), /checksum/i);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test("connector drops inherited secrets, keeps its token off argv and bounds crash restarts", async () => {
  let launches = 0;
  const timers = [], connector = createConnector({ cacheDir: "/unused-test-cache", install: async () => "/verified/cloudflared", spawn: (binary, args, options) => {
    assert.equal(binary, "/verified/cloudflared");
    assert.equal(args.includes("connector-secret"), false);
    assert.equal(options.env.TUNNEL_TOKEN, "connector-secret");
    assert.equal(options.env.CODER_GUARDRAILS_PATH, undefined);
    assert.equal(options.stdio, "ignore");
    const child = new EventEmitter(); child.kill = () => {};
    launches++; queueMicrotask(() => child.emit("exit", 1));
    return child;
  }, setTimeout: (fn, delay) => { assert.ok(delay >= 1000); timers.push(fn); return {}; }, clearTimeout: () => {} });
  await connector.start({ token: "connector-secret", beforeStart: async () => {} });
  for (let i = 0; i < 8; i++) {
    await new Promise(resolve => setImmediate(resolve));
    if (timers.length) await timers.shift()();
  }
  assert.equal(launches, 5);
  assert.equal(connector.status().state, "failed");
  await connector.close();
});

test("the connector owner stops its own tunnel child when its parent disappears", { timeout: 5000 }, async t => {
  const helper = require.resolve("../cloud/connectorChild");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-connector-owner-")), pidFile = path.join(dir, "child.pid");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owner = fork(helper, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1" } });
  t.after(() => owner.kill("SIGTERM"));
  const exit = new Promise(resolve => owner.once("exit", resolve));
  owner.send({ binary: process.execPath, args: ["-e", 'require("node:fs").writeFileSync(process.env.TEST_PID_FILE,String(process.pid));setInterval(()=>{},1000)'], env: { TEST_PID_FILE: pidFile } });
  const deadline = Date.now() + 3000;
  let pid;
  while (Date.now() < deadline) {
    try { pid = Number(fs.readFileSync(pidFile, "utf8")); } catch {}
    if (Number.isInteger(pid) && pid > 0) break;
    await wait(10);
  }
  assert.ok(pid > 0, "owned child started");
  owner.disconnect();
  await exit;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("local CLI rejects HTML or another runtime before reading or sending any credential", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-cloud-local-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "computer-id"), randomUUID());
  let upgrades = 0;
  const server = http.createServer((req, res) => { res.end("<html>Unrelated server</html>"); });
  server.on("upgrade", () => { upgrades++; });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(invokeLocal(server.address().port, dir, "cloud:admin", [{ action: "status" }]), /JSON|identity|Solenta/i);
  assert.equal(upgrades, 0);
  assert.equal(fs.existsSync(path.join(dir, "web-token")), false);
});

test("CLI routes link to the selected live port and cloud admin refuses ordinary web sessions", async () => {
  const calls = [];
  const result = await connectCommand(["link", "--port", "4621", "--data-dir", "/tmp/test-selected-host"], { invoke: async (port, dir, channel, args) => {
    assert.equal(port, 4621); assert.equal(dir, "/tmp/test-selected-host"); assert.equal(channel, "cloud:admin");
    calls.push(args[0].action);
    return args[0].action === "status" ? { account: { signedIn: true } } : { enabled: true };
  } });
  assert.deepEqual(calls, ["status", "link"]);
  assert.equal(result.enabled, true);
  const admin = createCloudAdmin({ client: {}, host: {} });
  await assert.rejects(admin["cloud:admin"]({ transport: "web" }, { action: "status" }), /local server credential/);
});

test("the real wire bridge permits local CLI administration only with its legacy server credential", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-cloud-admin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const computerId = randomUUID();
  fs.writeFileSync(path.join(dir, "computer-id"), computerId);
  fs.writeFileSync(path.join(dir, "web-token"), "local-secret");
  const devices = createWebDevices(dir);
  const ordinary = devices.add({ name: "Full access browser", scopes: ["full"] });
  const handlers = createCloudAdmin({ client: { status: () => ({ configured: true, signedIn: true, accountId: "user_test" }) }, host: { status: () => ({ computerId, enabled: false }) } });
  const server = await startWebServer({ host: "127.0.0.1", port: 0, userDataPath: dir, runtimeKind: "server", handlers, authorize: token => devices.authorize(token), ctx: {} });
  t.after(server.close);
  const result = await connectCommand(["status", "--port", String(server.port), "--data-dir", dir]);
  assert.equal(result.account.accountId, "user_test");
  assert.equal(result.host.computerId, computerId);
  fs.writeFileSync(path.join(dir, "web-token"), ordinary.token);
  await assert.rejects(invokeLocal(server.port, dir, "cloud:admin", [{ action: "status" }]), /local server credential/);
});


test("unlink reports broker cleanup still pending after access was revoked", async t => {
  const f = await fixture(t);
  await f.host.link();
  f.setCleanupPending(true);
  const result = await f.host.unlink();
  assert.equal(result.revocationPending, false);
  assert.equal(result.cleanupPending, true);
  assert.equal(f.host.status().enabled, false);
  assert.equal(f.host.status().cleanupPending, true);
  f.setCleanupPending(false);
  await f.host.unlink();
  assert.equal(f.host.status().cleanupPending, false);
});


test("remote revoke fences devices before acknowledging, then drains its own tunnel response before stopping", async t => {
  const f = await fixture(t);
  await f.host.link();
  const cloud = (await f.enroll()).result;
  const binding = await f.claims();
  const stops = f.actions.filter(action => action === "stopped").length;
  const response = await f.request("/api/cloud/revoke", { proof: await signProof(f.brokerKey.privateJwk, binding, "revoke", f.descriptor.computerId) });
  assert.equal(response.status, 200);
  assert.equal(f.devices.authorize(cloud.token), null);
  assert.equal(f.host.status().enabled, false);
  assert.equal(f.actions.filter(action => action === "stopped").length, stops, "Do not cut the tunnel carrying the revocation response");
  await wait(1200);
  assert.equal(f.actions.filter(action => action === "stopped").length, stops + 1);
});


test("a failed connector accepts an explicit retry with the same token after connectivity returns", async () => {
  const timers = []; let offline = true, installs = 0, launches = 0;
  const connector = createConnector({ cacheDir: "/unused", install: async () => { installs++; if (offline) throw new Error("Offline"); return "/verified/connector"; },
    spawn: () => { launches++; const child = new EventEmitter(); child.kill = () => {}; return child; },
    setTimeout: fn => { timers.push(fn); return {}; }, clearTimeout() {} });
  const input = { token: "same-credential", beforeStart: async () => {} };
  await connector.start(input);
  while (timers.length) { await timers.shift()(); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(connector.status().state, "failed"); assert.equal(installs, 5);
  offline = false; await connector.start(input);
  assert.equal(launches, 1); assert.equal(connector.status().state, "running");
  await connector.close();
});
