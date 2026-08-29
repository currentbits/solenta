/**
 * settings.agentsPanelDefault normalize + setSettings (issue #767).
 * Run: npm run test:electron -- --test-name-pattern agentsPanelDefault
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, normalizeSettings } = require("../store");
const services = require("../services");

describe("settings.agentsPanelDefault (#767)", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-agents-panel-"));
    filePath = path.join(dir, "store.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("absent/junk → closed so the right sidebar starts collapsed", () => {
    assert.equal(normalizeSettings({}).agentsPanelDefault, "closed");
    assert.equal(normalizeSettings(null).agentsPanelDefault, "closed");
    assert.equal(normalizeSettings({ agentsPanelDefault: "wide" }).agentsPanelDefault, "closed");
    assert.equal(normalizeSettings({ agentsPanelDefault: 1 }).agentsPanelDefault, "closed");
  });

  it("keeps closed and open", () => {
    assert.equal(
      normalizeSettings({ agentsPanelDefault: "closed" }).agentsPanelDefault,
      "closed",
    );
    assert.equal(
      normalizeSettings({ agentsPanelDefault: "open" }).agentsPanelDefault,
      "open",
    );
  });

  it("setSettings validates, persists, and round-trips", () => {
    const store = new Store(filePath);
    assert.equal(store.getSettings().agentsPanelDefault, "closed");
    assert.equal(
      services.setSettings(store, { agentsPanelDefault: "open" }).agentsPanelDefault,
      "open",
    );
    assert.equal(store.getSettings().agentsPanelDefault, "open");
    assert.throws(
      () => services.setSettings(store, { agentsPanelDefault: "wide" }),
      /agentsPanelDefault must be "closed" or "open"/,
    );
    assert.throws(
      () => services.setSettings(store, { agentsPanelDefault: null }),
      /agentsPanelDefault must be "closed" or "open"/,
    );
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().agentsPanelDefault, "open");
    assert.equal(
      services.setSettings(reloaded, { agentsPanelDefault: "closed" })
        .agentsPanelDefault,
      "closed",
    );
  });
});

describe("settings.agentsPanelRememberLast (#769)", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-agents-remember-"));
    filePath = path.join(dir, "store.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("absent/junk → false so last toggle stays ephemeral", () => {
    assert.equal(normalizeSettings({}).agentsPanelRememberLast, false);
    assert.equal(normalizeSettings(null).agentsPanelRememberLast, false);
    assert.equal(
      normalizeSettings({ agentsPanelRememberLast: "yes" }).agentsPanelRememberLast,
      false,
    );
    assert.equal(
      normalizeSettings({ agentsPanelRememberLast: 1 }).agentsPanelRememberLast,
      false,
    );
  });

  it("only an explicit true opts in", () => {
    assert.equal(
      normalizeSettings({ agentsPanelRememberLast: true }).agentsPanelRememberLast,
      true,
    );
    assert.equal(
      normalizeSettings({ agentsPanelRememberLast: false }).agentsPanelRememberLast,
      false,
    );
  });

  it("setSettings validates, persists, and round-trips", () => {
    const store = new Store(filePath);
    assert.equal(store.getSettings().agentsPanelRememberLast, false);
    assert.equal(
      services.setSettings(store, { agentsPanelRememberLast: true })
        .agentsPanelRememberLast,
      true,
    );
    assert.equal(store.getSettings().agentsPanelRememberLast, true);
    assert.throws(
      () => services.setSettings(store, { agentsPanelRememberLast: "yes" }),
      /agentsPanelRememberLast must be a boolean/,
    );
    assert.throws(
      () => services.setSettings(store, { agentsPanelRememberLast: null }),
      /agentsPanelRememberLast must be a boolean/,
    );
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().agentsPanelRememberLast, true);
    assert.equal(
      services.setSettings(reloaded, { agentsPanelRememberLast: false })
        .agentsPanelRememberLast,
      false,
    );
  });
});
