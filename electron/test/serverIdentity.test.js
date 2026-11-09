"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Worker } = require("node:worker_threads");
const { WebSocketServer } = require("ws");
const { loadOrCreateComputerId, computerDescriptor } = require("../serverIdentity.js");
const { probeToken, createTokenStore, openHostTunnel } = require("../remoteConnections.js");

const descriptor = (id = "computer-one") => ({ kind: "solenta", computerId: id, protocol: { min: 1, max: 1 }, runtimeKind: "server" });
async function host(publicIdentity, authenticatedIdentity = publicIdentity, status = 200) {
  const received = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/.well-known/solenta");
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(publicIdentity));
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => ws.on("message", (raw) => {
    received.push(JSON.parse(String(raw)));
    ws.send(JSON.stringify({ kind: "auth-ok", ...(authenticatedIdentity ? { computer: authenticatedIdentity } : {}) }));
  }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { received, url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  } };
}

describe("computer identity", () => {
  it("persists one opaque ID per data directory across concurrent initializers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-id-"));
    try {
      const modulePath = require.resolve("../serverIdentity.js");
      const ids = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
        const worker = new Worker(`require('node:worker_threads').parentPort.postMessage(require(${JSON.stringify(modulePath)}).loadOrCreateComputerId(${JSON.stringify(dir)}))`, { eval: true });
        worker.once("message", resolve); worker.once("error", reject);
      })));
      assert.equal(new Set(ids).size, 1);
      assert.equal(loadOrCreateComputerId(dir), ids[0]);
      assert.equal(fs.statSync(path.join(dir, "computer-id")).mode & 0o777, 0o600);
      assert.notEqual(loadOrCreateComputerId(path.join(dir, "other")), ids[0]);
      fs.writeFileSync(path.join(dir, "computer-id"), "");
      assert.throws(() => loadOrCreateComputerId(dir), /identity file is invalid/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("publishes only factual nonsensitive build fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-id-"));
    try {
      const d = computerDescriptor(dir, { pkg: { version: "1.2.3", token: "private", path: dir }, runtimeKind: "server" });
      assert.deepEqual(Object.keys(d).sort(), ["capabilities", "computerId", "kind", "protocol", "runtimeKind", "version"]);
      assert.equal(d.runtimeKind, "server");
      assert.equal(JSON.stringify(d).includes(dir), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("blocks an address reassignment before sending any saved credential", async () => {
    const remote = await host(descriptor("computer-two"));
    try {
      await assert.rejects(probeToken(remote.url, "secret", { computerId: "computer-one", allowLegacy: true }), /identity mismatch/);
      assert.equal(remote.received.length, 0);
    } finally { await remote.close(); }
  });

  it("confirms authenticated identity before considering a route verified", async () => {
    const remote = await host(descriptor(), descriptor("computer-two"));
    try {
      await assert.rejects(probeToken(remote.url, "secret", { computerId: "computer-one" }), /identity mismatch/);
      assert.equal(remote.received.length, 1);
    } finally { await remote.close(); }
  });

  it("blocks incompatible protocols before sending a credential", async () => {
    const remote = await host({ ...descriptor(), protocol: { min: 2, max: 2 } });
    try {
      await assert.rejects(probeToken(remote.url, "secret", {}), /incompatible/);
      assert.equal(remote.received.length, 0);
    } finally { await remote.close(); }
  });

  it("requires explicit legacy compatibility and never permits it for a bound ID", async () => {
    const remote = await host(null, null, 404);
    try {
      await assert.rejects(probeToken(remote.url, "secret"), /legacy compatibility/);
      assert.equal(remote.received.length, 0);
      assert.equal(await probeToken(remote.url, "secret", { allowLegacy: true }), null);
      await assert.rejects(probeToken(remote.url, "secret", { computerId: "computer-one", allowLegacy: true }), /legacy compatibility/);
      assert.equal(remote.received.length, 1);
    } finally { await remote.close(); }
  });

  it("retains route identity independently of token rotation and remember preference", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-token-"));
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
    const tokens = createTokenStore(path.join(dir, "routes"), safeStorage);
    const first = await host(descriptor());
    try {
      tokens.set(first.url, "token-one");
      await openHostTunnel({ url: first.url }, { tokens });
      assert.equal(tokens.computerId(first.url), "computer-one");
      tokens.delete(first.url);
      assert.equal(tokens.get(first.url), "");
      assert.equal(tokens.computerId(first.url), "computer-one");
      await assert.rejects(openHostTunnel({ url: first.url, computerId: "computer-two", token: "new-token" }, { tokens }), /identity mismatch/);
      assert.equal(tokens.computerId(first.url), "computer-one");
      tokens.forget(first.url);
      assert.equal(tokens.computerId(first.url), undefined);
    } finally { await first.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps relinked peer credentials independent of a separately saved sidebar route", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-peer-token-"));
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
    const tokens = createTokenStore(path.join(dir, "routes"), safeStorage);
    const remote = await host(descriptor("computer-two"));
    try {
      tokens.set(remote.url, "sidebar-token");
      tokens.bindComputer(remote.url, "computer-one");
      const opened = await openHostTunnel({ url: remote.url, peer: true, token: "peer-token", computerId: "computer-two" }, { tokens });
      assert.equal(opened.descriptor.computerId, "computer-two");
      assert.equal(opened.token, "peer-token");
      assert.equal(tokens.computerId(remote.url), "computer-one");
      assert.equal(tokens.get(remote.url), "sidebar-token");
      await assert.rejects(openHostTunnel({ url: remote.url }, { tokens }), /identity mismatch/);
    } finally { await remote.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
