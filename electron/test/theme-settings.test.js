/**
 * settings.theme normalize + setSettings (issue #651).
 * Run: npm run test:electron -- --test-name-pattern theme
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, normalizeSettings } = require("../store");
const services = require("../services");

describe("settings.theme (#651)", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-theme-"));
    filePath = path.join(dir, "store.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("absent/junk → dark so upgrades stay dark", () => {
    assert.equal(normalizeSettings({}).theme, "dark");
    assert.equal(normalizeSettings(null).theme, "dark");
    assert.equal(normalizeSettings({ theme: "neon" }).theme, "dark");
    assert.equal(normalizeSettings({ theme: 1 }).theme, "dark");
  });

  it("keeps system, light, and dark", () => {
    assert.equal(normalizeSettings({ theme: "system" }).theme, "system");
    assert.equal(normalizeSettings({ theme: "light" }).theme, "light");
    assert.equal(normalizeSettings({ theme: "dark" }).theme, "dark");
  });

  it("setSettings validates, persists, and round-trips", () => {
    const store = new Store(filePath);
    assert.equal(store.getSettings().theme, "dark");
    assert.equal(services.setSettings(store, { theme: "light" }).theme, "light");
    assert.equal(store.getSettings().theme, "light");
    assert.throws(
      () => services.setSettings(store, { theme: "neon" }),
      /theme must be "system", "light", or "dark"/,
    );
    assert.throws(
      () => services.setSettings(store, { theme: null }),
      /theme must be "system", "light", or "dark"/,
    );
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().theme, "light");
    assert.equal(
      services.setSettings(reloaded, { theme: "system" }).theme,
      "system",
    );
  });
});
