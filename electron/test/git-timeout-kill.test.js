const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitTry, gitTryAsync, gitOutAsync } = require("../worktrees-git.js");
const { execCommandAsync, KILL_FALLBACK_MS } = require("../ssh.js");

// A git that ignores SIGTERM: a timeout must still settle via SIGKILL.
describe("git timeouts escalate to SIGKILL", { skip: process.platform === "win32" }, () => {
  let dir;
  let oldPath;
  const bound = 200 + KILL_FALLBACK_MS + 3000;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-git-kill-"));
    fs.writeFileSync(path.join(dir, "git"), "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n", {
      mode: 0o755,
    });
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  });

  after(() => {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gitTryAsync resolves as timed out", async () => {
    const t = Date.now();
    const res = await gitTryAsync(dir, ["status"], { timeout: 200 });
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    assert.ok(Date.now() - t < bound, `took ${Date.now() - t}ms`);
  });

  it("gitOutAsync rejects", async () => {
    const t = Date.now();
    await assert.rejects(gitOutAsync(dir, ["status"], { timeout: 200 }));
    assert.ok(Date.now() - t < bound, `took ${Date.now() - t}ms`);
  });

  it("execCommandAsync rejects", async () => {
    const t = Date.now();
    await assert.rejects(execCommandAsync(null, "git", ["status"], { timeout: 200 }));
    assert.ok(Date.now() - t < bound, `took ${Date.now() - t}ms`);
  });

  it("sync gitTry on a read-only command returns as timed out", () => {
    const t = Date.now();
    const res = gitTry(dir, ["status"], { timeout: 200 });
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    assert.ok(Date.now() - t < bound, `took ${Date.now() - t}ms`);
  });
});
