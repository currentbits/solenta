const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store, localDayKey } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { getMemoryStatus, resetMemorySupForTests } = require("../memory-sup.js");

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

/**
 * Fake claude that records argv and emits a fixed cost.
 * @param {string} dir
 * @param {number} costUsd
 */
function writeFakeClaude(dir, costUsd) {
  const scriptPath = path.join(dir, "fake-claude.js");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_CLAUDE_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
emit({ type: "system", subtype: "init", session_id: "sess-budget", model: "m" });
emit({
  type: "assistant",
  message: { content: [{ type: "text", text: "ok" }] },
});
emit({
  type: "result",
  subtype: "success",
  result: "ok",
  session_id: "sess-budget",
  usage: { input_tokens: 10, output_tokens: 5 },
  total_cost_usd: ${Number(costUsd)},
});
process.exit(0);
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

describe("spendByDay and settings", () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-spend-"));
    filePath = path.join(tmpDir, "store.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recordSpend accumulates into local day key and persists", () => {
    const store = new Store(filePath);
    const day = localDayKey(new Date(2026, 7, 6, 15, 0, 0)); // Aug 6 local
    assert.equal(day, "2026-08-06");

    store.recordSpend(0.01, new Date(2026, 7, 6, 10, 0, 0));
    store.recordSpend(0.02, new Date(2026, 7, 6, 22, 0, 0));
    store.saveNow();

    assert.equal(store.getSpendToday(new Date(2026, 7, 6, 12, 0, 0)), 0.03);
    assert.equal(store.data.spendByDay["2026-08-06"], 0.03);

    const reloaded = new Store(filePath);
    assert.equal(reloaded.data.spendByDay["2026-08-06"], 0.03);
  });

  it("local-date bucketing uses LOCAL time not UTC", () => {
    // A moment that is still "yesterday" in a negative-offset timezone when UTC is next day.
    // Inject fixed clocks so the key matches localDayKey on the same Date.
    const store = new Store(filePath);
    const morning = new Date(2026, 0, 15, 1, 30, 0); // Jan 15 01:30 local
    const evening = new Date(2026, 0, 15, 23, 45, 0);
    const nextDay = new Date(2026, 0, 16, 0, 15, 0);

    store.recordSpend(1, morning);
    store.recordSpend(2, evening);
    store.recordSpend(4, nextDay);

    const key15 = localDayKey(morning);
    const key16 = localDayKey(nextDay);
    assert.equal(key15, "2026-01-15");
    assert.equal(key16, "2026-01-16");
    assert.equal(store.data.spendByDay[key15], 3);
    assert.equal(store.data.spendByDay[key16], 4);
    assert.equal(store.getSpendToday(evening), 3);
    assert.equal(store.getSpendToday(nextDay), 4);
  });

  it("prunes spendByDay buckets older than 90 days on load", () => {
    const now = new Date(2026, 7, 6); // Aug 6 2026
    const keepKey = localDayKey(new Date(2026, 7, 6 - 30)); // ~30 days ago
    const edgeKey = localDayKey(new Date(2026, 7, 6 - 90)); // exactly 90 days ago
    const oldKey = localDayKey(new Date(2026, 7, 6 - 91)); // 91 days ago

    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        messagesByThread: {},
        workLogByThread: {},
        usageByThread: {},
        spendByDay: {
          [oldKey]: 9,
          [edgeKey]: 1,
          [keepKey]: 2,
          "2026-08-06": 3,
        },
        settings: { dailyBudgetUsd: null },
      }),
      "utf8",
    );

    // Store prunes relative to Date.now(); stub by writing only old keys and
    // asserting the prune helper / load path drops keys older than 90 days.
    // Re-open with a store that uses injected "now" via pruneSpendByDay export.
    const { pruneSpendByDay } = require("../store.js");
    const map = {
      [oldKey]: 9,
      [edgeKey]: 1,
      [keepKey]: 2,
      "2026-08-06": 3,
    };
    pruneSpendByDay(map, now);
    assert.equal(map[oldKey], undefined);
    assert.equal(map[edgeKey], 1);
    assert.equal(map[keepKey], 2);
    assert.equal(map["2026-08-06"], 3);
  });

  it("settings default null; set validates and persists without touching threads", () => {
    const store = new Store(filePath);
    store.setThreads([
      {
        id: "t1",
        projectId: "p1",
        title: "Hello",
        branch: null,
        prNumber: null,
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
        runStartedAt: null,
        archived: false,
        provider: "claude",
        model: null,
        sessionId: null,
        permissionMode: "default",
        worktreePath: null,
      },
    ]);
    store.saveNow();

    assert.deepEqual(store.getSettings(), { dailyBudgetUsd: null, orchestrationBudgetUsd: null, autoSettleAfterDays: 3, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, updateChannel: null, notifications: true });
    assert.deepEqual(services.getSettings(store), { dailyBudgetUsd: null, orchestrationBudgetUsd: null, autoSettleAfterDays: 3, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, updateChannel: null, notifications: true });

    const set = services.setSettings(store, { dailyBudgetUsd: 12.5 });
    assert.deepEqual(set, { dailyBudgetUsd: 12.5, orchestrationBudgetUsd: null, autoSettleAfterDays: 3, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, updateChannel: null, notifications: true });
    assert.equal(store.getThreads()[0].updatedAt, 2);

    store.saveNow();
    const reloaded = new Store(filePath);
    assert.deepEqual(reloaded.getSettings(), { dailyBudgetUsd: 12.5, orchestrationBudgetUsd: null, autoSettleAfterDays: 3, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, updateChannel: null, notifications: true });

    const cleared = services.setSettings(store, { dailyBudgetUsd: null });
    assert.deepEqual(cleared, { dailyBudgetUsd: null, orchestrationBudgetUsd: null, autoSettleAfterDays: 3, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, updateChannel: null, notifications: true });

    assert.throws(
      () => services.setSettings(store, { dailyBudgetUsd: 0 }),
      /Daily budget must be a positive number or null/,
    );
    assert.throws(
      () => services.setSettings(store, { dailyBudgetUsd: -1 }),
      /Daily budget must be a positive number or null/,
    );
    assert.throws(
      () => services.setSettings(store, { dailyBudgetUsd: NaN }),
      /Daily budget must be a positive number or null/,
    );
    assert.throws(
      () => services.setSettings(store, { dailyBudgetUsd: "5" }),
      /Daily budget must be a positive number or null/,
    );
    assert.throws(
      () => services.setSettings(store, { dailyBudgetUsd: Infinity }),
      /Daily budget must be a positive number or null/,
    );
  });

  it("orchestrationBudgetUsd: default null; set, clear, validate, persist (issue #67)", () => {
    const store = new Store(filePath);
    assert.equal(store.getSettings().orchestrationBudgetUsd, null);

    const set = services.setSettings(store, { orchestrationBudgetUsd: 2.5 });
    assert.equal(set.orchestrationBudgetUsd, 2.5);
    // A partial patch leaves the daily cap untouched.
    assert.equal(set.dailyBudgetUsd, null);

    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().orchestrationBudgetUsd, 2.5);

    const cleared = services.setSettings(store, {
      orchestrationBudgetUsd: null,
    });
    assert.equal(cleared.orchestrationBudgetUsd, null);

    for (const junk of [0, -1, NaN, "5", Infinity]) {
      assert.throws(
        () => services.setSettings(store, { orchestrationBudgetUsd: junk }),
        /Orchestration budget must be a positive number or null/,
      );
    }
    // Junk on disk heals to null (no ceiling) on load.
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        projects: [],
        threads: [],
        settings: { orchestrationBudgetUsd: "lots" },
      }),
    );
    assert.equal(new Store(filePath).getSettings().orchestrationBudgetUsd, null);
  });

  it("app.status returns spend, memory stats and the build stamp", async () => {
    resetMemorySupForTests();
    const store = new Store(filePath);
    store.recordSpend(1.23456);
    store.saveNow();
    const status = await services.appStatus(store);
    assert.equal(status.spendTodayUsd, 1.23);
    // Memory is down here: counts must be null, never missing or throwing.
    const base = getMemoryStatus();
    assert.equal(status.memory.running, base.running);
    assert.equal(status.memory.entries, null);
    assert.equal(status.memory.vectors, null);
    assert.equal(status.memory.lastError, null);
    // Build stamp must come from the real package, not a placeholder: the whole
    // point is that a stale bundle is identifiable.
    assert.equal(status.build.version, require("../../package.json").version);
    // An unstamped dev tree has no sha/time.
    assert.equal(status.build.sha, null);
    assert.equal(status.build.time, null);
  });

  it("app.status surfaces the packaged build sha and time", async () => {
    resetMemorySupForTests();
    const store = new Store(filePath);
    const status = await services.appStatus(store, {
      pkg: {
        version: "9.9.9",
        buildSha: "deadbee+dirty",
        buildTime: "2026-08-07T14:05:05Z",
        channel: "nightly",
      },
    });
    assert.deepEqual(status.build, {
      version: "9.9.9",
      sha: "deadbee+dirty",
      time: "2026-08-07T14:05:05Z",
      channel: "nightly",
    });
  });

  it("app.status degrades to 0.0.0 when the package cannot be read", async () => {
    resetMemorySupForTests();
    const store = new Store(filePath);
    const status = await services.appStatus(store, {
      pkg: { version: null },
    });
    assert.equal(status.build.version, "0.0.0");
    assert.equal(status.build.sha, null);
    assert.equal(status.build.time, null);
  });

  it("app.status reports live memory counts and janitor errors when healthy", async () => {
    resetMemorySupForTests();
    const store = new Store(filePath);
    const status = await services.appStatus(store, {
      status: () => ({ running: true, adopted: false, port: 49999 }),
      health: async () => ({
        ok: true,
        entryCount: 42,
        vectors: { enabled: true, count: 40, model: "m" },
        janitor: { lastError: { step: "orphans", message: "no such table: mentions" } },
      }),
    });
    assert.equal(status.memory.running, true);
    assert.equal(status.memory.entries, 42);
    assert.equal(status.memory.vectors, 40);
    assert.equal(status.memory.lastError, "orphans: no such table: mentions");
  });

  it("app.status degrades to nulls when /health is unreachable", async () => {
    resetMemorySupForTests();
    const store = new Store(filePath);
    const status = await services.appStatus(store, {
      status: () => ({ running: true, adopted: true, port: 49999 }),
      health: async () => {
        throw new Error("connection refused");
      },
    });
    assert.equal(status.memory.running, true);
    assert.equal(status.memory.entries, null);
    assert.equal(status.memory.vectors, null);
    assert.equal(status.memory.lastError, null);
  });
});

describe("budget gate and spend on real runs", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let prevBin;
  let prevArgv;
  let argvFile;
  let fakeBin;

  beforeEach(async () => {
    prevBin = process.env.CODER_CLAUDE_BIN;
    prevArgv = process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-budget-run-"));
    store = new Store(path.join(tmpDir, "store.json"));
    argvFile = path.join(tmpDir, "argv.json");
    fakeBin = writeFakeClaude(tmpDir, 0.01);
    process.env.CODER_CLAUDE_BIN = fakeBin;
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE = argvFile;

    core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "Budget Thread",
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevBin;
    if (prevArgv === undefined) delete process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    else process.env.CODER_FAKE_CLAUDE_ARGV_FILE = prevArgv;
  });

  it("two fake runs accumulate cost into today's spendByDay bucket", async () => {
    const thread = store.getThreads()[0];
    const day = localDayKey();

    await runner.startRun({ threadId: thread.id, prompt: "run one" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    await runner.startRun({ threadId: thread.id, prompt: "run two" });
    await waitFor(() => {
      const u = store.getUsage(thread.id);
      return u && u.turns === 2 && store.getThread(thread.id).status === "done";
    });

    const usage = store.getUsage(thread.id);
    assert.ok(Math.abs(usage.costUsd - 0.02) < 1e-9);
    assert.ok(Math.abs(store.data.spendByDay[day] - 0.02) < 1e-9);
    assert.ok(Math.abs(store.getSpendToday() - 0.02) < 1e-9);
  });

  it("rejects startRun with exact message and does not spawn when over budget", async () => {
    services.setSettings(store, { dailyBudgetUsd: 1.0 });
    store.recordSpend(1.0);
    store.saveNow();

    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);

    const thread = store.getThreads()[0];
    await assert.rejects(
      () => runner.startRun({ threadId: thread.id, prompt: "should not run" }),
      (err) => {
        assert.equal(
          err.message,
          "Daily budget reached ($1.00 of $1.00). Raise or clear the cap in Settings.",
        );
        return true;
      },
    );

    assert.equal(fs.existsSync(argvFile), false, "fake claude must not spawn");
    assert.equal(store.getThread(thread.id).status, "idle");
    assert.equal(store.getMessages(thread.id).length, 0);
  });

  it("rejects startWorkflow with exact message and does not spawn", async () => {
    services.setSettings(store, { dailyBudgetUsd: 0.5 });
    store.recordSpend(0.75);
    store.saveNow();
    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);

    const thread = store.getThreads()[0];
    await assert.rejects(
      () =>
        runner.startWorkflowRun({
          threadId: thread.id,
          prompt: "build me something",
        }),
      (err) => {
        assert.equal(
          err.message,
          "Daily budget reached ($0.75 of $0.50). Raise or clear the cap in Settings.",
        );
        return true;
      },
    );
    assert.equal(fs.existsSync(argvFile), false);
  });

  it("allows start when budget is null or spend is under cap", async () => {
    services.setSettings(store, { dailyBudgetUsd: null });
    store.recordSpend(99);
    store.saveNow();

    const thread = store.getThreads()[0];
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "under null budget",
    });
    assert.ok(runId);
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(fs.existsSync(argvFile), true);

    // Under cap
    fs.unlinkSync(argvFile);
    services.setSettings(store, { dailyBudgetUsd: 1000 });
    // spend is ~99 + 0.01 from prior run; still under 1000
    const r2 = await runner.startRun({
      threadId: thread.id,
      prompt: "under numeric budget",
    });
    assert.ok(r2.runId);
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(fs.existsSync(argvFile), true);
  });
});
