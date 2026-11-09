"use strict";

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { createKeyPair, publicKey, thumbprint, signProof, verifyProof } = require("./protocol");
const { readJSON, fetchJSON } = require("./http");
const { createAuthLimiter } = require("../webBridge");

const hash = value => createHash("sha256").update(value).digest("base64url");
function createCloudHost({ dataDir, devices, descriptor, port, credentials, config, connector, account, fetch = globalThis.fetch, disconnect = () => {}, isActive = () => true }) {
  if (!dataDir) throw new Error("Cloud hosting requires its runtime's data directory.");
  const disabledFile = path.join(dataDir, "cloud-disabled");
  let state = credentials.read(), reconciled = false, connectorStarted = false, closed = false, timer, error;
  if (state?.link && fs.existsSync(disabledFile)) { state.link.enabled = false; state.link.revocationPending = true; }
  let operation = Promise.resolve();
  const limiter = createAuthLimiter();
  const exclusive = work => { const result = operation.then(work, work); operation = result.catch(() => {}); return result; };
  const matchesLink = claims => state?.link && claims.computerId === descriptor.computerId && claims.accountId === state.link.accountId &&
    claims.linkId === state.link.linkId && claims.generation === state.link.generation;
  const binding = claims => !closed && isActive() && state?.link?.enabled && reconciled && matchesLink(claims);
  function save() { return credentials.write(state); }
  function fence() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    let fd;
    try { fd = fs.openSync(disabledFile, "wx", 0o600); fs.fsyncSync(fd); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function revokeDevices() {
    if (state?.link) for (const id of devices.revokeCloud(state.link.linkId)) disconnect(id);
  }
  async function disable() {
    reconciled = false; connectorStarted = false;
    fence();
    revokeDevices();
    if (state?.link) { state.link.enabled = false; save(); }
    await connector.close();
  }
  async function reconcile(probe = false) {
    if (closed || !isActive() || !config.origin || !state?.link?.enabled) return false;
    if (state.link.brokerOrigin !== config.origin) throw new Error("Restore this computer's original broker configuration before unlinking or relinking.");
    const link = state.link, nonce = randomUUID();
    const claims = { computerId: descriptor.computerId, accountId: link.accountId, linkId: link.linkId, generation: link.generation, nonce, probe };
    const response = await fetchJSON(fetch, `${config.origin}/v1/computers/${encodeURIComponent(descriptor.computerId)}/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proof: await signProof(state.privateJwk, claims, "heartbeat", config.origin) }),
    });
    const verified = await verifyProof(response.proof, link.brokerKey, { purpose: "heartbeat-response", audience: descriptor.computerId });
    if (closed || state.link !== link) return false;
    if (verified.computerId !== descriptor.computerId || verified.linkId !== link.linkId || verified.generation !== link.generation || verified.nonce !== nonce || typeof verified.linked !== "boolean") throw new Error("Cloud link reconciliation failed its identity check.");
    if (!verified.linked) { await disable(); error = "This computer was unlinked from its cloud account."; return false; }
    reconciled = true; error = undefined;
    return true;
  }
  function schedule() {
    clearTimeout(timer);
    if (closed || !state?.link?.enabled) return;
    timer = setTimeout(() => {
      void exclusive(async () => {
        try {
          if (await reconcile(connectorStarted) && !connectorStarted) await startConnector();
        } catch { error = "Cloud account is unreachable. Existing sessions retain their original expiry."; }
        schedule();
      });
    }, 30_000);
    timer.unref?.();
  }
  async function startConnector() {
    if (closed || !state?.link?.enabled || !reconciled) return;
    await connector.start({ token: state.link.connectorToken, beforeStart: () => reconcile(false).then(ok => { if (!ok) throw new Error("Cloud link is disabled."); }) });
    connectorStarted = true;
  }
  function status() {
    return { configured: Boolean(config.origin), enabled: Boolean(state?.link?.enabled), computerId: descriptor.computerId,
      supported: connector.status().supported !== false,
      accountId: state?.link?.accountId, origin: state?.link?.origin, state: state?.link?.enabled ? (reconciled ? connector.status().state : "offline") : "unlinked",
      revocationPending: state?.link?.revocationPending === true, ...(error ? { error } : {}) };
  }
  return {
    status,
    link() { return exclusive(async () => {
      if (closed || !isActive() || !config.origin) throw new Error("Solenta Cloud is not configured or this runtime is not active.");
      if (connector.status().supported === false) throw new Error("Cloud hosting supports macOS and Linux on Intel and ARM.");
      const accountStatus = account.status();
      if (!accountStatus.signedIn) throw new Error("Sign in before enabling cloud access.");
      const localPort = typeof port === "function" ? port() : port;
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error("Start this computer's Solenta web listener before linking it.");
      if (credentials.storage() === "session") throw new Error("Cloud hosting needs persistent secure storage. Session-only desktop sign-in can still connect to other computers.");
      if (!state) state = await createKeyPair();
      if (!save()) throw new Error("Cloud signing identity could not be saved securely. No host was registered.");
      if (state.link && state.link.brokerOrigin !== config.origin) throw new Error("Restore the previous broker configuration and unlink it before changing brokers.");
      if (state.link?.revocationPending) throw new Error("Finish unlinking the previous cloud account before linking again.");
      const registration = await account.registerHost({ computerId: descriptor.computerId, label: os.hostname().slice(0, 100), port: localPort }, state);
      if (closed) throw new Error("Cloud host is shutting down.");
      const endpoint = new URL(registration.origin);
      if (registration.computerId !== descriptor.computerId || registration.accountId !== accountStatus.accountId ||
          await thumbprint(registration.publicKey) !== await thumbprint(state.publicJwk) || typeof registration.linkId !== "string" ||
          !Number.isSafeInteger(registration.generation) || registration.generation < 1 || endpoint.protocol !== "https:" || endpoint.origin !== registration.origin || endpoint.username || endpoint.password ||
          typeof registration.connectorToken !== "string" || !registration.connectorToken || registration.connectorToken.length > 16384) throw new Error("Cloud registration returned a different computer identity.");
      const brokerKey = publicKey(registration.brokerKey);
      if (state.link && state.link.linkId !== registration.linkId) revokeDevices();
      state.link = { accountId: registration.accountId, linkId: registration.linkId, generation: registration.generation, origin: registration.origin, brokerOrigin: config.origin,
        brokerKey, connectorToken: registration.connectorToken, enabled: true, revocationPending: false };
      if (!save()) throw new Error("Cloud link could not be saved securely. Restore secure storage and retry.");
      try { fs.unlinkSync(disabledFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
      reconciled = false;
      try { if (await reconcile(false)) await startConnector(); }
      catch { error = "Cloud link was saved, but its connector could not start. Retry when the broker and network are available."; }
      schedule(); return status();
    }); },
    unlink() { return exclusive(async () => {
      clearTimeout(timer);
      if (!state?.link) return { revocationPending: false };
      state.link.revocationPending = true;
      await disable();
      try {
        await account.deregister(descriptor.computerId);
        state.link.revocationPending = false; delete state.link.connectorToken; save();
        return { revocationPending: false };
      } catch { return { revocationPending: true }; }
    }); },
    start() { return exclusive(async () => {
      if (closed || !config.origin || !state?.link?.enabled) return status();
      try { if (await reconcile(false)) await startConnector(); }
      catch { error = "Cloud link cannot be verified. Its connector stays stopped until verification succeeds."; }
      schedule(); return status();
    }); },
    async handleRequest(req, res) {
      if (!["/api/cloud/mint", "/api/cloud/exchange", "/api/cloud/revoke"].includes(req.url?.split("?")[0])) return false;
      const reply = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); };
      if (closed || !isActive() || !state?.link || (req.url !== "/api/cloud/revoke" && (!state.link.enabled || !reconciled))) { reply(503, { error: "Cloud access is disabled or has not been reconciled." }); return true; }
      const remote = req.socket.remoteAddress;
      if (limiter.blocked(remote)) { reply(429, { error: "Too many cloud enrollment attempts." }); return true; }
      try {
        if (req.method !== "POST" || req.url.includes("?") || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new Error();
        const input = await readJSON(req);
        if (!isActive()) { reply(503, { error: "Cloud access waits for this runtime's activation." }); return true; }
        const link = state.link;
        if (req.url === "/api/cloud/exchange") {
          const key = publicKey(input.publicKey), jkt = await thumbprint(key);
          const claims = await verifyProof(input.proof, key, { purpose: "exchange", audience: descriptor.computerId });
          if (!binding(claims) || claims.jkt !== jkt || typeof input.grant !== "string" || !input.grant || input.grant.length > 1024 || claims.grantHash !== hash(input.grant) || typeof claims.nonce !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(claims.nonce)) throw new Error();
          const redeemed = devices.redeemCloudEnrollment({ grant: input.grant, cloud: { accountId: link.accountId, linkId: link.linkId, generation: link.generation, jkt } });
          const response = { token: redeemed.token, deviceId: redeemed.device.id, scopes: redeemed.device.scopes, expiresAt: redeemed.expiresAt, computer: descriptor };
          response.proof = await signProof(state.privateJwk, { ...claims, tokenHash: hash(response.token), deviceId: response.deviceId, scopes: response.scopes, expiresAt: response.expiresAt }, "session-response", jkt);
          reply(200, response);
        } else {
          const purpose = req.url.endsWith("/mint") ? "mint" : "revoke";
          const claims = await verifyProof(input.proof, link.brokerKey, { purpose, audience: descriptor.computerId });
          if (!isActive() || !(purpose === "revoke" ? matchesLink(claims) : binding(claims))) throw new Error();
          if (purpose === "mint") {
            const grant = devices.createCloudEnrollment({ name: "Cloud device", cloud: { accountId: link.accountId, linkId: link.linkId, generation: link.generation, jkt: claims.jkt }, nonce: claims.nonce, scopes: claims.scopes, deviceId: claims.deviceId });
            reply(200, { proof: await signProof(state.privateJwk, { ...claims, grant: grant.grant, expiresAt: grant.expiresAt }, "mint-response", config.origin) });
          } else {
            await disable();
            reply(200, { proof: await signProof(state.privateJwk, { ...claims, revoked: true }, "revoke-response", config.origin) });
          }
        }
      } catch { limiter.fail(remote); reply(400, { error: "Cloud enrollment or identity proof was rejected." }); }
      return true;
    },
    async close() { closed = true; reconciled = false; clearTimeout(timer); await connector.close(); },
  };
}

module.exports = { createCloudHost };
