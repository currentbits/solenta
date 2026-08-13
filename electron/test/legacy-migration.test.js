const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { migrateLegacyUserData } = require("../legacy-migration.js");

describe("migrateLegacyUserData", () => {
  let tmp;
  let appData;
  let userData;
  let legacy;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-migrate-"));
    appData = path.join(tmp, "appData");
    userData = path.join(appData, "Solenta");
    legacy = path.join(appData, "coder");
    fs.mkdirSync(legacy, { recursive: true });
    // Chromium pre-creates the new userData dir with cache files.
    fs.mkdirSync(path.join(userData, "Cache"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "coder-store.json"), "{}");
    fs.writeFileSync(
      path.join(legacy, "memory-server.json"),
      JSON.stringify({ port: 1, token: "t", dbPath: path.join(legacy, "memory.db") }),
    );
    fs.writeFileSync(path.join(legacy, "memory.db"), "db");
    fs.writeFileSync(path.join(legacy, "web-token"), "tok");
    fs.mkdirSync(path.join(legacy, "worktrees"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("moves app-owned files even when the new dir already exists", () => {
    assert.equal(migrateLegacyUserData(appData, userData), true);
    assert.ok(fs.existsSync(path.join(userData, "coder-store.json")));
    assert.ok(fs.existsSync(path.join(userData, "memory.db")));
    assert.ok(fs.existsSync(path.join(userData, "web-token")));
    assert.ok(fs.existsSync(path.join(userData, "worktrees")));
    assert.equal(
      fs.existsSync(path.join(legacy, "coder-store.json")),
      false,
      "legacy files move, not copy",
    );
  });

  it("rewrites a legacy dbPath in memory-server.json", () => {
    migrateLegacyUserData(appData, userData);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(userData, "memory-server.json"), "utf8"),
    );
    assert.equal(cfg.dbPath, path.join(userData, "memory.db"));
    assert.equal(cfg.token, "t");
  });

  it("does nothing when the new store already exists", () => {
    fs.writeFileSync(path.join(userData, "coder-store.json"), "{}");
    assert.equal(migrateLegacyUserData(appData, userData), false);
    assert.ok(
      fs.existsSync(path.join(legacy, "coder-store.json")),
      "legacy stays put",
    );
  });

  it("does nothing when there is no legacy store", () => {
    fs.rmSync(legacy, { recursive: true, force: true });
    assert.equal(migrateLegacyUserData(appData, userData), false);
  });

  it("does nothing when legacy and new are the same dir", () => {
    assert.equal(migrateLegacyUserData(appData, legacy), false);
  });
});
