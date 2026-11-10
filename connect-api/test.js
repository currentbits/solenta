"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { createKeyPair, signProof, verifyProof, thumbprint } = require("../electron/cloud/protocol");
const { createStore } = require("./store");
const { createBroker, createGitHubOAuth } = require("./server");
const { createCloudflare } = require("./cloudflare");

const databaseUrl = process.env.CONNECT_TEST_DATABASE_URL;
let pool, store, brokerKey, hostKey, clientKey;
before(async () => {
  [brokerKey, hostKey, clientKey] = await Promise.all([createKeyPair(), createKeyPair(), createKeyPair()]);
  if (databaseUrl) {
    pool = new Pool({ connectionString: databaseUrl });
    store = createStore(pool);
    await store.init();
  }
});
after(async () => { if (pool) await pool.end(); });

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function fixture(t, overrides = {}) {
  const account = `user_${randomUUID()}`;
  const config = { origin: "https://connect.example.com", issuer: "https://github.com", clientId: "public-client", maxComputers: 3 };
  let prepares = 0, deletes = 0, mintClaims;
  const tunnels = {
    async prepare(row) { prepares++; row.allocation = { tunnelId: randomUUID(), hostname: `c-${row.linkId}.hosts.example.com` }; return "connector-secret"; },
    async remove() { deletes++; },
  };
  const fetchHost = async (url, options) => {
    assert.equal(options.redirect, "error");
    if (url.endsWith("/api/cloud/mint")) {
      mintClaims = await verifyProof(JSON.parse(options.body).proof, brokerKey.publicJwk, { purpose: "mint", audience: row.computerId });
      const proof = await signProof(hostKey.privateJwk, { ...mintClaims, grant: "one-use-grant", expiresAt: Date.now() + 60_000 }, "mint-response", config.origin);
      return Response.json({ proof });
    }
    if (url.endsWith("/.well-known/solenta")) return Response.json({ kind: "solenta", computerId: row.computerId, protocol: { min: 1, max: 1 }, runtimeKind: "server", version: "0.29.0" });
    if (url.endsWith("/api/cloud/revoke")) {
      const claims = await verifyProof(JSON.parse(options.body).proof, brokerKey.publicJwk, { purpose: "revoke", audience: row.computerId });
      return Response.json({ proof: await signProof(hostKey.privateJwk, { ...claims, revoked: true }, "revoke-response", config.origin) });
    }
    return Response.json({ ok: true });
  };
  const server = await listen(createBroker({ store, verifyAccount: async token => {
    if (token === "invalid") throw new Error("Rejected");
    return token;
  }, tunnels, signingKey: brokerKey.privateJwk, fetch: fetchHost, config, ...overrides }));
  t.after(server.close);
  const row = { computerId: randomUUID(), publicKey: hostKey.publicJwk, label: "Test host", port: 4621, nonce: randomUUID() };
  const request = async (method, path, body, owner = account) => {
    const res = await fetch(server.origin + path, { method, headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  const register = async (owner = account, input = row) => request("POST", "/v1/computers", { ...input, proof: await signProof(hostKey.privateJwk, { computerId: input.computerId, accountId: owner, nonce: input.nonce, port: input.port, label: input.label }, "register", config.origin) }, owner);
  return { account, row, register, request, config, tunnels, counts: () => ({ prepares, deletes }), mint: () => mintClaims };
}

test("Postgres serializes ownership, caps and registration; list never exposes connector credentials", { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.register(), f.register()]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal(results[0].body.linkId, results[1].body.linkId);
  assert.equal(results[0].body.origin, results[1].body.origin);
  assert.equal((await f.register("another-owner")).status, 409);
  assert.equal((await f.request("GET", `/v1/computers/${f.row.computerId}`, undefined, "another-owner")).status, 404);
  const list = await f.request("GET", "/v1/computers");
  assert.equal(list.body.computers.length, 1);
  assert.equal(JSON.stringify(list).includes("connector-secret"), false);
  assert.equal((await f.request("GET", "/v1/computers", undefined, "another-owner")).body.computers.length, 0);
  const extra = await Promise.all(Array.from({ length: 4 }, () => f.register(f.account, { ...f.row, computerId: randomUUID(), nonce: randomUUID() })));
  assert.equal(extra.filter(r => r.status === 200).length, 2);
  assert.equal(extra.filter(r => r.status === 409).length, 2);
});

test("registration requires host proof and pins the host key; malformed and oversized requests fail", { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request("POST", "/v1/computers", f.row)).status, 400);
  assert.equal((await f.register()).status, 200);
  const attacker = await createKeyPair();
  const input = { ...f.row, publicKey: attacker.publicJwk, nonce: randomUUID() };
  const proof = await signProof(attacker.privateJwk, { computerId: input.computerId, accountId: f.account, nonce: input.nonce, port: input.port, label: input.label }, "register", f.config.origin);
  assert.equal((await f.request("POST", "/v1/computers", { ...input, proof })).status, 409);
  assert.equal((await f.register(f.account, { ...f.row, port: "4621" })).status, 400);
  assert.equal((await f.request("POST", "/v1/computers", { value: "x".repeat(40_000) })).status, 413);
  assert.equal((await f.request("GET", "/v1/computers", undefined, "invalid")).status, 401);
});

test("mint returns only a signed one-use grant bound to the client's proof key", { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  await f.register();
  const jkt = await thumbprint(clientKey.publicJwk);
  const response = await f.request("POST", `/v1/computers/${f.row.computerId}/connect`, { publicKey: clientKey.publicJwk, scopes: ["read"], deviceId: "renew-me" });
  assert.equal(response.status, 200);
  assert.equal(response.body.grant, "one-use-grant");
  assert.equal(f.mint().jkt, jkt);
  assert.equal(f.mint().accountId, f.account);
  assert.equal(f.mint().deviceId, "renew-me");
  assert.equal(response.body.publicKey.x, hostKey.publicJwk.x);
  assert.equal(response.body.token, undefined);
  assert.equal((await f.request("POST", `/v1/computers/${f.row.computerId}/connect`, { publicKey: clientKey.publicJwk }, "another-owner")).status, 404);
});

test("wrong host signatures are refused; upstream redirects never follow", { skip: !databaseUrl }, async t => {
  const f = await fixture(t, { fetch: async (url, options) => {
    assert.equal(options.redirect, "error");
    return Response.json({ proof: await signProof(clientKey.privateJwk, { grant: "stolen" }, "mint-response", "https://connect.example.com") });
  } });
  await f.register();
  assert.equal((await f.request("POST", `/v1/computers/${f.row.computerId}/connect`, { publicKey: clientKey.publicJwk })).status, 502);
});

test("heartbeat requires the pinned host key and a reachable matching descriptor; revoked links stay revoked", { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  const linked = (await f.register()).body;
  const claims = { computerId: f.row.computerId, accountId: f.account, linkId: linked.linkId, generation: linked.generation, nonce: randomUUID() };
  const path = `/v1/computers/${f.row.computerId}/heartbeat`;
  const proof = await signProof(hostKey.privateJwk, claims, "heartbeat", f.config.origin);
  assert.equal((await f.request("POST", path, { proof })).status, 200);
  assert.equal((await f.request("GET", "/v1/computers")).body.computers[0].status, "online");
  const forged = await signProof(clientKey.privateJwk, claims, "heartbeat", f.config.origin);
  assert.equal((await f.request("POST", path, { proof: forged })).status, 400);
  const revoked = await f.request("DELETE", `/v1/computers/${f.row.computerId}`);
  assert.equal(revoked.body.hostRevocationPending, false);
  const after = await f.request("POST", path, { proof });
  const response = await verifyProof(after.body.proof, brokerKey.publicJwk, { purpose: "heartbeat-response", audience: f.row.computerId });
  assert.equal(response.linked, false);
});

test("failed allocation checkpoints survive a new store instance and resume the same link", { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  f.tunnels.prepare = async row => { row.allocation = { tunnelId: "reserved-tunnel" }; throw new Error("DNS failed"); };
  assert.equal((await f.register()).status, 502);
  const saved = await createStore(pool).getHost(f.row.computerId);
  assert.equal(saved.allocation.tunnelId, "reserved-tunnel");
  assert.equal(saved.status, "setup-error");
  f.tunnels.prepare = async row => {
    assert.equal(row.linkId, saved.linkId);
    assert.equal(row.allocation.tunnelId, "reserved-tunnel");
    row.allocation.hostname = `c-${row.linkId}.hosts.example.com`;
    return "connector-secret";
  };
  assert.equal((await f.register()).status, 200);
});

test("a host can reconcile its signed link state before starting an offline connector", { skip: !databaseUrl }, async t => {
  const f = await fixture(t, { fetch: () => assert.fail("reconciliation must not require a running tunnel") });
  const linked = (await f.register()).body;
  const claims = { computerId: f.row.computerId, accountId: f.account, linkId: linked.linkId, generation: linked.generation, nonce: randomUUID(), probe: false };
  const result = await f.request("POST", `/v1/computers/${f.row.computerId}/heartbeat`, { proof: await signProof(hostKey.privateJwk, claims, "heartbeat", f.config.origin) });
  assert.equal(result.status, 200);
  const verified = await verifyProof(result.body.proof, brokerKey.publicJwk, { purpose: "heartbeat-response", audience: f.row.computerId });
  assert.equal(verified.linked, true);
  assert.equal((await f.request("GET", "/v1/computers")).body.computers[0].status, "connecting");
});

test("a failed host revocation remains visibly pending after provider cleanup succeeds", { skip: !databaseUrl }, async t => {
  const f = await fixture(t, { fetch: async () => Response.json({ ok: true }) });
  await f.register();
  const first = await f.request("DELETE", `/v1/computers/${f.row.computerId}`);
  assert.equal(first.body.hostRevocationPending, true);
  assert.equal(first.body.cleanupPending, false);
  const second = await f.request("DELETE", `/v1/computers/${f.row.computerId}`);
  assert.equal(second.body.hostRevocationPending, true);
});

test("revocation precedes cleanup, survives failure and fences a later re-link", { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  const first = (await f.register()).body;
  const previousNonce = f.row.nonce;
  f.row.nonce = randomUUID();
  await f.register();
  f.tunnels.remove = async old => {
    assert.equal((await store.getHost(f.row.computerId)).revoked, true);
    assert.equal(old.linkId, first.linkId);
    throw new Error("Cloud provider unavailable");
  };
  const revoked = await f.request("DELETE", `/v1/computers/${f.row.computerId}`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.cleanupPending, true);
  const pending = (await f.request("GET", "/v1/computers")).body.computers.find(row => row.computerId === f.row.computerId);
  assert.equal(pending?.status, "revoked");
  assert.equal(pending?.cleanupPending, true);
  assert.equal((await f.request("POST", `/v1/computers/${f.row.computerId}/connect`, { publicKey: clientKey.publicJwk })).status, 404);
  assert.equal((await f.register()).status, 409, "a captured registration cannot resurrect a revoked link");
  assert.equal((await f.register(f.account, { ...f.row, nonce: previousNonce })).status, 409);
  let cleanupAttempts = 0;
  f.tunnels.remove = async () => { cleanupAttempts++; };
  const retry = await f.request("DELETE", `/v1/computers/${f.row.computerId}`);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.cleanupPending, false);
  assert.equal(cleanupAttempts, 1);
  f.row.nonce = randomUUID();
  const second = (await f.register()).body;
  assert.notEqual(second.linkId, first.linkId);
  assert.ok(second.generation > first.generation);
  assert.equal(await store.updateIfLink(f.row.computerId, first.linkId, () => { throw new Error("stale cleanup ran"); }), null);
  assert.equal((await store.getHost(f.row.computerId)).linkId, second.linkId);
});

test("GitHub verifies the configured app, immutable user ID, expiry and identity-only scopes", async () => {
  const data = { app: { client_id: "public-client" }, token: "opaque-token", user: { id: 12345, login: "renameable", type: "User" }, scopes: [], expires_at: new Date(Date.now() + 300_000).toISOString() };
  const oauth = createGitHubOAuth({ clientSecret: "server-secret", clientId: "public-client", fetch: async (url, options) => {
    assert.equal(url, "https://api.github.com/applications/public-client/token");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, `Basic ${Buffer.from("public-client:server-secret").toString("base64")}`);
    assert.deepEqual(JSON.parse(options.body), { access_token: "opaque-token" });
    return Response.json(data);
  } });
  assert.equal(await oauth.verify("opaque-token"), "github_12345");
  data.user.login = "renamed";
  assert.equal(await oauth.verify("opaque-token"), "github_12345");
  for (const patch of [{ app: { client_id: "wrong" } }, { user: { id: "12345", type: "User" } }, { user: { id: 12345, type: "Organization" } }, { scopes: ["repo"] }, { expires_at: null }, { expires_at: "bad-date" }, { expires_at: new Date(0).toISOString() }, { token: "another-token" }]) {
    const original = { ...data }; Object.assign(data, patch);
    await assert.rejects(oauth.verify("opaque-token"), /authorization/i);
    Object.assign(data, original);
  }
});

test("GitHub exchanges only bounded PKCE/refresh grants and never exposes its client secret", async () => {
  let requests = 0;
  const oauth = createGitHubOAuth({ clientSecret: "server-secret", clientId: "public-client", fetch: async (url, options) => {
    requests++;
    assert.equal(url, "https://github.com/login/oauth/access_token");
    assert.equal(options.redirect, "error");
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("client_secret"), "server-secret");
    assert.equal(body.get("client_id"), "public-client");
    assert.equal(body.has("attacker"), false);
    return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "bearer", expires_in: 28800, scope: "", client_secret: "server-secret" });
  } });
  const input = { client_id: "public-client", grant_type: "authorization_code", code: "one-use", code_verifier: "a".repeat(43), redirect_uri: "http://127.0.0.1:1234/callback", attacker: "ignored" };
  assert.equal((await oauth.exchange(input)).access_token, "access");
  assert.equal(JSON.stringify(await oauth.exchange({ client_id: "public-client", grant_type: "refresh_token", refresh_token: "refresh" })).includes("server-secret"), false);
  for (const patch of [{ client_id: "wrong" }, { grant_type: "password" }, { code_verifier: "short" }, { code: "" }, { redirect_uri: "https://evil.example.com/callback" }, { redirect_uri: "http://user@127.0.0.1:1234/callback" }, { redirect_uri: "http://127.0.0.1:1234/callback?next=evil" }, { redirect_uri: "http://127.0.0.1:1234/other" }]) {
    await assert.rejects(oauth.exchange({ ...input, ...patch }), /Invalid GitHub/i);
  }
  assert.equal(requests, 2);
});

test("GitHub rejects provider errors, broad permissions and unrefreshable credentials", async () => {
  for (const data of [{ error: "bad_code", error_description: "private-upstream-error" }, { access_token: "access", refresh_token: "refresh", token_type: "bearer", expires_in: 28800, scope: "repo" }, { access_token: "access", token_type: "bearer", expires_in: 28800 }, { access_token: "access", refresh_token: "refresh", token_type: "bearer", expires_in: -1 }]) {
    const oauth = createGitHubOAuth({ clientId: "public-client", clientSecret: "server-secret", fetch: async () => Response.json(data) });
    await assert.rejects(oauth.exchange({ client_id: "public-client", grant_type: "refresh_token", refresh_token: "refresh" }), error => error.status === 401 && !error.message.includes("private-upstream-error"));
  }
  const oauth = createGitHubOAuth({ clientId: "public-client", clientSecret: "server-secret", fetch: async () => Response.json({ message: "private-upstream-error" }, { status: 404 }) });
  await assert.rejects(oauth.verify("wrong-app-token"), /authorization/i);
});

test("GitHub sign-out deletes one app token, leaving other devices authorized", async () => {
  const oauth = createGitHubOAuth({ clientId: "public-client", clientSecret: "server-secret", fetch: async (url, options) => {
    assert.equal(url, "https://api.github.com/applications/public-client/token");
    assert.equal(options.method, "DELETE");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { access_token: "this-device-token" });
    return new Response(null, { status: 204 });
  } });
  await oauth.revoke("this-device-token");
});

test("broker exposes bounded OAuth exchange and requires an app-verified token for revocation", async t => {
  let revoked = false, exchanges = 0;
  const config = { origin: "https://connect.example.com", issuer: "https://github.com", clientId: "public-client", maxComputers: 3 };
  const oauth = createGitHubOAuth({ clientId: config.clientId, clientSecret: "server-secret", fetch: async (url, options) => {
    if (url === "https://github.com/login/oauth/access_token") {
      exchanges++;
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 28800, token_type: "bearer", scope: "" });
    }
    const token = JSON.parse(options.body).access_token;
    if (token !== "access" || revoked) return Response.json({ message: "untrusted-provider-error" }, { status: 404 });
    if (options.method === "DELETE") { revoked = true; return new Response(null, { status: 204 }); }
    return Response.json({ app: { client_id: config.clientId }, token, user: { id: 42, type: "User" }, scopes: [], expires_at: new Date(Date.now() + 28800_000).toISOString() });
  } });
  const server = await listen(createBroker({ config, store: { list: async () => [] }, signingKey: brokerKey.privateJwk, oauth, verifyAccount: oauth.verify }));
  t.after(server.close);
  const request = (path, body, accessToken) => fetch(server.origin + path, { method: "POST", headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const publicConfig = await (await fetch(server.origin + "/v1/config")).json();
  assert.equal(publicConfig.issuer, "https://github.com");
  assert.equal(JSON.stringify(publicConfig).includes("secret"), false);
  assert.equal((await request("/v1/oauth/token", { client_id: "wrong", grant_type: "refresh_token", refresh_token: "refresh" })).status, 400);
  assert.equal((await request("/v1/oauth/token", { oversized: "x".repeat(40000) })).status, 413);
  const exchange = await request("/v1/oauth/token", { client_id: config.clientId, grant_type: "refresh_token", refresh_token: "refresh" });
  assert.equal(exchange.status, 200);
  assert.equal(exchange.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(await exchange.json()).includes("server-secret"), false);
  assert.equal(exchanges, 1);
  const account = await (await fetch(server.origin + "/v1/computers", { headers: { authorization: "Bearer access" } })).json();
  assert.equal(account.accountId, "github_42");
  assert.equal((await request("/v1/oauth/revoke")).status, 401);
  assert.equal((await request("/v1/oauth/revoke", undefined, "wrong-app-token")).status, 401);
  assert.equal(revoked, false);
  assert.equal((await request("/v1/oauth/revoke", undefined, "access")).status, 200);
  assert.equal(revoked, true);
  assert.equal((await fetch(server.origin + "/v1/computers", { headers: { authorization: "Bearer access" } })).status, 401);
  for (let i = 0; i < 27; i++) await request("/v1/oauth/token", { client_id: "wrong" });
  assert.equal((await request("/v1/oauth/token", { client_id: "wrong" })).status, 429);
});

test("Cloudflare retry reconciles its tunnel after DNS failure; origin is always loopback", async () => {
  let tunnel, dns, failDns = true, creates = 0;
  const requests = [];
  const api = createCloudflare({ token: "provider-secret", accountId: "a".repeat(32), zoneId: "b".repeat(32), domain: "hosts.example.com", fetch: async (url, options) => {
    assert.equal(options.redirect, "error");
    requests.push([url, options]);
    const method = options.method;
    if (url.includes("/configurations")) {
      const config = JSON.parse(options.body).config;
      assert.equal(config.ingress[0].service, "http://127.0.0.1:4621");
      assert.deepEqual(config.ingress[1], { service: "http_status:404" });
      return Response.json({ success: true, result: {} });
    }
    if (url.endsWith("/token")) return Response.json({ success: true, result: "connector-secret" });
    if (url.includes("/dns_records")) {
      if (method === "GET") return Response.json({ success: true, result: dns ? [dns] : [] });
      if (failDns) return Response.json({ success: false }, { status: 503 });
      dns = { id: "d".repeat(32), ...JSON.parse(options.body) };
      return Response.json({ success: true, result: dns });
    }
    if (method === "GET") return Response.json({ success: true, result: tunnel ? [tunnel] : [] });
    creates++; tunnel = { id: randomUUID(), name: JSON.parse(options.body).name };
    return Response.json({ success: true, result: tunnel });
  } });
  const row = { linkId: randomUUID(), port: 4621, allocation: {} };
  await assert.rejects(api.prepare(row), /Cloudflare/);
  assert.ok(row.allocation.tunnelId);
  failDns = false;
  assert.equal(await api.prepare(row), "connector-secret");
  assert.equal(creates, 1);
  assert.ok(row.allocation.dnsId);
  await assert.rejects(api.prepare({ ...row, port: "https://attacker.example" }), /port/i);
  assert.equal(requests.some(([url]) => !url.startsWith("https://api.cloudflare.com/client/v4/")), false);
});


test("Cloudflare cleanup retries a fenced tunnel while its connector drains", async () => {
  let attempts = 0;
  const provider = createCloudflare({ token: "fixture", accountId: "a".repeat(32), zoneId: "b".repeat(32), domain: "hosts.example.com", fetch: async (_url, options) => {
    assert.equal(options.method, "DELETE"); attempts++;
    return Response.json(attempts < 3 ? { success: false, errors: [{ code: 1000 }] } : { success: true, result: {} });
  } });
  await provider.remove({ allocation: { tunnelId: randomUUID() } });
  assert.equal(attempts, 3);
});


test("a revoked host confirms its durable disabled fence over its outbound signed heartbeat", { skip: !databaseUrl }, async t => {
  const f = await fixture(t, { fetch: async () => { throw new Error("Host unreachable"); } });
  const linked = (await f.register()).body;
  const revoked = await f.request("DELETE", `/v1/computers/${f.row.computerId}`);
  assert.equal(revoked.body.hostRevocationPending, true);
  const claims = { computerId: f.row.computerId, accountId: f.account, linkId: linked.linkId, generation: linked.generation, nonce: randomUUID(), probe: false, disabled: true };
  const result = await f.request("POST", `/v1/computers/${f.row.computerId}/heartbeat`, { proof: await signProof(hostKey.privateJwk, claims, "heartbeat", f.config.origin) });
  assert.equal(result.status, 200);
  assert.equal((await store.getHost(f.row.computerId)).hostRevocationPending, false);
  assert.equal((await f.request("GET", "/v1/computers")).body.computers.length, 0);
});


test("provider cleanup retry never reverses an acknowledged host revocation", { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  await f.register();
  f.tunnels.remove = async () => { throw new Error("Provider down"); };
  const first = await f.request("DELETE", `/v1/computers/${f.row.computerId}`);
  assert.equal(first.body.hostRevocationPending, false); assert.equal(first.body.cleanupPending, true);
  f.tunnels.remove = async () => {};
  // A later notification failure must not erase an existing acknowledgement.
  const saved = await store.getHost(f.row.computerId);
  saved.revocationSnapshot.publicKey = clientKey.publicJwk;
  await store.updateIfLink(saved.computerId, saved.linkId, row => { row.revocationSnapshot = saved.revocationSnapshot; });
  const retry = await f.request("DELETE", `/v1/computers/${f.row.computerId}`);
  assert.equal(retry.body.hostRevocationPending, false);
  assert.equal((await store.getHost(f.row.computerId)).hostRevocationPending, false);
});
