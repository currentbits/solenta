"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { createOAuth } = require("./oauth");
const { fetchJSON } = require("./http");
const { createKeyPair, publicKey, thumbprint, signProof, verifyProof } = require("./protocol");
const { parseComputerDescriptor, confirmComputer, DESCRIPTOR_PATH } = require("../serverIdentity");
const { sanitizeScopes, narrowScopes, SCOPES } = require("../webScopes");

const hash = value => createHash("sha256").update(value).digest("base64url");
function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw new Error("Cloud connection configuration is invalid.");
  return value;
}
function createCloudClient({ config, credentials, fetch = globalThis.fetch, openExternal, oauth, setTimeout: scheduleTimeout = setTimeout, clearTimeout: cancelTimeout = clearTimeout }) {
  const broker = config?.origin ? httpsOrigin(config.origin) : null;
  const sessions = new Map(), flights = new Map(), timers = new Map(), listeners = new Set();
  let generation = 0, lifecycle = new AbortController(), loginFlight, refreshFlight, closed = false, publicConfig;
  const notify = event => { for (const listener of listeners) { try { listener(event); } catch {} } };
  function active(epoch) { if (closed || epoch !== generation) throw new Error("Cloud sign-in changed or was cancelled."); }
  function record() {
    if (!broker) throw new Error("Solenta Cloud is not configured.");
    const saved = credentials.read();
    if (!saved?.oauth?.accessToken || !saved.accountId || saved.origin !== broker) throw new Error("Sign in to Solenta Cloud for this broker.");
    return saved;
  }
  async function provider() {
    if (oauth) return oauth;
    if (!broker) throw new Error("Solenta Cloud is not configured.");
    if (!publicConfig) publicConfig = await fetchJSON(fetch, `${broker}/v1/config`, { signal: lifecycle.signal });
    if (publicConfig.origin !== broker || publicConfig.protocol !== 1) throw new Error("Cloud login configuration is invalid.");
    oauth = createOAuth({ issuer: publicConfig.issuer, clientId: publicConfig.clientId, fetch, openExternal });
    return oauth;
  }
  async function access() {
    const saved = record();
    if (saved.oauth.expiresAt > Date.now() + 60_000) return saved.oauth.accessToken;
    if (!refreshFlight) {
      const epoch = generation;
      const pending = (async () => {
        const refreshed = await (await provider()).refresh(saved.oauth);
        active(epoch);
        const current = record();
        if (current.accountId !== saved.accountId || current.oauth.refreshToken !== saved.oauth.refreshToken) throw new Error("Cloud sign-in changed.");
        credentials.write({ ...current, oauth: refreshed });
        return refreshed.accessToken;
      })().finally(() => { if (refreshFlight === pending) refreshFlight = null; });
      refreshFlight = pending;
    }
    return refreshFlight;
  }
  async function api(path, method = "GET", body) {
    const epoch = generation, token = await access();
    active(epoch);
    const response = await fetchJSON(fetch, `${broker}${path}`, { method, signal: lifecycle.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    active(epoch);
    return response;
  }
  function reset() {
    generation++; lifecycle.abort(); lifecycle = new AbortController();
    for (const timer of timers.values()) cancelTimeout(timer);
    timers.clear(); sessions.clear(); flights.clear(); refreshFlight = null;
  }
  function schedule(computerId, cached, delay = cached.expiresAt - Date.now() - 60_000) {
    cancelTimeout(timers.get(computerId));
    const epoch = generation;
    const timer = scheduleTimeout(async () => {
      if (closed || epoch !== generation || sessions.get(computerId) !== cached) return;
      if (cached.expiresAt <= Date.now()) { sessions.delete(computerId); timers.delete(computerId); notify({ type: "expired", computerId }); return; }
      try { await session(computerId, { scopes: cached.scopes, renew: true }); }
      catch (error) {
        if (closed || epoch !== generation) return;
        notify({ type: "renewal-error", computerId, error: error.message });
        schedule(computerId, cached, Math.min(15_000, cached.expiresAt - Date.now()));
      }
    }, Math.max(0, delay));
    timer.unref?.(); timers.set(computerId, timer);
  }
  async function session(computerId, options = {}) {
    if (typeof computerId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(computerId)) throw new Error("Invalid cloud computer identity.");
    const saved = record(), epoch = generation, previous = sessions.get(computerId);
    const scopes = previous ? narrowScopes(previous.scopes, options.scopes ?? previous.scopes) : sanitizeScopes(options.scopes ?? ["full"]);
    if (!options.renew && previous && previous.expiresAt > Date.now() + 60_000 && JSON.stringify(previous.scopes) === JSON.stringify(scopes)) return structuredClone(previous);
    if (flights.has(computerId)) {
      const pending = flights.get(computerId);
      if (JSON.stringify(pending.scopes) !== JSON.stringify(scopes)) throw new Error("A different cloud access request is in progress. Try again shortly.");
      return structuredClone(await pending.promise);
    }
    const flight = (async () => {
      const clientPublicKey = publicKey({ kty: saved.proofKey.kty, crv: saved.proofKey.crv, x: saved.proofKey.x });
      const jkt = await thumbprint(clientPublicKey);
      const mint = await api(`/v1/computers/${encodeURIComponent(computerId)}/connect`, "POST", { publicKey: clientPublicKey, scopes, ...(previous ? { deviceId: previous.deviceId } : {}) });
      const origin = httpsOrigin(mint.origin);
      const proof = await verifyProof(mint.proof, mint.publicKey, { purpose: "mint-response", audience: broker });
      if (mint.computerId !== computerId || proof.computerId !== computerId || proof.accountId !== saved.accountId || proof.linkId !== mint.linkId || proof.generation !== mint.generation ||
          !Number.isSafeInteger(mint.generation) || mint.generation < 1 || typeof mint.linkId !== "string" ||
          proof.jkt !== jkt || typeof mint.nonce !== "string" || proof.nonce !== mint.nonce || proof.grant !== mint.grant ||
          !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt !== mint.expiresAt || proof.expiresAt <= Date.now() || proof.expiresAt > Date.now() + 60_000) throw new Error("Cloud host authorization identity mismatch.");
      const descriptor = parseComputerDescriptor(await fetchJSON(fetch, `${origin}${DESCRIPTOR_PATH}`, { signal: lifecycle.signal }));
      if (descriptor.computerId !== computerId) throw new Error("Cloud computer identity mismatch.");
      active(epoch);
      const nonce = randomUUID();
      const claims = { computerId, accountId: saved.accountId, linkId: mint.linkId, generation: mint.generation, jkt, grantHash: hash(mint.grant), nonce };
      const response = await fetchJSON(fetch, `${origin}/api/cloud/exchange`, { method: "POST", signal: lifecycle.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant: mint.grant, publicKey: clientPublicKey, proof: await signProof(saved.proofKey, claims, "exchange", computerId) }) });
      const verified = await verifyProof(response.proof, mint.publicKey, { purpose: "session-response", audience: jkt });
      if (typeof response.token !== "string" || !response.token || response.token.length > 1024 || typeof response.deviceId !== "string" || !response.deviceId || response.deviceId.length > 128 ||
          !Number.isSafeInteger(response.expiresAt) || response.expiresAt <= Date.now() || response.expiresAt > Date.now() + 600_000 ||
          !Array.isArray(response.scopes) || !response.scopes.length || response.scopes.some(scope => !SCOPES.includes(scope)) ||
          verified.nonce !== nonce || verified.computerId !== computerId || verified.accountId !== saved.accountId || verified.linkId !== mint.linkId || verified.generation !== mint.generation ||
          verified.tokenHash !== hash(response.token) || verified.deviceId !== response.deviceId || verified.expiresAt !== response.expiresAt || JSON.stringify(verified.scopes) !== JSON.stringify(response.scopes) ||
          (previous && response.deviceId !== previous.deviceId)) throw new Error("Cloud session identity mismatch.");
      narrowScopes(scopes, response.scopes);
      const computer = confirmComputer(descriptor, response.computer, computerId);
      active(epoch);
      if (record().accountId !== saved.accountId) throw new Error("Cloud sign-in changed.");
      const next = { computerId, accountId: saved.accountId, origin, deviceId: response.deviceId, token: response.token, scopes: response.scopes, expiresAt: response.expiresAt, computer };
      sessions.set(computerId, next); schedule(computerId, next);
      notify({ type: "session", computerId, session: structuredClone(next) });
      return next;
    })();
    const pending = { promise: flight, scopes };
    flights.set(computerId, pending);
    try { return structuredClone(await flight); } finally { if (flights.get(computerId) === pending) flights.delete(computerId); }
  }
  return {
    status() {
      try { const saved = broker ? credentials.read() : null; const signedIn = Boolean(saved?.accountId && saved.origin === broker); return { configured: Boolean(broker), signedIn, ...(signedIn ? { accountId: saved.accountId } : {}), storage: credentials.storage() }; }
      catch (error) { return { configured: Boolean(broker), signedIn: false, error: error.message, storage: credentials.storage() }; }
    },
    async login(options = {}) {
      if (closed) throw new Error("Cloud connection is closed.");
      if (!loginFlight) {
        const epoch = generation;
        loginFlight = (async () => {
          const auth = await (await provider()).login({ ...options, signal: AbortSignal.any([options.signal ?? new AbortController().signal, lifecycle.signal]) });
          active(epoch);
          const result = await fetchJSON(fetch, `${broker}/v1/computers`, { signal: lifecycle.signal, headers: { authorization: `Bearer ${auth.accessToken}` } });
          if (typeof result.accountId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.accountId)) throw new Error("Cloud account identity is invalid.");
          const pair = await createKeyPair();
          active(epoch);
          credentials.write({ origin: broker, accountId: result.accountId, oauth: auth, proofKey: pair.privateJwk });
          reset();
          notify({ type: "account", signedIn: true, accountId: result.accountId });
          return this.status();
        })().finally(() => { loginFlight = null; });
      }
      return loginFlight;
    },
    async logout() {
      const saved = credentials.read(); reset(); credentials.clear(); notify({ type: "account", signedIn: false });
      if (!saved?.oauth) return { revocationPending: false };
      if (saved.origin !== broker) return { revocationPending: true };
      try { await (await provider()).revoke(saved.oauth); return { revocationPending: false }; }
      catch { return { revocationPending: true }; }
    },
    async computers() {
      const saved = record();
      const result = await api("/v1/computers");
      if (result.accountId !== saved.accountId || !Array.isArray(result.computers)) throw new Error("Cloud account identity mismatch.");
      return result.computers;
    },
    session,
    async deregister(computerId) {
      const result = await api(`/v1/computers/${encodeURIComponent(computerId)}`, "DELETE");
      cancelTimeout(timers.get(computerId)); timers.delete(computerId); sessions.delete(computerId);
      notify({ type: "unlinked", computerId });
      return result;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { closed = true; reset(); listeners.clear(); },
  };
}

module.exports = { createCloudClient };
