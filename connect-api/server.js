"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { publicKey, thumbprint, signProof, verifyProof } = require("../electron/cloud/protocol");
const { readJSON, fetchJSON } = require("../electron/cloud/http");
const { parseComputerDescriptor, DESCRIPTOR_PATH } = require("../electron/serverIdentity");
const { SCOPES } = require("../electron/webScopes");

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const ACCOUNT = /^[a-zA-Z0-9_-]{1,128}$/;
const NONCE = /^[a-zA-Z0-9_-]{16,128}$/;
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function origin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw new Error("Cloud origins must be HTTPS origins.");
  return value;
}
function binding(claims, row) {
  return claims.computerId === row.computerId && claims.accountId === row.accountId && claims.linkId === row.linkId && claims.generation === row.generation;
}
function publicComputer(row) {
  return { computerId: row.computerId, label: row.label, publicKey: row.publicKey, linkId: row.linkId, generation: row.generation,
    origin: row.allocation.hostname ? `https://${row.allocation.hostname}` : null,
    status: row.status === "online" && Date.now() - row.lastSeen > 90_000 ? "offline" : row.status,
    lastSeen: row.lastSeen, descriptor: row.descriptor ?? null };
}

function createClerkVerifier({ secretKey, clientId, fetch = globalThis.fetch }) {
  if (!secretKey || !clientId) throw new Error("Clerk verification is not configured.");
  return async token => {
    try {
      const data = await fetchJSON(fetch, "https://api.clerk.com/v1/oauth_applications/access_tokens/verify", {
        method: "POST", headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" }, body: JSON.stringify({ access_token: token }),
      });
      if (data.client_id !== clientId || typeof data.subject !== "string" || !ACCOUNT.test(data.subject) ||
          data.revoked !== false || data.expired !== false || !Number.isSafeInteger(data.expiration) || data.expiration <= Date.now() / 1000 || data.act) throw new Error();
      return data.subject;
    } catch { fail(401, "Cloud authorization failed. Sign in again."); }
  };
}

function createBroker({ store, verifyAccount, tunnels, signingKey, fetch = globalThis.fetch, config }) {
  origin(config.origin); origin(config.issuer);
  if (!config.clientId || !Number.isInteger(config.maxComputers) || config.maxComputers < 1 || config.maxComputers > 100) throw new Error("Cloud broker configuration is incomplete.");
  const { d, ...publicJwk } = signingKey;
  publicKey(publicJwk);
  const limits = new Map();
  function rate(key, max) {
    const now = Date.now();
    if (limits.size > 10_000) for (const [id, value] of limits) if (value.until <= now) limits.delete(id);
    const value = limits.get(key) ?? { count: 0, until: now + 60_000 };
    if (value.until <= now) { value.count = 0; value.until = now + 60_000; }
    if (++value.count > max || (!limits.has(key) && limits.size >= 10_000)) fail(429, "Too many cloud requests. Try again shortly.");
    limits.set(key, value);
  }
  async function owned(accountId, computerId, allowRevoked = false) {
    const row = await store.getHost(computerId);
    if (!row || row.accountId !== accountId || (row.revoked && !allowRevoked)) fail(404, "Cloud computer not found.");
    return row;
  }
  async function hostJSON(row, path, claims, purpose) {
    return fetchJSON(fetch, `https://${row.allocation.hostname}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof: await signProof(signingKey, claims, purpose, row.computerId) }),
    });
  }
  async function handle(req) {
    const path = req.url;
    if (req.method === "GET" && path === "/health") return { ok: true };
    rate(`ip:${req.socket.remoteAddress}`, 240);
    if (req.method === "GET" && path === "/v1/config") return { protocol: 1, origin: config.origin, issuer: config.issuer, clientId: config.clientId, publicKey: publicJwk };
    const match = /^\/v1\/computers\/([a-zA-Z0-9._:-]{8,128})(?:\/(connect|heartbeat))?$/.exec(path);
    if (match?.[2] === "heartbeat" && req.method === "POST") {
      const input = await readJSON(req);
      const row = await store.getHost(match[1]);
      if (!row) fail(404, "Cloud computer not found.");
      const claims = await verifyProof(input.proof, row.publicKey, { purpose: "heartbeat", audience: config.origin });
      if (claims.computerId !== row.computerId || !NONCE.test(claims.nonce)) fail(400, "Invalid host heartbeat.");
      const linked = !row.revoked && binding(claims, row);
      if (linked) {
        let descriptor;
        try {
          descriptor = parseComputerDescriptor(await fetchJSON(fetch, `https://${row.allocation.hostname}${DESCRIPTOR_PATH}`));
          if (descriptor.computerId !== row.computerId) throw new Error();
        } catch { fail(502, "Cloud host identity is not reachable."); }
        const updated = await store.updateIfLink(row.computerId, row.linkId, current => {
          if (current.revoked || !binding(claims, current)) return false;
          current.lastSeen = Date.now(); current.status = "online"; current.descriptor = descriptor;
          return true;
        });
        if (!updated) fail(409, "Cloud link changed. Check its status.");
      }
      return { proof: await signProof(signingKey, { computerId: row.computerId, linkId: claims.linkId, generation: claims.generation, nonce: claims.nonce, linked }, "heartbeat-response", row.computerId) };
    }
    const token = /^Bearer ([^\s]{1,16384})$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) fail(401, "Sign in to Solenta Cloud.");
    let accountId;
    try { accountId = await verifyAccount(token); } catch { fail(401, "Cloud authorization failed. Sign in again."); }
    if (typeof accountId !== "string" || !ACCOUNT.test(accountId)) fail(401, "Cloud authorization failed.");
    rate(`account:${accountId}`, 90);
    if (path === "/v1/computers" && req.method === "GET") return { accountId, computers: (await store.list(accountId)).map(publicComputer) };
    if (path === "/v1/computers" && req.method === "POST") {
      const input = await readJSON(req);
      if (typeof input.computerId !== "string" || !ID.test(input.computerId) || typeof input.nonce !== "string" || !NONCE.test(input.nonce) || typeof input.label !== "string" || !input.label.trim() || input.label.length > 100 ||
          !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) fail(400, "Invalid computer registration.");
      const key = publicKey(input.publicKey);
      const claims = await verifyProof(input.proof, key, { purpose: "register", audience: config.origin });
      if (claims.computerId !== input.computerId || claims.accountId !== accountId || claims.nonce !== input.nonce || claims.label !== input.label || claims.port !== input.port) fail(400, "Invalid computer registration proof.");
      const row = await store.register(accountId, { ...input, publicKey: key, keyThumbprint: await thumbprint(key), proofExpiresAt: claims.exp * 1000 }, config.maxComputers);
      const result = await store.updateIfLink(row.computerId, row.linkId, async current => {
        if (current.revoked) return null;
        for (const old of [...current.retired]) {
          try { await tunnels.remove(old); current.retired = current.retired.filter(entry => entry.linkId !== old.linkId); } catch { /* Keep failed cleanup for the next explicit retry. */ }
        }
        try {
          const connectorToken = await tunnels.prepare(current);
          if (current.status !== "online") current.status = "connecting";
          return { ...publicComputer(current), accountId, connectorToken, brokerKey: publicJwk };
        } catch {
          current.status = "setup-error";
          return { setupFailed: true };
        }
      });
      if (!result) fail(409, "Cloud link changed. Start linking again.");
      if (result.setupFailed) fail(502, "Cloud tunnel setup failed. Retry to resume setup.");
      return result;
    }
    if (!match) fail(404, "Cloud endpoint not found.");
    const row = await owned(accountId, match[1], !match[2] && req.method === "DELETE");
    if (!match[2] && req.method === "GET") return publicComputer(row);
    if (match[2] === "connect" && req.method === "POST") {
      const input = await readJSON(req);
      const jkt = await thumbprint(input.publicKey);
      const scopes = input.scopes ?? ["read"];
      if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > SCOPES.length || scopes.some(scope => !SCOPES.includes(scope)) ||
          (input.deviceId !== undefined && (typeof input.deviceId !== "string" || input.deviceId.length > 128))) fail(400, "Invalid cloud session request.");
      if (!row.allocation.hostname) fail(409, "Cloud tunnel setup is pending.");
      const claims = { computerId: row.computerId, accountId, linkId: row.linkId, generation: row.generation, jkt, nonce: randomUUID(), scopes,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}) };
      try {
        const result = await hostJSON(row, "/api/cloud/mint", claims, "mint");
        const response = await verifyProof(result.proof, row.publicKey, { purpose: "mint-response", audience: config.origin });
        if (!binding(response, row) || response.nonce !== claims.nonce || response.jkt !== jkt || typeof response.grant !== "string" || !response.grant || response.grant.length > 1024 ||
            !Number.isSafeInteger(response.expiresAt) || response.expiresAt <= Date.now() || response.expiresAt > Date.now() + 60_000) throw new Error();
        const current = await owned(accountId, row.computerId);
        if (current.linkId !== row.linkId || current.generation !== row.generation) throw new Error();
        return { ...publicComputer(row), grant: response.grant, expiresAt: response.expiresAt, proof: result.proof, nonce: claims.nonce, jkt };
      } catch { fail(502, "Cloud computer is offline or its identity could not be verified."); }
    }
    if (!match[2] && req.method === "DELETE") {
      const snapshot = await store.updateIfLink(row.computerId, row.linkId, current => {
        if (current.revoked) return current.revocationSnapshot ?? null;
        const old = { computerId: current.computerId, accountId: current.accountId, linkId: current.linkId, generation: current.generation, allocation: current.allocation, publicKey: current.publicKey };
        current.revoked = true; current.generation++; current.status = "revoked";
        current.cleanupPending = old;
        current.revocationSnapshot = old;
        current.hostRevocationPending = true;
        return old;
      });
      if (!snapshot) return { revoked: true, cleanupPending: false, hostRevocationPending: row.hostRevocationPending ?? false };
      let hostRevocationPending = false, cleanupPending = false;
      try {
        const claims = { computerId: snapshot.computerId, accountId, linkId: snapshot.linkId, generation: snapshot.generation, nonce: randomUUID() };
        const result = await hostJSON(snapshot, "/api/cloud/revoke", claims, "revoke");
        const response = await verifyProof(result.proof, snapshot.publicKey, { purpose: "revoke-response", audience: config.origin });
        if (!binding(response, snapshot) || response.nonce !== claims.nonce || response.revoked !== true) throw new Error();
      }
      catch { hostRevocationPending = true; }
      try {
        for (const old of [...(row.retired ?? []), ...(row.revoked && !row.cleanupPending ? [] : [snapshot])]) await tunnels.remove(old);
        await store.updateIfLink(snapshot.computerId, snapshot.linkId, current => {
          if (current.revoked) { delete current.cleanupPending; current.retired = []; }
        });
      } catch { cleanupPending = true; }
      await store.updateIfLink(snapshot.computerId, snapshot.linkId, current => {
        if (current.revoked) current.hostRevocationPending = hostRevocationPending;
      });
      return { revoked: true, hostRevocationPending, cleanupPending };
    }
    fail(404, "Cloud endpoint not found.");
  }
  return async (req, res) => {
    res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store"); res.setHeader("x-content-type-options", "nosniff");
    try { res.end(JSON.stringify(await handle(req))); }
    catch (error) {
      const status = error.status ?? (error.name?.startsWith("JWT") || error.name?.startsWith("JWS") || error instanceof SyntaxError || /Invalid cloud/.test(error.message) ? 400 : 500);
      res.statusCode = status;
      res.end(JSON.stringify({ error: status === 500 ? "Cloud service is unavailable." : error.message }));
    }
  };
}

async function main() {
  const { Pool } = require("pg");
  const { createStore } = require("./store");
  const { createCloudflare } = require("./cloudflare");
  const config = { origin: process.env.CONNECT_ORIGIN, issuer: process.env.CLERK_ISSUER, clientId: process.env.CLERK_CLIENT_ID, maxComputers: Number(process.env.CONNECT_MAX_COMPUTERS ?? 3) };
  if (!process.env.DATABASE_URL) throw new Error("Connect database is not configured.");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 });
  const store = createStore(pool); await store.init();
  const handler = createBroker({ store, config, signingKey: JSON.parse(process.env.CONNECT_SIGNING_JWK),
    verifyAccount: createClerkVerifier({ secretKey: process.env.CLERK_SECRET_KEY, clientId: config.clientId }),
    tunnels: createCloudflare({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID, zoneId: process.env.CLOUDFLARE_ZONE_ID, domain: process.env.CONNECT_HOST_DOMAIN }),
  });
  const server = http.createServer({ requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 20_000 }, handler);
  server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
  const close = () => server.close(() => pool.end());
  process.once("SIGTERM", close); process.once("SIGINT", close);
}
if (require.main === module) main().catch(() => { process.stderr.write("Solenta Connect failed to start. Check its secure configuration.\n"); process.exitCode = 1; });
module.exports = { createBroker, createClerkVerifier };
