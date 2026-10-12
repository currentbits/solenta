const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  workerResultBlock,
  WORKER_RESULT_MAX,
} = require("../runner-orch-notices.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("workerResultBlock (#1427)", () => {
  let repo;
  let base;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "worker-result-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    fs.mkdirSync(path.join(repo, "core/dist"), { recursive: true });
    fs.writeFileSync(path.join(repo, "core/dist/index.js"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "base"]);
    base = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-qb", "worker"]);
  });

  afterEach(() => rmTree(repo));

  function worker(extra) {
    return {
      id: "w1",
      worktreePath: repo,
      branch: "worker",
      leadSnapshotSha: base,
      ...extra,
    };
  }

  it("includes the create mode 120000 line for a branch that adds a symlink", () => {
    git(repo, ["rm", "-rq", "core/dist"]);
    fs.mkdirSync(path.join(repo, "core"), { recursive: true });
    fs.symlinkSync("../../elsewhere/dist", path.join(repo, "core/dist"));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "symlink"]);
    const block = workerResultBlock(
      worker({
        verifyCommand: "npm test",
        verify: { ok: false, exitCode: 1, command: "npm test" },
        hypotheses: [
          { claim: "cache it", status: "invalidated", reason: "stale" },
          { claim: "kept", status: "validated" },
        ],
      }),
    );
    assert.match(block, /^\n\[worker result w1\]\n/);
    assert.match(block, /create mode 120000 core\/dist/);
    assert.match(block, /Verify: failed \(exit 1\): npm test/);
    assert.match(block, /Ruled out:\n- cache it — stale/);
    assert.doesNotMatch(block, /kept/);
    assert.ok(block.endsWith("\n[/worker result]"));
  });

  it("lists review-itinerary risks as open items", () => {
    fs.mkdirSync(path.join(repo, ".solenta/review-itinerary"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".solenta/review-itinerary/w1.json"),
      JSON.stringify({ chunks: [{ area: "ipc", risks: ["race"] }], risks: ["untested"] }),
    );
    const block = workerResultBlock(worker());
    assert.match(block, /Open review items:\n- ipc: race\n- untested/);
  });

  it("truncates the body at the cap", () => {
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(repo, `file-with-a-long-name-${i}.txt`), "y\n");
    }
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "many"]);
    const block = workerResultBlock(
      worker({
        hypotheses: Array.from({ length: 30 }, (_, i) => ({
          claim: `idea ${i} ${"z".repeat(60)}`,
          status: "invalidated",
        })),
      }),
    );
    const body = block.split("\n").slice(2, -1).join("\n");
    assert.ok(body.length <= WORKER_RESULT_MAX, `body ${body.length} chars`);
    assert.match(body, /… \(truncated\)$/);
    assert.ok(block.endsWith("\n[/worker result]"));
  });

  it("is empty when there is nothing to report", () => {
    assert.equal(workerResultBlock({ id: "w2" }), "");
  });
});
