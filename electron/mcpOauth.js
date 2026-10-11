"use strict";

/**
 * OAuth 2.1 + PKCE for the orch MCP endpoint (#1541).
 * Grants are pairing rows. Tokens are hashed; revoke cuts them off.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const pairing = require("./pairing.js");

const CLIENTS_FILE = "oauth-clients.json";
const ACCESS_TTL_MS = 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const NAME_MAX = 80;
const MAX_CLIENTS = 40;

/** @type {Map<string, object>} */
const consents = new Map();
/** @type {Map<string, object>} */
const codes = new Map();
/** @type {Map<string, { redirect: string }>} */
const results = new Map();

function clientsPath(userDataPath) {
  return path.join(String(userDataPath || ""), CLIENTS_FILE);
}

function loadClients(userDataPath) {
  const file = clientsPath(userDataPath);
  if (!file || file === CLIENTS_FILE || !fs.existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`oauth clients file at ${file} is not valid JSON`);
  }
  return Array.isArray(parsed && parsed.clients) ? parsed.clients.filter((c) => c && c.client_id) : [];
}

function saveClients(userDataPath, clients) {
  const file = clientsPath(userDataPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ clients }, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore
  }
}

function hostName(host) {
  const raw = String(host || "").trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end >= 0 ? raw.slice(0, end + 1) : raw;
  }
  return raw.split(":")[0];
}

function isLoopbackHost(host) {
  const h = hostName(host);
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

function issuerFromHost(host, port) {
  if (isLoopbackHost(host) || !String(host || "").trim()) {
    return `http://127.0.0.1:${port}`;
  }
  const raw = String(host).trim();
  const h = hostName(raw);
  let portPart = "";
  if (raw.startsWith("[")) {
    const idx = raw.lastIndexOf("]:");
    if (idx >= 0) portPart = raw.slice(idx + 2);
  } else {
    const parts = raw.split(":");
    if (parts.length === 2) portPart = parts[1];
  }
  if (!portPart || portPart === "443") return `https://${h}`;
  return `https://${h}:${portPart}`;
}

function authorizationServerMetadata(issuer) {
  const base = String(issuer || "").replace(/\/$/, "");
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: ["read", "launch", "steer", "read_all"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function protectedResourceMetadata(resource, issuer) {
  return {
    resource: String(resource),
    authorization_servers: [String(issuer).replace(/\/$/, "")],
    bearer_methods_supported: ["header"],
  };
}

function wwwAuthenticate(resourceMetadataUrl) {
  return `Bearer realm="Solenta", resource_metadata="${resourceMetadataUrl}"`;
}

function publicClient(row) {
  return {
    client_id: row.client_id,
    client_name: row.client_name,
    redirect_uris: row.redirect_uris.slice(),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

function sanitizeRedirects(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("redirect_uris is required");
  }
  const out = [];
  for (const item of input) {
    const uri = String(item || "").trim();
    if (!uri) continue;
    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error("redirect_uris must be absolute URLs");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("redirect_uris must be http or https");
    }
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
      throw new Error("http redirect_uris must be loopback");
    }
    out.push(uri);
    if (out.length > 8) throw new Error("At most 8 redirect_uris");
  }
  if (out.length === 0) throw new Error("redirect_uris is required");
  return out;
}

function registerClient(userDataPath, input) {
  const name = String((input && input.client_name) || "OAuth client").trim() || "OAuth client";
  if (name.length > NAME_MAX) throw new Error(`client_name must be ${NAME_MAX} characters or fewer`);
  const redirect_uris = sanitizeRedirects(input && input.redirect_uris);
  const clients = loadClients(userDataPath);
  if (clients.length >= MAX_CLIENTS) {
    throw new Error(`At most ${MAX_CLIENTS} OAuth clients`);
  }
  const row = {
    client_id: crypto.randomUUID(),
    client_name: name,
    redirect_uris,
    createdAt: Date.now(),
  };
  clients.push(row);
  saveClients(userDataPath, clients);
  return publicClient(row);
}

function getClient(userDataPath, clientId) {
  const want = String(clientId || "");
  return loadClients(userDataPath).find((c) => c.client_id === want) || null;
}

function s256(verifier) {
  return crypto.createHash("sha256").update(String(verifier)).digest("base64url");
}

function redirectWith(uri, params) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function startAuthorize(userDataPath, query) {
  const client = getClient(userDataPath, query && query.client_id);
  if (!client) throw new Error("Unknown client_id");
  const redirectUri = String((query && query.redirect_uri) || "");
  if (!client.redirect_uris.includes(redirectUri)) {
    throw new Error("redirect_uri is not registered for this client");
  }
  const challenge = String((query && query.code_challenge) || "");
  const method = String((query && query.code_challenge_method) || "");
  if (!challenge) throw new Error("code_challenge is required");
  if (method !== "S256") throw new Error("code_challenge_method must be S256");
  const id = crypto.randomUUID();
  const pending = {
    id,
    clientId: client.client_id,
    clientName: client.client_name,
    redirectUri,
    codeChallenge: challenge,
    state: query && query.state != null ? String(query.state) : null,
    createdAt: Date.now(),
  };
  consents.set(id, pending);
  return {
    id,
    clientName: client.client_name,
    redirectUri,
    state: pending.state,
  };
}

function listConsents() {
  return [...consents.values()].map((c) => ({
    id: c.id,
    clientName: c.clientName,
    redirectUri: c.redirectUri,
    createdAt: c.createdAt,
  }));
}

function takeConsent(id) {
  const want = String(id || "");
  const pending = consents.get(want);
  if (!pending) throw new Error("Unknown or expired consent request");
  consents.delete(want);
  return pending;
}

function approveConsent(userDataPath, id, grantInput, opts = {}) {
  const pending = takeConsent(id);
  const now = opts.now || Date.now();
  const created = pairing.createPairing(
    userDataPath,
    {
      name: pending.clientName,
      capabilities: grantInput && grantInput.capabilities,
      projectIds: grantInput && grantInput.projectIds,
      ttlMs: grantInput && grantInput.ttlMs,
      requireApproval: grantInput && grantInput.requireApproval,
      managedWorktree: grantInput && grantInput.managedWorktree,
      kind: "oauth",
      clientId: pending.clientId,
      accessExpiresAt: now,
    },
    { now, getOrchStatus: opts.getOrchStatus },
  );
  const code = crypto.randomBytes(32).toString("base64url");
  codes.set(code, {
    pairingId: created.pairing.id,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    expiresAt: now + CODE_TTL_MS,
  });
  const redirect = redirectWith(pending.redirectUri, {
    code,
    state: pending.state,
  });
  results.set(pending.id, { redirect });
  return { pairing: created.pairing, redirect };
}

function denyConsent(id) {
  const pending = takeConsent(id);
  const redirect = redirectWith(pending.redirectUri, {
    error: "access_denied",
    state: pending.state,
  });
  results.set(pending.id, { redirect });
  return { redirect };
}

function getConsentResult(id) {
  const want = String(id || "");
  const done = results.get(want);
  if (done) return { status: "done", redirect: done.redirect };
  if (consents.has(want)) return { status: "pending" };
  return { status: "unknown" };
}

function readCode(code, now, { consume = true } = {}) {
  const key = String(code || "");
  const row = codes.get(key);
  if (!row) throw new Error("Invalid or expired authorization code");
  if (row.expiresAt <= now) {
    codes.delete(key);
    throw new Error("Invalid or expired authorization code");
  }
  if (consume) codes.delete(key);
  return row;
}

function mintAccess(userDataPath, pairingId, now) {
  const accessToken = crypto.randomBytes(32).toString("hex");
  const accessExpiresAt = now + ACCESS_TTL_MS;
  pairing.rotateAccessToken(userDataPath, pairingId, accessToken, accessExpiresAt);
  return { accessToken, accessExpiresAt };
}

function exchangeToken(userDataPath, body, opts = {}) {
  const now = opts.now || Date.now();
  const grant = String((body && body.grant_type) || "");
  if (grant === "authorization_code") {
    const issued = readCode(body && body.code, now, { consume: false });
    if (issued.clientId !== String((body && body.client_id) || "")) {
      throw new Error("client_id does not match this code");
    }
    if (issued.redirectUri !== String((body && body.redirect_uri) || "")) {
      throw new Error("redirect_uri does not match this code");
    }
    const verifier = String((body && body.code_verifier) || "");
    if (!verifier || s256(verifier) !== issued.codeChallenge) {
      throw new Error("PKCE code_verifier does not match code_challenge");
    }
    readCode(body && body.code, now, { consume: true });
    const refreshToken = crypto.randomBytes(32).toString("hex");
    pairing.setRefreshTokenHash(userDataPath, issued.pairingId, pairing.hashToken(refreshToken));
    const access = mintAccess(userDataPath, issued.pairingId, now);
    return {
      token_type: "Bearer",
      access_token: access.accessToken,
      refresh_token: refreshToken,
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    };
  }
  if (grant === "refresh_token") {
    const row = pairing.findByRefreshToken(userDataPath, body && body.refresh_token);
    if (!row) throw new Error("Invalid refresh token");
    if (Number.isFinite(row.expiresAt) && row.expiresAt <= now) {
      throw new Error("Grant has expired");
    }
    if (row.clientId && body && body.client_id && row.clientId !== String(body.client_id)) {
      throw new Error("client_id does not match this grant");
    }
    const access = mintAccess(userDataPath, row.id, now);
    return {
      token_type: "Bearer",
      access_token: access.accessToken,
      refresh_token: String(body.refresh_token),
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    };
  }
  throw new Error("unsupported grant_type");
}

function resetForTests() {
  consents.clear();
  codes.clear();
  results.clear();
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function sendJson(res, status, body, extra) {
  res.writeHead(status, {
    "content-type": "application/json",
    ...corsHeaders(),
    ...(extra || {}),
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseTokenBody(raw, contentType) {
  const text = raw.toString("utf8");
  if (String(contentType || "").includes("application/json")) {
    return text ? JSON.parse(text) : {};
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function authorizePage(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, "");
  return `<!doctype html><meta charset="utf-8"><title>Solenta</title>
<p>Approve this connection in the Solenta app.</p>
<script>
const id = ${JSON.stringify(safe)};
async function poll() {
  const r = await fetch("/authorize/result?id=" + encodeURIComponent(id));
  const j = await r.json();
  if (j.redirect) location.replace(j.redirect);
  else setTimeout(poll, 800);
}
poll();
</script>`;
}

/**
 * OAuth + discovery routes. Returns true when the request was handled.
 */
async function handleRequest(req, res, url, deps) {
  const port = deps.port;
  const userDataPath = deps.userDataPath;
  const issuer = issuerFromHost(req.headers.host, port);
  const resource = `${issuer}/mcp`;
  const pathName = url.pathname;

  if (
    req.method === "OPTIONS" &&
    (pathName === "/register" ||
      pathName === "/token" ||
      pathName === "/authorize" ||
      pathName === "/authorize/result" ||
      pathName.startsWith("/.well-known/"))
  ) {
    res.writeHead(204, corsHeaders());
    res.end();
    return true;
  }

  if (req.method === "GET" && pathName === "/.well-known/oauth-protected-resource") {
    sendJson(res, 200, protectedResourceMetadata(resource, issuer));
    return true;
  }
  if (req.method === "GET" && pathName === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, authorizationServerMetadata(issuer));
    return true;
  }

  if (pathName === "/register" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      sendJson(res, 201, registerClient(userDataPath, body));
    } catch (err) {
      sendJson(res, 400, { error: "invalid_client_metadata", error_description: String(err.message || err) });
    }
    return true;
  }

  if (pathName === "/authorize" && req.method === "GET") {
    try {
      const pending = startAuthorize(userDataPath, {
        client_id: url.searchParams.get("client_id"),
        redirect_uri: url.searchParams.get("redirect_uri"),
        code_challenge: url.searchParams.get("code_challenge"),
        code_challenge_method: url.searchParams.get("code_challenge_method"),
        state: url.searchParams.get("state"),
      });
      if (typeof deps.notifyConsent === "function") {
        try {
          deps.notifyConsent(pending);
        } catch {
          // ignore
        }
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...corsHeaders() });
      res.end(authorizePage(pending.id));
    } catch (err) {
      sendJson(res, 400, { error: "invalid_request", error_description: String(err.message || err) });
    }
    return true;
  }

  if (pathName === "/authorize/result" && req.method === "GET") {
    const result = getConsentResult(url.searchParams.get("id"));
    if (result.status === "unknown") {
      sendJson(res, 404, { error: "unknown" });
    } else if (result.status === "pending") {
      sendJson(res, 202, { status: "pending" });
    } else {
      sendJson(res, 200, { redirect: result.redirect });
    }
    return true;
  }

  if (pathName === "/token" && req.method === "POST") {
    try {
      const body = parseTokenBody(await readBody(req), req.headers["content-type"]);
      sendJson(res, 200, exchangeToken(userDataPath, body));
    } catch (err) {
      sendJson(res, 400, { error: "invalid_grant", error_description: String(err.message || err) });
    }
    return true;
  }

  return false;
}

module.exports = {
  CLIENTS_FILE,
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  isLoopbackHost,
  issuerFromHost,
  authorizationServerMetadata,
  protectedResourceMetadata,
  wwwAuthenticate,
  registerClient,
  getClient,
  startAuthorize,
  listConsents,
  approveConsent,
  denyConsent,
  getConsentResult,
  exchangeToken,
  handleRequest,
  resetForTests,
};
