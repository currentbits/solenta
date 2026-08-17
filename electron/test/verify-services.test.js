/**
 * Issue #296: persist / set / run the thread verification gate.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { VERIFY_COMMAND_MAX } = require("../verify.js");

const idleRunner = { isRunning: () => false };
const busyRunner = { isRunning: () => true };

describe("verify persistence", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-verify-svc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Worker",
    }).id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createThread starts unarmed with no evidence", () => {
    const thread = store.getThread(threadId);
    assert.equal(thread.verifyCommand, null);
    assert.equal(thread.verify, null);
  });

  it("a legacy store row without the fields migrates to null", () => {
    store.saveNow();
    const filePath = path.join(tmpDir, "store.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    delete raw.threads[0].verifyCommand;
    delete raw.threads[0].verify;
    fs.writeFileSync(filePath, JSON.stringify(raw), "utf8");
    const upgraded = new Store(filePath);
    assert.equal(upgraded.getThread(threadId).verifyCommand, null);
    assert.equal(upgraded.getThread(threadId).verify, null);
  });

  it("migrateThread treats a non-string command as unarmed", () => {
    store.saveNow();
    const filePath = path.join(tmpDir, "store.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    raw.threads[0].verifyCommand = 42;
    fs.writeFileSync(filePath, JSON.stringify(raw), "utf8");
    const upgraded = new Store(filePath);
    assert.equal(upgraded.getThread(threadId).verifyCommand, null);
  });
});

describe("setVerifyCommand", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-verify-set-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Worker",
    }).id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("trims incoming command", () => {
    const updated = services.setVerifyCommand(store, {
      threadId,
      command: "  npm test  ",
    });
    assert.equal(updated.verifyCommand, "npm test");
    assert.equal(store.getThread(threadId).verifyCommand, "npm test");
  });

  it("caps at VERIFY_COMMAND_MAX", () => {
    const updated = services.setVerifyCommand(store, {
      threadId,
      command: "x".repeat(VERIFY_COMMAND_MAX + 50),
    });
    assert.equal(updated.verifyCommand.length, VERIFY_COMMAND_MAX);
    assert.equal(
      store.getThread(threadId).verifyCommand,
      "x".repeat(VERIFY_COMMAND_MAX),
    );
  });

  it("disarms on empty / whitespace / null", () => {
    services.setVerifyCommand(store, { threadId, command: "npm test" });
    const cleared = services.setVerifyCommand(store, {
      threadId,
      command: "   ",
    });
    assert.equal(cleared.verifyCommand, null);
    assert.equal(
      services.setVerifyCommand(store, { threadId, command: null })
        .verifyCommand,
      null,
    );
    assert.equal(store.getThread(threadId).verifyCommand, null);
  });

  it("throws on an unknown thread", () => {
    assert.throws(
      () =>
        services.setVerifyCommand(store, { threadId: "nope", command: "x" }),
      /Unknown thread/,
    );
  });

  it("does not bump updatedAt", () => {
    const before = store.getThread(threadId).updatedAt;
    const updated = services.setVerifyCommand(store, {
      threadId,
      command: "npm test",
    });
    assert.equal(updated.updatedAt, before);
    assert.equal(store.getThread(threadId).updatedAt, before);
  });
});

describe("runVerifyNow", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-verify-run-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Worker",
    }).id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects when no command is set", async () => {
    await assert.rejects(
      () => services.runVerifyNow(store, { threadId }, { runner: idleRunner }),
      /No verify command set for this thread/,
    );
  });

  it("rejects when a run is already active", async () => {
    services.setVerifyCommand(store, { threadId, command: "exit 0" });
    await assert.rejects(
      () => services.runVerifyNow(store, { threadId }, { runner: busyRunner }),
      /A run is already active on this thread/,
    );
  });

  it("rejects an unknown thread", async () => {
    await assert.rejects(
      () =>
        services.runVerifyNow(
          store,
          { threadId: "nope" },
          { runner: idleRunner },
        ),
      /Unknown thread/,
    );
  });

  it("on exit 0 stores ok: true evidence", async () => {
    services.setVerifyCommand(store, { threadId, command: "exit 0" });
    const result = await services.runVerifyNow(
      store,
      { threadId },
      { runner: idleRunner },
    );
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.runId, "manual");
    assert.equal(result.command, "exit 0");
    assert.equal(result.timedOut, false);
    assert.equal(result.sha, null);
    assert.equal(result.attempt, 1);
    assert.equal(typeof result.durationMs, "number");
    assert.equal(typeof result.at, "number");
    const stored = store.getThread(threadId).verify;
    assert.equal(stored.ok, true);
    assert.equal(stored.exitCode, 0);
    assert.equal(stored.runId, "manual");
  });

  it("on exit 1 stores ok: false with the exit code", async () => {
    services.setVerifyCommand(store, { threadId, command: "exit 1" });
    const result = await services.runVerifyNow(
      store,
      { threadId },
      { runner: idleRunner },
    );
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(store.getThread(threadId).verify.ok, false);
    assert.equal(store.getThread(threadId).verify.exitCode, 1);
  });
});
