"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createOAuth } = require("../cloud/oauth");

const issuer = "https://github.com";
const brokerOrigin = "https://connect.example.com";
const tokens = { access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer", expires_in: 3600 };

test("desktop PKCE callback refuses wrong state and duplicate use; tokens stay off the browser URL", async () => {
  let auth, exchanges = 0;
  const oauth = createOAuth({ issuer, brokerOrigin, clientId: "public-client", fetch: async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(url, `${brokerOrigin}/v1/oauth/token`);
    assert.equal(options.headers.accept, "application/json");
    exchanges++;
    const body = new URLSearchParams(options.headers["content-type"] === "application/json" ? JSON.parse(options.body) : options.body);
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
    assert.equal(auth.searchParams.get("scope"), "offline_access");
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
  const oauth = createOAuth({ issuer, brokerOrigin, clientId: "public-client", fetch: async () => assert.fail("cancelled login must not exchange tokens"), openExternal: async value => {
    redirect = new URL(value).searchParams.get("redirect_uri");
    controller.abort();
  } });
  await assert.rejects(oauth.login({ signal: controller.signal }), /abort|cancel/i);
  await assert.rejects(fetch(redirect));
});

test("GitHub configuration refuses alternate issuers and unsafe broker origins", () => {
  for (const config of [{ issuer: "https://wrong.example.com", brokerOrigin }, { issuer, brokerOrigin: "http://connect.example.com" }, { issuer, brokerOrigin: "https://user@connect.example.com" }]) {
    assert.throws(() => createOAuth({ ...config, clientId: "public-client" }), /configuration|issuer|origin/i);
  }
});

test("headless grant honors polling interval and slow_down without PKCE or callback", async () => {
  const requests = [], publicCodes = [];
  const oauth = createOAuth({ issuer, brokerOrigin, clientId: "public-client", fetch: async (url, options) => {
    const body = new URLSearchParams(options.headers["content-type"] === "application/json" ? JSON.parse(options.body) : options.body);
    assert.equal(body.has("client_secret"), false);
    assert.equal(body.has("code_verifier"), false);
    assert.equal(body.has("redirect_uri"), false);
    if (url.endsWith("/login/device/code")) { assert.equal(body.get("scope"), "offline_access"); return Response.json({ device_code: "private-device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 30 }); }
    assert.equal(url, "https://github.com/login/oauth/access_token");
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

test("device denial ends polling; refresh uses the broker and requires token rotation", async () => {
  let polls = 0;
  const oauth = createOAuth({ issuer, brokerOrigin, clientId: "public-client", fetch: async (url, options) => {
    if (url.endsWith("/login/device/code")) return Response.json({ device_code: "private-code", user_code: "ABCD", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 10 });
    if (url === `${brokerOrigin}/v1/oauth/token`) {
      assert.equal(JSON.parse(options.body).grant_type, "refresh_token");
      assert.equal(JSON.parse(options.body).refresh_token, "previous-refresh");
      return Response.json({ ...tokens, refresh_token: undefined });
    }
    polls++;
    return Response.json({ error: "access_denied", error_description: "untrusted server text" }, { status: 400 });
  } });
  await assert.rejects(oauth.login({ headless: true, onCode: () => {} }), /denied/i);
  assert.equal(polls, 1);
  await assert.rejects(oauth.refresh({ refreshToken: "previous-refresh" }), /credentials/i);
});

test("an expired device code is never polled again", async () => {
  let polls = 0;
  const oauth = createOAuth({ issuer, brokerOrigin, clientId: "public-client", fetch: async url => {
    if (url.endsWith("/login/device/code")) return Response.json({ device_code: "private-code", user_code: "ABCD", verification_uri: "https://github.com/login/device", interval: 2, expires_in: 1 });
    polls++; return Response.json(tokens);
  } });
  await assert.rejects(oauth.login({ headless: true, onCode: () => {} }), /expired/);
  assert.equal(polls, 0);
});

test("headless login refuses verification links outside GitHub before displaying a code", async () => {
  for (const uri of ["https://evil.example.com/login/device", "https://github.com/evil", "https://user@github.com/login/device"]) {
    const oauth = createOAuth({ issuer, brokerOrigin, clientId: "public-client", fetch: async () => Response.json({ device_code: "private-code", user_code: "ABCD", verification_uri: uri, expires_in: 900 }), });
    await assert.rejects(oauth.login({ headless: true, onCode: () => assert.fail("untrusted code must not be shown") }), /verification|authorization|endpoint/i);
  }
});

test("refresh rejects repository permissions and sign-out revokes only this login through the broker", async () => {
  const requests = [];
  const oauth = createOAuth({ issuer, brokerOrigin, clientId: "public-client", fetch: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/revoke")) return Response.json({ revoked: true });
    return Response.json({ ...tokens, scope: "repo" });
  } });
  await assert.rejects(oauth.refresh({ refreshToken: "old-refresh" }), /permission|credentials/i);
  await oauth.revoke({ accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: Date.now() + 60_000 });
  assert.equal(requests[1].url, `${brokerOrigin}/v1/oauth/revoke`);
  assert.equal(requests[1].options.headers.authorization, "Bearer access-secret");
  assert.equal(JSON.stringify(requests[1]).includes("refresh-secret"), false);
});
