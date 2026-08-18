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
      if (process.platform === "win32") {
        assert.match(bin, /\.cmd$/i);
        assert.ok(fs.existsSync(dest), "JS script still written next to the wrapper");
      } else {
        assert.equal(bin, dest);
        assert.ok(fs.readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"));
      }
      const r = spawn.sync(bin, ["a", "b"], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "echo:a,b");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
