"use strict";

/**
 * Issue #296: the verification engine.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const {
  normalizeCommand,
  tailLog,
  runVerifyCommand,
  buildFixPrompt,
  verifyShell,
  VERIFY_COMMAND_MAX,
} = require("../verify.js");

/** Child-shaped stub so runVerifyCommand can settle without a real spawn. */
function fakeChild(exitCode = 0, chunk = "ok\n") {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 0;
  process.nextTick(() => {
    if (chunk) child.stdout.emit("data", chunk);
    child.emit("close", exitCode);
  });
  return child;
}

describe("normalizeCommand", () => {
  it("disarms on empty, whitespace and non-strings", () => {
    assert.equal(normalizeCommand(""), null);
    assert.equal(normalizeCommand("   \n"), null);
    assert.equal(normalizeCommand(null), null);
    assert.equal(normalizeCommand(42), null);
  });

  it("trims and caps", () => {
    assert.equal(normalizeCommand("  npm test  "), "npm test");
    assert.equal(
      normalizeCommand("x".repeat(VERIFY_COMMAND_MAX + 50)).length,
      VERIFY_COMMAND_MAX,
    );
  });
});

describe("tailLog", () => {
  it("keeps the tail, not the head", () => {
    const out = tailLog("abcdefghij", 4);
    assert.match(out, /ghij$/);
    assert.match(out, /trimmed/);
  });

  it("leaves short output alone", () => {
    assert.equal(tailLog("ok", 100), "ok");
  });
});

describe("runVerifyCommand", () => {
  it("passes on exit 0", async () => {
    const r = await runVerifyCommand({ command: "echo hi", cwd: os.tmpdir() });
    assert.equal(r.ok, true);
    assert.equal(r.exitCode, 0);
    assert.match(r.log, /hi/);
  });

  it("fails on a non-zero exit and keeps stderr", async () => {
    const r = await runVerifyCommand({
      command: "echo boom >&2; exit 3",
      cwd: os.tmpdir(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 3);
    assert.match(r.log, /boom/);
  });

  it("kills and fails a command that outlives the timeout", async () => {
    const r = await runVerifyCommand({
      command: "sleep 30",
      cwd: os.tmpdir(),
      timeoutMs: 200,
    });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.match(r.log, /killed after/);
  });

  it("reports an unset command as a failure, not a throw", async () => {
    const r = await runVerifyCommand({ command: "  ", cwd: os.tmpdir() });
    assert.equal(r.ok, false);
  });

  it("uses /bin/sh off win32 and bash on win32", () => {
    assert.equal(verifyShell("darwin"), "/bin/sh");
    assert.equal(verifyShell("linux"), "/bin/sh");
    assert.equal(verifyShell("win32"), "bash");
  });

  it("spawns /bin/sh -c on posix (injected spawn)", async () => {
    const calls = [];
    const r = await runVerifyCommand({
      command: "npm test",
      cwd: "/tmp/repo",
      platform: "darwin",
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeChild();
      },
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "/bin/sh");
    assert.deepEqual(calls[0].args, ["-c", "npm test"]);
    assert.equal(calls[0].opts.cwd, "/tmp/repo");
    assert.equal(calls[0].opts.windowsHide, false);
  });

  it("spawns bash -c on win32, not /bin/sh or cmd.exe", async () => {
    const calls = [];
    const r = await runVerifyCommand({
      command: "npm test",
      cwd: "C:\\repo",
      platform: "win32",
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeChild();
      },
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0].bin, "bash");
    assert.deepEqual(calls[0].args, ["-c", "npm test"]);
    assert.equal(calls[0].opts.cwd, "C:\\repo");
    assert.equal(calls[0].opts.windowsHide, true);
  });

  it("routes a WSL-side project through wsl.exe so the command runs in the distro", async () => {
    const calls = [];
    const r = await runVerifyCommand({
      command: "npm test",
      cwd: "\\\\wsl$\\Ubuntu\\home\\me\\repo",
      project: { path: "\\\\wsl$\\Ubuntu\\home\\me\\repo" },
      platform: "win32",
      spawn: (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return fakeChild();
      },
    });
    assert.equal(r.ok, true);
    assert.equal(calls[0].bin, "wsl.exe");
    assert.deepEqual(calls[0].args, [
      "-d",
      "Ubuntu",
      "--cd",
      "/home/me/repo",
      "--",
      "bash",
      "-c",
      "npm test",
    ]);
    assert.equal(calls[0].opts.cwd, undefined);
  });

  it("does not wrap an ssh remote on posix (non-win32 behaviour unchanged)", async () => {
    const calls = [];
    await runVerifyCommand({
      command: "npm test",
      cwd: "/local/unused",
      project: { remoteHost: "dev@box", remotePath: "/srv/app" },
      platform: "darwin",
      spawn: (bin, args) => {
        calls.push({ bin, args });
        return fakeChild();
      },
    });
    assert.equal(calls[0].bin, "/bin/sh");
    assert.deepEqual(calls[0].args, ["-c", "npm test"]);
  });
});

describe("buildFixPrompt", () => {
  it("carries command, exit code, checkpoint, attempt and log", () => {
    const p = buildFixPrompt({
      command: "npm test",
      exitCode: 1,
      timedOut: false,
      log: "1 failing",
      sha: "abc1234",
      durationMs: 1000,
      attempt: 0,
    });
    assert.match(p, /verification failed/);
    assert.match(p, /npm test/);
    assert.match(p, /exited 1/);
    assert.match(p, /abc1234/);
    assert.match(p, /attempt 1 of 2/);
    assert.match(p, /1 failing/);
  });

  it("says timed out instead of an exit code", () => {
    const p = buildFixPrompt({
      command: "npm test",
      exitCode: null,
      timedOut: true,
      log: "",
      sha: null,
      durationMs: 600_000,
      attempt: 1,
    });
    assert.match(p, /timed out after 600s/);
    assert.match(p, /attempt 2 of 2/);
  });
});
