"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { requestStatus } = require("../server/service.js");
async function fixture(t, descriptor) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-ready-"));
  fs.writeFileSync(path.join(data, "computer-id"), "expected-computer");
  fs.writeFileSync(path.join(data, "web-token"), "private-test-token");
  const auths = [];
  const server = http.createServer((req, res) => {
    if (descriptor.redirect) { res.writeHead(302, { Location: "/other" }); res.end(); return; }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(descriptor));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.kind === "auth") { auths.push(msg.token); ws.send(JSON.stringify({ kind: "auth-ok", computer: descriptor })); }
    if (msg.kind === "invoke") ws.send(JSON.stringify({ kind: "reply", id: msg.id, result: { computer: descriptor, serverActivity: { active: 0 } } }));
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise((resolve) => wss.close(resolve)); await new Promise((resolve) => server.close(resolve)); fs.rmSync(data, { recursive: true, force: true }); });
  return { data, auths, port: server.address().port };
}
const descriptor = { kind: "solenta", computerId: "expected-computer", protocol: { min: 1, max: 1 }, runtimeKind: "server", version: "1.0.0", buildSha: "abc", releaseTag: "v1.0.0" };
it("readiness never sends a saved credential to a different computer on the old port", async (t) => {
  const f = await fixture(t, { ...descriptor, computerId: "another-computer" });
  await assert.rejects(requestStatus(f.port, f.data), /different computer/);
  assert.deepEqual(f.auths, []);
});
it("readiness rejects incompatible protocol and HTTP redirects before authentication", async (t) => {
  const incompatible = await fixture(t, { ...descriptor, protocol: { min: 2, max: 2 } });
  await assert.rejects(requestStatus(incompatible.port, incompatible.data), /incompatible/);
  assert.deepEqual(incompatible.auths, []);
  const redirect = await fixture(t, { redirect: true });
  await assert.rejects(requestStatus(redirect.port, redirect.data), /No credential was sent/);
  assert.deepEqual(redirect.auths, []);
});
it("matching public, authenticated and status identity permits readiness", async (t) => {
  const f = await fixture(t, descriptor);
  const status = await requestStatus(f.port, f.data);
  assert.equal(status.computer.computerId, "expected-computer");
  assert.deepEqual(f.auths, ["private-test-token"]);
});
