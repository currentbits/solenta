#!/usr/bin/env node
"use strict";

// Explicit staging acceptance: creates a test thread, then unlinks the test host.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");
const { WebSocket } = require("ws");
const { createCloudClient } = require("../electron/cloud/client");
const { createCredentials } = require("../electron/cloud/credentials");

async function until(check, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Cloud acceptance timed out."); await wait(100); }
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log("Staging only: set SOLENTA_CONNECT_ORIGIN, CONNECT_ACCEPTANCE_COMPUTER_ID and CONNECT_ACCEPTANCE_PROJECT (an existing host repo); run with --revoke-test-host. Creates a test thread and unlinks that computer.");
    return;
  }
  const computerId = process.env.CONNECT_ACCEPTANCE_COMPUTER_ID, projectPath = process.env.CONNECT_ACCEPTANCE_PROJECT;
  assert.ok(process.argv.includes("--revoke-test-host") && computerId && projectPath && process.env.SOLENTA_CONNECT_ORIGIN, "Read --help and explicitly select a staging computer to revoke.");
  const { createWireCoder } = await import("../src/wireClient.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-cloud-acceptance-"));
  const sockets = [], removers = [];
  let currentSocket, acceptanceTimer, allowReconnect = true;
  class TrackedSocket extends WebSocket {
    constructor(...args) { super(...args); sockets.push(this); currentSocket = this; }
  }
  const client = createCloudClient({ config: { origin: process.env.SOLENTA_CONNECT_ORIGIN }, credentials: createCredentials({ file: path.join(dir, "account.json") }) });
  try {
    console.log("Staging credentials remain in this process memory.");
    await client.login({ headless: true, onCode: code => console.log(`Open ${code.verificationUri}\nEnter code: ${code.userCode}`) });
    await Promise.race([(async () => {
    const first = await client.session(computerId, { scopes: ["full"] });
    const wire = createWireCoder({ url: `${first.origin.replace(/^https:/, "wss:")}/ws`, token: "", expectedComputerId: computerId, allowLegacy: false, WebSocket: TrackedSocket,
      getCredentials: () => client.session(computerId),
      subscribeCredentials: listener => {
        const remove = client.subscribe(event => {
          if (event.type === "session" && event.computerId === computerId) listener(event.session);
          if (event.type === "unlinked" && event.computerId === computerId) listener(null);
        });
        removers.push(remove); return remove;
      },
      setTimeout: (fn, ms) => { const timer = setTimeout(() => { if (allowReconnect) fn(); }, ms); timer.unref(); return timer; },
    });
    assert.equal((await wire.app.status()).computer.computerId, computerId);
    const project = await wire.projects.add(projectPath);
    const thread = await wire.threads.create({ projectId: project.id, title: "Cloud staging acceptance", worktree: true });
    await wire.runs.start({ threadId: thread.id, prompt: "Cloud staging smoke" });
    let detail;
    await until(async () => { detail = await wire.threads.get(thread.id); return ["done", "failed"].includes(detail.thread.status); });
    assert.equal(detail.thread.status, "done", "Start the dedicated staging server with CODER_SIMULATE=1");
    assert.ok(detail.thread.worktreePath);
    let output = "";
    removers.push(wire.on("terminal:data", value => { if (value.threadId === thread.id) output += value.data; }));
    const terminal = await wire.terminal.open({ threadId: thread.id, cols: 80, rows: 24 });
    assert.equal(terminal.pty, true);
    const beforeRotation = currentSocket;
    const renewed = await client.session(computerId, { renew: true });
    assert.equal(renewed.deviceId, first.deviceId); assert.notEqual(renewed.token, first.token);
    await wire.terminal.write({ threadId: thread.id, termId: terminal.termId, data: "echo CLOUD_$((40+2))\n" });
    await until(() => output.includes("CLOUD_42"));
    assert.equal(currentSocket, beforeRotation, "Rotation must preserve the terminal socket");
    const oldSocket = currentSocket;
    oldSocket.terminate();
    await until(() => currentSocket !== oldSocket && currentSocket.readyState === WebSocket.OPEN);
    assert.equal((await wire.app.status()).computer.computerId, computerId);
    console.log("Cloud worktree, PTY, rotation and reconnect passed without an SSH transport.");
    // Keep one independently authenticated socket to check host-side revocation.
    const witness = new WebSocket(`${first.origin.replace(/^https:/, "wss:")}/ws`); sockets.push(witness);
    await new Promise((resolve, reject) => {
      witness.once("error", reject);
      witness.once("open", () => witness.send(JSON.stringify({ kind: "auth", token: renewed.token, computerId, protocol: 1 })));
      witness.once("message", raw => { try { assert.equal(JSON.parse(String(raw)).kind, "auth-ok"); resolve(); } catch (error) { reject(error); } });
    });
    const result = await client.deregister(computerId);
    assert.equal(result.revoked, true);
    assert.ok(!result.hostRevocationPending && !result.cleanupPending, "Revocation requires host confirmation and provider cleanup");
    await until(() => witness.readyState === WebSocket.CLOSED);
    console.log("Cloud revocation confirmed; staging host unlinked. PASS");
    })(), new Promise((_, reject) => { acceptanceTimer = setTimeout(() => reject(new Error("Cloud staging acceptance exceeded two minutes.")), 120_000); })]);
  } finally {
    clearTimeout(acceptanceTimer); allowReconnect = false;
    for (const remove of removers) remove();
    for (const socket of sockets) socket.terminate();
    await client.logout().catch(() => {}); client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
