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
      autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
      mcpServers: [],
      defaultWorktree: false, updateChannel: null,
    });
    assert.deepEqual(normalizeSettings(null), {
      dailyBudgetUsd: null,
      autoSettleAfterDays: 3,
      mcpServers: [],
      defaultWorktree: false, updateChannel: null,
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
      { dailyBudgetUsd: null, autoSettleAfterDays: 7, mcpServers: [], defaultWorktree: false, updateChannel: null },
    );
    assert.equal(store.getSettings().autoSettleAfterDays, 7);

    assert.deepEqual(
      services.setSettings(store, { autoSettleAfterDays: null }),
      { dailyBudgetUsd: null, autoSettleAfterDays: null, mcpServers: [], defaultWorktree: false, updateChannel: null },
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
      autoSettleAfterDays: 3,
      mcpServers: [],
      defaultWorktree: false, updateChannel: null,
    });
  });

  it("null survives save + reload (Never is not healed to 3)", () => {
    const store = new Store(filePath);
    services.setSettings(store, { autoSettleAfterDays: null });
    assert.equal(store.getSettings().autoSettleAfterDays, null);
    store.save();
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
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().defaultWorktree, true);
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
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().updateChannel, "nightly");
    assert.equal(
      services.setSettings(reloaded, { updateChannel: null }).updateChannel,
      null,
    );
  });
});
