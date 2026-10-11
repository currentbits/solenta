/**
 * OAuth 2.1 + PKCE for /mcp (#1541).
 * Run: node --test electron/test/mcp-oauth.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const oauth = require("../mcpOauth.js");
const pairing = require("../pairing.js");

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-mcp-oauth-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function verifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function challenge(v) {
  return crypto.createHash("sha256").update(v).digest("base64url");
}

function register(over = {}) {
  return oauth.registerClient(tmp, {
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
    ...over,
  });
}

describe("mcp oauth metadata", () => {
  it("describes a public-client AS and points the resource at it", () => {
    const issuer = "https://mac.tail1.ts.net:8443";
    const as = oauth.authorizationServerMetadata(issuer);
    assert.equal(as.issuer, issuer);
    assert.equal(as.authorization_endpoint, `${issuer}/authorize`);
    assert.equal(as.token_endpoint, `${issuer}/token`);
    assert.equal(as.registration_endpoint, `${issuer}/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
    assert.ok(as.grant_types_supported.includes("authorization_code"));
    assert.ok(as.grant_types_supported.includes("refresh_token"));

    const pr = oauth.protectedResourceMetadata(`${issuer}/mcp`, issuer);
    assert.equal(pr.resource, `${issuer}/mcp`);
    assert.deepEqual(pr.authorization_servers, [issuer]);
    assert.deepEqual(pr.bearer_methods_supported, ["header"]);
  });

  it("treats a Tailscale Funnel Host as public HTTPS and loopback as http", () => {
    assert.equal(
      oauth.issuerFromHost("mac.tail1.ts.net:8443", 7422),
      "https://mac.tail1.ts.net:8443",
    );
    assert.equal(oauth.issuerFromHost("mac.tail1.ts.net", 7422), "https://mac.tail1.ts.net");
    assert.equal(oauth.issuerFromHost("127.0.0.1:7422", 7422), "http://127.0.0.1:7422");
    assert.equal(oauth.isLoopbackHost("127.0.0.1:7422"), true);
    assert.equal(oauth.isLoopbackHost("mac.tail1.ts.net:8443"), false);
    assert.equal(oauth.isLoopbackHost(""), false);
    assert.equal(oauth.isLoopbackHost(undefined), false);
  });
});

describe("mcp oauth grants", () => {
  it("registers a public client with no secret and rejects an unknown redirect", () => {
    const client = register();
    assert.ok(client.client_id);
    assert.equal(client.client_secret, undefined);
    assert.equal(client.token_endpoint_auth_method, "none");
    assert.throws(
      () => register({ redirect_uris: ["http://evil.example/cb"] }),
      /loopback/,
    );
    const local = register({
      client_name: "Local",
      redirect_uris: ["http://127.0.0.1:54321/cb"],
    });
    assert.ok(local.client_id);
    const file = path.join(tmp, oauth.CLIENTS_FILE);
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))).includes("secret"), false);

    const v = verifier();
    assert.throws(
      () =>
        oauth.startAuthorize(tmp, {
          client_id: client.client_id,
          redirect_uri: "https://evil.example/cb",
          code_challenge: challenge(v),
          code_challenge_method: "S256",
          state: "s1",
        }),
      /redirect/i,
    );
  });

  it("requires PKCE S256 and maps an approved grant onto a pairing row", () => {
    const client = register();
    const v = verifier();
    assert.throws(
      () =>
        oauth.startAuthorize(tmp, {
          client_id: client.client_id,
          redirect_uri: client.redirect_uris[0],
          state: "s1",
        }),
      /code_challenge/,
    );

    const pending = oauth.startAuthorize(tmp, {
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: challenge(v),
      code_challenge_method: "S256",
      state: "s1",
    });
    assert.ok(pending.id);
    assert.equal(pending.clientName, "ChatGPT");
    assert.equal(oauth.listConsents().length, 1);

    const approved = oauth.approveConsent(tmp, pending.id, {
      capabilities: ["read", "launch"],
      projectIds: ["p1"],
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    });
    assert.match(approved.redirect, /code=/);
    assert.match(approved.redirect, /state=s1/);
    assert.equal(oauth.listConsents().length, 0);

    const listed = pairing.listPairings(tmp);
    assert.equal(listed.pairings.length, 1);
    assert.equal(listed.pairings[0].name, "ChatGPT");
    assert.deepEqual(listed.pairings[0].capabilities, ["read", "launch"]);
    assert.deepEqual(listed.pairings[0].projectIds, ["p1"]);
    assert.equal(listed.pairings[0].kind, "oauth");
  });

  it("exchanges a code with the verifier, then revoke cuts the access token off", () => {
    const client = register();
    const v = verifier();
    const pending = oauth.startAuthorize(tmp, {
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: challenge(v),
      code_challenge_method: "S256",
      state: "st",
    });
    const approved = oauth.approveConsent(tmp, pending.id, {
      capabilities: ["read", "launch"],
    });
    const code = new URL(approved.redirect).searchParams.get("code");

    assert.throws(
      () =>
        oauth.exchangeToken(tmp, {
          grant_type: "authorization_code",
          code,
          redirect_uri: client.redirect_uris[0],
          client_id: client.client_id,
          code_verifier: "wrong-verifier-value-that-is-long-enough",
        }),
      /verifier|pkce|challenge/i,
    );

    const tokens = oauth.exchangeToken(tmp, {
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirect_uris[0],
      client_id: client.client_id,
      code_verifier: v,
    });
    assert.equal(tokens.token_type, "Bearer");
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.ok(tokens.expires_in > 0);
    assert.ok(tokens.expires_in <= 3600);

    const ok = pairing.authorizeToken(tmp, tokens.access_token);
    assert.equal(ok.ok, true);
    assert.equal(ok.pairing.kind, "oauth");

    pairing.revokePairing(tmp, pairing.listPairings(tmp).pairings[0].id);
    assert.equal(pairing.authorizeToken(tmp, tokens.access_token).ok, false);
  });

  it("refresh rotates the access token and a spent code cannot be reused", () => {
    const client = register();
    const v = verifier();
    const pending = oauth.startAuthorize(tmp, {
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: challenge(v),
      code_challenge_method: "S256",
    });
    const approved = oauth.approveConsent(tmp, pending.id, { capabilities: ["read"] });
    const code = new URL(approved.redirect).searchParams.get("code");
    const first = oauth.exchangeToken(tmp, {
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirect_uris[0],
      client_id: client.client_id,
      code_verifier: v,
    });
    assert.throws(
      () =>
        oauth.exchangeToken(tmp, {
          grant_type: "authorization_code",
          code,
          redirect_uri: client.redirect_uris[0],
          client_id: client.client_id,
          code_verifier: v,
        }),
      /code/i,
    );

    const now = Date.now();
    assert.equal(
      pairing.authorizeToken(tmp, first.access_token, {
        now: now + oauth.ACCESS_TTL_MS + 1,
      }).ok,
      false,
    );

    const refreshed = oauth.exchangeToken(tmp, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: client.client_id,
    });
    assert.notEqual(refreshed.access_token, first.access_token);
    assert.equal(pairing.authorizeToken(tmp, first.access_token).ok, false);
    assert.equal(pairing.authorizeToken(tmp, refreshed.access_token).ok, true);
  });

  it("deny redirects with access_denied and mints no pairing", () => {
    const client = register();
    const v = verifier();
    const pending = oauth.startAuthorize(tmp, {
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: challenge(v),
      code_challenge_method: "S256",
      state: "nope",
    });
    const denied = oauth.denyConsent(pending.id);
    assert.match(denied.redirect, /error=access_denied/);
    assert.match(denied.redirect, /state=nope/);
    assert.equal(pairing.listPairings(tmp).pairings.length, 0);
  });
});
