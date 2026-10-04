"use strict";

/**
 * Repro R5 (commit 615b38a0): startRun registers a `preparing` active entry
 * (runner.js:8644), then awaits the first-turn bootstrap prefetch, then calls
 * start*Run. Nothing deletes the entry if that tail throws. startClaudeRun
 * re-checks the CLI (assertProviderBinary, runner.js:3853) and throws if it
 * vanished during the prefetch (a CLI upgrade swapping the binary), so the
 * thread is left "already active" with status "working".
 *
 * Convention: asserts the CORRECT behaviour, so it FAILS while R5 is real.
 * Run: node --test electron/test/repro-r5-preparing-leak.test.js
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
const { createRunner } = require("../runner.js");
const { rmTree } = require("./support/rmTree.js");

describe("R5: synchronous throw after the preparing entry", () => {
  let tmpDir, store, runner, thread, fakeClaude;
  const prev = {};

  beforeEach(async () => {
    for (const k of ["CODER_SIMULATE", "CODER_AGENT_CMD", "CODER_CLAUDE_BIN"]) prev[k] = process.env[k];
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-r5-"));
    fakeClaude = path.join(tmpDir, "claude");
    fs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.CODER_CLAUDE_BIN = fakeClaude;
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "Claude thread", provider: "claude" });
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      userDataPath: tmpDir,
      // The CLI disappears while the first-turn memory prefetch is in flight.
      bootstrapMemory: async () => {
        fs.rmSync(fakeClaude, { force: true });
        return {};
      },
    });
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("a throw after preparing must not leave the thread active forever", async () => {
    let firstErr = null;
    try {
      await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    } catch (e) {
      firstErr = e.message;
    }
    // The CLI is back (upgrade finished); the user presses send again.
    fs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    let retryErr = null;
    try {
      await runner.startRun({ threadId: thread.id, prompt: "try again" });
    } catch (e) {
      retryErr = e.message;
    }
    const facts = {
      firstErr,
      isRunningAfterThrow: runner.isRunning(thread.id),
      statusAfterThrow: store.getThread(thread.id).status,
      retryErr,
    };
    await runner.stopRun({ threadId: thread.id });
    facts.isRunningAfterStop = runner.isRunning(thread.id);
    facts.statusAfterStop = store.getThread(thread.id).status;
    console.log("R5 facts:", JSON.stringify(facts));
    assert.match(String(facts.firstErr), /Provider binary not found/);
    assert.equal(facts.isRunningAfterThrow, false, "preparing entry leaked");
    assert.doesNotMatch(String(facts.retryErr), /already active/);
    // A try/catch that only deletes the entry still leaves the sidebar on
    // "working" with no run behind it (verified against that patch).
    assert.notEqual(facts.statusAfterThrow, "working", "status left 'working' with no run");
  });
});
