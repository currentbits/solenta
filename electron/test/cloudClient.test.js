"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { createCredentials } = require("../cloud/credentials");
const { createCloudClient } = require("../cloud/client");
const { createCloudHost } = require("../cloud/host");
const { createKeyPair, verifyProof } = require("../cloud/protocol");
const { createWebDevices } = require("../webDevices");
const { createBroker } = require("../../connect-api/server");
const { readJSON } = require("../cloud/http");
const { Readable } = require("node:stream");

function file(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-cloud-creds-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "account.json");
}
const encrypted = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "keychain",
  encryptString: text => Buffer.from(text).map(byte => byte ^ 123), decryptString: value => Buffer.from(value.map(byte => byte ^ 123)).toString() };

test("credentials use encrypted atomic files or explicit 0600 headless storage; unavailable desktop storage is session-only", t => {
  const target = file(t);
  const store = createCredentials({ file: target, safeStorage: encrypted });
  store.write({ accessToken: "secret-value" });
  assert.equal(fs.readFileSync(target, "utf8").includes("secret-value"), false);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(createCredentials({ file: target, safeStorage: encrypted }).read().accessToken, "secret-value");
  const sessionFile = file(t);
  const session = createCredentials({ file: sessionFile, safeStorage: { ...encrypted, getSelectedStorageBackend: () => "basic_text" } });
  assert.equal(session.write({ accessToken: "session-secret" }), false);
  assert.equal(session.read().accessToken, "session-secret");
  assert.equal(fs.existsSync(sessionFile), false);
  const plain = createCredentials({ file: file(t), allowPlaintext: true });
  assert.equal(plain.write({ refreshToken: "headless-secret" }), true);
  assert.equal(plain.read().refreshToken, "headless-secret");
  store.clear();
  assert.equal(fs.existsSync(target), false);
  assert.equal(store.read(), null);
});

test("locked or malformed credentials fail visibly without overwriting the saved file", t => {
  const target = file(t);
  fs.writeFileSync(target, "invalid", { mode: 0o600 });
  assert.throws(() => createCredentials({ file: target, safeStorage: encrypted }).read(), /credential/i);
  assert.equal(fs.readFileSync(target, "utf8"), "invalid");
});

test("cloud JSON parsing bounds messages and never reflects a malformed secret payload", async () => {
  await assert.rejects(readJSON(Readable.from([Buffer.from('{"secret":"never-reflect-this", invalid')])) , { message: "Invalid cloud JSON message." });
  await assert.rejects(readJSON(Readable.from([Buffer.alloc(32769)])), /too large/);
});

test("concurrent API calls refresh once; temporary failure retains credentials and logout cannot be undone by a late refresh", async t => {
  const credentials = createCredentials({ file: file(t) });
  credentials.write({ origin: "https://connect.example.com", accountId: "user_test", oauth: { accessToken: "old", refreshToken: "refresh", expiresAt: Date.now() - 1 }, proofKey: {} });
  let refreshes = 0, fail = false, unblock;
  const client = createCloudClient({ config: { origin: "https://connect.example.com" }, credentials,
    oauth: { refresh: async () => { refreshes++; if (fail) throw new Error("Temporary network failure"); if (unblock) await unblock; return { accessToken: "new", refreshToken: "rotated", expiresAt: Date.now() + 3600_000 }; }, revoke: async () => {} },
    fetch: async () => Response.json({ accountId: "user_test", computers: [] }),
  });
  t.after(client.close);
  await Promise.all([client.computers(), client.computers(), client.computers()]);
  assert.equal(refreshes, 1);
  assert.equal(credentials.read().oauth.refreshToken, "rotated");
  credentials.write({ ...credentials.read(), oauth: { ...credentials.read().oauth, expiresAt: 0 } });
  fail = true;
  await assert.rejects(client.computers(), /Temporary/);
  assert.equal(credentials.read().oauth.refreshToken, "rotated");
  fail = false;
  let release;
  unblock = new Promise(resolve => { release = resolve; });
  const pending = client.computers();
  await new Promise(resolve => setImmediate(resolve));
  await client.logout();
  release();
  await assert.rejects(pending, /sign|cancel|changed/i);
  assert.equal(credentials.read(), null);
  assert.equal(client.status().signedIn, false);
});

async function bootstrap(t, timers = {}) {
  const [brokerKey, hostKey, clientKey] = await Promise.all([createKeyPair(), createKeyPair(), createKeyPair()]);
  const brokerOrigin = "https://connect.example.com", hostOrigin = "https://c-test.hosts.example.com";
  const row = { computerId: randomUUID(), accountId: "user_test", publicKey: hostKey.publicJwk, linkId: randomUUID(), generation: 1, allocation: { hostname: new URL(hostOrigin).hostname } };
  let descriptor = { kind: "solenta", computerId: row.computerId, protocol: { min: 1, max: 1 }, runtimeKind: "server", version: "0.29.0" };
  const dataDir = path.dirname(file(t)), devices = createWebDevices(dataDir);
  const hostCredentials = createCredentials({ file: file(t) });
  hostCredentials.write({ ...hostKey, link: { ...row, brokerOrigin, brokerKey: brokerKey.publicJwk, enabled: true, connectorToken: "fixture-connector" } });
  let exchanges = 0, offline = false;
  const servers = [];
  async function server(handler) {
    const server = http.createServer(handler); servers.push(server);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  t.after(async () => { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); });
  const mapped = new Map();
  const fetchMapped = (url, options) => {
    if (offline) return Promise.reject(new Error("Fixture broker offline"));
    const target = new URL(url);
    const local = mapped.get(target.origin);
    if (!local) throw new Error("Unexpected fixture endpoint");
    return fetch(`${local}${target.pathname}${target.search}`, options);
  };
  const cloudHost = createCloudHost({ dataDir, devices, descriptor, port: 4621, credentials: hostCredentials, config: { origin: brokerOrigin }, account: {}, fetch: fetchMapped,
    connector: { start: async () => {}, close: async () => {}, status: () => ({ state: "running" }) } });
  t.after(cloudHost.close);
  mapped.set(hostOrigin, await server(async (req, res) => {
    res.setHeader("content-type", "application/json");
    try {
      if (req.url === "/.well-known/solenta") return res.end(JSON.stringify(descriptor));
      if (req.url === "/api/cloud/exchange") exchanges++;
      if (!await cloudHost.handleRequest(req, res)) { res.statusCode = 404; res.end(); }
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
  }));
  mapped.set(brokerOrigin, await server(createBroker({ store: { getHost: async () => row }, verifyAccount: async () => "user_test", tunnels: {}, signingKey: brokerKey.privateJwk, fetch: fetchMapped,
    config: { origin: brokerOrigin, issuer: "https://identity.example.com", clientId: "public-client", maxComputers: 3 } })));
  await cloudHost.start();
  const credentials = createCredentials({ file: file(t) });
  credentials.write({ origin: brokerOrigin, accountId: "user_test", oauth: { accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: Date.now() + 3600_000 }, proofKey: clientKey.privateJwk });
  const client = createCloudClient({ config: { origin: brokerOrigin }, credentials, fetch: fetchMapped, ...timers });
  t.after(client.close);
  return { client, devices, row, credentials, exchanges: () => exchanges, setDescriptor: value => { descriptor = value; }, setOffline: value => { offline = value; } };
}

test("real HTTP broker and host exchange rotates a read-only session once, preserving its device identity", async t => {
  const f = await bootstrap(t), changes = [];
  f.client.subscribe(event => { if (event.type === "session") changes.push(event); });
  const first = await f.client.session(f.row.computerId, { scopes: ["read"] });
  assert.deepEqual(f.devices.authorize(first.token).scopes, ["read"]);
  const [a, b] = await Promise.all([f.client.session(f.row.computerId, { renew: true }), f.client.session(f.row.computerId, { renew: true })]);
  assert.equal(a.token, b.token);
  assert.notEqual(a.token, first.token);
  assert.equal(a.deviceId, first.deviceId);
  assert.deepEqual(a.scopes, ["read"]);
  assert.equal(f.devices.authorize(first.token), null);
  assert.equal(f.devices.authorize(a.token).id, a.deviceId);
  assert.equal(f.exchanges(), 2);
  assert.equal(changes.length, 2);
  await assert.rejects(f.client.session(f.row.computerId, { scopes: ["full"] }), /grant that access/i);
});

test("a mismatching descriptor blocks the exchange before any host credential is sent", async t => {
  const f = await bootstrap(t);
  f.setDescriptor({ kind: "solenta", computerId: randomUUID(), protocol: { min: 1, max: 1 }, runtimeKind: "server" });
  await assert.rejects(f.client.session(f.row.computerId), /identity mismatch/i);
  assert.equal(f.exchanges(), 0);
});

test("credentials are bound to their configured broker, and sign-out clears cloud credentials locally even if revocation is offline", async t => {
  const credentials = createCredentials({ file: file(t) });
  credentials.write({ origin: "https://other.example.com", accountId: "user_test", oauth: { accessToken: "never-send", expiresAt: Date.now() + 3600_000 } });
  const client = createCloudClient({ config: { origin: "https://connect.example.com" }, credentials, fetch: () => assert.fail("must not send another broker's credential") });
  t.after(client.close);
  assert.equal(client.status().signedIn, false);
  await assert.rejects(client.computers(), /sign|broker/i);
  const result = await client.logout();
  assert.equal(result.revocationPending, true);
  assert.equal(credentials.read(), null);
});

test("concurrent requests with different scopes cannot accidentally share the broader result", async t => {
  const f = await bootstrap(t);
  const full = f.client.session(f.row.computerId, { scopes: ["full"] });
  await assert.rejects(f.client.session(f.row.computerId, { scopes: ["read"] }), /different.*access request/i);
  assert.deepEqual((await full).scopes, ["full"]);
});

test("login saves the broker-verified account but returns only public status", async t => {
  const credentials = createCredentials({ file: file(t) });
  let logins = 0;
  const client = createCloudClient({ config: { origin: "https://connect.example.com" }, credentials,
    oauth: { login: async () => { logins++; return { accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: Date.now() + 3600_000 }; } },
    fetch: async (url, options) => {
      assert.equal(options.headers.authorization, "Bearer access-secret");
      return Response.json({ accountId: "verified-user", computers: [] });
    },
  });
  t.after(client.close);
  const [a, b] = await Promise.all([client.login(), client.login()]);
  assert.deepEqual(a, b);
  assert.equal(logins, 1);
  assert.equal(a.accountId, "verified-user");
  assert.equal(a.storage, "session");
  assert.equal(JSON.stringify(a).includes("secret"), false);
  assert.equal(credentials.read().proofKey.crv, "Ed25519");
});

test("server-owned headless login verifies the account before saving, and registration proves its separate host key", async t => {
  const credentials = createCredentials({ file: file(t) });
  const hostKey = await createKeyPair();
  const origin = "https://connect.example.com";
  const client = createCloudClient({ config: { origin }, credentials, fetch: async (url, options) => {
    if (options.method === "POST") {
      const input = JSON.parse(options.body);
      const proof = await verifyProof(input.proof, hostKey.publicJwk, { purpose: "register", audience: origin });
      assert.equal(proof.accountId, "verified-user");
      assert.equal(input.port, 4621);
      assert.equal(input.publicKey.x, hostKey.publicJwk.x);
      return Response.json({ computerId: input.computerId });
    }
    assert.equal(options.headers.authorization, "Bearer headless-access");
    return Response.json({ accountId: "verified-user", computers: [] });
  } });
  t.after(client.close);
  await assert.rejects(client.acceptLogin({ accessToken: "invalid" }), /credential/i);
  const status = await client.acceptLogin({ accessToken: "headless-access", refreshToken: "headless-refresh", expiresAt: Date.now() + 3600_000 });
  assert.equal(status.accountId, "verified-user");
  assert.equal(status.brokerOrigin, origin);
  const computerId = randomUUID();
  assert.equal((await client.registerHost({ computerId, label: "Host", port: 4621 }, hostKey)).computerId, computerId);
});

test("scheduled renewal notifies owners; an outage preserves the current session until its actual expiry", { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-09T13:00:00Z") });
  const scheduled = new Map();
  const f = await bootstrap(t, { setTimeout: (fn, ms) => {
    const id = {}; scheduled.set(id, { fn, at: Date.now() + ms }); return id;
  }, clearTimeout: id => scheduled.delete(id) });
  const advance = ms => {
    t.mock.timers.tick(ms);
    for (const [id, timer] of [...scheduled]) if (timer.at <= Date.now()) { scheduled.delete(id); timer.fn(); }
  };
  const first = await f.client.session(f.row.computerId, { scopes: ["read"] });
  assert.equal(scheduled.size, 1);
  assert.equal([...scheduled.values()][0].at - Date.now(), 540_000);
  const nextEvent = type => new Promise(resolve => {
    const unsubscribe = f.client.subscribe(event => { if (event.type === type) { unsubscribe(); resolve(event); } });
  });
  const renewal = nextEvent("session");
  advance(540_000);
  const second = (await renewal).session;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.deviceId, first.deviceId);
  assert.notEqual(second.token, first.token);
  f.setOffline(true);
  const failed = nextEvent("renewal-error");
  advance(540_000);
  await failed;
  assert.equal(f.devices.authorize(second.token).id, second.deviceId);
  const expired = nextEvent("expired");
  advance(60_001);
  await expired;
  assert.equal(f.devices.authorize(second.token), null);
});


test("explicit logout clears locked credentials; sign-in never overwrites them before that choice", async t => {
  const target = file(t);
  fs.writeFileSync(target, "invalid", { mode: 0o600 });
  const credentials = createCredentials({ file: target, safeStorage: encrypted });
  const client = createCloudClient({ config: { origin: "https://connect.example.com" }, credentials,
    fetch: async () => Response.json({ accountId: "user_test", computers: [] }) });
  t.after(client.close);
  await assert.rejects(client.acceptLogin({ accessToken: "new", refreshToken: "new", expiresAt: Date.now() + 3600_000 }), /locked|invalid/);
  assert.equal(fs.readFileSync(target, "utf8"), "invalid");
  assert.equal((await client.logout()).revocationPending, true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(client.status().signedIn, false);
});
