"use strict";

/**
 * Issue #296: runner verification gate.
 *
 * A thread with verifyCommand must prove the command exits 0 before it
 * lands "done". Failures hand a fix turn back, up to MAX_FIX_ATTEMPTS.
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
const { setupWorktree } = require("../worktrees.js");
const { createRunner } = require("../runner.js");
const { MAX_FIX_ATTEMPTS } = require("../verify.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function loadCore() {
  return import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
}

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 30 } = {}) {
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

function fakeAgentSuccessScript() {
  return "process.stdout.write('Hello');setTimeout(()=>{process.stdout.write('_ok');setTimeout(()=>process.exit(0),40)},40)";
}

/**
 * Real project + worktree fixture (same shape as checkpoints.test.js).
 */
async function makeWorktreeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-vgate-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const worktreeBase = path.join(tmpDir, "worktrees");
  const repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  try {
    git(repo, ["checkout", "-b", "main"]);
  } catch {
    // already on main
  }
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, {
    projectId: project.id,
    title: "Verify gate thread",
  });
  const setup = setupWorktree({
    store,
    threadId: thread.id,
    worktreeBase,
    broadcast: () => {},
  });
  return {
    tmpDir,
    store,
    project,
    thread: store.getThread(thread.id),
    worktreePath: setup.worktreePath,
    worktreeBase,
  };
}

function fixPrompts(store, threadId) {
  return (store.getMessages(threadId) || []).filter(
    (m) =>
      m.role === "user" &&
      String(m.text || "").startsWith("[verification failed]"),
  );
}

describe("runner verification gate", () => {
  let fx;
  let runner;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSuccessScript()}`;
    fx = await makeWorktreeFixture();
    const core = await loadCore();
    runner = createRunner({
      store: fx.store,
      core,
      pushFn: () => {},
      tickMs: 15,
      // #511 fail-closed: a bound worktree rematerializes via
      // path.join(userDataPath, "worktrees"), matching makeWorktreeFixture.
      userDataPath: fx.tmpDir,
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    if (fx) {
      try {
        fs.rmSync(fx.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      fx = null;
    }
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("no verifyCommand lands done exactly as before", async () => {
    await runner.startRun({
      threadId: fx.thread.id,
      prompt: "do work",
    });
    await waitFor(() => {
      const t = fx.store.getThread(fx.thread.id);
      return t && t.status === "done" && !runner.isRunning(fx.thread.id);
    });
    const t = fx.store.getThread(fx.thread.id);
    assert.equal(t.status, "done");
    assert.equal(t.verify == null, true);
    assert.equal(fixPrompts(fx.store, fx.thread.id).length, 0);
  });

  it("passing command lands done and records verify evidence with sha", async () => {
    fx.store.updateThread(fx.thread.id, { verifyCommand: "echo verify-ok" });
    fs.writeFileSync(path.join(fx.worktreePath, "edit.txt"), "dirty\n");

    await runner.startRun({
      threadId: fx.thread.id,
      prompt: "do work",
    });
    await waitFor(() => {
      const t = fx.store.getThread(fx.thread.id);
      return t && t.status === "done" && t.verify && t.verify.ok;
    });
    const t = fx.store.getThread(fx.thread.id);
    assert.equal(t.status, "done");
    assert.equal(t.verify.ok, true);
    assert.equal(t.verify.command, "echo verify-ok");
    assert.ok(t.verify.sha && t.verify.sha.length >= 7);
    assert.equal(t.verify.attempt, 0);
    assert.match(t.verify.log, /verify-ok/);
    const events = (fx.store.getMessages(fx.thread.id) || []).filter(
      (m) => m.role === "event",
    );
    assert.ok(
      events.some((m) => /Verified: echo verify-ok passed in \d+s/.test(m.text)),
    );
  });

  it("failing command does not land done and starts a fix turn", async () => {
    fx.store.updateThread(fx.thread.id, {
      verifyCommand: "echo verify-boom; exit 1",
    });

    await runner.startRun({
      threadId: fx.thread.id,
      prompt: "do work",
    });
    await waitFor(() => fixPrompts(fx.store, fx.thread.id).length >= 1);

    const t = fx.store.getThread(fx.thread.id);
    assert.notEqual(t.status, "done");
    const prompt = fixPrompts(fx.store, fx.thread.id)[0].text;
    assert.match(prompt, /echo verify-boom; exit 1/);
    assert.match(prompt, /verify-boom/);
  });

  it("exhausted attempts land failed with lastError and start no further fix", async () => {
    fx.store.updateThread(fx.thread.id, {
      verifyCommand: "echo still-failing; exit 1",
    });

    await runner.startRun({
      threadId: fx.thread.id,
      prompt: "do work",
    });
    await waitFor(() => {
      const t = fx.store.getThread(fx.thread.id);
      return t && t.status === "failed" && !runner.isRunning(fx.thread.id);
    });
    const t = fx.store.getThread(fx.thread.id);
    assert.equal(t.status, "failed");
    assert.match(String(t.lastError || ""), /Verification failed: echo still-failing; exit 1/);
    assert.equal(t.verify && t.verify.ok, false);
    const fixes = fixPrompts(fx.store, fx.thread.id);
    assert.equal(fixes.length, MAX_FIX_ATTEMPTS);

    await new Promise((r) => setTimeout(r, 250));
    assert.equal(runner.isRunning(fx.thread.id), false);
    assert.equal(
      fixPrompts(fx.store, fx.thread.id).length,
      MAX_FIX_ATTEMPTS,
    );
    assert.equal(fx.store.getThread(fx.thread.id).status, "failed");
  });
});
