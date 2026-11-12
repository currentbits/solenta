"use strict";

const { it, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const childProcess = require("node:child_process");
const script = require.resolve("../../scripts/verify-ios-simulator-helper.js");
const developerDir = "/Applications/Xcode.app/Contents/Developer";

afterEach(() => {
  mock.restoreAll();
  delete require.cache[script];
});

it("accepts a working selected Xcode toolchain without a Simulator GUI bundle", () => {
  mock.method(fs, "existsSync", (file) => file === developerDir);
  const exec = mock.method(childProcess, "execFileSync", () => "simctl help");
  const { hasFullXcode } = require(script);
  assert.equal(hasFullXcode(developerDir), true);
  assert.deepEqual(exec.mock.calls[0].arguments.slice(0, 2), ["/usr/bin/xcrun", ["simctl", "help"]]);
  assert.equal(exec.mock.calls[0].arguments[2].env.DEVELOPER_DIR, developerDir);
  assert.equal(hasFullXcode("/missing"), false);
  assert.equal(hasFullXcode("/Library/Developer/CommandLineTools"), false);
});

it("refuses Xcode when the simulator toolchain probe fails", () => {
  mock.method(fs, "existsSync", () => true);
  const exec = mock.method(childProcess, "execFileSync", () => { throw new Error("simctl unavailable"); });
  const { hasFullXcode } = require(script);
  assert.equal(hasFullXcode("/Library/Developer/CommandLineTools"), false);
  assert.equal(exec.mock.callCount(), 0);
  assert.equal(hasFullXcode(developerDir), false);
});

const checks = [
  ...["deny-shell", "deny-spawn", "deny-home-read", "deny-home-write", "deny-listen", "deny-non-loopback"]
    .map((name) => `sandbox-self-test ${name} denied`),
  ...["allow-loopback-client", "allow-iosurface", "allow-h264-encoder"]
    .map((name) => `sandbox-self-test ${name} allowed`),
];

it("requires every capture permission check, not just a successful helper exit", () => {
  const result = { status: 0, stdout: checks.join("\n"), stderr: "" };
  mock.method(childProcess, "spawnSync", () => result);
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
  mock.method(process, "exit", (code) => { throw new Error(`exit ${code}`); });
  const { runSandboxSelfTest } = require(script);
  assert.doesNotThrow(() => runSandboxSelfTest("/helper", developerDir));
  for (const name of ["allow-iosurface", "allow-h264-encoder"]) {
    result.stdout = checks.filter((line) => !line.includes(name)).join("\n");
    assert.throws(() => runSandboxSelfTest("/helper", developerDir), /exit 1/);
    result.stdout = checks.map((line) => line.includes(name) ? line.replace("allowed", "DENIED") : line).join("\n");
    assert.throws(() => runSandboxSelfTest("/helper", developerDir), /exit 1/);
  }
  result.stdout = checks.join("\n");
  result.status = 2;
  assert.throws(() => runSandboxSelfTest("/helper", developerDir), /exit 2/);
});
