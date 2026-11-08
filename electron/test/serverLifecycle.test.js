"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { acquireDataLock } = require("../server/dataLock.js");
const { createLifecycle } = require("../server/lifecycle.js");
const { ready, withOperationLock } = require("../server/service.js");
const { manageRemoteServer, installRemoteSolenta, serverLifecycleCommand } = require("../remoteConnections.js");
function fixture(t, platform = "linux", overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-service-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const runtime = path.join(home, "runtime");
  fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
  fs.mkdirSync(path.join(runtime, "app"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "bin/solenta-server"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(path.join(runtime, "app/package.json"), JSON.stringify({ version: "1.0.0", runtimeKind: "server", buildSha: "abc", releaseTag: "nightly-abc" }));
  const calls = [];
  let running = false;
  const lc = createLifecycle({ home }, {
    platform, uid: 501,
    run: (cmd, args) => {
      calls.push([cmd, args]);
      if (args.includes("is-active")) { if (!running) throw new Error("inactive"); return "active\n"; }
      if (cmd === "loginctl") return "no\n";
      if (cmd === "launchctl" && args[0] === "print") { if (args[1] === "gui/501") return "domain"; if (!running) throw new Error("not loaded"); return "pid = 77\n"; }
      if (args.includes("start") || args.includes("--now") || args[0] === "bootstrap" || args[0] === "kickstart") running = true;
      if (args.includes("stop") || args[0] === "bootout") running = false;
      return "";
    },
    ready: async () => {}, verifyRuntime: async () => {}, trial: async () => {},
    inspectWork: async () => ({ active: 0 }), waitStopped: async () => {}, ...overrides,
  });
  return { home, runtime, calls, lc };
}
it("holds one writer per canonical data directory and reclaims only proven dead owners", (t) => {
  const f = fixture(t);
  const data = path.join(f.home, "data");
  const release = acquireDataLock(data);
  assert.throws(() => acquireDataLock(data), /Another server owns/);
  const alias = path.join(f.home, "alias"); fs.symlinkSync(data, alias);
  assert.throws(() => acquireDataLock(alias), /Another server owns/);
  release();
  fs.mkdirSync(path.join(data, ".server-lock"));
  fs.writeFileSync(path.join(data, ".server-lock/owner.json"), JSON.stringify({ pid: 99999999 }));
  acquireDataLock(data, { alive: () => false })();
  fs.mkdirSync(path.join(data, ".server-lock"));
  assert.throws(() => acquireDataLock(data), /Another server owns/);
});
it("systemd service is explicit, idempotent and reports actual linger limits; uninstall preserves data", async (t) => {
  const f = fixture(t);
  assert.equal(f.lc.status().mode, "external");
  assert.equal(f.calls.some(([, a]) => a.includes("start")), false);
  const status = await f.lc.install(f.runtime);
  assert.equal(status.mode, "managed"); assert.equal(status.running, true); assert.equal(status.linger, false);
  assert.match(fs.readFileSync(f.lc.paths.unit, "utf8"), /ExecStart=.*solenta-server.*--data-dir/);
  assert.match(status.sessionLimit, /linger/);
  await f.lc.install(f.runtime);
  fs.mkdirSync(f.lc.paths.dataDir, { recursive: true }); fs.writeFileSync(path.join(f.lc.paths.dataDir, "store"), "retained");
  await f.lc.action("uninstall");
  assert.equal(fs.readFileSync(path.join(f.lc.paths.dataDir, "store"), "utf8"), "retained");
  assert.equal(f.lc.status().installed, false);
});
it("launchd uses a GUI login domain, honest session limits, bootout stop and bootstrap restart", async (t) => {
  const f = fixture(t, "darwin");
  const s = await f.lc.install(f.runtime);
  assert.match(s.sessionLimit, /stops at logout/);
  assert.match(fs.readFileSync(f.lc.paths.unit, "utf8"), /<key>ProgramArguments<\/key>/);
  await f.lc.action("restart");
  assert.ok(f.calls.some(([cmd, args]) => cmd === "launchctl" && args[0] === "bootout"));
  assert.ok(f.calls.filter(([, args]) => args[0] === "bootstrap").length >= 2);
});
it("unavailable user manager refuses installation and does not create a service", async (t) => {
  const f = fixture(t, "linux", { run: () => { throw new Error("No user bus"); } });
  await assert.rejects(f.lc.install(f.runtime), /unavailable/);
  assert.equal(fs.existsSync(f.lc.paths.unit), false);
});
it("active work refuses stop/update before any service stop or runtime change", async (t) => {
  const f = fixture(t, "linux", { inspectWork: async () => ({ active: 1 }) });
  await f.lc.install(f.runtime);
  await assert.rejects(f.lc.action("stop"), /active runs or terminals/);
  assert.equal(f.calls.some(([, args]) => args.includes("stop")), false);
  assert.equal(fs.existsSync(path.join(f.lc.paths.dataDir, ".server-maintenance-request")), false);
});
it("failed maintenance trial restores the complete data directory and old runtime", async (t) => {
  let trialData;
  const f = fixture(t, "linux", { trial: async (_runtime, _port, data) => {
    trialData = data;
    fs.writeFileSync(path.join(data, "coder-store.json"), "migrated");
    fs.writeFileSync(path.join(data, "new-schema"), "new");
    throw new Error("bad candidate");
  } });
  await f.lc.install(f.runtime);
  fs.mkdirSync(path.join(f.lc.paths.dataDir, "messages"), { recursive: true });
  fs.writeFileSync(path.join(f.lc.paths.dataDir, "coder-store.json"), "old");
  fs.writeFileSync(path.join(f.lc.paths.dataDir, "messages/thread.json"), "old transcript");
  await assert.rejects(f.lc.update(f.runtime), /Previous runtime and data directory were restored/);
  assert.equal(trialData, f.lc.paths.dataDir);
  assert.equal(fs.readFileSync(path.join(f.lc.paths.dataDir, "coder-store.json"), "utf8"), "old");
  assert.equal(fs.readFileSync(path.join(f.lc.paths.dataDir, "messages/thread.json"), "utf8"), "old transcript");
  assert.equal(fs.existsSync(path.join(f.lc.paths.dataDir, "new-schema")), false);
  assert.equal(fs.realpathSync(f.lc.paths.current), fs.realpathSync(f.runtime));
  assert.equal(f.lc.status().running, true);
});
it("readiness demands authenticated exact build identity even for same-version nightlies", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.lc.paths.dataDir, { recursive: true });
  fs.writeFileSync(path.join(f.lc.paths.dataDir, "computer-id"), "test-computer");
  await assert.rejects(ready(1, f.runtime, f.lc.paths.dataDir, { timeout: 1, request: async () => ({ computer: { computerId: "test-computer", runtimeKind: "server", version: "1.0.0", buildSha: "wrong", releaseTag: "nightly-abc" } }) }), /buildSha does not match/);
  const s = await ready(1, f.runtime, f.lc.paths.dataDir, { request: async () => ({ computer: { computerId: "test-computer", runtimeKind: "server", version: "1.0.0", buildSha: "abc", releaseTag: "nightly-abc" } }) });
  assert.equal(s.computer.buildSha, "abc");
});
it("SSH lifecycle status is read-only; install/update stage checksum-pinned server assets on all targets", async (t) => {
  const f = fixture(t);
  for (const action of ["status", "install", "update", "stop"]) {
    const server = ["install", "update"].includes(action) ? { version: "nightly-test", byTarget: { "linux-arm64": { url: "https://example.com/node.tar.gz", sha256: "a".repeat(64) } } } : null;
    const cmd = serverLifecycleCommand(action, 4620, server);
    execFileSync("sh", ["-n", "-c", cmd]);
    assert.equal(cmd.slice(7, -1).includes("'"), false);
    if (server) { assert.match(cmd, /linux-arm64/); assert.match(cmd, /\$got.*\$sum/); }
    else assert.doesNotMatch(cmd, /curl.*-o|solenta-service.*install|nohup/);
  }
  const cmd = serverLifecycleCommand("status", 4620, null);
  const fakeBin = path.join(f.home, "fake-bin"); fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "uname"), "#!/bin/sh\necho UnsupportedTestPlatform\n", { mode: 0o700 });
  const raw = execFileSync("sh", ["-c", cmd], { env: { ...process.env, HOME: f.home, PATH: `${fakeBin}:${process.env.PATH}` }, encoding: "utf8" });
  assert.equal(JSON.parse(raw).mode, "external");
});
it("actual Node runtime update never fetches or invokes the Linux Electron installer", async () => {
  let script;
  const result = await installRemoteSolenta({ host: "me@arm", remotePort: 4620 }, {
    remoteDescriptor: async () => ({ runtimeKind: "server" }),
    serverDownloads: { version: "nightly-test", byTarget: { "linux-arm64": { url: "https://example.com/node.tar.gz", sha256: "a".repeat(64) } } },
    updater: { pickAsset: () => assert.fail("desktop asset selection") },
    execFile: (_cmd, args, _opts, cb) => { script = args.at(-1); cb(null, JSON.stringify({ mode: "managed", installed: true, running: true, updated: true }), ""); },
  });
  assert.match(script, /solenta-service" update/);
  assert.doesNotMatch(script, /ldd|pkill|solenta\.old/);
  assert.equal(result.updated, true);
});
it("unknown runtime and missing release metadata never report update success", async () => {
  await assert.rejects(installRemoteSolenta({ host: "me@box" }, { remoteDescriptor: async () => ({}) }), /could not be verified/);
  await assert.rejects(manageRemoteServer({ host: "me@box", action: "install" }, { serverDownloads: null }), /no checksum-pinned/);
});
it("candidate verification failure leaves running runtime and state untouched", async (t) => {
  const f = fixture(t, "linux", { verifyRuntime: async () => { throw new Error("checksum or metadata invalid"); } });
  await f.lc.install(f.runtime);
  await assert.rejects(f.lc.update(f.runtime), /metadata invalid/);
  assert.equal(f.calls.some(([, a]) => a.includes("stop")), false);
  assert.equal(f.lc.status().running, true);
});
it("failed normal activation rolls back after a successful maintenance trial", async (t) => {
  let activations = 0;
  const f = fixture(t, "linux", { ready: async () => { if (++activations === 2) throw new Error("new process did not become ready"); }, trial: async (_r, _p, data) => fs.writeFileSync(path.join(data, "schema"), "candidate") });
  await f.lc.install(f.runtime);
  fs.mkdirSync(f.lc.paths.dataDir, { recursive: true });
  fs.writeFileSync(path.join(f.lc.paths.dataDir, "schema"), "original");
  await assert.rejects(f.lc.update(f.runtime), /Previous runtime and data directory were restored/);
  assert.equal(fs.readFileSync(path.join(f.lc.paths.dataDir, "schema"), "utf8"), "original");
  assert.equal(activations, 3, "installation, failed activation, restored runtime readiness");
});
it("successful update validates trial then normal ready and retains no maintenance gate", async (t) => {
  let trialRan = false;
  const f = fixture(t, "linux", { trial: async () => { trialRan = true; } });
  await f.lc.install(f.runtime);
  fs.mkdirSync(f.lc.paths.dataDir, { recursive: true });
  const result = await f.lc.update(f.runtime);
  assert.equal(trialRan, true); assert.equal(result.updated, true); assert.equal(result.releaseTag, "nightly-abc");
  assert.equal(fs.existsSync(path.join(f.lc.paths.dataDir, ".server-maintenance-request")), false);
});
it("lifecycle commands serialize their complete operation and preserve another owner's lock", async (t) => {
  const f = fixture(t);
  const order = [];
  const first = withOperationLock(f.lc.paths.stateFile, async () => {
    order.push("first enter"); await new Promise((r) => setTimeout(r, 50)); order.push("first leave");
  }, { poll: 5 });
  const second = withOperationLock(f.lc.paths.stateFile, async () => { order.push("second enter"); }, { poll: 5 });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first enter", "first leave", "second enter"]);
  fs.mkdirSync(`${f.lc.paths.stateFile}.operation`);
  await assert.rejects(withOperationLock(f.lc.paths.stateFile, () => assert.fail("must not enter a held operation"), { timeout: 10, poll: 5 }), /Another lifecycle operation/);
  assert.equal(fs.existsSync(`${f.lc.paths.stateFile}.operation`), true);
});
it("an existing backup refuses an update before stopping a healthy service", async (t) => {
  const f = fixture(t);
  await f.lc.install(f.runtime);
  const key = path.basename(f.lc.paths.stateFile).slice("service-".length, -".json".length);
  fs.mkdirSync(path.join(f.lc.paths.root, `.data-backup-${key}`));
  await assert.rejects(f.lc.update(f.runtime), /earlier data backup exists/);
  assert.equal(f.calls.some(([, a]) => a.includes("stop")), false);
  assert.equal(f.lc.status().running, true);
});
it("a same-build endpoint with another computer identity never passes readiness", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.lc.paths.dataDir, { recursive: true });
  fs.writeFileSync(path.join(f.lc.paths.dataDir, "computer-id"), "owner");
  await assert.rejects(ready(1, f.runtime, f.lc.paths.dataDir, { timeout: 1, request: async () => ({ computer: { computerId: "other", runtimeKind: "server", version: "1.0.0", buildSha: "abc", releaseTag: "nightly-abc" } }) }), /computerId does not match/);
});
it("a bound computer mismatch refuses update before any remote mutation", async () => {
  await assert.rejects(installRemoteSolenta({ host: "me@box", computerId: "expected" }, { remoteDescriptor: async () => ({ runtimeKind: "desktop", computerId: "different" }), execFile: () => assert.fail("must not install") }), /identity changed/);
});
it("insufficient snapshot space refuses update before stopping a healthy service", async (t) => {
  const f = fixture(t, "linux", { checkBackupSpace: async () => { throw new Error("Not enough disk space. The server was not stopped."); } });
  await f.lc.install(f.runtime);
  await assert.rejects(f.lc.update(f.runtime), /Not enough disk space/);
  assert.equal(f.calls.some(([, a]) => a.includes("stop")), false);
  assert.equal(f.lc.status().running, true);
});
it("external preparation is explicit and never dispatches the desktop installer", () => {
  const server = { version: "nightly-test", byTarget: { "darwin-arm64": { url: "https://example.com/server.tgz", sha256: "a".repeat(64) } } };
  const cmd = serverLifecycleCommand("install", 4620, server, "test-id", "external");
  assert.match(cmd, /solenta-service" external-start/);
  assert.match(cmd, /--computer-id test-id/);
  execFileSync("sh", ["-n", "-c", cmd]);
});
it("desktop updater stays disabled for Node-server release metadata", async () => {
  const status = await require("../updater.js").downloadUpdate({ pkg: { channel: "prod", releaseTag: "v1.0.0", runtimeKind: "server" }, fetch: () => assert.fail("Node server cannot download an Electron release") });
  assert.equal(status.state, "disabled");
});
it("service logs retain context while redacting credentials", async () => {
  const result = await manageRemoteServer({ host: "me@box", action: "logs" }, {
    execFile: (_cmd, _args, _opts, cb) => cb(null, JSON.stringify({ mode: "managed", installed: true, running: true, logs: "startup context\ntoken=secret-token\nAuthorization: Bearer secret-bearer\nfinal diagnostic" }), ""),
  });
  assert.match(result.logs, /startup context/); assert.match(result.logs, /final diagnostic/);
  assert.doesNotMatch(result.logs, /secret-token|secret-bearer/);
});
it("independent lifecycle command processes cannot overlap their mutation windows", async (t) => {
  const f = fixture(t);
  const trace = path.join(f.home, "trace");
  const modulePath = path.resolve(__dirname, "../server/service.js");
  const source = `const fs=require('node:fs');const {withOperationLock}=require(process.argv[1]);withOperationLock(process.argv[2],async()=>{fs.appendFileSync(process.argv[3],process.argv[4]+' enter\\n');process.stdout.write('entered\\n');await new Promise(r=>setTimeout(r,100));fs.appendFileSync(process.argv[3],process.argv[4]+' leave\\n')},{poll:5}).catch(e=>{console.error(e);process.exitCode=1})`;
  const launch = (name) => {
    const child = spawn(process.execPath, ["-e", source, modulePath, f.lc.paths.stateFile, trace, name], { stdio: ["ignore", "pipe", "pipe"] });
    const finished = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`fixture command exited ${code}`))); });
    t.after(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } });
    return { child, finished };
  };
  const first = launch("first");
  await new Promise((resolve) => first.child.stdout.once("data", resolve));
  const second = launch("second");
  await Promise.all([first.finished, second.finished]);
  assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n"), ["first enter", "first leave", "second enter", "second leave"]);
});
