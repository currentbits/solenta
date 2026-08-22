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
const { writeFakeBin } = require("./support/fakeBin.js");

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
function writeFakeClaude(dir, costUsd, opts = {}) {
  const scriptPath = path.join(dir, "fake-claude.js");
  const subtype = opts.subtype || "success";
  const errors = Array.isArray(opts.errors) ? opts.errors : [];
  const exitCode = opts.exitCode == null ? 0 : Number(opts.exitCode);
  const usage = opts.usage || { input_tokens: 10, output_tokens: 5 };
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
  subtype: ${JSON.stringify(subtype)},
  result: "ok",
  session_id: "sess-budget",
  usage: ${JSON.stringify(usage)},
  total_cost_usd: ${Number(costUsd)},
  errors: ${JSON.stringify(errors)},
});
process.exit(${exitCode});
`;
  return writeFakeBin(scriptPath, body);
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

  it("recordUsage accumulates per day/provider/model and persists", () => {
    const store = new Store(filePath);
    const morning = new Date(2026, 7, 6, 10, 0, 0);
    const evening = new Date(2026, 7, 6, 22, 0, 0);
    const nextDay = new Date(2026, 7, 7, 9, 0, 0);

    store.recordUsage(
      { provider: "claude", model: "opus", costUsd: 0.01, inputTokens: 100, outputTokens: 20 },
      morning,
    );
    store.recordUsage(
      { provider: "claude", model: "opus", costUsd: 0.02, inputTokens: 50, outputTokens: 10 },
      evening,
    );
    store.recordUsage(
      { provider: "grok", model: "grok-4", costUsd: 0.05, inputTokens: 200, outputTokens: 40 },
      evening,
    );
    store.recordUsage(
      { provider: "claude", model: "sonnet", costUsd: 0.03, inputTokens: 80, outputTokens: 8 },
      nextDay,
    );
    store.saveNow();

    const day = store.getUsageByDay();
    assert.deepEqual(day["2026-08-06"].claude.opus, {
      costUsd: 0.03,
      inputTokens: 150,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 30,
      turns: 2,
      wastedUsd: 0,
    });
    assert.deepEqual(day["2026-08-06"].grok["grok-4"], {
      costUsd: 0.05,
      inputTokens: 200,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 40,
      turns: 1,
      wastedUsd: 0,
    });
    assert.deepEqual(day["2026-08-07"].claude.sonnet, {
      costUsd: 0.03,
      inputTokens: 80,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 8,
      turns: 1,
      wastedUsd: 0,
    });

    const reloaded = new Store(filePath);
    assert.deepEqual(
      reloaded.getUsageByDay()["2026-08-06"].claude.opus,
      day["2026-08-06"].claude.opus,
    );
  });

  it("recordUsage records tokens when costUsd is 0", () => {
    const store = new Store(filePath);
    store.recordUsage(
      { provider: "grok", model: "grok-4", costUsd: 0, inputTokens: 1200, outputTokens: 80 },
      new Date(2026, 7, 6, 12, 0, 0),
    );
    assert.deepEqual(store.getUsageByDay()["2026-08-06"].grok["grok-4"], {
      costUsd: 0,
      inputTokens: 1200,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 80,
      turns: 1,
      wastedUsd: 0,
    });
    // Missing / simulate providers are ignored; all-zero turns are kept (#556).
    store.recordUsage(
      { provider: "grok", model: "grok-4", costUsd: 0, inputTokens: 0, outputTokens: 0 },
      new Date(2026, 7, 6, 12, 0, 0),
    );
    store.recordUsage(
      { provider: "", model: "x", costUsd: 1, inputTokens: 1, outputTokens: 1 },
      new Date(2026, 7, 6, 12, 0, 0),
    );
    store.recordUsage(
      { provider: "simulate", model: "sim", costUsd: 9, inputTokens: 9, outputTokens: 9 },
      new Date(2026, 7, 6, 12, 0, 0),
    );
    assert.equal(store.getUsageByDay()["2026-08-06"].grok["grok-4"].turns, 2);
    assert.equal(store.getUsageByDay()["2026-08-06"].x, undefined);
    assert.equal(store.getUsageByDay()["2026-08-06"].simulate, undefined);
  });

  it("usageByDay buckets older than 90 days are pruned on load", () => {
    const now = new Date();
    const keep = new Date(now);
    keep.setDate(keep.getDate() - 30);
    const edge = new Date(now);
    edge.setDate(edge.getDate() - 90);
    const old = new Date(now);
    old.setDate(old.getDate() - 91);
    const keepKey = localDayKey(keep);
    const edgeKey = localDayKey(edge);
    const oldKey = localDayKey(old);
    const todayKey = localDayKey(now);
    const entry = {
      claude: { opus: { costUsd: 1, inputTokens: 10, outputTokens: 2, turns: 1 } },
    };

    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        messagesByThread: {},
        workLogByThread: {},
        usageByThread: {},
        spendByDay: {},
        usageByDay: {
          [oldKey]: entry,
          [edgeKey]: entry,
          [keepKey]: entry,
          [todayKey]: entry,
        },
        settings: { dailyBudgetUsd: null },
      }),
      "utf8",
    );

    const loaded = new Store(filePath).getUsageByDay();
    assert.equal(loaded[oldKey], undefined);
    assert.ok(loaded[edgeKey]);
    assert.ok(loaded[keepKey]);
    assert.ok(loaded[todayKey]);
  });

  it("malformed usageByDay input normalizes to {} instead of throwing", () => {
    for (const junk of ["nope", [], 12, null]) {
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          projects: [],
          threads: [],
          usageByDay: junk,
        }),
        "utf8",
      );
      const store = new Store(filePath);
      assert.deepEqual(store.getUsageByDay(), {});
    }

    const today = localDayKey();
    const yesterday = localDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        usageByDay: {
          [yesterday]: "bad",
          "not-a-day": { claude: { opus: { costUsd: 1 } } },
          [today]: {
            claude: "nope",
            grok: {
              "grok-4": { costUsd: "0.5", inputTokens: 10, outputTokens: null, turns: 2 },
              bad: 3,
            },
          },
        },
      }),
      "utf8",
    );
    const store = new Store(filePath);
    const map = store.getUsageByDay();
    assert.equal(map[yesterday], undefined);
    assert.deepEqual(map[today].grok["grok-4"], {
      costUsd: 0.5,
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      turns: 2,
      wastedUsd: 0,
    });
    assert.equal(map[today].claude, undefined);
    assert.equal(map[today].grok.bad, undefined);
  });

  it("recordUsage keeps a kimi all-zero turn (issue #556)", () => {
    const store = new Store(filePath);
    const now = new Date(2026, 7, 6, 12, 0, 0);
    store.recordUsage(
      { provider: "kimi", model: "kimi-k2", costUsd: 0, inputTokens: 0, outputTokens: 0 },
      now,
    );
    const cell = store.getUsageByDay()["2026-08-06"].kimi["kimi-k2"];
    assert.deepEqual(cell, {
      costUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      turns: 1,
      wastedUsd: 0,
    });
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.deepEqual(
      reloaded.getUsageByDay()["2026-08-06"].kimi["kimi-k2"],
      cell,
    );
  });

  it("recordUsage splits billable input from cache read/write", () => {
    const store = new Store(filePath);
    store.recordUsage(
      {
        provider: "claude",
        model: "opus",
        costUsd: 0.5,
        inputTokens: 2,
        cachedInputTokens: 17028,
        cacheWriteTokens: 20661,
        outputTokens: 884,
      },
      new Date(2026, 7, 6, 12, 0, 0),
    );
    const cell = store.getUsageByDay()["2026-08-06"].claude.opus;
    assert.equal(cell.inputTokens, 2);
    assert.equal(cell.cachedInputTokens, 17028);
    assert.equal(cell.cacheWriteTokens, 20661);
    const processed =
      cell.inputTokens + cell.cachedInputTokens + cell.cacheWriteTokens;
    assert.equal(processed, 2 + 17028 + 20661);
    assert.notEqual(processed, cell.inputTokens);
  });

  it("old usage cells missing cache/waste fields load as 0", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        usageByDay: {
          "2026-08-06": {
            claude: {
              opus: { costUsd: 1.5, inputTokens: 10, outputTokens: 4, turns: 2 },
            },
          },
        },
      }),
      "utf8",
    );
    const loaded = new Store(filePath).getUsageByDay()["2026-08-06"].claude.opus;
    assert.deepEqual(loaded, {
      costUsd: 1.5,
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 4,
      turns: 2,
      wastedUsd: 0,
    });
  });

  it("usageThreadsByDay accumulates per thread, labels, persists, and prunes at 90 days", () => {
    const store = new Store(filePath);
    const morning = new Date(2026, 7, 6, 10, 0, 0);
    const evening = new Date(2026, 7, 6, 22, 0, 0);
    store.recordUsage(
      {
        provider: "claude",
        model: "opus",
        costUsd: 0.01,
        inputTokens: 100,
        cachedInputTokens: 50,
        cacheWriteTokens: 10,
        outputTokens: 20,
        threadId: "t1",
        projectId: "p1",
        projectName: "Alpha",
        title: "Old title",
      },
      morning,
    );
    store.recordUsage(
      {
        provider: "claude",
        model: "sonnet",
        costUsd: 0.02,
        inputTokens: 40,
        outputTokens: 8,
        threadId: "t1",
        projectId: "p1",
        projectName: "Alpha",
        title: "Renamed",
      },
      evening,
    );
    store.recordUsage(
      {
        provider: "kimi",
        model: "kimi-k2",
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        threadId: "t2",
        projectId: "p2",
        projectName: "Beta",
        title: "Silent",
      },
      evening,
    );
    const day = store.getUsageThreadsByDay()["2026-08-06"];
    assert.deepEqual(day.t1, {
      costUsd: 0.03,
      inputTokens: 140,
      cachedInputTokens: 50,
      cacheWriteTokens: 10,
      outputTokens: 28,
      turns: 2,
      wastedUsd: 0,
      projectId: "p1",
      projectName: "Alpha",
      title: "Renamed",
      provider: "claude",
      model: "sonnet",
    });
    assert.equal(day.t2.turns, 1);
    assert.equal(day.t2.provider, "kimi");
    assert.equal(day.t2.title, "Silent");
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.deepEqual(
      reloaded.getUsageThreadsByDay()["2026-08-06"].t1,
      day.t1,
    );

    const now = new Date();
    const keep = new Date(now);
    keep.setDate(keep.getDate() - 30);
    const edge = new Date(now);
    edge.setDate(edge.getDate() - 90);
    const old = new Date(now);
    old.setDate(old.getDate() - 91);
    const keepKey = localDayKey(keep);
    const edgeKey = localDayKey(edge);
    const oldKey = localDayKey(old);
    const todayKey = localDayKey(now);
    const threadRow = {
      costUsd: 1,
      inputTokens: 10,
      outputTokens: 2,
      turns: 1,
      projectId: "p",
      projectName: "P",
      title: "T",
      provider: "claude",
      model: "opus",
    };
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        usageThreadsByDay: {
          [oldKey]: { tOld: threadRow },
          [edgeKey]: { tEdge: threadRow },
          [keepKey]: { tKeep: threadRow },
          [todayKey]: { tToday: threadRow },
        },
      }),
      "utf8",
    );
    const pruned = new Store(filePath).getUsageThreadsByDay();
    assert.equal(pruned[oldKey], undefined);
    assert.ok(pruned[edgeKey]);
    assert.ok(pruned[keepKey]);
    assert.ok(pruned[todayKey]);
  });

  it("recordWastedSpend adds to wastedUsd without touching costUsd", () => {
    const store = new Store(filePath);
    const now = new Date(2026, 7, 6, 12, 0, 0);
    store.recordUsage(
      {
        provider: "claude",
        model: "opus",
        costUsd: 1.25,
        inputTokens: 10,
        outputTokens: 4,
        threadId: "t1",
        projectId: "p1",
        projectName: "Alpha",
        title: "Run",
      },
      now,
    );
    store.recordWastedSpend(
      { provider: "claude", model: "opus", threadId: "t1", costUsd: 1.25 },
      now,
    );
    const cell = store.getUsageByDay()["2026-08-06"].claude.opus;
    assert.equal(cell.costUsd, 1.25);
    assert.equal(cell.wastedUsd, 1.25);
    assert.equal(cell.turns, 1);
    const threadCell = store.getUsageThreadsByDay()["2026-08-06"].t1;
    assert.equal(threadCell.costUsd, 1.25);
    assert.equal(threadCell.wastedUsd, 1.25);
    assert.equal(threadCell.title, "Run");

    store.recordWastedSpend(
      { provider: "grok", model: "grok-4", threadId: "t-ghost", costUsd: 0.4 },
      now,
    );
    const ghost = store.getUsageByDay()["2026-08-06"].grok["grok-4"];
    assert.equal(ghost.costUsd, 0);
    assert.equal(ghost.turns, 0);
    assert.equal(ghost.wastedUsd, 0.4);
    assert.equal(store.getUsageThreadsByDay()["2026-08-06"]["t-ghost"].turns, 0);
    assert.equal(store.getUsageThreadsByDay()["2026-08-06"]["t-ghost"].wastedUsd, 0.4);

    // A run that burned cost without ever recording a turn still needs labels,
    // or the project/thread breakdown shows "Unknown project" and a raw id.
    store.recordWastedSpend(
      {
        provider: "grok",
        model: "grok-4",
        threadId: "t-nolabel",
        costUsd: 0.2,
        projectId: "p2",
        projectName: "Beta",
        title: "Died early",
      },
      now,
    );
    const labelled = store.getUsageThreadsByDay()["2026-08-06"]["t-nolabel"];
    assert.equal(labelled.projectName, "Beta");
    assert.equal(labelled.title, "Died early");
    // Labels already on the row win over a later caller's.
    store.recordWastedSpend(
      {
        provider: "grok",
        model: "grok-4",
        threadId: "t-nolabel",
        costUsd: 0.1,
        projectName: "Stale",
        title: "Stale",
      },
      now,
    );
    assert.equal(
      store.getUsageThreadsByDay()["2026-08-06"]["t-nolabel"].title,
      "Died early",
    );

    store.recordWastedSpend(
      { provider: "claude", model: "opus", costUsd: 0 },
      now,
    );
    store.recordWastedSpend(
      { provider: "simulate", model: "x", costUsd: 9 },
      now,
    );
    assert.equal(store.getUsageByDay()["2026-08-06"].claude.opus.wastedUsd, 1.25);
    assert.equal(store.getUsageByDay()["2026-08-06"].simulate, undefined);
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

    assert.deepEqual(store.getSettings(), { dailyBudgetUsd: null, orchestrationBudgetUsd: null, autoSettleAfterDays: 3, autoSettleOnMerge: true, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, onboardingSeen: false, updateChannel: null, notifications: true, feltEstimatePrompt: false, theme: "dark", quotaWaitAutoResume: true, prDiffCapLines: 400, agentProfiles: [], subagentPool: { defaultAlias: null, force: false, entries: [] }, otel: { endpoint: null, headers: {}, claudeMetrics: false }, uiScale: 1, linearApiKey: null, webhook: { url: null, onDone: true, onFailed: true, onWaiting: true } });
    assert.deepEqual(services.getSettings(store), { dailyBudgetUsd: null, orchestrationBudgetUsd: null, autoSettleAfterDays: 3, autoSettleOnMerge: true, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, onboardingSeen: false, updateChannel: null, notifications: true, feltEstimatePrompt: false, theme: "dark", quotaWaitAutoResume: true, prDiffCapLines: 400, agentProfiles: [], subagentPool: { defaultAlias: null, force: false, entries: [] }, otel: { endpoint: null, headers: {}, claudeMetrics: false }, uiScale: 1, linearApiKey: null, webhook: { url: null, onDone: true, onFailed: true, onWaiting: true } });

    const set = services.setSettings(store, { dailyBudgetUsd: 12.5 });
    assert.deepEqual(set, { dailyBudgetUsd: 12.5, orchestrationBudgetUsd: null, autoSettleAfterDays: 3, autoSettleOnMerge: true, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, onboardingSeen: false, updateChannel: null, notifications: true, feltEstimatePrompt: false, theme: "dark", quotaWaitAutoResume: true, prDiffCapLines: 400, agentProfiles: [], subagentPool: { defaultAlias: null, force: false, entries: [] }, otel: { endpoint: null, headers: {}, claudeMetrics: false }, uiScale: 1, linearApiKey: null, webhook: { url: null, onDone: true, onFailed: true, onWaiting: true } });
    assert.equal(store.getThreads()[0].updatedAt, 2);

    store.saveNow();
    const reloaded = new Store(filePath);
    assert.deepEqual(reloaded.getSettings(), { dailyBudgetUsd: 12.5, orchestrationBudgetUsd: null, autoSettleAfterDays: 3, autoSettleOnMerge: true, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, onboardingSeen: false, updateChannel: null, notifications: true, feltEstimatePrompt: false, theme: "dark", quotaWaitAutoResume: true, prDiffCapLines: 400, agentProfiles: [], subagentPool: { defaultAlias: null, force: false, entries: [] }, otel: { endpoint: null, headers: {}, claudeMetrics: false }, uiScale: 1, linearApiKey: null, webhook: { url: null, onDone: true, onFailed: true, onWaiting: true } });

    const cleared = services.setSettings(store, { dailyBudgetUsd: null });
    assert.deepEqual(cleared, { dailyBudgetUsd: null, orchestrationBudgetUsd: null, autoSettleAfterDays: 3, autoSettleOnMerge: true, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, onboardingSeen: false, updateChannel: null, notifications: true, feltEstimatePrompt: false, theme: "dark", quotaWaitAutoResume: true, prDiffCapLines: 400, agentProfiles: [], subagentPool: { defaultAlias: null, force: false, entries: [] }, otel: { endpoint: null, headers: {}, claudeMetrics: false }, uiScale: 1, linearApiKey: null, webhook: { url: null, onDone: true, onFailed: true, onWaiting: true } });

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

  it("claude cache fields land on the usage cell as processed-not-billable", async () => {
    fakeBin = writeFakeClaude(tmpDir, 0.01, {
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 17028,
        cache_creation_input_tokens: 20661,
        output_tokens: 884,
      },
    });
    process.env.CODER_CLAUDE_BIN = fakeBin;

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "cache me" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const day = localDayKey();
    const cell = store.getUsageByDay()[day].claude.m;
    assert.equal(cell.inputTokens, 2);
    assert.equal(cell.cachedInputTokens, 17028);
    assert.equal(cell.cacheWriteTokens, 20661);
    assert.equal(cell.outputTokens, 884);
    assert.notEqual(
      cell.inputTokens + cell.cachedInputTokens + cell.cacheWriteTokens,
      cell.inputTokens,
    );
    const threadCell = store.getUsageThreadsByDay()[day][thread.id];
    assert.equal(threadCell.title, "Budget Thread");
    assert.equal(threadCell.cachedInputTokens, 17028);
  });

  it("failed run attributes cost to wastedUsd on the same provider/model row", async () => {
    fakeBin = writeFakeClaude(tmpDir, 0.01, {
      subtype: "error",
      errors: ["something broke"],
      exitCode: 1,
    });
    process.env.CODER_CLAUDE_BIN = fakeBin;

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "please fail" });
    await waitFor(() => store.getThread(thread.id).status === "failed");

    const day = localDayKey();
    const cell = store.getUsageByDay()[day].claude.m;
    assert.ok(Math.abs(cell.costUsd - 0.01) < 1e-9);
    assert.ok(Math.abs(cell.wastedUsd - 0.01) < 1e-9);
    assert.equal(cell.turns, 1);
    const threadCell = store.getUsageThreadsByDay()[day][thread.id];
    assert.ok(threadCell);
    assert.ok(Math.abs(threadCell.wastedUsd - 0.01) < 1e-9);
    assert.equal(threadCell.provider, "claude");
    assert.equal(threadCell.model, "m");
  });

  it("quota-wait failure does not attribute wastedUsd", async () => {
    fakeBin = writeFakeClaude(tmpDir, 0.01, {
      subtype: "error",
      errors: ["You've hit your limit · resets 11:59pm"],
      exitCode: 1,
    });
    process.env.CODER_CLAUDE_BIN = fakeBin;

    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "park me" });
    await waitFor(() => store.getThread(thread.id).status === "quota-wait");

    const day = localDayKey();
    const cell = store.getUsageByDay()[day].claude.m;
    assert.ok(Math.abs(cell.costUsd - 0.01) < 1e-9);
    assert.equal(cell.wastedUsd, 0);
    assert.equal(cell.turns, 1);
  });
});
