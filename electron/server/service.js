#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { WebSocket } = require("ws");
const { createLifecycle } = require("./lifecycle.js");
function requestStatus(port, dataDir, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let token;
    try { token = fs.readFileSync(path.join(dataDir, "web-token"), "utf8").trim(); } catch (e) { reject(e); return; }
    let authenticatedComputerId;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const done = (error, value) => { clearTimeout(timer); ws.terminate(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => done(new Error("Timed out authenticating server readiness.")), timeout);
    ws.on("error", (e) => done(e));
    ws.on("open", () => ws.send(JSON.stringify({ kind: "auth", token })));
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return done(new Error("Invalid server response.")); }
      if (msg.kind === "auth-ok") {
        authenticatedComputerId = msg.computer?.computerId;
        ws.send(JSON.stringify({ kind: "invoke", id: 1, channel: "app:status", args: [] }));
      }
      if (msg.kind === "reply" && msg.id === 1) {
        if (!authenticatedComputerId || msg.result?.computer?.computerId !== authenticatedComputerId) return done(new Error("Authenticated server identity did not match its status."));
        done(msg.error ? new Error(msg.error) : null, msg.result);
      }
    });
    ws.on("close", () => done(new Error("Server closed before readiness was verified.")));
  });
}
function metadata(runtime) { return JSON.parse(fs.readFileSync(path.join(runtime, "app/package.json"), "utf8")); }
async function ready(port, runtime, dataDir, { timeout = 60000, request = requestStatus } = {}) {
  const expected = metadata(runtime);
  // The release identity alone cannot distinguish two data directories.
  let expectedComputerId;
  let last;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (!expectedComputerId) expectedComputerId = fs.readFileSync(path.join(dataDir, "computer-id"), "utf8").trim();
      if (!expectedComputerId) throw new Error("The server data directory has no computer identity.");
      const s = await request(port, dataDir);
      const actual = s.computer || s.build || {};
      if (actual.computerId !== expectedComputerId) throw new Error("Ready server computerId does not match this data directory.");
      if (actual.runtimeKind !== "server") throw new Error("The endpoint is not a Node server.");
      for (const field of ["version", "buildSha", "releaseTag"]) {
        if (expected[field] && actual[field] !== expected[field]) throw new Error(`Ready server ${field} does not match the staged runtime.`);
      }
      return s;
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error(`Server did not reach verified readiness: ${last?.message || "no response"}`);
}
async function trial(runtime, port, dataDir) {
  const child = spawn(path.join(runtime, "bin/solenta-server"), ["--port", String(port), "--host", "127.0.0.1", "--data-dir", dataDir, "--maintenance"], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  let log = "";
  child.stderr.on("data", (b) => { log = (log + b).slice(-32768); });
  const exit = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  try { await ready(port, runtime, dataDir); }
  catch (error) { throw new Error(`${error.message}. Trial log: ${redact(log).slice(-4000)}`); }
  finally {
    if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ } }
    let timer;
    try {
      await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Maintenance trial did not stop; runtime was not activated.")), 60000); })]);
    } finally { clearTimeout(timer); }
  }
}
function redact(s) { return String(s).replace(/(token[=:\s]+)[^\s&"']+/gi, "$1[redacted]").replace(/(Bearer\s+)\S+/gi, "$1[redacted]"); }
async function main(argv) {
  const action = argv.shift();
  if (!["install", "prepare", "external-start", "status", "logs", "start", "stop", "restart", "update", "recover", "uninstall"].includes(action)) throw new Error("Usage: solenta-service install|status|logs|start|stop|restart|update|recover|uninstall [--runtime DIR] [--data-dir DIR] [--port N]");
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { "--data-dir": "dataDir", "--root": "root", "--runtime": "runtime", "--port": "port", "--computer-id": "computerId" }[argv[i]];
    if (!key || !argv[i + 1]) throw new Error("Usage: solenta-service install|status|logs|start|stop|restart|update|recover|uninstall [--runtime DIR] [--data-dir DIR] [--port N]");
    options[key] = argv[i + 1];
  }
  const dataDir = path.resolve(options.dataDir || path.join(os.homedir(), ".solenta/data"));
  if (options.computerId && fs.readFileSync(path.join(dataDir, "computer-id"), "utf8").trim() !== options.computerId) throw new Error("This data directory belongs to a different computer. Lifecycle action refused.");
  const port = options.port === undefined ? 4620 : Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid service port.");
  const lifecycle = createLifecycle(options, {
    inspectWork: async () => {
      const status = await requestStatus(lifecycle.state()?.port || port, dataDir);
      return status.serverActivity;
    },
    ready: (p, runtime) => ready(p, runtime, dataDir),
    verifyRuntime: async (runtime) => {
      const m = metadata(runtime);
      if (!m.buildSha || !m.releaseTag || m.runtimeKind !== "server") throw new Error("Server updates require a stamped release with exact build identity.");
      const result = execFileSync(path.join(runtime, "bin/solenta-server"), ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
      if (result !== m.version) throw new Error("Staged runtime version check failed.");
    },
    trial,
  });
  // Read-only status/log requests never install a service or take a lock.
  if (action === "status" || action === "logs") return lifecycle.action(action);
  return withOperationLock(lifecycle.paths.stateFile, async () => {
    if (action === "external-start" || (action === "prepare" && !lifecycle.status().available)) {
      if (lifecycle.status().installed || fs.existsSync(path.join(dataDir, ".server-lock"))) throw new Error("This data directory already has an owner. Attach to it or stop its existing service/process before preparing another.");
      const runtime = options.runtime || path.resolve(__dirname, "../../..");
      fs.mkdirSync(lifecycle.paths.root, { recursive: true, mode: 0o700 });
      const logFile = path.join(lifecycle.paths.root, "external.log");
      const logFd = fs.openSync(logFile, "a", 0o600);
      let child;
      try { child = spawn(path.join(runtime, "bin/solenta-server"), ["--data-dir", dataDir, "--host", "127.0.0.1", "--port", String(port)], { detached: true, stdio: ["ignore", logFd, logFd] }); }
      finally { fs.closeSync(logFd); }
      const spawnFailure = new Promise((_, reject) => child.once("error", reject));
      try { await Promise.race([ready(port, runtime, dataDir), spawnFailure]); }
      catch (error) { if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* exited */ } } throw error; }
      child.unref();
      return { mode: "external", manager: null, installed: false, running: true, sessionLimit: "External process started. It can survive the SSH connection closing, but logout/session policies may stop it. No crash restart or reboot startup is installed.", logFile };
    }
    if (action === "install" || action === "prepare") return await lifecycle.install(options.runtime || path.resolve(__dirname, "../../.."), port);
    if (action === "update") { if (!options.runtime) throw new Error("--runtime is required for update."); return await lifecycle.update(options.runtime); }
    if (action === "recover") return await lifecycle.recover();
    return await lifecycle.action(action);
  });
}
async function withOperationLock(stateFile, task, { timeout = 60000, poll = 200 } = {}) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const operation = `${stateFile}.operation`;
  const deadline = Date.now() + timeout;
  const nonce = require("node:crypto").randomUUID();
  for (;;) {
    try { fs.mkdirSync(operation, { mode: 0o700 }); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() >= deadline) throw new Error("Another lifecycle operation is in progress. Inspect the operation lock after a crashed updater before removing it.");
      await new Promise((r) => setTimeout(r, poll));
    }
  }
  fs.writeFileSync(path.join(operation, "owner.json"), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
  try { return await task(); }
  finally {
    if (JSON.parse(fs.readFileSync(path.join(operation, "owner.json"), "utf8")).nonce === nonce) {
      fs.unlinkSync(path.join(operation, "owner.json")); fs.rmdirSync(operation);
    }
  }
}
if (require.main === module) main(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result)), (error) => { console.error(redact(error.message)); process.exitCode = 1; });
module.exports = { requestStatus, ready, trial, main, withOperationLock };
