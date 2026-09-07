/**
 * Shared plugin.json reader. Run:
 *   node --test electron/test/plugin-manifest.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_JSON_BYTES,
  readPluginManifest,
} = require("../pluginManifest.js");

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-plugin-manifest-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeRel(rel, content) {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("readPluginManifest", () => {
  it("falls through when an earlier candidate is invalid JSON", () => {
    writeRel(".claude-plugin/plugin.json", "{not json");
    writeRel(
      ".cursor-plugin/plugin.json",
      JSON.stringify({ name: "shipper", commands: ["./slash"] }),
    );
    const manifest = readPluginManifest(tmp);
    assert.equal(manifest.name, "shipper");
    assert.deepEqual(manifest.commandDirs, [path.join(tmp, "slash")]);
  });

  it("treats a plugin.json larger than 512KB as missing and continues", () => {
    writeRel(".claude-plugin/plugin.json", `${"x".repeat(MAX_JSON_BYTES + 1)}`);
    writeRel(
      ".cursor-plugin/plugin.json",
      JSON.stringify({ name: "shipper" }),
    );
    const manifest = readPluginManifest(tmp);
    assert.equal(manifest.name, "shipper");
  });

  it("treats a symlinked plugin.json as missing", () => {
    const target = path.join(tmp, "outside.json");
    fs.writeFileSync(target, JSON.stringify({ name: "evil" }));
    fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
    fs.symlinkSync(target, path.join(tmp, ".claude-plugin", "plugin.json"));
    writeRel("plugin.json", JSON.stringify({ name: "shipper" }));
    const manifest = readPluginManifest(tmp);
    assert.equal(manifest.name, "shipper");
  });

  it("skips command and skill dirs that leave the plugin root", () => {
    writeRel(
      "plugin.json",
      JSON.stringify({
        name: "shipper",
        commands: ["../../evil-commands", "commands"],
        skills: ["../../evil-skills", "skills"],
      }),
    );
    const manifest = readPluginManifest(tmp);
    assert.deepEqual(manifest.commandDirs, [path.join(tmp, "commands")]);
    assert.deepEqual(manifest.skillDirs, [path.join(tmp, "skills")]);
  });

  it("falls back to the plugin dir name unless requireName is set", () => {
    writeRel("plugin.json", JSON.stringify({ name: "Not Valid" }));
    const listed = readPluginManifest(tmp);
    assert.equal(listed.name, path.basename(tmp).toLowerCase());
    assert.equal(readPluginManifest(tmp, { requireName: true }), null);
  });
});
