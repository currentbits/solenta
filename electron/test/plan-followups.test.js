"use strict";

/**
 * #1501 plan card follow-ups, main side: "Save plan to file" writes into the
 * thread's checkout and never overwrites; "Implement in a new thread" forks
 * out of plan mode.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { rmTree } = require("./support/rmTree.js");

let tmpDir;
afterEach(async () => {
  if (tmpDir) await rmTree(tmpDir);
  tmpDir = null;
});

async function fixture() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-planfu-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const repo = path.join(tmpDir, "app");
  fs.mkdirSync(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, { projectId: project.id });
  return { store, repo, threadId: thread.id };
}

describe("savePlanFile (#1501)", () => {
  it("writes docs/plans/<date>-<slug>.md and refuses to overwrite it", async () => {
    const { store, repo, threadId } = await fixture();
    const plan = "## Add the Queue Card!\n\n1. Build it";
    const { path: rel } = services.savePlanFile(store, { threadId, plan });
    assert.match(rel, /^docs\/plans\/\d{4}-\d{2}-\d{2}-add-the-queue-card\.md$/);
    assert.equal(fs.readFileSync(path.join(repo, rel), "utf8"), plan + "\n");

    assert.throws(
      () => services.savePlanFile(store, { threadId, plan: plan + "\n2. More" }),
      /already exists; not overwriting/,
    );
    assert.equal(fs.readFileSync(path.join(repo, rel), "utf8"), plan + "\n");
  });

  it("writes into the thread's worktree when it has one", async () => {
    const { store, threadId } = await fixture();
    const wt = path.join(tmpDir, "wt");
    fs.mkdirSync(wt);
    store.updateThread(threadId, { worktreePath: wt });
    const { path: rel } = services.savePlanFile(store, { threadId, plan: "Plan" });
    assert.ok(fs.existsSync(path.join(wt, rel)));
  });

  it("rejects an empty plan and a remote project", async () => {
    const { store, threadId } = await fixture();
    assert.throws(() => services.savePlanFile(store, { threadId, plan: "  " }), /empty/);
    const t = store.getThread(threadId);
    store.getProject(t.projectId).remoteHost = "box";
    assert.throws(
      () => services.savePlanFile(store, { threadId, plan: "x" }),
      /remote projects/,
    );
  });
});

describe("forkThread leavePlan (#1501)", () => {
  it("starts the fork out of plan mode only when asked", async () => {
    const { store, threadId } = await fixture();
    store.updateThread(threadId, { permissionMode: "plan" });
    const kept = services.forkThread(store, { threadId });
    assert.equal(kept.permissionMode, "plan");
    const left = services.forkThread(store, { threadId, leavePlan: true });
    assert.equal(left.permissionMode, "default");
    assert.equal(left.handoffFrom, threadId);
  });
});
