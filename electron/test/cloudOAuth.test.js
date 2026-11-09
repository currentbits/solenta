"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createOAuth } = require("../cloud/oauth");

const issuer = "https://identity.example.com";
const metadata = { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, revocation_endpoint: `${issuer}/oauth/revoke`, device_authorization_endpoint: `${issuer}/oauth/device_authorization`, code_challenge_methods_supported: ["S256"] };
const tokens = { access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer", expires_in: 3600 };

test("desktop PKCE callback refuses wrong state and duplicate use; tokens stay off the browser URL", async () => {
  let auth, exchanges = 0;
  const oauth = createOAuth({ issuer, clientId: "public-client", fetch: async (url, options) => {
    assert.equal(options.redirect, "error");
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json(metadata);
    exchanges++;
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("client_secret"), null);
    assert.equal(body.get("client_id"), "public-client");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "one-use-code");
    assert.equal(createHash("sha256").update(body.get("code_verifier")).digest("base64url"), auth.searchParams.get("code_challenge"));
    return Response.json(tokens);
  }, openExternal: async value => {
    auth = new URL(value);
    assert.equal(auth.origin, issuer);
    assert.equal(auth.searchParams.get("response_type"), "code");
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.equal(auth.searchParams.has("client_secret"), false);
    const callback = new URL(auth.searchParams.get("redirect_uri"));
    assert.equal(callback.hostname, "127.0.0.1");
    callback.search = new URLSearchParams({ code: "one-use-code", state: "wrong" });
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set("state", auth.searchParams.get("state"));
    const valid = await fetch(callback);
    assert.equal(valid.status, 200);
    assert.equal((await valid.text()).includes("secret"), false);
    try { assert.equal((await fetch(callback)).status, 409); } catch (error) { if (error.name !== "TypeError") throw error; }
  } });
  const result = await oauth.login({});
  assert.equal(result.accessToken, tokens.access_token);
  assert.equal(result.refreshToken, tokens.refresh_token);
  assert.ok(result.expiresAt > Date.now() + 3_500_000);
  assert.equal(exchanges, 1);
});

test("desktop login cancellation closes its loopback and returns no credential", async () => {
  const controller = new AbortController();
  let redirect;
  const oauth = createOAuth({ issuer, clientId: "public-client", fetch: async () => Response.json(metadata), openExternal: async value => {
    redirect = new URL(value).searchParams.get("redirect_uri");
    controller.abort();
  } });
  await assert.rejects(oauth.login({ signal: controller.signal }), /abort|cancel/i);
  await assert.rejects(fetch(redirect));
});

test("discovery refuses issuer changes and credential endpoints on another origin", async () => {
  for (const data of [{ ...metadata, issuer: "https://wrong.example.com" }, { ...metadata, token_endpoint: "https://wrong.example.com/token" }]) {
    const oauth = createOAuth({ issuer, clientId: "public-client", fetch: async () => Response.json(data), openExternal: () => assert.fail("must not open unverified authorization") });
    await assert.rejects(oauth.login({}), /configuration|issuer|endpoint/i);
  }
});

test("headless grant honors polling interval and slow_down without PKCE or callback", async () => {
  const requests = [], publicCodes = [];
  const oauth = createOAuth({ issuer, clientId: "public-client", fetch: async (url, options) => {
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json(metadata);
    const body = new URLSearchParams(options.body);
    assert.equal(body.has("client_secret"), false);
    assert.equal(body.has("code_verifier"), false);
    assert.equal(body.has("redirect_uri"), false);
    if (url.endsWith("/device_authorization")) return Response.json({ device_code: "private-device-code", user_code: "ABCD-EFGH", verification_uri: "https://accounts.example.com/device", interval: 1, expires_in: 30 });
    assert.equal(body.get("device_code"), "private-device-code");
    requests.push(Date.now());
    if (requests.length === 1) return Response.json({ error: "slow_down" }, { status: 400 });
    return Response.json(tokens);
  }, openExternal: () => assert.fail("headless must not open a local browser") });
  const started = Date.now();
  const result = await oauth.login({ headless: true, onCode: code => publicCodes.push(code) });
  assert.equal(result.accessToken, tokens.access_token);
  assert.ok(requests[0] - started >= 950);
  assert.ok(requests[1] - requests[0] >= 5950);
  assert.equal(publicCodes[0].userCode, "ABCD-EFGH");
  assert.equal(JSON.stringify(publicCodes).includes("private-device-code"), false);
});

test("device expiry or denial ends polling; refresh preserves a non-rotated refresh token", async () => {
  let polls = 0;
  const oauth = createOAuth({ issuer, clientId: "public-client", fetch: async (url, options) => {
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json(metadata);
    if (url.endsWith("/device_authorization")) return Response.json({ device_code: "private-code", user_code: "ABCD", verification_uri: "https://accounts.example.com/device", interval: 1, expires_in: 10 });
    if (new URLSearchParams(options.body).get("grant_type") === "refresh_token") return Response.json({ ...tokens, refresh_token: undefined });
    polls++;
    return Response.json({ error: "access_denied", error_description: "untrusted server text" }, { status: 400 });
  } });
  await assert.rejects(oauth.login({ headless: true, onCode: () => {} }), /denied/i);
  assert.equal(polls, 1);
  assert.equal((await oauth.refresh({ refreshToken: "previous-refresh" })).refreshToken, "previous-refresh");
});

test("an expired device code is never polled again", async () => {
  let polls = 0;
  const oauth = createOAuth({ issuer, clientId: "public-client", fetch: async url => {
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json(metadata);
    if (url.endsWith("/device_authorization")) return Response.json({ device_code: "private-code", user_code: "ABCD", verification_uri: "https://accounts.example.com/device", interval: 2, expires_in: 1 });
    polls++; return Response.json(tokens);
  } });
  await assert.rejects(oauth.login({ headless: true, onCode: () => {} }), /expired/);
  assert.equal(polls, 0);
});
