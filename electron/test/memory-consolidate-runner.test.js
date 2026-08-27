"use strict";

/**
 * Issue #722: prompt-level integration with a fake agent.
 * The scheduler mints a consolidation thread; CODER_AGENT_CMD dumps the
 * argv prompt so we can assert the self-contained instructions actually
 * reach the CLI (same pattern as teach-runner.test.js).
 *
 * Run: npm run test:electron
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
const {
  TITLE,
  WORK_CAP,
  startMemoryConsolidateScheduler,
} = require("../memory-consolidate.js");

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

describe("consolidation prompt on dispatch", () => {
  let tmpDir;
  let store;
  let runner;
  let prevSimulate;
  let prevAgentCmd;
  let promptFile;
  let project;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-memc-run-"));
    promptFile = path.join(tmpDir, "prompt.txt");
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);

    // No spaces: parseAgentCommand whitespace-splits CODER_AGENT_CMD.
    const dump = `require('fs').writeFileSync(${JSON.stringify(promptFile)},process.argv[process.argv.length-1]);process.exit(0)`;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${dump}`;
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("fake agent receives the consolidation prompt with memory-tools-only rules", async () => {
    const handle = startMemoryConsolidateScheduler({
      store,
      runner,
      intervalMs: 60 * 60 * 1000,
      maintenance: async () => ({ queue: { open: 5 } }),
      resolveProvider: () => ({ provider: "claude", model: null }),
    });
    try {
      await handle.tick();
      const thread = store.getThreads().find((t) => t.memoryConsolidate);
      assert.ok(thread, "consolidation thread minted");
      assert.equal(thread.title, TITLE);
      await waitFor(() => store.getThread(thread.id).status === "done");

      const dumped = fs.readFileSync(promptFile, "utf8");
      assert.match(dumped, /memory_maintenance/);
      assert.match(dumped, /memory_distill/);
      assert.match(dumped, /memory_supersede/);
      assert.match(dumped, /tombstone/);
      assert.match(dumped, /memory_delete/);
      assert.match(dumped, /1500/);
      assert.match(dumped, /type:strategy/);
      assert.match(dumped, /yesterday/);
      assert.match(dumped, /last consolidation: X resolved, Y merged/);
      assert.match(dumped, new RegExp(`Cap this pass at ${WORK_CAP}`));
      assert.match(dumped, /coder-memory/);
      assert.ok(dumped.includes(project.path));

      const user = store
        .getMessages(thread.id)
        .find((m) => m && m.role === "user");
      assert.ok(user);
      assert.match(String(user.text), /memory_maintenance/);
    } finally {
      handle.stop();
    }
  });

  it("skips the daily budget on a consolidation thread", async () => {
    store.setSettings({ dailyBudgetUsd: 0.01 });
    store.recordSpend(0.5);
    store.saveNow();

    const handle = startMemoryConsolidateScheduler({
      store,
      runner,
      intervalMs: 60 * 60 * 1000,
      maintenance: async () => ({ queue: { open: 8 } }),
      resolveProvider: () => ({ provider: "claude", model: null }),
    });
    try {
      await handle.tick();
      const thread = store.getThreads().find((t) => t.memoryConsolidate);
      assert.ok(thread);
      await waitFor(() => store.getThread(thread.id).status === "done");
      assert.equal(store.getThread(thread.id).status, "done");
    } finally {
      handle.stop();
    }
  });
});
