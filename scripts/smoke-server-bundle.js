#!/usr/bin/env node
"use strict";

/**
 * Smoke-test one headless server archive (#1829) on the machine it was
 * built for: unpack it, boot its own bin/solenta-server (its bundled Node,
 * not this one) with a throwaway HOME and data dir, then over Solenta Web
 * add a git repo, run a thread in its own worktree (simulated agent), and
 * type into a real terminal. Exits non-zero on any failure.
 *
 *   node scripts/smoke-server-bundle.js out/solenta-server-<v>-<target>.tar.gz
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { invokeRemote } = require("../electron/remoteConnections.js");

const archive = process.argv[2];
if (!archive || !fs.existsSync(archive)) {
  console.error("usage: smoke-server-bundle.js <solenta-server archive>");
  process.exit(2);
}

const step = (msg) => console.log(`[smoke] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-smoke-"));
  const home = path.join(tmp, "home");
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  execFileSync("tar", ["-xzf", archive, "-C", tmp]);
  const bin = path.join(tmp, "solenta-server", "bin");
  step(`bundled node ${execFileSync(path.join(bin, "node"), ["--version"], { encoding: "utf8" }).trim()} (${process.platform}-${process.arch})`);
  const app = path.join(tmp, "solenta-server", "app");
  const proofCheck = `const p = require(${JSON.stringify(path.join(app, "electron/cloud/protocol.js"))}); (async () => { const key = await p.createKeyPair(); const proof = await p.signProof(key.privateJwk, { nonce: "package-check" }, "package-check", "package-check"); const claims = await p.verifyProof(proof, key.publicJwk, { purpose: "package-check", audience: "package-check" }); if (claims.nonce !== "package-check") process.exit(1); })().catch(() => process.exit(1));`;
  execFileSync(path.join(bin, "node"), ["-e", proofCheck], { cwd: home, stdio: "pipe" });
  assert.match(execFileSync(path.join(bin, "solenta-connect"), ["--help"], { cwd: home, encoding: "utf8" }), /login.*link.*status/s);
  step("bundled cloud proof dependency and connect CLI resolve outside the checkout");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=s@s", "-c", "user.name=s", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });

  const port = 47000 + Math.floor(Math.random() * 2000);
  const child = spawn(path.join(bin, "solenta-server"), ["--port", String(port), "--data-dir", path.join(tmp, "data")], {
    env: { ...process.env, HOME: home, CODER_SIMULATE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
  try {
    for (let i = 0; !/solenta-web: listening/.test(log); i++) {
      if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}`);
      if (i > 600) throw new Error("server did not start in 60 s");
      await sleep(100);
    }
    step("server up");
    const token = fs.readFileSync(path.join(tmp, "data", "web-token"), "utf8").trim();
    const tokens = { get: () => token, set() { return true; }, delete() {} };
    const call = (ch, args) => invokeRemote({ url: `http://127.0.0.1:${port}` }, ch, args, { tokens });

    const descriptor = await fetch(`http://127.0.0.1:${port}/.well-known/solenta`, { redirect: "error" }).then(r => r.json());
    const packaged = JSON.parse(fs.readFileSync(path.join(tmp, "solenta-server", "app", "package.json"), "utf8"));
    assert.equal(descriptor.runtimeKind, "server");
    assert.equal(descriptor.computerId, fs.readFileSync(path.join(tmp, "data", "computer-id"), "utf8").trim());
    assert.equal(descriptor.buildSha, packaged.buildSha);
    if (packaged.releaseTag) assert.equal(descriptor.releaseTag, packaged.releaseTag);
    const status = await call("app:status", []);
    assert.equal(status.computer.computerId, descriptor.computerId);
    assert.equal(status.build.runtimeKind, "server");
    assert.equal(status.build.buildSha, packaged.buildSha);
    step("public and authenticated computer/build identity agree");
    // isBuildMismatch compares app:status build.sha with the renderer's baked
    // __BUILD_SHA__ exactly; a short/full mismatch boots every browser into
    // "Reload required".
    const assets = path.join(tmp, "solenta-server", "app", "dist", "assets");
    assert.ok(
      fs.readdirSync(assets).some((f) => f.endsWith(".js") && fs.readFileSync(path.join(assets, f), "utf8").includes(JSON.stringify(status.build.sha))),
      `renderer bundle is stamped with server build ${status.build.sha}`,
    );
    step("renderer build stamp matches the server");

    const project = await call("projects:add", [repo]);
    const thread = await call("threads:create", [{ projectId: project.id, title: "smoke", worktree: true }]);
    await call("runs:start", [{ threadId: thread.id, prompt: "hello" }]);
    let detail = null;
    for (let i = 0; i < 200; i++) {
      detail = await call("threads:get", [thread.id]);
      if (detail.thread.status === "done" || detail.thread.status === "failed") break;
      await sleep(150);
    }
    if (detail.thread.status !== "done") throw new Error(`run ended ${detail.thread.status}: ${detail.thread.lastError || ""}`);
    if (!detail.thread.worktreePath) throw new Error("run had no worktree");
    step("worktree run done");

    const term = await call("terminal:open", [{ threadId: thread.id, cols: 80, rows: 24 }]);
    if (!term.pty) throw new Error("terminal fell back to no PTY: native node-pty did not load");
    await call("terminal:write", [{ threadId: thread.id, termId: term.termId, data: "echo SMOKE_$((40+2))\n" }]);
    let out = "";
    for (let i = 0; i < 50 && !out.includes("SMOKE_42"); i++) {
      await sleep(200);
      out = JSON.stringify(await call("terminal:read", [{ threadId: thread.id, termId: term.termId }]));
    }
    if (!out.includes("SMOKE_42")) throw new Error("terminal did not echo");
    step("PTY terminal ok");
    step("PASS");
  } catch (err) {
    console.error(`[smoke] FAIL: ${err && err.message ? err.message : err}\n--- server log ---\n${log.slice(-4000)}`);
    process.exitCode = 1;
  } finally {
    stop();
    await sleep(500);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})();
