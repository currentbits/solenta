"use strict";

/**
 * settings.confirmQuitWithActiveWork normalize + setSettings (issue #1195).
 * Run: node --test electron/test/confirm-quit-settings.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, normalizeSettings } = require("../store");
const services = require("../services");

describe("settings.confirmQuitWithActiveWork (#1195)", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-confirm-quit-"));
    filePath = path.join(dir, "store.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("absent/junk → true (confirm stays on)", () => {
    assert.equal(normalizeSettings({}).confirmQuitWithActiveWork, true);
    assert.equal(normalizeSettings(null).confirmQuitWithActiveWork, true);
    assert.equal(
      normalizeSettings({ confirmQuitWithActiveWork: "no" }).confirmQuitWithActiveWork,
      true,
    );
    assert.equal(
      normalizeSettings({ confirmQuitWithActiveWork: 0 }).confirmQuitWithActiveWork,
      true,
    );
    assert.equal(
      normalizeSettings({ confirmQuitWithActiveWork: null }).confirmQuitWithActiveWork,
      true,
    );
  });

  it("only an explicit false opts out", () => {
    assert.equal(
      normalizeSettings({ confirmQuitWithActiveWork: false }).confirmQuitWithActiveWork,
      false,
    );
    assert.equal(
      normalizeSettings({ confirmQuitWithActiveWork: true }).confirmQuitWithActiveWork,
      true,
    );
  });

  it("setSettings validates, persists, and round-trips", () => {
    const store = new Store(filePath);
    assert.equal(store.getSettings().confirmQuitWithActiveWork, true);
    assert.equal(
      services.setSettings(store, { confirmQuitWithActiveWork: false })
        .confirmQuitWithActiveWork,
      false,
    );
    assert.equal(store.getSettings().confirmQuitWithActiveWork, false);
    assert.throws(
      () => services.setSettings(store, { confirmQuitWithActiveWork: "no" }),
      /confirmQuitWithActiveWork must be a boolean/,
    );
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().confirmQuitWithActiveWork, false);
    assert.equal(
      services.setSettings(reloaded, { confirmQuitWithActiveWork: true })
        .confirmQuitWithActiveWork,
      true,
    );
  });
});
