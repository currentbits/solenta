const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { defaultWhich, clearWhichCache } = require("../providers.js");

// The win32 cases run on macOS by injecting the platform. What cannot be
// injected is `where` itself, so the win32 assertions cover path handling and
// the cache key; the lookup command choice is asserted via the source.

afterEach(() => {
  clearWhichCache();
});

describe("defaultWhich absolute paths", () => {
  it("accepts an existing absolute path on win32 without any PATH lookup", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "which-")),
      "claude.cmd",
    );
    fs.writeFileSync(file, "@echo off\n");
    assert.equal(defaultWhich(file, { PATH: "" }, "win32"), file);
  });

  it("rejects a missing absolute path on win32", () => {
    assert.equal(
      defaultWhich("C:\\nope\\claude.cmd", { PATH: "" }, "win32"),
      null,
    );
  });

  it("treats a backslash path as a path, not a PATH lookup", () => {
    // No throw even though `where` cannot run here: the branch never shells out.
    assert.equal(defaultWhich("bin\\claude.cmd", { PATH: "" }, "win32"), null);
  });
});

describe("defaultWhich PATH lookup", () => {
  it("finds a real binary on this platform", () => {
    const hit = defaultWhich("node", process.env);
    assert.ok(hit && hit.includes("node"), `expected a node path, got ${hit}`);
  });

  it("returns null for a binary that is not installed", () => {
    assert.equal(defaultWhich("definitely-not-a-real-binary-xyz"), null);
  });

  it("returns a single line, never `where`-style multi-line output", () => {
    const hit = defaultWhich("node", process.env);
    assert.ok(hit && !hit.includes("\n"), "result must be one path");
  });

  it("keys the cache by platform, so a win32 miss cannot poison posix", () => {
    // win32 lookup runs `where`, which does not exist here -> null, uncached.
    assert.equal(defaultWhich("node", process.env, "win32"), null);
    // The posix lookup must still find node rather than reuse that null.
    const hit = defaultWhich("node", process.env, "darwin");
    assert.ok(hit && hit.includes("node"), `platform leaked: got ${hit}`);
  });
});

describe("providers.js source hygiene", () => {
  it("uses `where` on win32 and `which` elsewhere", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "providers.js"),
      "utf8",
    );
    assert.match(src, /platform === "win32" \? "where" : "which"/);
  });

  it("contains no raw NUL byte (#441 — a NUL makes grep skip the file)", () => {
    const buf = fs.readFileSync(path.join(__dirname, "..", "providers.js"));
    assert.equal(buf.indexOf(0), -1, "raw NUL byte in providers.js");
  });
});

describe("agent CLI spawns go through cross-spawn (#442)", () => {
  // Windows installs these CLIs as .cmd shims; child_process.spawn refuses
  // to exec those, so a regression here kills every run on Windows.
  for (const file of [
    "agent.js",
    "claude.js",
    "codex.js",
    "kimi.js",
    "opencode.js",
    "commitmsg.js",
  ]) {
    it(`${file} requires cross-spawn`, () => {
      const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      assert.match(src, /require\("cross-spawn"\)/);
      assert.doesNotMatch(src, /\{\s*spawn\s*\}\s*=\s*require\("node:child_process"\)/);
    });
  }

  it("devservers.js requires cross-spawn for npm.cmd", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "devservers.js"), "utf8");
    assert.match(src, /require\("cross-spawn"\)/);
  });
});

describe("agent CLIs do not detach on win32 (#480)", () => {
  // detached:true + cross-spawn of a .cmd wrapper is CREATE_NEW_PROCESS_GROUP
  // | DETACHED_PROCESS. On Windows the parent then waits on cmd.exe (exit 0,
  // empty pipes) while the node grandchild's stdout never arrives.
  for (const file of [
    "agent.js",
    "claude.js",
    "codex.js",
    "kimi.js",
    "opencode.js",
  ]) {
    it(`${file} uses agentSpawnOptions and does not hardcode detached: true`, () => {
      const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      assert.match(src, /agentSpawnOptions/);
      assert.doesNotMatch(src, /detached:\s*true/);
    });
  }
});

describe("memory-sup.js PATH lookup", () => {
  it("uses defaultWhich (where on win32), not a raw `which`", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "memory-sup.js"), "utf8");
    assert.match(src, /defaultWhich/);
    assert.doesNotMatch(src, /execFileSync\("which"/);
  });
});
