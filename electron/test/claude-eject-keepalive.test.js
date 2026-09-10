"use strict";

/**
 * #979: ejecting after a Claude turn must kill the idle keep-alive CLI so
 * Desktop or `claude --resume` can take the session writer. stopRun is a
 * no-op once the Solenta turn has ended; disposeClaudeSession is the
 * release. Crew cascade is not part of eject.
 *
 * Run: node --test electron/test/claude-eject-keepalive.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync, spawnSync } = require("node:child_process");
const Module = require("node:module");

{
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return {
        ipcMain: { handle() {} },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        shell: {},
        app: { getPath: () => os.tmpdir() },
      };
    }
    return origLoad.apply(this, arguments);
  };
}

const { IPC_HANDLERS, makeCtx } = require("../ipc.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { writeFakeBin } = require("./support/fakeBin.js");

const KEEP_SESSION = "sess-keep";
const WORKER_SESSION = "sess-keep-worker";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
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

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file) {
  if (!fs.existsSync(file)) return 0;
  const n = Number(fs.readFileSync(file, "utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Keep-alive Claude CLI: exclusive-create a lock file (the session writer),
 * emit one turn, then linger. SIGTERM unlinks the lock so a later
 * CLI-shaped `claude --resume` can take it. A second process that loses
 * wx prints a writer-lock error and exits 2.
 */
function writeKeepAliveFakeClaude(dir) {
  const filePath = path.join(dir, "fake-claude");
  return writeFakeBin(
    filePath,
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(1);
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
function sessionKey() {
  const i = argv.indexOf("--resume");
  if (i >= 0 && argv[i + 1]) return String(argv[i + 1]);
  return process.env.CODER_FAKE_CLAUDE_SESSION || "sess-keep";
}
const key = sessionKey();
const pidsDir = process.env.CODER_FAKE_CLAUDE_PIDS_DIR;
if (pidsDir) {
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, key), String(process.pid));
}
if (process.env.CODER_FAKE_CLAUDE_PID_FILE) {
  fs.writeFileSync(process.env.CODER_FAKE_CLAUDE_PID_FILE, String(process.pid));
}
const lockPath =
  process.env.CODER_FAKE_CLAUDE_LOCK_FILE ||
  (process.env.CODER_FAKE_CLAUDE_LOCK_DIR
    ? path.join(process.env.CODER_FAKE_CLAUDE_LOCK_DIR, key + ".lock")
    : "");
let lockFd = null;
if (lockPath) {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    lockFd = fs.openSync(lockPath, "wx");
    fs.writeSync(lockFd, String(process.pid));
  } catch {
    process.stderr.write(
      "Error: session " + key + " already has an active writer\\n",
    );
    process.exit(2);
  }
}
function releaseLock() {
  if (lockFd != null) {
    try { fs.closeSync(lockFd); } catch {}
    lockFd = null;
  }
  if (lockPath) {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}
process.on("exit", releaseLock);
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(0);
});
if (process.env.CODER_FAKE_CLAUDE_RESUME_FILE && argv.includes("--resume")) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CLAUDE_RESUME_FILE,
    JSON.stringify({ ok: true, argv: argv }),
    "utf8",
  );
  emit({ type: "system", subtype: "init", session_id: key, model: "m" });
  emit({
    type: "result",
    subtype: "success",
    result: "cli resume",
    usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: 0,
    num_turns: 1,
    session_id: key,
  });
  process.exit(0);
}
emit({ type: "system", subtype: "init", session_id: key, model: "m" });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user") continue;
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "kept" }] },
    });
    emit({
      type: "result",
      subtype: "success",
      result: "kept",
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      num_turns: 1,
      session_id: key,
    });
  }
});
setInterval(() => {}, 500);
`,
  );
}

describe("eject disposes idle Claude keep-alive (#979)", () => {
  let tmpDir;
  let store;
  let runner;
  let fakeClaude;
  let pidFile;
  let lockFile;
  let resumeFile;
  let prevSimulate;
  let prevAgentCmd;
  let prevClaudeBin;
  let prevGrokMcpDisable;
  let prevGrokBin;
  let prevPidFile;
  let prevLockFile;
  let prevLockDir;
  let prevPidsDir;
  let prevResumeFile;
  let prevSession;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevGrokMcpDisable = process.env.CODER_GROK_MCP_DISABLE;
    prevGrokBin = process.env.CODER_GROK_BIN;
    prevPidFile = process.env.CODER_FAKE_CLAUDE_PID_FILE;
    prevLockFile = process.env.CODER_FAKE_CLAUDE_LOCK_FILE;
    prevLockDir = process.env.CODER_FAKE_CLAUDE_LOCK_DIR;
    prevPidsDir = process.env.CODER_FAKE_CLAUDE_PIDS_DIR;
    prevResumeFile = process.env.CODER_FAKE_CLAUDE_RESUME_FILE;
    prevSession = process.env.CODER_FAKE_CLAUDE_SESSION;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_FAKE_CLAUDE_RESUME_FILE;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";
    process.env.CODER_FAKE_CLAUDE_SESSION = KEEP_SESSION;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-claude-eject-"));
    fakeClaude = writeKeepAliveFakeClaude(tmpDir);
    pidFile = path.join(tmpDir, "keep.pid");
    lockFile = path.join(tmpDir, "session.lock");
    resumeFile = path.join(tmpDir, "cli-resume.json");
    process.env.CODER_CLAUDE_BIN = fakeClaude;
    process.env.CODER_FAKE_CLAUDE_PID_FILE = pidFile;
    process.env.CODER_FAKE_CLAUDE_LOCK_FILE = lockFile;

    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      userDataPath: tmpDir,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "Claude Lead",
    });
    store.saveNow();
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevClaudeBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevClaudeBin;
    if (prevGrokMcpDisable === undefined) {
      delete process.env.CODER_GROK_MCP_DISABLE;
    } else process.env.CODER_GROK_MCP_DISABLE = prevGrokMcpDisable;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
    if (prevPidFile === undefined) delete process.env.CODER_FAKE_CLAUDE_PID_FILE;
    else process.env.CODER_FAKE_CLAUDE_PID_FILE = prevPidFile;
    if (prevLockFile === undefined) delete process.env.CODER_FAKE_CLAUDE_LOCK_FILE;
    else process.env.CODER_FAKE_CLAUDE_LOCK_FILE = prevLockFile;
    if (prevLockDir === undefined) delete process.env.CODER_FAKE_CLAUDE_LOCK_DIR;
    else process.env.CODER_FAKE_CLAUDE_LOCK_DIR = prevLockDir;
    if (prevPidsDir === undefined) delete process.env.CODER_FAKE_CLAUDE_PIDS_DIR;
    else process.env.CODER_FAKE_CLAUDE_PIDS_DIR = prevPidsDir;
    if (prevResumeFile === undefined) {
      delete process.env.CODER_FAKE_CLAUDE_RESUME_FILE;
    } else process.env.CODER_FAKE_CLAUDE_RESUME_FILE = prevResumeFile;
    if (prevSession === undefined) delete process.env.CODER_FAKE_CLAUDE_SESSION;
    else process.env.CODER_FAKE_CLAUDE_SESSION = prevSession;
  });

  function lead() {
    return store.getThreads().find((t) => !t.orchWorker);
  }

  async function eject(threadId, ejected) {
    const ctx = makeCtx({
      store,
      runner,
      broadcast() {},
      worktreeBase: "",
      userDataPath: tmpDir,
    });
    return IPC_HANDLERS["threads:setEjected"](ctx, { threadId, ejected });
  }

  async function finishKeepAliveTurn(threadId) {
    await runner.startRun({ threadId, prompt: "one turn" });
    await waitFor(() => store.getThread(threadId).status === "done");
    // Turn settled but the CLI must still be holding the writer.
    await waitFor(() => readPid(pidFile) > 0 && fs.existsSync(lockFile));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      runner.isRunning(threadId),
      false,
      "Solenta turn must have ended before eject",
    );
  }

  it("kills the kept child and lets a CLI-shaped resume take the writer", async () => {
    const orch = lead();
    await finishKeepAliveTurn(orch.id);
    const pid = readPid(pidFile);
    assert.equal(processAlive(pid), true, "keep-alive must survive turn settle");
    assert.equal(store.getThread(orch.id).sessionId, KEEP_SESSION);

    const blocked = spawnSync(fakeClaude, ["--resume", KEEP_SESSION], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        CODER_FAKE_CLAUDE_LOCK_FILE: lockFile,
        CODER_FAKE_CLAUDE_RESUME_FILE: resumeFile,
        CODER_FAKE_CLAUDE_PID_FILE: path.join(tmpDir, "blocked.pid"),
      },
    });
    assert.equal(blocked.status, 2, "writer lock must still be held before eject");

    const updated = await eject(orch.id, true);
    assert.equal(updated.ejected, true);
    assert.equal(
      updated.sessionId,
      KEEP_SESSION,
      "sessionId stays for the raw CLI",
    );

    await waitFor(() => !processAlive(pid), { timeoutMs: 5000 });
    assert.equal(processAlive(pid), false, "kept-alive child must be gone");
    await waitFor(() => !fs.existsSync(lockFile), { timeoutMs: 5000 });

    const cli = spawnSync(fakeClaude, ["--resume", KEEP_SESSION], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        CODER_FAKE_CLAUDE_LOCK_FILE: lockFile,
        CODER_FAKE_CLAUDE_RESUME_FILE: resumeFile,
        CODER_FAKE_CLAUDE_PID_FILE: path.join(tmpDir, "cli.pid"),
      },
    });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.equal(JSON.parse(fs.readFileSync(resumeFile, "utf8")).ok, true);
    assert.equal(store.getThread(orch.id).ejected, true);
  });

  it("does not stop a running crew worker keep-alive", async () => {
    delete process.env.CODER_FAKE_CLAUDE_LOCK_FILE;
    delete process.env.CODER_FAKE_CLAUDE_PID_FILE;
    const pidsDir = path.join(tmpDir, "pids");
    const lockDir = path.join(tmpDir, "locks");
    process.env.CODER_FAKE_CLAUDE_PIDS_DIR = pidsDir;
    process.env.CODER_FAKE_CLAUDE_LOCK_DIR = lockDir;

    const orch = lead();
    const worker = services.forkThread(store, { threadId: orch.id });
    store.updateThread(worker.id, {
      orchWorker: true,
      title: "Worker A",
    });
    store.saveNow();

    process.env.CODER_FAKE_CLAUDE_SESSION = KEEP_SESSION;
    await runner.startRun({ threadId: orch.id, prompt: "lead turn" });
    await waitFor(() => store.getThread(orch.id).status === "done");

    process.env.CODER_FAKE_CLAUDE_SESSION = WORKER_SESSION;
    await runner.startRun({ threadId: worker.id, prompt: "worker turn" });
    await waitFor(() => store.getThread(worker.id).status === "done");

    const leadPidFile = path.join(pidsDir, KEEP_SESSION);
    const workerPidFile = path.join(pidsDir, WORKER_SESSION);
    await waitFor(
      () => readPid(leadPidFile) > 0 && readPid(workerPidFile) > 0,
    );
    const leadPid = readPid(leadPidFile);
    const workerPid = readPid(workerPidFile);
    assert.equal(processAlive(leadPid), true);
    assert.equal(processAlive(workerPid), true);

    await eject(orch.id, true);

    await waitFor(() => !processAlive(leadPid), { timeoutMs: 5000 });
    assert.equal(processAlive(workerPid), true, "worker keep-alive must stay");
    assert.equal(
      store.getThread(worker.id).status,
      "done",
      "crew must not be cascade-stopped",
    );
  });

  it("reclaim (ejected: false) does not kill a kept-alive child", async () => {
    const orch = lead();
    await finishKeepAliveTurn(orch.id);
    const pid = readPid(pidFile);

    await eject(orch.id, false);

    assert.equal(processAlive(pid), true);
    assert.equal(store.getThread(orch.id).ejected, false);
  });
});
