"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { rmTree } = require("./support/rmTree.js");

it("rmTree bounds Windows cwd-lock retries and yields for child shutdown", { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-rm-cwd-"));
  const child = spawn(process.execPath, ["-e", `
    process.stdin.once('data', () => process.exit(0));
    process.stdout.write('ready');
  `], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  let release;
  try {
    await once(child.stdout, "data");
    if (process.platform === "win32") {
      // Characterize the initial rmdir failure seen in the Grok fixtures.
      assert.throws(() => fs.rmSync(dir, { recursive: true, force: true }), { code: "EBUSY" });
      await assert.rejects(rmTree(dir), { code: "EBUSY" });
      assert.equal(fs.existsSync(dir), true, "an unreleased lock must not report success");
    }
    release = setTimeout(() => child.stdin.end("release"), 100);
    await rmTree(dir);
    assert.deepEqual(await closed, [0, null], "cleanup allows shutdown to complete");
    assert.equal(fs.existsSync(dir), false);
  } finally {
    clearTimeout(release);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    await rmTree(dir);
  }
});
