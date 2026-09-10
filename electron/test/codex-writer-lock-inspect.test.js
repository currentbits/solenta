"use strict";

/**
 * #1226: inspect Codex thread-writer lock holders and repair overlay dirs.
 *
 * Run: node --test electron/test/codex-writer-lock-inspect.test.js
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  writerLockPath,
  sessionIdFromWriterLock,
  parseLsofHolders,
  inspectWriterLock,
  formatWriterLockDiagnosis,
  ensurePrivateWriterLockDir,
  releaseWriterLockHolder,
} = require("../codexWriterLock.js");

const SESSION = "01a08a25-29c9-7260-9410-a6552c1da79b";
const STDERR =
  "thread-store conflict: thread " +
  SESSION +
  " already has an active writer (code -32600)";

describe("sessionIdFromWriterLock", () => {
  it("pulls the Codex thread id from live stderr", () => {
    assert.equal(sessionIdFromWriterLock(STDERR), SESSION);
  });

  it("does not treat generic JSON-RPC -32600 as a session id", () => {
    assert.equal(sessionIdFromWriterLock("JSON-RPC error -32600: Invalid Request"), null);
  });
});

describe("parseLsofHolders", () => {
  it("reads pid and command from lsof -Fpc output", () => {
    assert.deepEqual(parseLsofHolders("p22106\nccodex\n"), [
      { pid: 22106, command: "codex" },
    ]);
  });

  it("returns [] for empty output", () => {
    assert.deepEqual(parseLsofHolders(""), []);
  });
});

describe("inspectWriterLock", () => {
  it("reports a live holder and whether it is ours", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lock-"));
    try {
      fs.mkdirSync(path.join(tmp, "thread-writer-locks"));
      const lockPath = writerLockPath(tmp, SESSION);
      fs.writeFileSync(lockPath, "");
      const info = inspectWriterLock({
        sessionId: SESSION,
        codexHome: tmp,
        ourPids: new Set([22106]),
        lsofFile: () => "p22106\nccodex\n",
      });
      assert.equal(info.lockPath, lockPath);
      assert.equal(info.holderPid, 22106);
      assert.equal(info.holderCommand, "codex");
      assert.equal(info.ours, true);
      assert.equal(info.stale, false);
      assert.equal(info.lockDirShared, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("marks a lock file with no process as stale, not ours", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lock-"));
    try {
      fs.mkdirSync(path.join(tmp, "thread-writer-locks"));
      fs.writeFileSync(writerLockPath(tmp, SESSION), "");
      const info = inspectWriterLock({
        sessionId: SESSION,
        codexHome: tmp,
        ourPids: new Set([99]),
        lsofFile: () => "",
      });
      assert.equal(info.holderPid, null);
      assert.equal(info.ours, false);
      assert.equal(info.stale, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects a lock dir that still symlinks to ~/.codex", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lock-"));
    try {
      const real = path.join(tmp, "real-locks");
      fs.mkdirSync(real);
      const home = path.join(tmp, "overlay");
      fs.mkdirSync(home);
      fs.symlinkSync(real, path.join(home, "thread-writer-locks"));
      const info = inspectWriterLock({
        sessionId: SESSION,
        codexHome: home,
        ourPids: new Set(),
        lsofFile: () => "p22106\nccodex\n",
      });
      assert.equal(info.lockDirShared, true);
      assert.equal(info.holderPid, 22106);
      assert.equal(info.ours, false, "Desktop on a shared lock dir is not ours");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("formatWriterLockDiagnosis", () => {
  it("names pid, CODEX_HOME, lock file, and whether Solenta owns it", () => {
    const text = formatWriterLockDiagnosis({
      holderPid: 22106,
      holderCommand: "codex",
      ours: false,
      stale: false,
      lockDirShared: true,
      lockDir: "/tmp/overlay/thread-writer-locks",
      lockPath: `/tmp/overlay/thread-writer-locks/${SESSION}.lock`,
      codexHome: "/tmp/overlay",
    });
    assert.match(text, /pid 22106/);
    assert.match(text, /CODEX_HOME=\/tmp\/overlay/);
    assert.match(text, new RegExp(`${SESSION}\\.lock`));
    assert.match(text, /not a Solenta child|other process|Quit/i);
    assert.match(text, /symlink|shares/i);
  });

  it("tells the user to send again when the lock is stale, not to quit processes", () => {
    const text = formatWriterLockDiagnosis({
      holderPid: null,
      ours: false,
      stale: true,
      lockDirShared: false,
      lockPath: `/tmp/overlay/thread-writer-locks/${SESSION}.lock`,
      codexHome: "/tmp/overlay",
    });
    assert.match(text, /stale/i);
    assert.match(text, /send again/i);
    assert.doesNotMatch(text, /Quit Codex Desktop/i);
  });
});

describe("ensurePrivateWriterLockDir", () => {
  it("unlinks a leftover symlink and mkdir a real directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lock-"));
    try {
      const shared = path.join(tmp, "shared");
      fs.mkdirSync(shared);
      fs.writeFileSync(path.join(shared, "desktop.lock"), "held\n");
      const dest = path.join(tmp, "overlay");
      fs.mkdirSync(dest);
      fs.symlinkSync(shared, path.join(dest, "thread-writer-locks"));
      const out = ensurePrivateWriterLockDir(dest);
      assert.equal(fs.lstatSync(out).isSymbolicLink(), false);
      assert.ok(fs.statSync(out).isDirectory());
      assert.equal(fs.existsSync(path.join(out, "desktop.lock")), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("releaseWriterLockHolder", () => {
  it("kills only when the holder is a Solenta child", () => {
    const killed = [];
    assert.equal(
      releaseWriterLockHolder(
        { ours: true, holderPid: 4242 },
        (pid) => killed.push(pid),
      ),
      true,
    );
    assert.deepEqual(killed, [4242]);
    assert.equal(
      releaseWriterLockHolder(
        { ours: false, holderPid: 22106 },
        (pid) => killed.push(pid),
      ),
      false,
    );
    assert.deepEqual(killed, [4242]);
    assert.equal(
      releaseWriterLockHolder({ ours: true, holderPid: null }, () => killed.push(1)),
      false,
    );
  });
});
