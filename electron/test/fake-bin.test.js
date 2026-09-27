"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const spawn = require("cross-spawn");
const { writeFakeBin } = require("./support/fakeBin.js");

describe("writeFakeBin", () => {
  it("writes a spawnable node fake that forwards argv and stdout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-fakebin-"));
    try {
      const dest = path.join(dir, "fake-echo");
      const bin = writeFakeBin(
        dest,
        `process.stdout.write("echo:" + process.argv.slice(2).join(","));\n`,
      );
      assert.equal(bin, dest);
      assert.ok(fs.readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"));
      const r = spawn.sync(bin, ["a", "b"], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "echo:a,b");
      // cmd.exe %* splits on newlines. cross-spawn must hand this to node.
      const nl = spawn.sync(bin, ["line1\n- Folder: kept"], { encoding: "utf8" });
      assert.equal(nl.status, 0, nl.stderr);
      assert.equal(nl.stdout, "echo:line1\n- Folder: kept");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
