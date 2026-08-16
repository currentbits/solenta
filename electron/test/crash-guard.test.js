const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installCrashGuard, MAX_LOGGED } = require("../crash-guard.js");

describe("installCrashGuard", () => {
  /** @type {string} */
  let dir;
  const errors = [];
  const realError = console.error;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-guard-"));
    console.error = (msg) => errors.push(msg);
  });

  after(() => {
    console.error = realError;
    fs.rmSync(dir, { recursive: true, force: true });
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
  });

  it("logs, notifies once, and never throws", () => {
    const before = {
      rejection: process.listenerCount("unhandledRejection"),
      exception: process.listenerCount("uncaughtException"),
    };
    const notified = [];
    const report = installCrashGuard({
      userDataPath: dir,
      notify: (message, logPath) => notified.push([message, logPath]),
    });

    // Both fatal-by-default events are actually wired to the reporter.
    assert.equal(process.listenerCount("unhandledRejection"), before.rejection + 1);
    assert.equal(process.listenerCount("uncaughtException"), before.exception + 1);

    report("unhandledRejection", new Error("boom"));
    report("uncaughtException", new Error("bang"));
    report("unhandledRejection", "not an error at all");

    const log = fs.readFileSync(path.join(dir, "crash.log"), "utf8");
    assert.match(log, /unhandledRejection: Error: boom/);
    assert.match(log, /uncaughtException: Error: bang/);
    assert.match(log, /unhandledRejection: not an error at all/);
    assert.equal(errors.length, 3);

    // One notification per boot, pointing at the log.
    assert.equal(notified.length, 1);
    assert.deepEqual(notified[0], ["boom", path.join(dir, "crash.log")]);
  });

  it("stops writing after MAX_LOGGED so a crash loop cannot fill the disk", () => {
    const report = installCrashGuard({ userDataPath: dir });
    const logPath = path.join(dir, "crash.log");
    fs.rmSync(logPath, { force: true });

    for (let i = 0; i < MAX_LOGGED + 10; i++) report("uncaughtException", `e${i}`);

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, MAX_LOGGED);
  });

  it("survives an unwritable log path", () => {
    const report = installCrashGuard({ userDataPath: path.join(dir, "nope") });
    assert.doesNotThrow(() => report("uncaughtException", new Error("x")));
  });
});
