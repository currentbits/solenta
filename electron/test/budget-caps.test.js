// Hard budget caps per thread and per automation (#286).
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const {
  normalizeBudget,
  budgetBreach,
} = require("../budgetCaps.js");
const { recordCompaction } = require("../compaction.js");
const { parseAutomations, automationsHash } = require("../automations-file.js");
const { runAutomation } = require("../automations.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

const { git } = require("./support/git.js");

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Fake claude: one result at $costUsd, or (hang) streams then sleeps. */
function writeFakeClaude(dir, { costUsd = 0.01, hang = false } = {}) {
  const body = `#!/usr/bin/env node
"use strict";
if (process.env.CODER_FAKE_CLAUDE_SPAWNED) {
  require("fs").writeFileSync(process.env.CODER_FAKE_CLAUDE_SPAWNED, "1");
}
function emit(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
emit({ type: "system", subtype: "init", session_id: "sess-cap", model: "m" });
emit({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
if (${hang}) { setTimeout(() => {}, 60000); } else {
  emit({ type: "result", subtype: "success", result: "ok", session_id: "sess-cap",
    usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: ${costUsd} });
  process.exit(0);
}
`;
  return writeFakeBin(path.join(dir, "fake-claude.js"), body);
}

describe("budgetCaps helpers", () => {
  it("normalizeBudget: lenient drops junk, strict throws, empty is null", () => {
    assert.equal(normalizeBudget(null), null);
    assert.equal(normalizeBudget({}), null);
    assert.deepEqual(normalizeBudget({ usd: 2.5, tokens: 1000.2, turns: -1, x: 1 }), {
      usd: 2.5,
      tokens: 1001,
    });
    assert.throws(() => normalizeBudget({ turns: 0 }, true), /budget\.turns must be a positive number/);
    assert.throws(() => normalizeBudget("5", true), /budget must be an object/);
  });

  it("budgetBreach: each axis, minutes only while a run is live", () => {
    const usage = { costUsd: 1, inputTokens: 600, outputTokens: 400, turns: 3 };
    assert.equal(budgetBreach({}, usage), null);
    assert.match(budgetBreach({ budget: { usd: 1 } }, usage), /\$1\.00 of a \$1\.00 cap/);
    assert.equal(budgetBreach({ budget: { usd: 1.5 } }, usage), null);
    assert.match(budgetBreach({ budget: { tokens: 1000 } }, usage), /1,000 of a 1,000 token cap/);
    assert.match(budgetBreach({ budget: { turns: 3 } }, usage), /3 of a 3 turn cap/);
    const t0 = 1_000_000;
    assert.equal(budgetBreach({ budget: { minutes: 5 } }, usage, t0 + 10 * 60000), null);
    assert.match(
      budgetBreach({ budget: { minutes: 5 }, runStartedAt: t0 }, usage, t0 + 5 * 60000),
      /5 of a 5 min per-run cap/,
    );
  });
});

describe("budget caps in the store and services", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-caps-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
  });

  afterEach(async () => {
    await rmTree(tmpDir);
  });

  it("setThreadBudget persists, survives reload and compaction, and clears", () => {
    const t = services.createThread(store, { projectId: project.id });
    assert.throws(
      () => services.setThreadBudget(store, { threadId: t.id, budget: { usd: -1 } }),
      /budget\.usd/,
    );
    const row = services.setThreadBudget(store, { threadId: t.id, budget: { usd: 3, minutes: 20 } });
    assert.deepEqual(row.budget, { usd: 3, minutes: 20 });

    // Compaction rewrites usage and the transcript, never harness state.
    store.setUsage(t.id, { model: null, inputTokens: 0, outputTokens: 0, costUsd: 1, turns: 1, contextTokens: 90000 });
    recordCompaction({ store, appendMessage: () => {} }, t.id, "run-1", { pre: 90000, post: 2000 });
    assert.deepEqual(store.getThread(t.id).budget, { usd: 3, minutes: 20 });
    assert.equal(store.getUsage(t.id).costUsd, 1);

    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.deepEqual(reloaded.getThread(t.id).budget, { usd: 3, minutes: 20 });

    const cleared = services.setThreadBudget(store, { threadId: t.id, budget: null });
    assert.equal("budget" in cleared, false);
  });

  it("raising the cap answers a budget stop: clears awaitingInput", () => {
    const t = services.createThread(store, { projectId: project.id });
    store.updateThread(t.id, { awaitingInput: true, status: "idle" });
    services.setThreadBudget(store, { threadId: t.id, budget: { usd: 10 } });
    assert.equal(store.getThread(t.id).awaitingInput, false);
  });

  it("an applied profile stamps its cap; a cap-less profile leaves the thread's", () => {
    services.setSettings(store, {
      agentProfiles: [
        { id: "capped", name: "Capped", provider: "claude", model: null, reasoningEffort: null, permissionMode: "default", budget: { usd: 2 } },
        { id: "open", name: "Open", provider: "claude", model: null, reasoningEffort: null, permissionMode: "default" },
      ],
    });
    assert.throws(
      () =>
        services.setSettings(store, {
          agentProfiles: [
            { id: "bad", name: "Bad", provider: "claude", model: null, reasoningEffort: null, permissionMode: "default", budget: { turns: "x" } },
          ],
        }),
      /budget\.turns/,
    );
    const t = services.createThread(store, { projectId: project.id });
    services.applyAgentProfile(store, { threadId: t.id, profileId: "capped" });
    assert.deepEqual(store.getThread(t.id).budget, { usd: 2 });
    services.applyAgentProfile(store, { threadId: t.id, profileId: "open" });
    assert.deepEqual(store.getThread(t.id).budget, { usd: 2 });
  });

  it("a fork inherits the cap", () => {
    const t = services.createThread(store, { projectId: project.id });
    services.setThreadBudget(store, { threadId: t.id, budget: { turns: 4 } });
    const fork = services.forkThread(store, { threadId: t.id });
    assert.deepEqual(store.getThread(fork.id).budget, { turns: 4 });
  });

  it("an automation stamps its cap on the thread it fires", async () => {
    const auto = services.addAutomation(store, {
      name: "Nightly",
      projectId: project.id,
      prompt: "do it",
      provider: "claude",
      preset: "hourly",
      budget: { usd: 0.5 },
    });
    assert.deepEqual(auto.budget, { usd: 0.5 });
    assert.throws(
      () => services.updateAutomation(store, { id: auto.id, budget: { usd: "lots" } }),
      /budget\.usd/,
    );
    const started = [];
    await runAutomation(
      { store, runner: { startRun: async (input) => started.push(input) } },
      auto,
      Date.now(),
    );
    assert.equal(started.length, 1);
    assert.deepEqual(store.getThread(started[0].threadId).budget, { usd: 0.5 });

    const cleared = services.updateAutomation(store, { id: auto.id, budget: null });
    assert.equal(cleared.budget ?? null, null);
  });

  it("solenta.json: budget parses, junk fails the row, cap-less rows keep their hash", () => {
    const row = { id: "a", name: "A", prompt: "p", provider: "claude", preset: "hourly" };
    const plain = parseAutomations({ automations: [row] });
    assert.equal(
      plain.hash,
      automationsHash([{ ...plain.automations[0] }]),
    );
    assert.equal("budget" in plain.automations[0], false);
    const capped = parseAutomations({ automations: [{ ...row, budget: { turns: 5 } }] });
    assert.deepEqual(capped.automations[0].budget, { turns: 5 });
    assert.notEqual(capped.hash, plain.hash, "a cap change needs re-trust");
    const bad = parseAutomations({ automations: [{ ...row, budget: { turns: 0 } }] });
    assert.match(bad.error, /automations\[0\]\.budget\.turns/);
  });
});

describe("budget caps on real runs", () => {
  let tmpDir;
  let store;
  let runner;
  let thread;
  let clock;
  let prevBin;
  let prevSpawned;
  let spawnedFile;

  async function setup(fake) {
    prevBin = process.env.CODER_CLAUDE_BIN;
    prevSpawned = process.env.CODER_FAKE_CLAUDE_SPAWNED;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-caps-run-"));
    store = new Store(path.join(tmpDir, "store.json"));
    spawnedFile = path.join(tmpDir, "spawned");
    process.env.CODER_CLAUDE_BIN = writeFakeClaude(tmpDir, fake);
    process.env.CODER_FAKE_CLAUDE_SPAWNED = spawnedFile;
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    clock = Date.now();
    runner = createRunner({ store, core, pushFn: () => {}, tickMs: 15, now: () => clock });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "Capped" });
  }

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    if (prevBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevBin;
    if (prevSpawned === undefined) delete process.env.CODER_FAKE_CLAUDE_SPAWNED;
    else process.env.CODER_FAKE_CLAUDE_SPAWNED = prevSpawned;
  });

  it("refuses the next start once a turn crosses the cap, until it is raised", async () => {
    await setup({ costUsd: 0.4 });
    services.setThreadBudget(store, { threadId: thread.id, budget: { usd: 0.3 } });
    await runner.startRun({ threadId: thread.id, prompt: "one" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    fs.rmSync(spawnedFile, { force: true });

    await assert.rejects(
      () => runner.startRun({ threadId: thread.id, prompt: "two" }),
      /Thread budget reached \(spent \$0\.40 of a \$0\.30 cap\)\. Raise or clear this thread's cap to continue\./,
    );
    assert.equal(fs.existsSync(spawnedFile), false, "over-cap start must not spawn");

    services.setThreadBudget(store, { threadId: thread.id, budget: { usd: 1 } });
    await runner.startRun({ threadId: thread.id, prompt: "three" });
    await waitFor(() => store.getUsage(thread.id)?.turns === 2);
  });

  it("stops a live run that crosses the per-run minutes cap and flags the thread", async () => {
    await setup({ hang: true });
    services.setThreadBudget(store, { threadId: thread.id, budget: { minutes: 5 } });
    store.updateThread(thread.id, { runStartedAt: null });
    await runner.startRun({ threadId: thread.id, prompt: "long job" });
    await waitFor(() => fs.existsSync(spawnedFile));
    assert.equal(runner.isRunning(thread.id), true);

    await runner.checkBudgets();
    assert.equal(runner.isRunning(thread.id), true, "under the cap keeps running");

    const started = store.getThread(thread.id).runStartedAt;
    clock = started + 5 * 60000;
    await runner.checkBudgets();
    assert.equal(runner.isRunning(thread.id), false);
    const t = store.getThread(thread.id);
    assert.equal(t.status, "idle");
    assert.equal(t.awaitingInput, true);
    const texts = store.getMessages(thread.id).map((m) => m.text);
    assert.ok(
      texts.some((x) => /^Budget cap reached: ran 5 of a 5 min per-run cap\. Stopping the run\./.test(x)),
      texts.join("\n"),
    );
    assert.ok(texts.includes("Run stopped"));
  });
});
