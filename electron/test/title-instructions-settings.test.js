/**
 * settings.titleInstructions normalize + setSettings (issue #1765).
 * Run: node --test electron/test/title-instructions-settings.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, normalizeSettings } = require("../store.js");
const services = require("../services.js");
const { TITLE_INSTRUCTIONS_MAX } = require("../store-normalize.js");

describe("settings.titleInstructions (#1765)", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-title-instructions-"));
    filePath = path.join(dir, "store.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("absent/junk -> empty string", () => {
    assert.equal(normalizeSettings({}).titleInstructions, "");
    assert.equal(normalizeSettings(null).titleInstructions, "");
    assert.equal(normalizeSettings({ titleInstructions: 5 }).titleInstructions, "");
    assert.equal(
      normalizeSettings({ titleInstructions: null }).titleInstructions,
      "",
    );
  });

  it("trims and caps at TITLE_INSTRUCTIONS_MAX", () => {
    assert.equal(
      normalizeSettings({ titleInstructions: "  Lowercase only.  " })
        .titleInstructions,
      "Lowercase only.",
    );
    const long = "x".repeat(TITLE_INSTRUCTIONS_MAX + 200);
    const capped = normalizeSettings({ titleInstructions: long }).titleInstructions;
    assert.equal(capped.length, TITLE_INSTRUCTIONS_MAX);
    assert.equal(capped, long.slice(0, TITLE_INSTRUCTIONS_MAX));
  });

  it("setSettings validates, trims, caps, persists, and round-trips", () => {
    const store = new Store(filePath);
    assert.equal(store.getSettings().titleInstructions, "");
    assert.equal(
      services.setSettings(store, {
        titleInstructions: "  Start with the issue number.  ",
      }).titleInstructions,
      "Start with the issue number.",
    );
    assert.equal(
      store.getSettings().titleInstructions,
      "Start with the issue number.",
    );
    const long = "y".repeat(TITLE_INSTRUCTIONS_MAX + 50);
    assert.equal(
      services.setSettings(store, { titleInstructions: long })
        .titleInstructions.length,
      TITLE_INSTRUCTIONS_MAX,
    );
    assert.throws(
      () => services.setSettings(store, { titleInstructions: 5 }),
      /titleInstructions must be a string/,
    );
    assert.equal(
      services.setSettings(store, { titleInstructions: "" }).titleInstructions,
      "",
    );
    services.setSettings(store, { titleInstructions: "Keep it short." });
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().titleInstructions, "Keep it short.");
  });
});
