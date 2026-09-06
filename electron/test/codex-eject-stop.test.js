"use strict";

/**
 * #554 / #960: ejecting a running thread must kill Solenta's agent child
 * so Desktop or the raw CLI can take the session writer. Crew cascade is
 * not part of eject (stopRun's default still cascades for a user Stop).
 *
 * Run: node --test electron/test/codex-eject-stop.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync, spawnSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { IPC_HANDLERS, makeCtx } = require("../ipc.js");
const { writeFakeBin } = require("./support/fakeBin.js");

const HANG_SESSION = "01a072f7-10e0-7fd2-b691-7d481327516f";
const WORKER_SESSION = "01a072f7-aaaa-7fd2-b691-7d481327516f";

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
 * Hanging Codex CLI: exclusive-create a lock file (the session writer),
 * write pid, emit thread.started, then linger. SIGTERM unlinks the lock
 * so a later CLI-shaped `exec resume` can take it. A second process that
 * loses wx prints a writer-lock error and exits 2.
 */
function writeHangingFakeCodex(dir) {
  const filePath = path.join(dir, "fake-codex");
  return writeFakeBin(
    filePath,
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(1);
if (process.env.CODER_FAKE_CODEX_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CODEX_ARGV_FILE,
    JSON.stringify(argv),
    "utf8",
  );
}
function sessionKey() {
  const i = argv.indexOf("resume");
  if (i >= 0 && argv[i + 1]) return String(argv[i + 1]);
  return "fresh";
}
const key = sessionKey();
const pidsDir = process.env.CODER_FAKE_CODEX_PIDS_DIR;
if (pidsDir) {
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, key), String(process.pid));
}
if (process.env.CODER_FAKE_CODEX_PID_FILE) {
  fs.writeFileSync(process.env.CODER_FAKE_CODEX_PID_FILE, String(process.pid));
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
const lockPath =
  process.env.CODER_FAKE_CODEX_LOCK_FILE ||
  (process.env.CODER_FAKE_CODEX_LOCK_DIR
    ? path.join(process.env.CODER_FAKE_CODEX_LOCK_DIR, key + ".lock")
    : "");
let lockFd = null;
if (lockPath) {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    lockFd = fs.openSync(lockPath, "wx");
    fs.writeSync(lockFd, String(process.pid));
  } catch {
    process.stderr.write(
      "Error: thread/resume: thread/resume failed: thread " +
        key +
        " already has an active writer (code -32600)\\n",
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
if (process.env.CODER_FAKE_CODEX_RESUME_FILE && argv.includes("resume")) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CODEX_RESUME_FILE,
    JSON.stringify({ ok: true, argv: argv }),
    "utf8",
  );
  emit({ type: "thread.started", thread_id: key });
  emit({
    type: "item.completed",
    item: { id: "item-msg-1", type: "agent_message", text: "cli resume" },
  });
  emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}
emit({ type: "thread.started", thread_id: key === "fresh" ? "codex-sess-hang" : key });
setInterval(() => {}, 500);
`,
  );
}

describe("setEjected persist", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-eject-store-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    }).id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("new threads are not ejected; true survives reload without bumping updatedAt", () => {
    assert.equal(store.getThread(threadId).ejected, false);
    const before = store.getThread(threadId).updatedAt;
    const updated = services.setEjected(store, {
      threadId,
      ejected: true,
    });
    assert.equal(updated.ejected, true);
    assert.equal(updated.updatedAt, before);
    assert.equal(store.getThread(threadId).sessionId, null);

    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getThread(threadId).ejected, true);
  });

  it("setEjected throws on an unknown thread", () => {
    assert.throws(
      () => services.setEjected(store, { threadId: "nope", ejected: true }),
      /Unknown thread/,
    );
  });
});

describe("eject stops a running Codex child (#960)", () => {
  let tmpDir;
  let store;
  let runner;
  let fakeCodex;
  let pidFile;
  let lockFile;
  let resumeFile;
  let prevSimulate;
  let prevAgentCmd;
  let prevCodexBin;
  let prevArgvFile;
  let prevGrokMcpDisable;
  let prevGrokBin;
  let prevPidFile;
  let prevLockFile;
  let prevLockDir;
  let prevPidsDir;
  let prevResumeFile;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevCodexBin = process.env.CODER_CODEX_BIN;
    prevArgvFile = process.env.CODER_FAKE_CODEX_ARGV_FILE;
    prevGrokMcpDisable = process.env.CODER_GROK_MCP_DISABLE;
    prevGrokBin = process.env.CODER_GROK_BIN;
    prevPidFile = process.env.CODER_FAKE_CODEX_PID_FILE;
    prevLockFile = process.env.CODER_FAKE_CODEX_LOCK_FILE;
    prevLockDir = process.env.CODER_FAKE_CODEX_LOCK_DIR;
    prevPidsDir = process.env.CODER_FAKE_CODEX_PIDS_DIR;
    prevResumeFile = process.env.CODER_FAKE_CODEX_RESUME_FILE;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-eject-stop-"));
    fakeCodex = writeHangingFakeCodex(tmpDir);
    pidFile = path.join(tmpDir, "hang.pid");
    lockFile = path.join(tmpDir, "session.lock");
    resumeFile = path.join(tmpDir, "cli-resume.json");
    process.env.CODER_CODEX_BIN = fakeCodex;
    process.env.CODER_FAKE_CODEX_PID_FILE = pidFile;
    process.env.CODER_FAKE_CODEX_LOCK_FILE = lockFile;

    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const lead = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    services.setProvider(store, { threadId: lead.id, provider: "codex" });
    store.updateThread(lead.id, { sessionId: HANG_SESSION });
    store.saveNow();
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevCodexBin === undefined) delete process.env.CODER_CODEX_BIN;
    else process.env.CODER_CODEX_BIN = prevCodexBin;
    if (prevArgvFile === undefined) delete process.env.CODER_FAKE_CODEX_ARGV_FILE;
    else process.env.CODER_FAKE_CODEX_ARGV_FILE = prevArgvFile;
    if (prevGrokMcpDisable === undefined) {
      delete process.env.CODER_GROK_MCP_DISABLE;
    } else process.env.CODER_GROK_MCP_DISABLE = prevGrokMcpDisable;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
    if (prevPidFile === undefined) delete process.env.CODER_FAKE_CODEX_PID_FILE;
    else process.env.CODER_FAKE_CODEX_PID_FILE = prevPidFile;
    if (prevLockFile === undefined) delete process.env.CODER_FAKE_CODEX_LOCK_FILE;
    else process.env.CODER_FAKE_CODEX_LOCK_FILE = prevLockFile;
    if (prevLockDir === undefined) delete process.env.CODER_FAKE_CODEX_LOCK_DIR;
    else process.env.CODER_FAKE_CODEX_LOCK_DIR = prevLockDir;
    if (prevPidsDir === undefined) delete process.env.CODER_FAKE_CODEX_PIDS_DIR;
    else process.env.CODER_FAKE_CODEX_PIDS_DIR = prevPidsDir;
    if (prevResumeFile === undefined) {
      delete process.env.CODER_FAKE_CODEX_RESUME_FILE;
    } else process.env.CODER_FAKE_CODEX_RESUME_FILE = prevResumeFile;
  });

  function lead() {
    return store.getThreads().find((t) => !t.orchWorker);
  }

  async function eject(threadId, ejected) {
    const ctx = makeCtx({
      store,
      runner,
      broadcast() {},
    });
    return IPC_HANDLERS["threads:setEjected"](ctx, { threadId, ejected });
  }

  it("kills the hanging child and lets a CLI-shaped resume take the writer", async () => {
    const orch = lead();
    await runner.startRun({ threadId: orch.id, prompt: "hold the writer" });
    await waitFor(() => readPid(pidFile) > 0 && fs.existsSync(lockFile));
    const pid = readPid(pidFile);
    assert.equal(processAlive(pid), true, "child must be alive before eject");
    assert.equal(runner.isRunning(orch.id), true);

    const updated = await eject(orch.id, true);
    assert.equal(updated.ejected, true);
    assert.equal(updated.sessionId, HANG_SESSION, "sessionId stays for the raw CLI");

    await waitFor(() => !runner.isRunning(orch.id) && !processAlive(pid));
    assert.equal(processAlive(pid), false, "Solenta child must be gone");
    await waitFor(() => !fs.existsSync(lockFile));

    process.env.CODER_FAKE_CODEX_RESUME_FILE = resumeFile;
    const cli = spawnSync(fakeCodex, ["exec", "resume", HANG_SESSION], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        CODER_FAKE_CODEX_LOCK_FILE: lockFile,
        CODER_FAKE_CODEX_RESUME_FILE: resumeFile,
        CODER_FAKE_CODEX_PID_FILE: path.join(tmpDir, "cli.pid"),
      },
    });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.equal(JSON.parse(fs.readFileSync(resumeFile, "utf8")).ok, true);
    assert.equal(store.getThread(orch.id).ejected, true);
  });

  it("does not stop a running crew worker", async () => {
    delete process.env.CODER_FAKE_CODEX_LOCK_FILE;
    delete process.env.CODER_FAKE_CODEX_PID_FILE;
    const pidsDir = path.join(tmpDir, "pids");
    const lockDir = path.join(tmpDir, "locks");
    process.env.CODER_FAKE_CODEX_PIDS_DIR = pidsDir;
    process.env.CODER_FAKE_CODEX_LOCK_DIR = lockDir;

    const orch = lead();
    const worker = services.forkThread(store, { threadId: orch.id });
    store.updateThread(worker.id, {
      orchWorker: true,
      title: "Worker A",
      provider: "codex",
      sessionId: WORKER_SESSION,
    });
    store.saveNow();

    await runner.startRun({ threadId: worker.id, prompt: "worker holds" });
    await runner.startRun({ threadId: orch.id, prompt: "lead holds" });
    const leadPidFile = path.join(pidsDir, HANG_SESSION);
    const workerPidFile = path.join(pidsDir, WORKER_SESSION);
    await waitFor(
      () => readPid(leadPidFile) > 0 && readPid(workerPidFile) > 0,
    );
    const leadPid = readPid(leadPidFile);
    const workerPid = readPid(workerPidFile);
    assert.equal(processAlive(leadPid), true);
    assert.equal(processAlive(workerPid), true);

    await eject(orch.id, true);

    await waitFor(() => !runner.isRunning(orch.id) && !processAlive(leadPid));
    assert.equal(runner.isRunning(worker.id), true, "crew must keep running");
    assert.equal(processAlive(workerPid), true, "worker child must stay alive");
    assert.equal(store.getThread(worker.id).status, "working");
  });

  it("reclaim (ejected: false) does not kill a running child", async () => {
    const orch = lead();
    await runner.startRun({ threadId: orch.id, prompt: "keep going" });
    await waitFor(() => readPid(pidFile) > 0);
    const pid = readPid(pidFile);

    await eject(orch.id, false);

    assert.equal(runner.isRunning(orch.id), true);
    assert.equal(processAlive(pid), true);
    assert.equal(store.getThread(orch.id).ejected, false);
  });
});
