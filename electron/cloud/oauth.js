"use strict";

const http = require("node:http");
const { randomBytes, createHash } = require("node:crypto");
const { setTimeout: wait } = require("node:timers/promises");
const { readJSON, fetchJSON } = require("./http");

const LOGIN_MS = 10 * 60_000;
function httpsURL(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Invalid OAuth endpoint configuration.");
  return url;
}
function createOAuth({ issuer, clientId, fetch = globalThis.fetch, openExternal, now = Date.now }) {
  const issuerURL = httpsURL(issuer);
  if (issuerURL.origin !== issuer || typeof clientId !== "string" || !clientId || clientId.length > 256) throw new Error("Invalid OAuth issuer configuration.");
  let discovery;
  async function metadata(signal) {
    if (!discovery) discovery = fetchJSON(fetch, `${issuer}/.well-known/openid-configuration`, { signal }).then(data => {
      if (data.issuer !== issuer || !data.code_challenge_methods_supported?.includes("S256")) throw new Error("Invalid OAuth issuer configuration.");
      for (const key of ["authorization_endpoint", "token_endpoint", "revocation_endpoint", "device_authorization_endpoint"]) {
        if (data[key] !== undefined && httpsURL(data[key]).origin !== issuer) throw new Error("Invalid OAuth endpoint configuration.");
      }
      if (!data.authorization_endpoint || !data.token_endpoint) throw new Error("OAuth configuration is incomplete.");
      return data;
    }).catch(error => { discovery = undefined; throw error; });
    return discovery;
  }
  async function post(endpoint, body, signal) {
    const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]),
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, ...body }).toString() });
    const data = await readJSON(response.body);
    if (!response.ok || data.error) {
      const code = ["authorization_pending", "slow_down", "access_denied", "expired_token", "invalid_grant", "invalid_client"].includes(data.error) ? data.error : "request_failed";
      throw Object.assign(new Error(`Cloud sign-in ${code === "access_denied" ? "was denied" : "failed"} (${code}).`), { oauthCode: code });
    }
    return data;
  }
  function credential(data, previous) {
    const valid = value => typeof value === "string" && value.length > 0 && value.length <= 16384;
    const refreshToken = data.refresh_token ?? previous?.refreshToken;
    if (!valid(data.access_token) || !valid(refreshToken) || data.token_type?.toLowerCase() !== "bearer" ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 7 * 86400) throw new Error("The OAuth server returned invalid credentials.");
    return { accessToken: data.access_token, refreshToken, expiresAt: now() + data.expires_in * 1000 };
  }
  async function desktop(data, signal) {
    if (!openExternal) throw new Error("Desktop browser sign-in is unavailable.");
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    let resolveCode, rejectCode, consumed = false;
    const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    code.catch(() => {});
    const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10_000 }, (req, res) => {
      const send = (status, message) => { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", connection: "close" }); res.end(message); };
      let callback;
      try { callback = new URL(req.url, "http://127.0.0.1"); } catch { return send(400, "Invalid callback URL."); }
      if (req.method !== "GET" || callback.pathname !== "/callback" || req.headers.host !== `127.0.0.1:${server.address().port}`) return send(404, "Not found.");
      if (consumed) return send(409, "This sign-in callback has already been used.");
      if (callback.searchParams.getAll("state").length !== 1 || callback.searchParams.get("state") !== state) return send(400, "This sign-in link is invalid. Return to Solenta.");
      if (callback.searchParams.has("error")) { consumed = true; send(400, "Sign-in was denied. Return to Solenta."); rejectCode(new Error("Cloud sign-in was denied.")); return; }
      const received = callback.searchParams.get("code");
      if (!received || received.length > 4096 || callback.searchParams.getAll("code").length !== 1) return send(400, "Missing authorization code.");
      consumed = true; send(200, "Signed in. You can close this tab and return to Solenta."); resolveCode(received);
    });
    const abort = () => rejectCode(signal.reason ?? new Error("Cloud sign-in cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const redirect = `http://127.0.0.1:${server.address().port}/callback`;
      const url = new URL(data.authorization_endpoint);
      url.search = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirect, scope: "openid profile email offline_access", state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
      await openExternal(url.toString());
      const authorizationCode = await code;
      return credential(await post(data.token_endpoint, { grant_type: "authorization_code", code: authorizationCode, redirect_uri: redirect, code_verifier: verifier }, signal));
    } finally { signal.removeEventListener("abort", abort); server.close(); server.closeAllConnections(); }
  }
  async function device(data, { onCode, signal }) {
    if (!data.device_authorization_endpoint || !onCode) throw new Error("Headless cloud sign-in requires device authorization and a code display.");
    const auth = await post(data.device_authorization_endpoint, { scope: "openid profile email offline_access" }, signal);
    if (typeof auth.device_code !== "string" || !auth.device_code || auth.device_code.length > 4096 || typeof auth.user_code !== "string" || !auth.user_code || auth.user_code.length > 128 ||
        !Number.isFinite(auth.expires_in) || auth.expires_in <= 0 || auth.expires_in > 3600 ||
        (auth.interval !== undefined && (!Number.isFinite(auth.interval) || auth.interval <= 0 || auth.interval > 3600))) throw new Error("Invalid OAuth device authorization response.");
    const verificationUri = httpsURL(auth.verification_uri).toString();
    const verificationUriComplete = auth.verification_uri_complete ? httpsURL(auth.verification_uri_complete).toString() : undefined;
    const expiresAt = now() + auth.expires_in * 1000;
    let interval = (auth.interval ?? 5) * 1000;
    await onCode({ verificationUri, verificationUriComplete, userCode: auth.user_code, expiresAt });
    while (now() < expiresAt) {
      await wait(Math.min(interval, expiresAt - now()), undefined, { signal });
      if (now() >= expiresAt) break;
      try { return credential(await post(data.token_endpoint, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: auth.device_code }, signal)); }
      catch (error) {
        if (error.oauthCode === "slow_down") interval += 5000;
        else if (error.oauthCode !== "authorization_pending") throw error;
      }
    }
    throw new Error("Cloud sign-in code expired. Start sign-in again.");
  }
  return {
    async login(options = {}) {
      const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.headless ? 3600_000 : LOGIN_MS)]);
      const data = await metadata(signal);
      return options.headless ? device(data, { ...options, signal }) : desktop(data, signal);
    },
    async refresh(previous) {
      if (!previous?.refreshToken) throw new Error("Cloud sign-in expired. Sign in again.");
      const data = await metadata();
      return credential(await post(data.token_endpoint, { grant_type: "refresh_token", refresh_token: previous.refreshToken }), previous);
    },
    async revoke(previous) {
      const data = await metadata();
      if (!data.revocation_endpoint) throw new Error("OAuth token revocation is unavailable.");
      const response = await fetch(data.revocation_endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, token: previous.refreshToken, token_type_hint: "refresh_token" }).toString() });
      if (!response.ok) throw new Error("Cloud sign-out could not revoke the server credential.");
    },
  };
}

module.exports = { createOAuth };
