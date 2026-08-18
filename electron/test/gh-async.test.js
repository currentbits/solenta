"use strict";

/**
 * Interactive gh (planboard + PR list/status/checks) must go through
 * ghTryAsync. execFileSync would freeze every window for up to 30s.
 *
 * Fake gh via CODER_GH_BIN — never PATH. node:test files run concurrently.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { fetchIssue, listIssues, setPlanStatus } = require("../issues.js");
const { listPrs, ghTryAsync } = require("../worktrees.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFakeGh(dir, body) {
  const bin = writeFakeBin(path.join(dir, "fake-gh"), body);
  process.env.CODER_GH_BIN = bin;
  return bin;
}

describe("interactive gh is async", () => {
  let tmp;
  let repo;
  let prevGh;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-gh-async-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    prevGh = process.env.CODER_GH_BIN;
  });

  afterEach(() => {
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function sleepGh(scriptAfterSleep) {
    writeFakeGh(
      tmp,
      `#!/usr/bin/env node
"use strict";
setTimeout(() => {
${scriptAfterSleep}
}, 180);
`,
    );
  }

  async function assertEventLoopFree(run) {
    let ticks = 0;
    const id = setInterval(() => {
      ticks += 1;
    }, 20);
    try {
      return await run();
    } finally {
      clearInterval(id);
      assert.ok(
        ticks >= 4,
        `event loop froze during gh (ticks=${ticks}); still on execFileSync?`,
      );
    }
  }

  it("fetchIssue does not block the event loop", async () => {
    sleepGh(`
process.stdout.write(JSON.stringify({
  number: 1, title: "T", body: "", url: "https://github.com/acme/demo/issues/1"
}));
process.exit(0);
`);
    const result = await assertEventLoopFree(() => fetchIssue(repo, "1"));
    assert.equal(result.ok, true);
    assert.equal(result.issue.number, 1);
  });

  it("listIssues does not block the event loop", async () => {
    sleepGh(`process.stdout.write("[]\\n"); process.exit(0);`);
    const result = await assertEventLoopFree(() => listIssues(repo));
    assert.deepEqual(result, { ok: true, issues: [] });
  });

  it("listPrs does not block the event loop", async () => {
    sleepGh(`process.stdout.write("[]\\n"); process.exit(0);`);
    const result = await assertEventLoopFree(() => listPrs(repo));
    assert.deepEqual(result, { ok: true, prs: [] });
  });

  it("setPlanStatus does not block the event loop", async () => {
    sleepGh(`process.exit(0);`);
    const result = await assertEventLoopFree(() =>
      setPlanStatus(repo, 5, "doing"),
    );
    assert.deepEqual(result, { ok: true });
  });

  it("in-band: gh missing / enoent", async () => {
    process.env.CODER_GH_BIN = path.join(tmp, "definitely-missing-gh");
    assert.deepEqual(await listIssues(repo), {
      ok: false,
      reason: "gh missing",
    });
    assert.deepEqual(await listPrs(repo), { ok: false, reason: "gh missing" });
    assert.deepEqual(await fetchIssue(repo, "1"), {
      ok: false,
      reason: "gh missing",
    });
    assert.deepEqual(await setPlanStatus(repo, 5, "doing"), {
      ok: false,
      reason: "gh missing",
    });
  });

  it("in-band: non-GitHub origin never spawns gh", async () => {
    git(repo, ["remote", "set-url", "origin", "https://gitlab.com/acme/demo.git"]);
    const argsPath = path.join(tmp, "gh-ran");
    writeFakeGh(
      tmp,
      `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(argsPath)}, "ran");
process.exit(0);
`,
    );
    assert.deepEqual(await listIssues(repo), {
      ok: false,
      reason: "not a GitHub repo",
    });
    assert.deepEqual(await listPrs(repo), {
      ok: false,
      reason: "not a GitHub repo",
    });
    assert.equal(fs.existsSync(argsPath), false);
  });

  it("in-band: ghTryAsync timeout is ok:false + timedOut (not a throw)", async () => {
    writeFakeGh(
      tmp,
      `#!/usr/bin/env node
setTimeout(() => process.exit(0), 30000);
`,
    );
    const started = Date.now();
    const result = await ghTryAsync(repo, ["issue", "view", "1"], {
      timeout: 80,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.enoent, false);
    assert.ok(elapsed < 5000, `timeout kill took ${elapsed}ms`);
  });
});
