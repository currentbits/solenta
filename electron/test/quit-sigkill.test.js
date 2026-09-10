"use strict";

/**
 * #1233: app quit must reap SIGTERM-ignoring detached agent children.
 * Run: node --test electron/test/quit-sigkill.test.js
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { resetShutdownForTests } = require("../proc.js");
const { installShutdown, runAppCleanup } = require("../shutdown.js");

const posix = process.platform !== "win32";
const IGNORER =
  "process.on('SIGTERM',()=>{});require('fs').writeFileSync('agent.pid',String(process.pid));setInterval(()=>{},200)";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).charAt(0) === "Z") return false;
  } catch {
    // no /proc, or the pid vanished
  }
  return true;
}

function reap(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

describe("#1233 quit SIGKILL", { skip: !posix }, () => {
  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    resetShutdownForTests();
  });

  it("stopAll plus shutdown exit reaps a SIGTERM-ignorer without a harness SIGKILL", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-quit-sigkill-"));
    const readyFile = path.join(tmp, "ready");
    const helperPath = path.join(tmp, "helper.js");
    const procPath = require.resolve("../proc.js");
    const shutdownPath = require.resolve("../shutdown.js");
    const victimSrc =
      "process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.env.READY_FILE,String(process.pid));setInterval(()=>{},200)";
    fs.writeFileSync(
      helperPath,
      `"use strict";
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { agentSpawnOptions, killTree } = require(${JSON.stringify(procPath)});
const { installShutdown, runAppCleanup } = require(${JSON.stringify(shutdownPath)});
const readyFile = process.env.READY_FILE;
const victim = spawn(process.execPath, ["-e", ${JSON.stringify(victimSrc)}], {
  ...agentSpawnOptions({ stdio: "ignore", env: { ...process.env, READY_FILE: readyFile } }),
});
if (!victim.pid) process.exit(2);
const deadline = Date.now() + 5000;
(function waitReady() {
  let pid = "";
  try { pid = fs.readFileSync(readyFile, "utf8").trim(); } catch { pid = ""; }
  if (pid) {
    const app = new EventEmitter();
    installShutdown({
      app,
      exit: (code) => process.exit(code ?? 0),
      cleanup: () => runAppCleanup({ stopRuns() { killTree(victim, 3000); } }),
    });
    app.emit("before-quit", { preventDefault() {} });
    return;
  }
  if (Date.now() > deadline) process.exit(3);
  setTimeout(waitReady, 10);
})();
`,
    );

    const helper = spawn(process.execPath, [helperPath], {
      env: { ...process.env, READY_FILE: readyFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    helper.stderr.setEncoding("utf8");
    let stderr = "";
    helper.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let victimPid = 0;
    try {
      await waitFor(() => fs.existsSync(readyFile));
      victimPid = Number(fs.readFileSync(readyFile, "utf8").trim());
      assert.ok(Number.isFinite(victimPid) && victimPid > 0);
      const helperExit = await new Promise((resolve, reject) => {
        if (helper.exitCode != null) return resolve(helper.exitCode);
        const t = setTimeout(
          () => reject(new Error("helper did not exit: " + stderr)),
          5000,
        );
        helper.on("exit", (code) => {
          clearTimeout(t);
          resolve(code);
        });
        helper.on("error", (err) => {
          clearTimeout(t);
          reject(err);
        });
      });
      assert.equal(helperExit, 0, "helper shutdown must exit 0; stderr=" + stderr);
      await waitFor(() => !alive(victimPid), { timeoutMs: 3000 });
      assert.equal(alive(victimPid), false);
    } finally {
      if (victimPid && alive(victimPid)) reap(victimPid);
      if (helper.pid && alive(helper.pid)) reap(helper.pid);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("in-app stopRun returns immediately and does not SIGKILL a SIGTERM-ignorer", async () => {
    const prevSimulate = process.env.CODER_SIMULATE;
    const prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${IGNORER}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-stoprun-"));
    const pids = [];
    let runner;
    try {
      const store = new Store(path.join(tmpDir, "store.json"));
      const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
      runner = createRunner({ store, core, pushFn: () => {}, tickMs: 15 });
      const repo = path.join(tmpDir, "app");
      fs.mkdirSync(repo);
      git(repo, ["init"]);
      const project = await services.addProject(store, repo);
      services.createThread(store, { projectId: project.id, title: "Stop" });
      const thread = store.getThreads()[0];
      const pidPath = path.join(project.path, "agent.pid");
      await runner.startRun({ threadId: thread.id, prompt: "linger" });
      await waitFor(() => fs.existsSync(pidPath));
      const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
      assert.ok(Number.isFinite(pid) && pid > 0);
      pids.push(pid);
      assert.equal(alive(pid), true);
      const t0 = Date.now();
      await runner.stopRun({ threadId: thread.id });
      assert.ok(Date.now() - t0 < 1000, "stopRun must return immediately");
      assert.equal(alive(pid), true, "in-app stopRun must not SIGKILL");
    } finally {
      resetShutdownForTests();
      if (runner) runner.stopAll();
      for (const pid of pids) reap(pid);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
      else process.env.CODER_SIMULATE = prevSimulate;
      if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
      else process.env.CODER_AGENT_CMD = prevAgentCmd;
    }
  });
});
