/**
 * settings.commitMessageInstructions + settings.prInstructions normalize +
 * setSettings (issue #1774). Mirrors title-instructions-settings.test.js.
 * Run: node --test electron/test/commit-pr-instructions-settings.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, normalizeSettings } = require("../store.js");
const services = require("../services.js");
const {
  COMMIT_MESSAGE_INSTRUCTIONS_MAX,
  PR_INSTRUCTIONS_MAX,
} = require("../store-normalize.js");

for (const [key, MAX] of [
  ["commitMessageInstructions", COMMIT_MESSAGE_INSTRUCTIONS_MAX],
  ["prInstructions", PR_INSTRUCTIONS_MAX],
]) {
  describe(`settings.${key} (#1774)`, () => {
    let dir;
    let filePath;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `solenta-${key}-`));
      filePath = path.join(dir, "store.json");
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("absent/junk -> empty string", () => {
      assert.equal(normalizeSettings({})[key], "");
      assert.equal(normalizeSettings(null)[key], "");
      assert.equal(normalizeSettings({ [key]: 5 })[key], "");
      assert.equal(normalizeSettings({ [key]: null })[key], "");
    });

    it(`trims and caps at ${MAX} chars`, () => {
      assert.equal(
        normalizeSettings({ [key]: "  Lowercase only.  " })[key],
        "Lowercase only.",
      );
      const long = "x".repeat(MAX + 200);
      const capped = normalizeSettings({ [key]: long })[key];
      assert.equal(capped.length, MAX);
      assert.equal(capped, long.slice(0, MAX));
    });

    it("setSettings validates, trims, caps, persists, and round-trips", () => {
      const store = new Store(filePath);
      assert.equal(store.getSettings()[key], "");
      assert.equal(
        services.setSettings(store, { [key]: "  Imperative mood.  " })[key],
        "Imperative mood.",
      );
      assert.equal(store.getSettings()[key], "Imperative mood.");
      const long = "y".repeat(MAX + 50);
      assert.equal(
        services.setSettings(store, { [key]: long })[key].length,
        MAX,
      );
      assert.throws(
        () => services.setSettings(store, { [key]: 5 }),
        new RegExp(`${key} must be a string`),
      );
      assert.equal(services.setSettings(store, { [key]: "" })[key], "");
      services.setSettings(store, { [key]: "Keep it short." });
      store.saveNow();
      const reloaded = new Store(filePath);
      assert.equal(reloaded.getSettings()[key], "Keep it short.");
    });
  });
}
