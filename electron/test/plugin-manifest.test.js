/**
 * plugin.json reader: 512KB cap, escaped dirs skipped, symlink skip,
 * invalid JSON treated as missing. Never executes plugin files. Name
 * policy stays split: palette basename fallback vs import
 * `{ requireName: true }` → null.
 *
 * Run: node --test electron/test/plugin-manifest.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readPluginManifest,
  MAX_JSON_BYTES,
} = require("../pluginManifest.js");

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-plugin-manifest-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function pluginRoot(name = "shipper-cache") {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function jsonAtLeast(obj, minBytes) {
  const body = JSON.stringify(obj);
  const pad = minBytes - Buffer.byteLength(body);
  return pad > 0 ? body + " ".repeat(pad) : body;
}

describe("readPluginManifest size cap", () => {
  it("treats plugin.json larger than 512KB as missing: palette basename, import null", () => {
    const root = pluginRoot("shipper-cache");
    const payload = jsonAtLeast(
      { name: "shipper", commands: ["./commands"], skills: ["./skills"] },
      MAX_JSON_BYTES + 1,
    );
    writeFile(path.join(root, "plugin.json"), payload);
    assert.ok(fs.statSync(path.join(root, "plugin.json")).size > MAX_JSON_BYTES);

    const palette = readPluginManifest(root);
    assert.equal(
      palette.name,
      "shipper-cache",
      "palette falls back to basename when the oversized json is ignored",
    );
    assert.deepEqual(palette.commandDirs, [
      path.join(root, "commands"),
      path.join(root, ".claude", "commands"),
    ]);
    assert.equal(readPluginManifest(root, { requireName: true }), null);
  });

  it("falls through an oversized earlier candidate to a later plugin.json", () => {
    const root = pluginRoot("shipper-cache");
    writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      jsonAtLeast({ name: "too-big" }, MAX_JSON_BYTES + 1),
    );
    writeFile(
      path.join(root, "plugin.json"),
      JSON.stringify({ name: "shipper", commands: ["./commands"] }),
    );

    const palette = readPluginManifest(root);
    assert.equal(palette.name, "shipper");
    assert.deepEqual(palette.commandDirs, [path.join(root, "commands")]);
    assert.equal(readPluginManifest(root, { requireName: true }).name, "shipper");
  });
});

describe("readPluginManifest escaped dirs", () => {
  it("omits commands and skills that resolve outside the plugin root", () => {
    const root = pluginRoot("shipper");
    const absCommands = path.join(tmp, "abs-commands");
    const absSkills = path.join(tmp, "abs-skills");
    writeFile(
      path.join(root, "plugin.json"),
      JSON.stringify({
        name: "shipper",
        commands: ["../escaped-commands", absCommands, "./commands"],
        skills: ["../escaped-skills", absSkills, "./skills"],
      }),
    );

    const manifest = readPluginManifest(root);
    assert.deepEqual(manifest.commandDirs, [path.join(root, "commands")]);
    assert.deepEqual(manifest.skillDirs, [path.join(root, "skills")]);
    const listed = [...manifest.commandDirs, ...manifest.skillDirs];
    assert.equal(
      listed.some((dir) => dir.includes("escaped") || dir === absCommands || dir === absSkills),
      false,
    );
  });
});

describe("readPluginManifest symlink skip", () => {
  it("does not read a symlinked plugin.json", () => {
    const root = pluginRoot("shipper-cache");
    const outside = path.join(tmp, "outside.json");
    writeFile(
      outside,
      JSON.stringify({ name: "shipper", commands: ["./commands"] }),
    );
    fs.symlinkSync(outside, path.join(root, "plugin.json"));

    const palette = readPluginManifest(root);
    assert.equal(palette.name, "shipper-cache");
    assert.equal(readPluginManifest(root, { requireName: true }), null);
  });

  it("falls through a symlinked earlier candidate to a later real plugin.json", () => {
    const root = pluginRoot("shipper-cache");
    const outside = path.join(tmp, "outside.json");
    writeFile(outside, JSON.stringify({ name: "from-symlink" }));
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, ".claude-plugin", "plugin.json"));
    writeFile(
      path.join(root, "plugin.json"),
      JSON.stringify({ name: "shipper", commands: ["./commands"] }),
    );

    const palette = readPluginManifest(root);
    assert.equal(palette.name, "shipper");
    assert.equal(readPluginManifest(root, { requireName: true }).name, "shipper");
  });
});

describe("readPluginManifest parse error", () => {
  it("falls through an invalid earlier candidate to a later plugin.json", () => {
    const root = pluginRoot("shipper-cache");
    writeFile(path.join(root, ".claude-plugin", "plugin.json"), "{ not json");
    writeFile(
      path.join(root, "plugin.json"),
      JSON.stringify({
        name: "shipper",
        commands: ["./commands"],
        skills: ["./skills"],
      }),
    );

    const palette = readPluginManifest(root);
    assert.equal(palette.name, "shipper");
    assert.deepEqual(palette.commandDirs, [path.join(root, "commands")]);
    assert.deepEqual(palette.skillDirs, [path.join(root, "skills")]);
    const imported = readPluginManifest(root, { requireName: true });
    assert.equal(imported.name, "shipper");
    assert.deepEqual(imported.commandDirs, [path.join(root, "commands")]);
    assert.deepEqual(imported.skillDirs, [path.join(root, "skills")]);
  });
});

describe("readPluginManifest name policy", () => {
  it("falls back to the plugin dir name unless requireName is set", () => {
    const root = pluginRoot("shipper-cache");
    writeFile(path.join(root, "plugin.json"), JSON.stringify({ name: "Not Valid" }));
    const listed = readPluginManifest(root);
    assert.equal(listed.name, "shipper-cache");
    assert.equal(readPluginManifest(root, { requireName: true }), null);
  });
});
