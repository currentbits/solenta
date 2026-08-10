"use strict";

/**
 * Kimi effort config flip. kimi has no per-invocation effort flag, so
 * kimi.js flips [thinking].effort in config.toml around the spawn. These
 * tests point KIMI_CODE_HOME (kimi's own home override) at a temp dir; the
 * user's real ~/.kimi-code is never touched.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { flipKimiEffort, kimiConfigPath, runKimi } = require("../kimi.js");

const CONFIG = `default_model = "kimi-code/k3"

[thinking]
enabled = true
effort = "high"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
support_efforts = [ "low", "high", "max" ]
default_effort = "high"
`;

let tmpHome;
let prevHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "coder-kimi-home-"));
  prevHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeConfig(text = CONFIG) {
  fs.writeFileSync(kimiConfigPath(), text);
}

function readConfig() {
  return fs.readFileSync(kimiConfigPath(), "utf8");
}

describe("flipKimiEffort", () => {
  it("flips only the [thinking] effort line and backs up the original", () => {
    writeConfig();
    const restore = flipKimiEffort("low");
    const flipped = readConfig();
    assert.match(flipped, /\[thinking\]\nenabled = true\neffort = "low"/);
    assert.match(
      flipped,
      /default_effort = "high"/,
      "the per-model default_effort in a later section must not be touched",
    );
    assert.equal(
      fs.readFileSync(`${kimiConfigPath()}.coder-effort-backup`, "utf8"),
      CONFIG,
      "the backup must be the byte-identical original",
    );
    restore();
  });

  it("restore returns the file byte-identical and removes the backup", () => {
    writeConfig();
    const restore = flipKimiEffort("max");
    restore();
    assert.equal(readConfig(), CONFIG);
    assert.equal(
      fs.existsSync(`${kimiConfigPath()}.coder-effort-backup`),
      false,
    );
    // Idempotent: a second call must not throw or rewrite.
    restore();
    assert.equal(readConfig(), CONFIG);
  });

  it("reinstates a leftover backup (crash) before flipping", () => {
    // A previous flip crashed: config holds the flipped value, backup holds
    // the user's real file. The next flip must start from the backup.
    writeConfig(CONFIG.replace('effort = "high"', 'effort = "low"'));
    fs.writeFileSync(`${kimiConfigPath()}.coder-effort-backup`, CONFIG);
    const restore = flipKimiEffort("max");
    assert.match(readConfig(), /effort = "max"/);
    restore();
    assert.equal(
      readConfig(),
      CONFIG,
      "restore must land on the user's real config, not the crashed flip",
    );
  });

  it("leaves the file alone when [thinking] has no effort line", () => {
    const noEffort = 'default_model = "kimi-code/k3"\n\n[thinking]\nenabled = true\n';
    writeConfig(noEffort);
    const restore = flipKimiEffort("low");
    assert.equal(readConfig(), noEffort, "Coder does not invent config lines");
    assert.equal(
      fs.existsSync(`${kimiConfigPath()}.coder-effort-backup`),
      false,
    );
    restore();
  });

  it("does not match an effort line belonging to a LATER section", () => {
    // [thinking] without its own effort line, followed by a section that has
    // one: the flip must not cross the section boundary.
    const tricky =
      '[thinking]\nenabled = true\n\n[models."kimi-code/k3"]\neffort = "high"\n';
    writeConfig(tricky);
    flipKimiEffort("low");
    assert.equal(
      readConfig(),
      tricky,
      "a later section's effort line is not [thinking]'s",
    );
  });

  it("is a noop without an effort or without a config file", () => {
    writeConfig();
    flipKimiEffort(null);
    flipKimiEffort("");
    assert.equal(readConfig(), CONFIG);

    fs.unlinkSync(kimiConfigPath());
    const restore = flipKimiEffort("low");
    restore();
    assert.equal(fs.existsSync(kimiConfigPath()), false);
  });
});

describe("runKimi applies effort via config", () => {
  /**
   * Fake kimi that reads its own config.toml (as the real one does at
   * startup) and reports the effort it saw as a stream-json event.
   */
  function writeFakeKimi(dir) {
    const scriptPath = path.join(dir, "fake-kimi-effort.js");
    fs.writeFileSync(
      scriptPath,
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const cfg = fs.readFileSync(path.join(process.env.KIMI_CODE_HOME, "config.toml"), "utf8");',
        'const m = cfg.match(/\\[thinking\\][^[]*?effort[ \\t]*=[ \\t]*"([^"]*)"/);',
        'process.stdout.write(JSON.stringify({ type: "text", text: m ? m[1] : "none" }) + "\\n");',
      ].join("\n"),
    );
    return scriptPath;
  }

  it("the child sees the flipped effort and the file is restored on exit", async () => {
    writeConfig();
    const script = writeFakeKimi(tmpHome);
    const seen = [];
    await new Promise((resolve) => {
      runKimi({
        binary: process.execPath,
        args: [script],
        cwd: tmpHome,
        reasoningEffort: "low",
        onEvent: (ev) => seen.push(ev),
        onExit: () => resolve(),
      });
    });
    assert.deepEqual(
      seen.map((e) => e.text),
      ["low"],
      "the child must read the FLIPPED effort at startup",
    );
    assert.equal(readConfig(), CONFIG, "restored after the turn");
    assert.equal(
      fs.existsSync(`${kimiConfigPath()}.coder-effort-backup`),
      false,
    );
  });

  it("restores on FIRST output, not at exit, so long turns don't hold the flip", async () => {
    // The child prints (startup done, config already read) then lingers like
    // a real multi-minute turn. The user's config must be back while the
    // child still runs, or their own kimi launched meanwhile inherits ours.
    writeConfig();
    const script = path.join(tmpHome, "fake-kimi-linger.js");
    fs.writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({ type: "text", text: "up" }) + "\\n");\n' +
        "setTimeout(() => {}, 30000);",
    );
    let handle;
    await new Promise((resolve) => {
      handle = runKimi({
        binary: process.execPath,
        args: [script],
        cwd: tmpHome,
        reasoningEffort: "low",
        onEvent: () => resolve(),
        onExit: () => resolve(),
      });
    });
    assert.equal(
      readConfig(),
      CONFIG,
      "config must be restored while the child is still running",
    );
    handle.kill();
  });

  it("restores the config even when the spawn fails", async () => {
    writeConfig();
    await new Promise((resolve) => {
      runKimi({
        binary: path.join(tmpHome, "no-such-binary"),
        args: [],
        cwd: tmpHome,
        reasoningEffort: "max",
        onExit: () => resolve(),
      });
    });
    assert.equal(readConfig(), CONFIG);
    assert.equal(
      fs.existsSync(`${kimiConfigPath()}.coder-effort-backup`),
      false,
    );
  });

  it("touches nothing when the thread has no effort set", async () => {
    writeConfig();
    const script = writeFakeKimi(tmpHome);
    const seen = [];
    await new Promise((resolve) => {
      runKimi({
        binary: process.execPath,
        args: [script],
        cwd: tmpHome,
        reasoningEffort: null,
        onEvent: (ev) => seen.push(ev),
        onExit: () => resolve(),
      });
    });
    assert.deepEqual(
      seen.map((e) => e.text),
      ["high"],
      "no effort on the thread means the user's own default",
    );
    assert.equal(readConfig(), CONFIG);
  });
});
