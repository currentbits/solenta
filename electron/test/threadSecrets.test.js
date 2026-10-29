"use strict";

/** Issue #1744: secret_request values survive a relaunch for 24 hours. */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const threadSecrets = require("../threadSecrets.js");
const { retireAgent } = require("../ipc-shared.js");

const VALUE = "tskey-auth-k1234567";

describe("threadSecrets persistence (#1744)", () => {
  let dir;
  let file;
  let clock;
  const now = () => clock;
  /** A fresh process: memory gone, only the file left. */
  const relaunch = (opts = {}) => threadSecrets.configure({ file, now, ...opts });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-thread-secrets-"));
    file = path.join(dir, "thread-secrets.json");
    clock = 1_000_000;
    relaunch();
  });

  afterEach(() => {
    threadSecrets.configure({});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists to a 0600 file and is back after a reload, redaction included", () => {
    threadSecrets.set("t1", "TS_AUTHKEY", VALUE);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [
      { threadId: "t1", name: "TS_AUTHKEY", value: VALUE, savedAt: 1_000_000 },
    ]);
    assert.deepEqual(fs.readdirSync(dir), ["thread-secrets.json"], "no tmp left behind");

    threadSecrets.configure({});
    assert.equal(threadSecrets.withEnv("t1", undefined), undefined, "memory cleared");
    relaunch();
    assert.deepEqual(threadSecrets.withEnv("t1", { A: "1" }), { A: "1", TS_AUTHKEY: VALUE });
    assert.equal(threadSecrets.redact("t1", `key ${VALUE}`), "key [secret:TS_AUTHKEY]");
  });

  it("expires 24h after save, on read and on load", () => {
    threadSecrets.set("t1", "OLD_KEY", "old-value-1");
    clock += 60_000;
    threadSecrets.set("t2", "NEW_KEY", "new-value-2");

    clock = 1_000_000 + threadSecrets.TTL_MS - 1;
    assert.ok(threadSecrets.withEnv("t1", undefined), "still live just under 24h");
    clock += 1;
    assert.equal(threadSecrets.withEnv("t1", undefined), undefined, "expired on read");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).map((r) => r.name), ["NEW_KEY"]);

    clock += 60_000;
    relaunch();
    assert.equal(threadSecrets.withEnv("t2", undefined), undefined, "expired on load");
    assert.equal(fs.existsSync(file), false, "empty store leaves no file");
  });

  it("retireAgent (archive / settle / delete) clears it from memory and disk", () => {
    threadSecrets.set("t1", "API_KEY", VALUE);
    threadSecrets.set("t2", "API_KEY", "other-thread-val");
    retireAgent({ runner: {} }, "t1");
    assert.equal(threadSecrets.withEnv("t1", undefined), undefined);
    relaunch();
    assert.equal(threadSecrets.withEnv("t1", undefined), undefined);
    assert.deepEqual(threadSecrets.withEnv("t2", undefined), { API_KEY: "other-thread-val" });
  });

  it("seals values on disk when encryption is on, and drops what it cannot open", () => {
    const secrets = {
      seal: (v) => `enc:v1:${Buffer.from(v).toString("base64")}`,
      open: (v) => Buffer.from(String(v).slice(7), "base64").toString(),
    };
    relaunch({ secrets });
    threadSecrets.set("t1", "API_KEY", VALUE);
    assert.ok(!fs.readFileSync(file, "utf8").includes(VALUE));
    relaunch({ secrets });
    assert.deepEqual(threadSecrets.withEnv("t1", undefined), { API_KEY: VALUE });

    // Encryption turned off since: sealed rows can't be opened and are dropped.
    relaunch({ secrets: { seal: (v) => v, open: () => null } });
    assert.equal(threadSecrets.withEnv("t1", undefined), undefined);
    assert.equal(fs.existsSync(file), false);
  });
});
