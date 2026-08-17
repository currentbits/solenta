const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildFmArgs, fmAvailable, fmRun } = require("../fm.js");

/** Write an executable fake fm that runs `body` as node. */
function writeFakeFm(dir, body) {
  const bin = path.join(dir, "fake-fm");
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe("buildFmArgs", () => {
  it("prompt is the last argv element", () => {
    assert.deepEqual(buildFmArgs("hello", {}), ["hello"]);
  });

  it("CODER_FM_ARGS prepends flags, prompt still last", () => {
    assert.deepEqual(buildFmArgs("hello", { CODER_FM_ARGS: "--quiet -m small" }), [
      "--quiet",
      "-m",
      "small",
      "hello",
    ]);
  });
});

describe("fmAvailable", () => {
  it("false when the binary does not exist", () => {
    assert.equal(fmAvailable({ CODER_FM_BIN: "/nope/fm" }), false);
  });

  it("false when disabled even with a real binary", () => {
    assert.equal(
      fmAvailable({ CODER_FM_BIN: process.execPath, CODER_FM_DISABLE: "1" }),
      false,
    );
  });

  it("true for an existing binary path", () => {
    assert.equal(fmAvailable({ CODER_FM_BIN: process.execPath }), true);
  });
});

describe("fmRun", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-fm-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns trimmed stdout and passes the prompt as the last arg", async () => {
    const logPath = path.join(tmpDir, "argv.json");
    const bin = writeFakeFm(
      tmpDir,
      `require("fs").writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));
console.log("  chore: tidy up  ");`,
    );
    const out = await fmRun("summarise this", { env: { ...process.env, CODER_FM_BIN: bin } });
    assert.equal(out, "chore: tidy up");
    assert.deepEqual(JSON.parse(fs.readFileSync(logPath, "utf8")), [
      "summarise this",
    ]);
  });

  it("null when fm is unavailable", async () => {
    assert.equal(await fmRun("x", { env: { CODER_FM_BIN: "/nope/fm" } }), null);
  });

  it("null on a non-zero exit", async () => {
    const bin = writeFakeFm(tmpDir, `console.error("boom"); process.exit(3);`);
    assert.equal(await fmRun("x", { env: { ...process.env, CODER_FM_BIN: bin } }), null);
  });

  it("null on empty output", async () => {
    const bin = writeFakeFm(tmpDir, `console.log("   ");`);
    assert.equal(await fmRun("x", { env: { ...process.env, CODER_FM_BIN: bin } }), null);
  });

  it("null on timeout instead of hanging the caller", async () => {
    const bin = writeFakeFm(tmpDir, `setTimeout(() => console.log("late"), 5000);`);
    assert.equal(
      await fmRun("x", { env: { ...process.env, CODER_FM_BIN: bin }, timeoutMs: 300 }),
      null,
    );
  });

  it("null on an empty prompt without spawning anything", async () => {
    assert.equal(await fmRun("   ", { env: { CODER_FM_BIN: process.execPath } }), null);
  });
});
