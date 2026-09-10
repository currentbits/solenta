"use strict";

/**
 * #950: do not auto-continue a Codex lead while another process holds
 * the session writer. Overlay isolation is in codex-guardrail-hook.test.js.
 *
 * Run: node --test electron/test/codex-writer-lock.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner, looksWriterLock } = require("../runner.js");
const { writeFakeBin } = require("./support/fakeBin.js");

const WRITER_LOCK_STDERR =
  "2026-09-06T06:26:58.016879Z ERROR codex_core::session::session: " +
  "failed to initialize thread persistence: thread-store conflict: " +
  "thread 01a072f7-10e0-7fd2-b691-7d481327516f already has an active writer";

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

function userTexts(store, threadId) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === "user")
    .map((m) => String(m.text || ""));
}

function eventTexts(store, threadId) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === "event")
    .map((m) => String(m.text || ""));
}

async function writeFakeCodex(dir) {
  return require("./support/fakeCodexCli.js").writeFakeCodexBin(dir, writeFakeBin);
}

describe("looksWriterLock", () => {
  it("matches explicit thread-store writer conflicts, not generic -32600", () => {
    assert.equal(looksWriterLock(WRITER_LOCK_STDERR), true);
    assert.equal(
      looksWriterLock("thread 01abc already has an active writer"),
      true,
    );
    assert.equal(
      looksWriterLock("thread-store conflict: thread x already has a live local writer"),
      true,
    );
    assert.equal(
      looksWriterLock("JSON-RPC error -32600: Invalid Request"),
      false,
    );
    assert.equal(looksWriterLock("Run error (exit 1): spawn codex ENOENT"), false);
    assert.equal(looksWriterLock(""), false);
  });
});

describe("Codex writer-lock auto-continue (#950)", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let argvFile;
  let prevSimulate;
  let prevAgentCmd;
  let prevCodexBin;
  let prevScenario;
  let prevArgvFile;
  let prevGrokMcpDisable;
  let prevGrokBin;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevCodexBin = process.env.CODER_CODEX_BIN;
    prevScenario = process.env.CODER_FAKE_CODEX_SCENARIO;
    prevArgvFile = process.env.CODER_FAKE_CODEX_ARGV_FILE;
    prevGrokMcpDisable = process.env.CODER_GROK_MCP_DISABLE;
    prevGrokBin = process.env.CODER_GROK_BIN;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-codex-lock-"));
    const fakeCodex = await writeFakeCodex(tmpDir);
    argvFile = path.join(tmpDir, "argv.json");
    process.env.CODER_CODEX_BIN = fakeCodex;
    process.env.CODER_FAKE_CODEX_ARGV_FILE = argvFile;
    process.env.CODER_FAKE_CODEX_RPC_FILE = path.join(tmpDir, "rpc.jsonl");
    process.env.CODER_FAKE_CODEX_SCENARIO = "writer-lock";

    store = new Store(path.join(tmpDir, "store.json"));
    core = await loadCore();
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
    const orch = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    services.setProvider(store, { threadId: orch.id, provider: "codex" });
    store.updateThread(
      orch.id,
      {
        sessionId: "01a072f7-10e0-7fd2-b691-7d481327516f",
        status: "failed",
        lastError: "Run error (exit 1):\n" + WRITER_LOCK_STDERR,
      },
      { touch: true },
    );
    const worker = services.forkThread(store, { threadId: orch.id });
    store.updateThread(worker.id, {
      orchWorker: true,
      title: "Worker A",
      provider: "simulate",
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
    if (prevCodexBin === undefined) delete process.env.CODER_CODEX_BIN;
    else process.env.CODER_CODEX_BIN = prevCodexBin;
    if (prevScenario === undefined) delete process.env.CODER_FAKE_CODEX_SCENARIO;
    else process.env.CODER_FAKE_CODEX_SCENARIO = prevScenario;
    if (prevArgvFile === undefined) delete process.env.CODER_FAKE_CODEX_ARGV_FILE;
    else process.env.CODER_FAKE_CODEX_ARGV_FILE = prevArgvFile;
    delete process.env.CODER_FAKE_CODEX_RPC_FILE;
    if (prevGrokMcpDisable === undefined) {
      delete process.env.CODER_GROK_MCP_DISABLE;
    } else process.env.CODER_GROK_MCP_DISABLE = prevGrokMcpDisable;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
  });

  function orchWorker() {
    return store.getThreads().find((t) => t.orchWorker);
  }

  function orch() {
    return store.getThreads().find((t) => !t.orchWorker);
  }

  it("parks a worker-finished notice instead of spawning exec resume", async () => {
    const lead = orch();
    const worker = orchWorker();
    await runner.startRun({ threadId: worker.id, prompt: "worker task" });
    await waitFor(() => store.getThread(worker.id).status === "done");
    await waitFor(
      () =>
        fs.existsSync(argvFile) ||
        eventTexts(store, lead.id).some((t) =>
          /owned by another process/i.test(t),
        ),
    );
    assert.equal(fs.existsSync(argvFile), false, "must not spawn exec resume");
    assert.equal(
      userTexts(store, lead.id).some((t) => t.includes("[orchestration]")),
      false,
    );
    const leadNow = store.getThread(lead.id);
    assert.equal(leadNow.status, "failed");
    assert.match(String(leadNow.lastError || ""), /active writer/);
  });

  it("delivers the parked notice once the writer-lock lastError is gone", async () => {
    const lead = orch();
    const worker = orchWorker();
    await runner.startRun({ threadId: worker.id, prompt: "worker task" });
    await waitFor(() => store.getThread(worker.id).status === "done");
    await waitFor(
      () =>
        fs.existsSync(argvFile) ||
        eventTexts(store, lead.id).some((t) =>
          /owned by another process/i.test(t),
        ),
    );
    assert.equal(fs.existsSync(argvFile), false);

    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    store.updateThread(
      lead.id,
      { status: "done", lastError: null, lastErrorKind: null },
      { touch: true },
    );
    store.saveNow();

    const worker2 = services.forkThread(store, { threadId: lead.id });
    store.updateThread(worker2.id, {
      orchWorker: true,
      title: "Worker B",
      provider: "simulate",
    });
    store.saveNow();
    await runner.startRun({ threadId: worker2.id, prompt: "second worker" });
    await waitFor(() => store.getThread(worker2.id).status === "done");
    await waitFor(() => {
      const f = process.env.CODER_FAKE_CODEX_RPC_FILE;
      if (!f || !fs.existsSync(f)) return false;
      const rpc = fs
        .readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        });
      return rpc.some((m) => m && m.method === "thread/resume");
    });
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("app-server"), JSON.stringify(argv));
    const rpc = fs
      .readFileSync(process.env.CODER_FAKE_CODEX_RPC_FILE, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const resume = rpc.find((m) => m.method === "thread/resume");
    assert.ok(resume, JSON.stringify(rpc));
    assert.equal(resume.params.threadId, "01a072f7-10e0-7fd2-b691-7d481327516f");
    await waitFor(() =>
      userTexts(store, lead.id).some((t) => t.includes("[orchestration]")),
    );
  });

  it("still starts a user send on a writer-locked Codex lead", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "success";
    const lead = orch();
    await runner.startRun({ threadId: lead.id, prompt: "human turn" });
    await waitFor(() => {
      const f = process.env.CODER_FAKE_CODEX_RPC_FILE;
      if (!f || !fs.existsSync(f)) return false;
      return /thread\/resume/.test(fs.readFileSync(f, "utf8"));
    });
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.includes("app-server"), JSON.stringify(argv));
    const rpc = fs
      .readFileSync(process.env.CODER_FAKE_CODEX_RPC_FILE, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(
      rpc.some((m) => m.method === "thread/resume"),
      JSON.stringify(rpc),
    );
    await waitFor(() => store.getThread(lead.id).status === "done");
  });

  it("does not auto-resume an ejected Codex lead", async () => {
    const lead = orch();
    store.updateThread(
      lead.id,
      { ejected: true, status: "done", lastError: null, lastErrorKind: null },
      { touch: true },
    );
    store.saveNow();
    const worker = orchWorker();
    await runner.startRun({ threadId: worker.id, prompt: "worker task" });
    await waitFor(() => store.getThread(worker.id).status === "done");
    await waitFor(
      () =>
        fs.existsSync(argvFile) ||
        eventTexts(store, lead.id).some((t) => /ejected/i.test(t)),
    );
    assert.equal(fs.existsSync(argvFile), false);
    assert.equal(
      userTexts(store, lead.id).some((t) => t.includes("[orchestration]")),
      false,
    );
  });

  it("does not start a second Solenta Codex child for the same sessionId", async () => {
    process.env.CODER_FAKE_CODEX_SCENARIO = "hang";
    const lead = orch();
    store.updateThread(
      lead.id,
      { status: "idle", lastError: null, lastErrorKind: null },
      { touch: true },
    );
    const other = services.createThread(store, {
      projectId: lead.projectId,
      title: "Other",
    });
    services.setProvider(store, { threadId: other.id, provider: "codex" });
    store.updateThread(other.id, {
      sessionId: lead.sessionId,
    });
    store.saveNow();

    await runner.startRun({ threadId: lead.id, prompt: "hold the writer" });
    await waitFor(() => runner.isRunning(lead.id));
    await waitFor(() => fs.existsSync(argvFile));
    fs.unlinkSync(argvFile);

    await assert.rejects(
      () => runner.startRun({ threadId: other.id, prompt: "second child" }),
      /already running|session writer|active writer/i,
    );
    assert.equal(fs.existsSync(argvFile), false);
    assert.equal(runner.isRunning(other.id), false);
  });
});

describe("Claude auto-continue is unchanged (#950)", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    process.env.CODER_SIMULATE = "1";
    delete process.env.CODER_AGENT_CMD;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-claude-lock-"));
    store = new Store(path.join(tmpDir, "store.json"));
    core = await loadCore();
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
    services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("still wakes an idle non-Codex orchestrator", async () => {
    const orch = store.getThreads()[0];
    store.updateThread(orch.id, {
      lastError:
        "Run error (exit 1):\n" + WRITER_LOCK_STDERR,
      status: "failed",
    });
    const worker = services.forkThread(store, { threadId: orch.id });
    store.updateThread(worker.id, { orchWorker: true, title: "Worker A" });
    store.saveNow();
    await runner.startRun({ threadId: worker.id, prompt: "worker task" });
    await waitFor(() => store.getThread(worker.id).status === "done");
    await waitFor(() =>
      userTexts(store, orch.id).some((t) => t.includes("[orchestration]")),
    );
  });
});
