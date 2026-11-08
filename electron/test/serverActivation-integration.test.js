"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");
const { requestStatus } = require("../server/service.js");
async function boot(t, maintenance, ipc = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-activation-"));
  const data = path.join(home, "data"); fs.mkdirSync(data);
  const marker = path.join(data, ".server-maintenance-request"); fs.writeFileSync(marker, "pending update");
  const providerFile = path.join(home, ".claude.json");
  const originalProvider = JSON.stringify({ mcpServers: { "coder-memory": { type: "http", url: "http://127.0.0.1:1/mcp" } }, fixture: "preserve" });
  fs.writeFileSync(providerFile, originalProvider);
  fs.writeFileSync(path.join(data, "coder-store.json"), JSON.stringify({ settings: {}, projects: [], threads: [{ id: "activation-thread", projectId: "missing-project", status: "idle", createdAt: Date.now(), updatedAt: Date.now(), teleportedTo: { pending: true, host: "fixture" } }], messagesByThread: {}, workLogByThread: {} }));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../server/index.js"), "--port", "0", "--data-dir", data, ...(maintenance ? ["--maintenance"] : [])], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CODER_SIMULATE: "1", SOLENTA_SKIP_USERDATA_MIGRATION: "1" }, stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])], detached: true,
  });
  let log = ""; child.stdout.on("data", (b) => { log += b; }); child.stderr.on("data", (b) => { log += b; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
    await exited;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const deadline = Date.now() + 45000;
  let port;
  while (!(port = /solenta-web: listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(log)?.[1])) {
    if (child.exitCode !== null) assert.fail(`server exited ${child.exitCode}: ${log}`);
    if (Date.now() > deadline) assert.fail(`server did not become ready: ${log}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return { home, data, marker, child, exited, port: Number(port), providerFile, originalProvider };
}
function invoke(f, channel) {
  return new Promise((resolve, reject) => {
    const token = fs.readFileSync(path.join(f.data, "web-token"), "utf8").trim();
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("test invocation timed out")); }, 5000);
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ kind: "auth", token })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.kind === "auth-ok") ws.send(JSON.stringify({ kind: "invoke", id: 1, channel, args: [] }));
      if (msg.kind === "reply" && msg.id === 1) { clearTimeout(timer); ws.terminate(); resolve(msg); }
    });
  });
}
it("marked normal startup proves readiness before activating boot cleanup and provider setup", { skip: process.platform === "win32" }, async (t) => {
  const f = await boot(t, false);
  const status = await requestStatus(f.port, f.data);
  assert.equal(status.computer.computerId, fs.readFileSync(path.join(f.data, "computer-id"), "utf8").trim());
  assert.equal(fs.readFileSync(f.providerFile, "utf8"), f.originalProvider);
  assert.equal(fs.existsSync(path.join(f.data, "memory-server.json")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, "coder-store.json"), "utf8")).threads[0].teleportedTo.pending, true);
  assert.match((await invoke(f, "threads:list")).error, /maintenance mode/);
  fs.unlinkSync(f.marker);
  const deadline = Date.now() + 10000;
  let threads;
  do {
    threads = (await invoke(f, "threads:list")).result;
    if (threads?.find((row) => row.id === "activation-thread")?.teleportedTo === null) break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  assert.equal(threads?.find((row) => row.id === "activation-thread")?.teleportedTo, null, "marker release runs deferred teleport cleanup");
});
it("maintenance trial never activates after marker removal or mutates provider configuration during graceful shutdown", { skip: process.platform === "win32" }, async (t) => {
  const f = await boot(t, true);
  await requestStatus(f.port, f.data);
  fs.unlinkSync(f.marker);
  await new Promise((r) => setTimeout(r, 250));
  assert.match((await invoke(f, "threads:list")).error, /maintenance mode/);
  assert.equal(fs.readFileSync(f.providerFile, "utf8"), f.originalProvider);
  try { process.kill(-f.child.pid, "SIGTERM"); } catch { /* exited */ }
  await f.exited;
  assert.equal(fs.readFileSync(f.providerFile, "utf8"), f.originalProvider, "unstarted supervisor cannot revoke MCP configuration at shutdown");
});
it("a maintenance trial releases its writer when its updater IPC disconnects", { skip: process.platform === "win32" }, async (t) => {
  const f = await boot(t, true, true);
  await requestStatus(f.port, f.data);
  f.child.disconnect();
  let timer;
  try {
    await Promise.race([f.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("orphan trial did not stop")), 10000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(fs.existsSync(path.join(f.data, ".server-lock")), false);
  assert.equal(fs.readFileSync(f.providerFile, "utf8"), f.originalProvider);
});
