/**
 * Round 45: autoSettleAfterDays normalize + setSettings validation.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  Store,
  normalizeSettings,
  DEFAULT_AUTO_SETTLE_AFTER_DAYS,
} = require("../store");
const services = require("../services");

describe("normalizeSettings autoSettleAfterDays", () => {
  it("absent key → default 3", () => {
    assert.deepEqual(normalizeSettings({}), {
      dailyBudgetUsd: null,
      orchestrationBudgetUsd: null,
      autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
      autoSettleOnMerge: true,
      prDiffCapLines: 400,
      mcpServers: [],
      defaultWorktree: false, defaultOrchestrate: false, onboardingSeen: false, updateChannel: null, notifications: true, theme: "dark", quotaWaitAutoResume: true, prDiffCapLines: 400, agentProfiles: [], subagentPool: { defaultAlias: null, force: false, entries: [] }, otel: { endpoint: null, headers: {}, claudeMetrics: false }, uiScale: 1,
    });
    assert.deepEqual(normalizeSettings(null), {
      dailyBudgetUsd: null,
      orchestrationBudgetUsd: null,
      autoSettleAfterDays: 3,
      autoSettleOnMerge: true,
      prDiffCapLines: 400,
      mcpServers: [],
      defaultWorktree: false, defaultOrchestrate: false, onboardingSeen: false, updateChannel: null, notifications: true, theme: "dark", quotaWaitAutoResume: true, prDiffCapLines: 400, agentProfiles: [], subagentPool: { defaultAlias: null, force: false, entries: [] }, otel: { endpoint: null, headers: {}, claudeMetrics: false }, uiScale: 1,
    });
    assert.equal(DEFAULT_AUTO_SETTLE_AFTER_DAYS, 3);
  });

  it("null → null (user disabled)", () => {
    assert.equal(
      normalizeSettings({ autoSettleAfterDays: null }).autoSettleAfterDays,
      null,
    );
  });

  it("positive integer kept", () => {
    assert.equal(
      normalizeSettings({ autoSettleAfterDays: 5 }).autoSettleAfterDays,
      5,
    );
  });

  it("junk on disk heals to default 3 (not null)", () => {
    assert.equal(
      normalizeSettings({ autoSettleAfterDays: "nope" }).autoSettleAfterDays,
      3,
    );
    assert.equal(
      normalizeSettings({ autoSettleAfterDays: 0 }).autoSettleAfterDays,
      3,
    );
    assert.equal(
      normalizeSettings({ autoSettleAfterDays: 1.5 }).autoSettleAfterDays,
      3,
    );
    assert.equal(
      normalizeSettings({ autoSettleAfterDays: NaN }).autoSettleAfterDays,
      3,
    );
  });
});

describe("setSettings autoSettleAfterDays validation", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-settle-"));
    filePath = path.join(dir, "store.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("accepts null and positive integers; rejects junk", () => {
    const store = new Store(filePath);
    assert.equal(store.getSettings().autoSettleAfterDays, 3);

    assert.deepEqual(
      services.setSettings(store, { autoSettleAfterDays: 7 }),
      { dailyBudgetUsd: null, orchestrationBudgetUsd: null, autoSettleAfterDays: 7, autoSettleOnMerge: true, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, onboardingSeen: false, updateChannel: null, notifications: true, theme: "dark", quotaWaitAutoResume: true, prDiffCapLines: 400, agentProfiles: [], subagentPool: { defaultAlias: null, force: false, entries: [] }, otel: { endpoint: null, headers: {}, claudeMetrics: false }, uiScale: 1 },
    );
    assert.equal(store.getSettings().autoSettleAfterDays, 7);

    assert.deepEqual(
      services.setSettings(store, { autoSettleAfterDays: null }),
      { dailyBudgetUsd: null, orchestrationBudgetUsd: null, autoSettleAfterDays: null, autoSettleOnMerge: true, mcpServers: [], defaultWorktree: false, defaultOrchestrate: false, onboardingSeen: false, updateChannel: null, notifications: true, theme: "dark", quotaWaitAutoResume: true, prDiffCapLines: 400, agentProfiles: [], subagentPool: { defaultAlias: null, force: false, entries: [] }, otel: { endpoint: null, headers: {}, claudeMetrics: false }, uiScale: 1 },
    );

    assert.throws(
      () => services.setSettings(store, { autoSettleAfterDays: 0 }),
      /Auto-settle days must be a positive integer or null/,
    );
    assert.throws(
      () => services.setSettings(store, { autoSettleAfterDays: -1 }),
      /Auto-settle days/,
    );
    assert.throws(
      () => services.setSettings(store, { autoSettleAfterDays: 1.5 }),
      /Auto-settle days/,
    );
    assert.throws(
      () => services.setSettings(store, { autoSettleAfterDays: NaN }),
      /Auto-settle days/,
    );
    assert.throws(
      () => services.setSettings(store, { autoSettleAfterDays: "3" }),
      /Auto-settle days/,
    );
  });

  it("old store file without the key heals to 3 on load", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        projects: [],
        threads: [],
        settings: { dailyBudgetUsd: null },
      }),
    );
    const store = new Store(filePath);
    assert.deepEqual(store.getSettings(), {
      dailyBudgetUsd: null,
      orchestrationBudgetUsd: null,
      autoSettleAfterDays: 3,
      autoSettleOnMerge: true,
      prDiffCapLines: 400,
      mcpServers: [],
      defaultWorktree: false, defaultOrchestrate: false, onboardingSeen: false, updateChannel: null, notifications: true, theme: "dark", quotaWaitAutoResume: true, prDiffCapLines: 400, agentProfiles: [], subagentPool: { defaultAlias: null, force: false, entries: [] }, otel: { endpoint: null, headers: {}, claudeMetrics: false }, uiScale: 1,
    });
  });

  it("null survives save + reload (Never is not healed to 3)", () => {
    const store = new Store(filePath);
    services.setSettings(store, { autoSettleAfterDays: null });
    assert.equal(store.getSettings().autoSettleAfterDays, null);
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(
      reloaded.getSettings().autoSettleAfterDays,
      null,
      "explicit Never must persist across reload, not become default 3",
    );
  });

  it("defaultWorktree: absent/junk → false, boolean kept, persists", () => {
    assert.equal(normalizeSettings({}).defaultWorktree, false);
    assert.equal(normalizeSettings({ defaultWorktree: "yes" }).defaultWorktree, false);
    assert.equal(normalizeSettings({ defaultWorktree: 1 }).defaultWorktree, false);
    assert.equal(normalizeSettings({ defaultWorktree: true }).defaultWorktree, true);

    const store = new Store(filePath);
    assert.equal(store.getSettings().defaultWorktree, false);
    assert.equal(
      services.setSettings(store, { defaultWorktree: true }).defaultWorktree,
      true,
    );
    assert.throws(
      () => services.setSettings(store, { defaultWorktree: "yes" }),
      /defaultWorktree must be a boolean/,
    );
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().defaultWorktree, true);
  });

  it("defaultOrchestrate: absent/junk → false, boolean kept, persists", () => {
    assert.equal(normalizeSettings({}).defaultOrchestrate, false);
    assert.equal(
      normalizeSettings({ defaultOrchestrate: "yes" }).defaultOrchestrate,
      false,
    );
    assert.equal(
      normalizeSettings({ defaultOrchestrate: 1 }).defaultOrchestrate,
      false,
    );
    assert.equal(
      normalizeSettings({ defaultOrchestrate: true }).defaultOrchestrate,
      true,
    );

    const store = new Store(filePath);
    assert.equal(store.getSettings().defaultOrchestrate, false);
    assert.equal(
      services.setSettings(store, { defaultOrchestrate: true }).defaultOrchestrate,
      true,
    );
    assert.throws(
      () => services.setSettings(store, { defaultOrchestrate: "yes" }),
      /defaultOrchestrate must be a boolean/,
    );
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().defaultOrchestrate, true);
  });

  it("updateChannel: absent/junk → null, prod/nightly kept, persists", () => {
    assert.equal(normalizeSettings({}).updateChannel, null);
    assert.equal(normalizeSettings({ updateChannel: "beta" }).updateChannel, null);
    assert.equal(normalizeSettings({ updateChannel: "nightly" }).updateChannel, "nightly");

    const store = new Store(filePath);
    assert.equal(store.getSettings().updateChannel, null);
    assert.equal(
      services.setSettings(store, { updateChannel: "nightly" }).updateChannel,
      "nightly",
    );
    assert.throws(
      () => services.setSettings(store, { updateChannel: "beta" }),
      /updateChannel must be/,
    );
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().updateChannel, "nightly");
    assert.equal(
      services.setSettings(reloaded, { updateChannel: null }).updateChannel,
      null,
    );
  });

  it("autoSettleOnMerge: absent/junk → true, explicit false kept, persists", () => {
    assert.equal(normalizeSettings({}).autoSettleOnMerge, true);
    assert.equal(normalizeSettings({ autoSettleOnMerge: "no" }).autoSettleOnMerge, true);
    assert.equal(normalizeSettings({ autoSettleOnMerge: 0 }).autoSettleOnMerge, true);
    assert.equal(normalizeSettings({ autoSettleOnMerge: false }).autoSettleOnMerge, false);

    const store = new Store(filePath);
    assert.equal(store.getSettings().autoSettleOnMerge, true);
    assert.equal(
      services.setSettings(store, { autoSettleOnMerge: false }).autoSettleOnMerge,
      false,
    );
    assert.throws(
      () => services.setSettings(store, { autoSettleOnMerge: "no" }),
      /autoSettleOnMerge must be a boolean/,
    );
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().autoSettleOnMerge, false);
  });
});
