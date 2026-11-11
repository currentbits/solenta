"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { writeConfigAtomicSync } = require("../atomic-config.js");
const { materializeKimiHome } = require("../kimi.js");

function readJsonExternally(file) {
  return JSON.parse(execFileSync(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))))",
    file,
  ], { encoding: "utf8" }));
}

describe("atomic generated configuration", () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-config-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("keeps a generated MCP file valid for an external reader during partial and completed staging writes", (t) => {
    const file = path.join(dir, "mcp.json");
    const old = { mcpServers: { old: { command: "old" } } };
    fs.writeFileSync(file, JSON.stringify(old));
    const write = fs.writeFileSync;
    const rename = fs.renameSync;
    let expected = old;
    let observations = 0;
    t.mock.method(fs, "writeFileSync", (dest, data, options) => {
      // Pause the real writer halfway through its write. A direct destination
      // write exposes truncated JSON here; staging must leave the old document.
      if (typeof dest !== "number") return write(dest, data, options);
      const bytes = Buffer.from(data);
      const split = Math.floor(bytes.length / 2);
      fs.writeSync(dest, bytes.subarray(0, split));
      assert.deepEqual(readJsonExternally(file), expected);
      observations++;
      fs.writeSync(dest, bytes.subarray(split));
    });
    t.mock.method(fs, "renameSync", (from, to) => {
      assert.equal(path.dirname(from), path.dirname(to));
      if (to === file) {
        assert.deepEqual(readJsonExternally(file), expected);
        observations++;
      }
      const result = rename(from, to);
      if (to === file) expected = JSON.parse(fs.readFileSync(file, "utf8"));
      return result;
    });
    const next = { test: { command: "fixture", args: ["x".repeat(65536)] } };
    materializeKimiHome({ dest: dir, sourceHome: "", mcpServers: next });
    assert.ok(observations >= 3);
    assert.deepEqual(readJsonExternally(file), { mcpServers: next });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["mcp.json", "workspaces.json"]);
  });

  it("stages a copied provider TOML config before replacing the previous file", (t) => {
    const source = path.join(dir, "source");
    const dest = path.join(dir, "overlay");
    fs.mkdirSync(source);
    fs.mkdirSync(dest);
    const file = path.join(dest, "config.toml");
    const original = 'model = "old"\n';
    const next = 'model = "new"\n[settings]\neffort = "high"\n';
    fs.writeFileSync(path.join(source, "config.toml"), next);
    fs.writeFileSync(file, original);
    const rename = fs.renameSync;
    let published = false;
    t.mock.method(fs, "renameSync", (from, to) => {
      if (to === file) {
        assert.equal(fs.readFileSync(file, "utf8"), original);
        assert.equal(fs.readFileSync(from, "utf8"), next);
        published = true;
      }
      return rename(from, to);
    });
    materializeKimiHome({ dest, sourceHome: source });
    assert.ok(published);
    assert.equal(fs.readFileSync(file, "utf8"), next);
  });

  it("preserves relative symlink chains and publishes at the target", (t) => {
    if (process.platform === "win32") return t.skip("requires symlink privileges");
    const targetDir = path.join(dir, "shared");
    fs.mkdirSync(targetDir);
    const target = path.join(targetDir, "actual.json");
    const link = path.join(dir, "mcp.json");
    const middle = path.join(dir, "middle.json");
    fs.writeFileSync(target, '{"old":true}');
    fs.symlinkSync("shared/actual.json", middle);
    fs.symlinkSync("middle.json", link);
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from, to) => {
      assert.equal(path.dirname(from), targetDir);
      assert.equal(to, target);
      assert.deepEqual(readJsonExternally(link), { old: true });
      return rename(from, to);
    });
    writeConfigAtomicSync(link, '{"new":true}', { mode: 0o600 });
    assert.equal(fs.readlinkSync(link), "middle.json");
    assert.equal(fs.readlinkSync(middle), "shared/actual.json");
    assert.deepEqual(readJsonExternally(link), { new: true });
    assert.deepEqual(fs.readdirSync(targetDir), ["actual.json"]);
  });

  it("creates a dangling symlink's target without replacing the link", (t) => {
    if (process.platform === "win32") return t.skip("requires symlink privileges");
    const link = path.join(dir, "mcp.json");
    fs.symlinkSync("shared.json", link);
    writeConfigAtomicSync(link, '{"ok":true}');
    assert.equal(fs.readlinkSync(link), "shared.json");
    assert.deepEqual(readJsonExternally(link), { ok: true });
  });

  it("keeps existing permissions and stages secret replacements with 0600", (t) => {
    if (process.platform === "win32") return t.skip("POSIX permissions");
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, "old = true\n");
    fs.chmodSync(file, 0o640);
    writeConfigAtomicSync(file, "next = true\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    fs.chmodSync(file, 0o644);
    const write = fs.writeFileSync;
    t.mock.method(fs, "writeFileSync", (fd, data, options) => {
      assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600);
      return write(fd, data, options);
    });
    writeConfigAtomicSync(file, "secret = 'fixture'\n", { mode: 0o600 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const fresh = path.join(dir, "fresh.json");
    writeConfigAtomicSync(fresh, "{}", { mode: 0o600 });
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
  });

  for (const failure of ["write", "chmod", "rename"]) {
    it(`retains the previous config and cleans its staging file after ${failure} failure`, (t) => {
      const file = path.join(dir, "mcp.json");
      fs.writeFileSync(file, '{"old":true}');
      let stagedFd;
      const write = fs.writeFileSync;
      t.mock.method(fs, "writeFileSync", (fd, data, options) => {
        stagedFd = fd;
        if (failure === "write") {
          fs.writeSync(fd, "partial");
          throw new Error("injected write failure");
        }
        return write(fd, data, options);
      });
      if (failure === "chmod") t.mock.method(fs, "fchmodSync", () => { throw new Error("injected chmod failure"); });
      if (failure === "rename") t.mock.method(fs, "renameSync", () => { throw new Error("injected rename failure"); });
      assert.throws(() => writeConfigAtomicSync(file, '{"new":true}', { mode: 0o600 }), new RegExp(`injected ${failure} failure`));
      assert.deepEqual(readJsonExternally(file), { old: true });
      assert.deepEqual(fs.readdirSync(dir), ["mcp.json"]);
      assert.throws(() => fs.fstatSync(stagedFd), { code: "EBADF" });
    });
  }

  it("leaves an intentional symlink and its old target intact when publication fails", (t) => {
    if (process.platform === "win32") return t.skip("requires symlink privileges");
    const target = path.join(dir, "shared.json");
    const link = path.join(dir, "mcp.json");
    fs.writeFileSync(target, '{"old":true}');
    fs.symlinkSync("shared.json", link);
    t.mock.method(fs, "renameSync", () => { throw new Error("injected rename failure"); });
    assert.throws(() => writeConfigAtomicSync(link, "{}"), /injected rename failure/);
    assert.equal(fs.readlinkSync(link), "shared.json");
    assert.deepEqual(readJsonExternally(link), { old: true });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["mcp.json", "shared.json"]);
  });
});
