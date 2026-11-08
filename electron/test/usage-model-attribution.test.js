"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, localDayKey } = require("../store.js");
const { applyModelPrices } = require("../modelPrices.js");

describe("recorded usage model attribution", () => {
  let dir;
  let store;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-usage-models-"));
    file = path.join(dir, "store.json");
    store = new Store(file);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("prices and filters original model/provider buckets in a mixed session after reload", async () => {
    const { filterUsageReport, summarizeUsage } = await import("../../src/usage.ts");
    const now = new Date();
    const day = localDayKey(now);
    const meta = { threadId: "mixed", projectId: "p", projectName: "Project", title: "Mixed session" };
    store.recordUsage({ ...meta, provider: "codex", model: "model-a", inputTokens: 1e6 }, now);
    store.recordUsage({ ...meta, provider: "codex", model: "model-b", inputTokens: 1e6 }, now);
    store.recordUsage({ ...meta, provider: "claude", model: "model-a", inputTokens: 1e6, costUsd: 7 }, now);
    store.recordUsage({ ...meta, provider: "kimi", model: null }, now);
    store.recordWastedSpend({ ...meta, provider: "claude", model: "model-a", costUsd: 2 }, now);
    // A later settings change is not evidence about the usage already recorded.
    store.data.threads.push({ id: "mixed", provider: "codex", model: "current-model" });
    store.saveNow();
    store = new Store(file);
    const raw = { byDay: store.getUsageByDay(), threadsByDay: store.getUsageThreadsByDay() };
    const prices = { "model-a": { input: 1, output: 0 }, "model-b": { input: 10, output: 0 }, "current-model": { input: 999, output: 0 } };
    const report = applyModelPrices(raw, prices);
    assert.equal(report.threadsByDay[day].mixed.costUsd, 18, "1 + 10 + provider-reported 7");
    assert.equal(report.threadsByDay[day].mixed.byProviderModel.claude["model-a"].costUsd, 7);
    assert.equal(raw.threadsByDay[day].mixed.costUsd, 7, "raw ledger stays unpriced");
    const all = summarizeUsage(report, 7, now);
    assert.equal(all.totals.costUsd, all.threads[0].costUsd);
    assert.equal(all.totals.costUsd, all.projects[0].costUsd);
    assert.equal(all.totals.wastedUsd, 2);
    assert.equal(all.hasUnattributedThreadUsage, false);
    const filtered = filterUsageReport(report, "codex", { mode: "include", models: [{ provider: "codex", model: "model-a" }] });
    const one = summarizeUsage(filtered, 7, now);
    assert.equal(one.totals.costUsd, 1);
    assert.equal(one.threads[0].costUsd, 1);
    assert.equal(one.projects[0].costUsd, 1);
    assert.equal(one.models[0].model, "model-a");
    const unknown = summarizeUsage(filterUsageReport(report, null, { mode: "include", models: [{ provider: "kimi", model: "unknown" }] }), 7, now);
    assert.equal(unknown.totals.turns, 1);
    assert.equal(unknown.providers[0].unreported, true);
  });

  it("retains unassignable legacy totals without repricing them at a later model", () => {
    const now = new Date();
    const day = localDayKey(now);
    store.data.usageThreadsByDay = { [day]: { legacy: {
      costUsd: 0, inputTokens: 2e6, turns: 2,
      provider: "codex", model: "last-seen", projectId: "p", projectName: "P", title: "Old",
    } } };
    store.recordUsage({ threadId: "legacy", provider: "codex", model: "next", inputTokens: 1e6 }, now);
    store.saveNow();
    const reloaded = new Store(file);
    const raw = reloaded.getUsageThreadsByDay()[day].legacy;
    assert.equal(raw.inputTokens, 3e6);
    assert.equal(raw.unattributed.inputTokens, 2e6);
    assert.equal(raw.byProviderModel.codex.next.inputTokens, 1e6);
    assert.equal(raw.byProviderModel.codex["last-seen"], undefined);
    const priced = applyModelPrices({ byDay: {}, threadsByDay: { [day]: { legacy: raw } } }, {
      "last-seen": { input: 100, output: 0 }, next: { input: 10, output: 0 },
    });
    assert.equal(priced.threadsByDay[day].legacy.costUsd, 10);
    assert.equal(priced.threadsByDay[day].legacy.unattributed.costUsd, 0);
  });

  it("estimates only uncovered tokens when another thread with the same model reports cost", () => {
    const now = new Date();
    const day = localDayKey(now);
    store.recordUsage({ threadId: "reported", provider: "codex", model: "same", inputTokens: 1e6, costUsd: 7 }, now);
    store.recordUsage({ threadId: "unmetered", provider: "codex", model: "same", inputTokens: 1e6 }, now);
    const report = applyModelPrices({ byDay: store.getUsageByDay(), threadsByDay: store.getUsageThreadsByDay() }, {
      same: { input: 10, output: 0 },
    });
    assert.equal(report.byDay[day].codex.same.costUsd, 17);
    assert.equal(report.threadsByDay[day].reported.costUsd, 7);
    assert.equal(report.threadsByDay[day].unmetered.costUsd, 10);
  });
});
