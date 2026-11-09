#!/usr/bin/env node
"use strict";

// Native acceptance for the archive's real service adapter. Data and provider
// HOME are disposable; Linux's uniquely named user unit is removed afterward.
// This checks service restarts and updates, not OS reboot or login/logout policy.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");
const { createLifecycle } = require("../electron/server/lifecycle.js");
const { requestStatus } = require("../electron/server/service.js");
const { invokeRemote } = require("../electron/remoteConnections.js");

const step = (text) => console.log(`[lifecycle] ${text}`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
async function until(check, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (e) { error = e; }
    await pause(200);
  }
  throw new Error(`${message}${error ? `: ${error.message}` : ""}`);
}
function run(command, args, env, timeout = 150000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (b) => { output += b; });
    child.stderr.on("data", (b) => { output += b; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${path.basename(command)} ${args[0]} exited ${code ?? signal}: ${output.slice(-4000)}`));
      else resolve(output.trim());
    });
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main(archive) {
  assert.ok(archive && fs.existsSync(archive), "usage: smoke-server-lifecycle.js <server archive>");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-lifecycle-smoke-"));
  const home = path.join(tmp, "home");
  const dataDir = path.join(tmp, "data");
  const root = path.join(tmp, "service");
  fs.mkdirSync(home);
  // systemd searches the real user's unit directory; launchd accepts an
  // explicitly bootstrapped plist anywhere. Provider HOME stays isolated below.
  const serviceHome = process.platform === "linux" ? os.homedir() : home;
  const env = { ...process.env, HOME: serviceHome, USERPROFILE: serviceHome };
  for (const key of Object.keys(env)) if (key.startsWith("CODER_")) delete env[key];
  const lifecycle = createLifecycle({ home: serviceHome, dataDir, root });
  let installed = false;
  const children = new Set();
  try {
    const before = lifecycle.status();
    assert.equal(before.available, true, `Native ${before.manager} is unavailable: ${before.sessionLimit}`);
    step(`native ${before.manager} available`);
    execFileSync("tar", ["-xzf", archive, "-C", tmp]);
    const runtime = path.join(tmp, "solenta-server");
    const packageFile = path.join(runtime, "app/package.json");
    const metadata = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    assert.ok(metadata.buildSha && metadata.runtimeKind === "server", "archive has server build identity");
    // Private fixture stamps let us exercise same-version releases without
    // publishing a release. Keep the archive's build SHA and renderer intact.
    metadata.releaseTag = "lifecycle-smoke-old";
    fs.writeFileSync(packageFile, JSON.stringify(metadata));
    const launcher = path.join(runtime, "bin/solenta-server");
    const originalLauncher = fs.readFileSync(launcher, "utf8");
    fs.writeFileSync(launcher, originalLauncher.replace("#!/bin/sh\n", `#!/bin/sh\nexport HOME=${quote(home)} USERPROFILE=${quote(home)}\nexport CODER_SIMULATE=1 CODER_GROK_MCP_DISABLE=1 CODER_CURSOR_MCP_DISABLE=1 CODER_KIMI_MCP_PATH=${quote(path.join(tmp, "kimi.json"))}\n`));
    const candidate = path.join(tmp, "candidate");
    fs.cpSync(runtime, candidate, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    fs.writeFileSync(path.join(candidate, "app/package.json"), JSON.stringify({ ...metadata, releaseTag: "lifecycle-smoke-new" }));
    const port = await freePort();
    const service = path.join(runtime, "bin/solenta-service");
    const cli = async (action, extra = []) => JSON.parse(await run(service, [action, "--data-dir", dataDir, "--root", root, "--port", String(port), ...extra], env));
    const status = () => requestStatus(port, dataDir);
    const owner = () => JSON.parse(fs.readFileSync(path.join(dataDir, ".server-lock/owner.json"), "utf8")).pid;
    // Set before installation so a readiness failure still unloads the job.
    installed = true;
    assert.equal((await cli("install", ["--runtime", runtime])).running, true);
    const initial = await status();
    const computerId = initial.computer.computerId;
    const token = fs.readFileSync(path.join(dataDir, "web-token"), "utf8");
    const call = (channel, args) => invokeRemote({ url: `http://127.0.0.1:${port}` }, channel, args, { tokens: { get: () => token.trim() } });
    const oldPid = owner();
    assert.equal((await cli("prepare", ["--runtime", candidate])).running, true);
    assert.equal(owner(), oldPid, "repeated setup preserves the existing owner");
    assert.equal((await status()).computer.releaseTag, "lifecycle-smoke-old");
    await assert.rejects(run(launcher, ["--data-dir", dataDir, "--port", String(await freePort())], env), /Another server owns/);
    step("install, idempotent prepare and duplicate-owner refusal pass");

    // Client/service commands have all exited. Kill just this backend, then let
    // the native manager restart it without a client or SSH process keeping it up.
    process.kill(oldPid, "SIGKILL");
    await until(async () => owner() !== oldPid && (await status()).computer.computerId === computerId, "service did not recover after crash");
    step("native manager restarted a crashed backend with the same identity");

    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=s@s", "-c", "user.name=s", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    const project = await call("projects:add", [repo]);
    const thread = await call("threads:create", [{ projectId: project.id, title: "lifecycle smoke" }]);
    const term = await call("terminal:open", [{ threadId: thread.id, cols: 80, rows: 24 }]);
    await assert.rejects(cli("update", ["--runtime", candidate]), /active runs or terminals/);
    assert.equal((await status()).computer.releaseTag, "lifecycle-smoke-old");
    await call("terminal:close", [{ threadId: thread.id, termId: term.termId }]);
    await until(async () => (await status()).serverActivity.active === 0, "terminal did not stop");
    step("active terminal refused update without stopping the old server");

    await cli("stop");
    await cli("restart");
    assert.equal((await status()).computer.computerId, computerId);
    await cli("stop");
    const updated = await cli("update", ["--runtime", candidate, "--release-tag", "lifecycle-smoke-new", "--build-sha", metadata.buildSha]);
    assert.equal(updated.updated, true);
    assert.equal((await status()).computer.releaseTag, "lifecycle-smoke-new");
    assert.equal((await status()).computer.computerId, computerId);
    assert.equal(fs.readFileSync(path.join(dataDir, "web-token"), "utf8"), token);
    assert.equal(fs.realpathSync(lifecycle.paths.current), fs.realpathSync(candidate));
    step("stopped service restarted and updated to the requested same-version release; identity and credentials preserved");

    const interrupted = path.join(tmp, "interrupted");
    fs.cpSync(candidate, interrupted, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    // Hold readiness with an intentionally wrong descriptor stamp. The real
    // maintenance entry and IPC lifetime handler remain intact.
    const interruptedIdentity = path.join(interrupted, "app/electron/serverIdentity.js");
    const interruption = `if (process.env.SOLENTA_SERVER_MAINTENANCE === "1") { fs.writeFileSync(path.join(dataDir, "smoke-interrupted-migration"), "partial migration"); descriptor.releaseTag = "trial-not-ready"; } return descriptor;`;
    fs.writeFileSync(interruptedIdentity, fs.readFileSync(interruptedIdentity, "utf8").replace("return descriptor;", interruption));
    const updater = spawn(service, ["update", "--data-dir", dataDir, "--root", root, "--port", String(port), "--runtime", interrupted], { env, stdio: "ignore" });
    children.add(updater.pid);
    const updaterExit = new Promise((resolve, reject) => { updater.once("exit", resolve); updater.once("error", reject); });
    const trialPid = await until(() => fs.existsSync(path.join(dataDir, "smoke-interrupted-migration")) && owner(), "interrupted update never reached its trial");
    children.add(trialPid);
    process.kill(updater.pid, "SIGKILL");
    await updaterExit;
    children.delete(updater.pid);
    await until(() => { try { process.kill(trialPid, 0); return false; } catch (e) { return e.code === "ESRCH"; } }, "trial process did not exit");
    children.delete(trialPid);
    await cli("recover");
    assert.equal((await status()).computer.releaseTag, "lifecycle-smoke-new");
    assert.equal((await status()).computer.computerId, computerId);
    assert.equal(fs.existsSync(path.join(dataDir, "smoke-interrupted-migration")), false);
    step("killed updater's trial exited automatically; recovery reclaimed its lock and rolled back the partial migration");

    const broken = path.join(tmp, "broken");
    fs.cpSync(candidate, broken, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    fs.writeFileSync(path.join(broken, "app/package.json"), JSON.stringify({ ...metadata, releaseTag: "lifecycle-smoke-broken" }));
    const entry = path.join(broken, "app/electron/server/index.js");
    const source = fs.readFileSync(entry, "utf8");
    const failure = `if (process.argv.includes("--maintenance")) { require("node:fs").writeFileSync(require("node:path").join(process.argv[process.argv.indexOf("--data-dir") + 1], "smoke-failed-migration"), "candidate data"); process.exit(23); }\n`;
    fs.writeFileSync(entry, source.replace(/^(#![^\n]*\n)?/, (prefix) => prefix + failure));
    step("checking real failed-trial rollback (readiness timeout can take 60 seconds)");
    await assert.rejects(cli("update", ["--runtime", broken]), /Previous runtime and data directory were restored/);
    assert.equal((await status()).computer.releaseTag, "lifecycle-smoke-new");
    assert.equal((await status()).computer.computerId, computerId);
    assert.equal(fs.existsSync(path.join(dataDir, "smoke-failed-migration")), false);
    assert.equal((await cli("status")).recoveryRequired, false);
    step("failed trial restored the previous runtime and data snapshot");

    await cli("stop");
    assert.equal((await cli("status")).running, false);
    await cli("start");
    assert.equal((await status()).computer.computerId, computerId);
    await cli("uninstall");
    installed = false;
    assert.equal((await cli("status")).installed, false);
    assert.equal(fs.readFileSync(path.join(dataDir, "computer-id"), "utf8").trim(), computerId);
    assert.equal(fs.readFileSync(path.join(dataDir, "web-token"), "utf8"), token);
    step("stop/start and uninstall preserve identity and credentials; PASS");
  } catch (error) {
    console.error(`[lifecycle] failure before cleanup: ${error.stack}`);
    throw error;
  } finally {
    for (const pid of children) { try { process.kill(pid, "SIGKILL"); } catch { /* exited */ } }
    if (installed) {
      // Cleanup must not depend on a possibly broken candidate or readiness.
      const name = path.basename(lifecycle.paths.unit);
      try {
        if (process.platform === "darwin") {
          const job = `gui/${process.getuid()}/${name.replace(/\.plist$/, "")}`;
          let loaded = false;
          try { execFileSync("launchctl", ["print", job], { stdio: "ignore" }); loaded = true; }
          catch (error) { if (error.status !== 113) throw error; }
          if (loaded) execFileSync("launchctl", ["bootout", job], { stdio: "ignore" });
        }
        else {
          execFileSync("systemctl", ["--user", "disable", "--now", name], { stdio: "ignore" });
          fs.rmSync(lifecycle.paths.unit, { force: true });
          execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
        }
      } catch (e) { console.error(`[lifecycle] cleanup failed; fixture retained at ${tmp}: ${e.message}`); throw e; }
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main(process.argv[2]).catch((error) => { console.error(`[lifecycle] FAIL: ${error.stack}`); process.exitCode = 1; });
