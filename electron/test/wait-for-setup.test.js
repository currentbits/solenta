"use strict";

/**
 * #1506 H3 "Agent waits for setup": with the project flag on, the first
 * run in a new worktree holds the agent until setup settles; a failed
 * setup is reported and the agent starts anyway; Stop cuts the wait.
 * Run: npm run test:electron -- electron/test/wait-for-setup.test.js
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
const { setRunCommandFn, waitForCommand } = require("../projectCommands.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFakeClaude(dir) {
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
fs.writeFileSync(process.env.CODER_FAKE_CLAUDE_ARGV_FILE, "spawned", "utf8");
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
emit({ type: "system", subtype: "init", session_id: "sess-wait", model: "m" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
emit({
  type: "result",
  subtype: "success",
  result: "ok",
  session_id: "sess-wait",
  usage: { input_tokens: 1, output_tokens: 1 },
  total_cost_usd: 0,
});
process.exit(0);
`;
  return writeFakeBin(path.join(dir, "fake-claude-wait"), body);
}

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting");
}

describe("agent waits for setup (#1506)", () => {
  let tmpDir;
  let store;
  let runner;
  let project;
  let spawnedFile;
  let prevBin;
  let prevArgv;
  let prevSimulate;
  /** @type {(r: object) => void} */
  let finishSetup;

  beforeEach(async () => {
    prevBin = process.env.CODER_CLAUDE_BIN;
    prevArgv = process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    prevSimulate = process.env.CODER_SIMULATE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-waitsetup-"));
    store = new Store(path.join(tmpDir, "store.json"));
    spawnedFile = path.join(tmpDir, "spawned");
    process.env.CODER_CLAUDE_BIN = writeFakeClaude(tmpDir);
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE = spawnedFile;
    delete process.env.CODER_SIMULATE;

    setRunCommandFn(
      () =>
        new Promise((resolve) => {
          finishSetup = resolve;
        }),
    );

    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      userDataPath: tmpDir,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    project = await services.addProject(store, repo);
    services.updateProject(store, project.id, {
      setupCommand: "npm ci",
      waitForSetup: true,
    });
  });

  afterEach(async () => {
    if (finishSetup) finishSetup({ ok: true, exitCode: 0, durationMs: 1 });
    for (const t of store.getThreads()) await waitForCommand(t.id);
    if (runner) runner.stopAll();
    setRunCommandFn(null);
    for (const [k, v] of [
      ["CODER_CLAUDE_BIN", prevBin],
      ["CODER_FAKE_CLAUDE_ARGV_FILE", prevArgv],
      ["CODER_SIMULATE", prevSimulate],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rmTree(tmpDir);
  });

  function newWorktreeThread() {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Waits",
    });
    store.updateThread(thread.id, { pendingWorktree: true });
    return thread;
  }

  const workLog = (id) =>
    (services.getThreadDetail(store, id, null, { markVisited: false }).workLog || []);

  it("holds the agent until setup finishes, showing the waiting step", async () => {
    const thread = newWorktreeThread();
    const started = runner.startRun({ threadId: thread.id, prompt: "go" });
    await until(() => workLog(thread.id).some((w) => w.label === "Waiting for setup"));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fs.existsSync(spawnedFile), false, "agent must not spawn yet");
    assert.equal(store.getThread(thread.id).status, "working");

    finishSetup({ ok: true, exitCode: 0, timedOut: false, log: "", durationMs: 5 });
    await started;
    await until(() => fs.existsSync(spawnedFile));
    const step = workLog(thread.id).find((w) => w.label === "Waiting for setup");
    assert.equal(step.done, true);
  });

  it("a failed setup is reported and the agent starts anyway", async () => {
    const thread = newWorktreeThread();
    const started = runner.startRun({ threadId: thread.id, prompt: "go" });
    await until(() => workLog(thread.id).some((w) => w.label === "Waiting for setup"));
    finishSetup({ ok: false, exitCode: 1, timedOut: false, log: "npm ERR!", durationMs: 5 });
    await started;
    await until(() => fs.existsSync(spawnedFile));
    const texts = store.getMessages(thread.id).map((m) => String(m.text));
    assert.ok(texts.some((t) => /^\[setup\] failed: exit 1/.test(t)));
    assert.ok(texts.includes("Setup did not finish cleanly. Starting the agent anyway."));
  });

  it("Stop during the wait never spawns the agent", async () => {
    const thread = newWorktreeThread();
    const started = runner.startRun({ threadId: thread.id, prompt: "go" });
    await until(() => workLog(thread.id).some((w) => w.label === "Waiting for setup"));
    await runner.stopRun({ threadId: thread.id });
    await started;
    assert.equal(fs.existsSync(spawnedFile), false);
    assert.notEqual(store.getThread(thread.id).status, "working");
  });

  it("without the flag the agent starts alongside setup", async () => {
    services.updateProject(store, project.id, { waitForSetup: false });
    const thread = newWorktreeThread();
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await until(() => fs.existsSync(spawnedFile));
    assert.ok(!workLog(thread.id).some((w) => w.label === "Waiting for setup"));
  });
});
