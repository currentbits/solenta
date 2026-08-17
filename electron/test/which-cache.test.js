/**
 * defaultWhich memoises `which` hits (issue #124).
 *
 * `which` is execFileSync on the main-process event loop and runner.js calls it
 * on every run start, so N concurrent runs paid N PATH walks. Hits are cached;
 * MISSES deliberately are not, so installing a provider CLI while the app is
 * open does not require a restart.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const {
  defaultWhich,
  clearWhichCache,
} = require("../providers.js");

describe("defaultWhich caching", () => {
  beforeEach(() => {
    clearWhichCache();
  });

  it("returns the same resolved path across calls", () => {
    const first = defaultWhich("sh");
    assert.ok(first, "sh must resolve on PATH");
    assert.equal(defaultWhich("sh"), first);
  });

  it("does not re-walk PATH once a bin is resolved", () => {
    // A PATH holding exactly one fake bin, so the answer is unambiguous.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-which-"));
    const bin = path.join(dir, "coder-fake-cli");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);

    // /usr/bin:/bin stays on PATH so the `which` binary itself resolves.
    const env = { PATH: `${dir}:/usr/bin:/bin` };
    assert.equal(defaultWhich("coder-fake-cli", env), bin);

    // Remove it. A cached hit must still answer; an uncached lookup would now
    // fail, which is exactly what distinguishes the two.
    fs.rmSync(bin);
    assert.equal(
      defaultWhich("coder-fake-cli", env),
      bin,
      "resolved path must come from the cache, not a fresh PATH walk",
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT cache a miss, so a later install is picked up", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-which-miss-"));
    const env = { PATH: `${dir}:/usr/bin:/bin` };

    assert.equal(defaultWhich("coder-later-cli", env), null);

    // Install it after the miss — no restart, no cache clear.
    const bin = path.join(dir, "coder-later-cli");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);

    assert.equal(
      defaultWhich("coder-later-cli", env),
      bin,
      "a miss must not be cached",
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keys the cache on PATH, not just the bin name", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "coder-which-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "coder-which-b-"));
    for (const dir of [a, b]) {
      const bin = path.join(dir, "coder-dup-cli");
      fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(bin, 0o755);
    }

    assert.equal(
      defaultWhich("coder-dup-cli", { PATH: `${a}:/usr/bin:/bin` }),
      path.join(a, "coder-dup-cli"),
    );
    assert.equal(
      defaultWhich("coder-dup-cli", { PATH: `${b}:/usr/bin:/bin` }),
      path.join(b, "coder-dup-cli"),
      "a different PATH must not reuse the first PATH's answer",
    );

    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });

  it("still resolves an explicit path without consulting PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-which-abs-"));
    const bin = path.join(dir, "direct-cli");
    fs.writeFileSync(bin, "");
    assert.equal(defaultWhich(bin, { PATH: "" }), bin);
    assert.equal(defaultWhich(path.join(dir, "missing-cli"), { PATH: "" }), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
