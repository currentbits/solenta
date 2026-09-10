/**
 * #346 numbered lanes, per-lane ports, preview mirror, wedged recycle.
 * Promote stays human-only; the queue still does not close issues itself.
 *
 * Run: node --test electron/test/merge-queue-lanes.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const issues = require("../issues.js");
const {
  enqueue,
  integrateNext,
  claimLane,
  listLanes,
  lanePort,
  laneEnv,
  heartbeatLane,
  previewLane,
  restorePreview,
  recycleWedgedLanes,
  DEFAULT_PORT_BASE,
  DEFAULT_WEDGE_MS,
} = require("../mergeQueue.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function head(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]);
}

function installCompleteSpy() {
  const orig = issues.completeIssue;
  const seen = [];
  issues.completeIssue = async (projectPath, number, opts) => {
    seen.push({ projectPath, number, comment: opts && opts.comment });
    return { ok: true };
  };
  return {
    seen,
    restore() {
      issues.completeIssue = orig;
    },
  };
}

describe("merge queue lanes (#346)", () => {
  let tmpDir;
  let store;
  let project;
  let worktreeBase;
  let spy;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-lanes-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    project = await services.addProject(store, repo);
    store.save();
    spy = installCompleteSpy();
  });

  afterEach(() => {
    if (spy) spy.restore();
    try {
      for (const t of store.getThreads()) {
        if (t && t.worktreePath && fs.existsSync(t.worktreePath)) {
          try {
            git(project.path, ["worktree", "remove", "--force", t.worktreePath]);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeThread(title) {
    const thread = services.createThread(store, {
      projectId: project.id,
      title,
    });
    store.save();
    return store.getThread(thread.id);
  }

  it("assigns PORT as portBase + lane number", () => {
    assert.equal(lanePort(1), DEFAULT_PORT_BASE + 1);
    assert.equal(lanePort(2, 5170), 5172);
    assert.throws(() => lanePort(0), /lane/i);
    assert.throws(() => lanePort(1, 0), /port/i);
    assert.deepEqual(laneEnv(3, 4000), {
      PORT: "4003",
      SOLENTA_LANE: "3",
    });
  });

  it("claims the lowest free numbered lane with a matching branch and port", () => {
    const a = makeThread("A");
    const b = makeThread("B");
    const first = claimLane({
      store,
      threadId: a.id,
      worktreeBase,
      portBase: 3000,
      now: 1_000,
    });
    const second = claimLane({
      store,
      threadId: b.id,
      worktreeBase,
      portBase: 3000,
      now: 2_000,
    });

    assert.equal(first.n, 1);
    assert.equal(first.port, 3001);
    assert.equal(first.branch, "lane/1");
    assert.equal(
      first.path,
      path.join(worktreeBase, "app-lane-1"),
    );
    assert.ok(fs.existsSync(path.join(first.path, "README.md")));
    assert.equal(store.getThread(a.id).worktreePath, first.path);
    assert.equal(store.getThread(a.id).branch, "lane/1");
    assert.equal(store.getThread(a.id).lane.n, 1);
    assert.equal(store.getThread(a.id).lane.port, 3001);

    assert.equal(second.n, 2);
    assert.equal(second.port, 3002);
    assert.equal(second.branch, "lane/2");
    assert.equal(second.path, path.join(worktreeBase, "app-lane-2"));

    const lanes = listLanes(store, project.id);
    assert.deepEqual(
      lanes.map((l) => ({ n: l.n, threadId: l.threadId, port: l.port })),
      [
        { n: 1, threadId: a.id, port: 3001 },
        { n: 2, threadId: b.id, port: 3002 },
      ],
    );
  });

  it("reuses a recycled lane number instead of growing forever", () => {
    const a = makeThread("A");
    const b = makeThread("B");
    claimLane({ store, threadId: a.id, worktreeBase, now: 0 });
    claimLane({ store, threadId: b.id, worktreeBase, now: 0 });

    recycleWedgedLanes({
      store,
      projectId: project.id,
      now: DEFAULT_WEDGE_MS + 1,
    });

    const c = makeThread("C");
    const again = claimLane({
      store,
      threadId: c.id,
      worktreeBase,
      now: DEFAULT_WEDGE_MS + 2,
    });
    assert.equal(again.n, 1);
    assert.equal(again.branch, "lane/1");
    assert.equal(again.path, path.join(worktreeBase, "app-lane-1"));
  });

  it("mirrors a lane onto the main checkout and restores it", () => {
    const a = makeThread("A");
    const lane = claimLane({
      store,
      threadId: a.id,
      worktreeBase,
      now: 1_000,
    });
    fs.writeFileSync(path.join(lane.path, "feature.js"), "export const n = 1;\n");
    fs.mkdirSync(path.join(lane.path, "dist"), { recursive: true });
    fs.writeFileSync(path.join(lane.path, "dist", "bundle.js"), "built\n");
    const mainBefore = head(project.path);

    const preview = previewLane({ store, projectId: project.id, lane: 1 });
    assert.equal(preview.lane, 1);
    assert.equal(
      fs.readFileSync(path.join(project.path, "feature.js"), "utf8"),
      "export const n = 1;\n",
    );
    assert.equal(
      fs.existsSync(path.join(project.path, "dist", "bundle.js")),
      false,
      "preview must not copy build output dirs",
    );
    assert.equal(head(project.path), mainBefore, "preview is a file mirror, not a commit");

    restorePreview({ store, projectId: project.id });
    assert.equal(fs.existsSync(path.join(project.path, "feature.js")), false);
    assert.equal(head(project.path), mainBefore);
    assert.equal(git(project.path, ["status", "--porcelain"]), "");
  });

  it("refuses to preview over a dirty main checkout", () => {
    const a = makeThread("A");
    claimLane({ store, threadId: a.id, worktreeBase, now: 1_000 });
    fs.writeFileSync(path.join(project.path, "dirty.txt"), "nope\n");
    assert.throws(
      () => previewLane({ store, projectId: project.id, lane: 1 }),
      /dirty|uncommitted|checkout/i,
    );
    assert.equal(
      fs.readFileSync(path.join(project.path, "dirty.txt"), "utf8"),
      "nope\n",
    );
  });

  it("recycles a wedged lane without closing issues or moving main", async () => {
    const a = makeThread("A");
    store.updateThread(a.id, { issueNumber: 123 });
    store.save();
    const lane = claimLane({
      store,
      threadId: a.id,
      worktreeBase,
      now: 1_000,
    });
    fs.writeFileSync(path.join(lane.path, "stuck.js"), "stuck\n");
    const mainBefore = head(project.path);

    const stillHeld = recycleWedgedLanes({
      store,
      projectId: project.id,
      now: 1_000 + DEFAULT_WEDGE_MS - 1,
    });
    assert.equal(stillHeld.length, 0);
    assert.equal(store.getThread(a.id).lane.n, 1);
    assert.ok(fs.existsSync(lane.path));

    heartbeatLane({ store, threadId: a.id, now: 1_000 + 5_000 });
    const afterBeat = recycleWedgedLanes({
      store,
      projectId: project.id,
      now: 1_000 + 5_000 + DEFAULT_WEDGE_MS - 1,
    });
    assert.equal(afterBeat.length, 0);

    const recycled = recycleWedgedLanes({
      store,
      projectId: project.id,
      now: 1_000 + 5_000 + DEFAULT_WEDGE_MS,
    });
    assert.deepEqual(
      recycled.map((r) => r.n),
      [1],
    );
    const after = store.getThread(a.id);
    assert.equal(after.lane, undefined);
    assert.equal(after.worktreePath, null);
    assert.equal(after.branch, null);
    assert.equal(fs.existsSync(lane.path), false);
    assert.equal(head(project.path), mainBefore);
    assert.deepEqual(spy.seen.map((c) => c.number), []);
  });

  it("integrateNext releases the worker lane without closing issues", () => {
    const lead = makeThread("Lead");
    claimLane({ store, threadId: lead.id, worktreeBase, now: 1 });
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    store.updateThread(worker.id, {
      title: "A",
      status: "done",
      issueNumber: 99,
    });
    store.save();
    const claimed = claimLane({
      store,
      threadId: worker.id,
      worktreeBase,
      now: 2,
    });
    fs.writeFileSync(path.join(claimed.path, "a.txt"), "a\n");
    git(claimed.path, ["add", "-A"]);
    git(claimed.path, ["commit", "-m", "add a"]);

    enqueue(store, { leadThreadId: lead.id, workerThreadId: worker.id });
    integrateNext({ store, leadThreadId: lead.id, broadcast: () => {} });

    const after = store.getThread(worker.id);
    assert.equal(after.lane, undefined);
    assert.equal(after.worktreePath, null);
    assert.deepEqual(spy.seen.map((c) => c.number), []);
    const next = makeThread("Next");
    const reused = claimLane({
      store,
      threadId: next.id,
      worktreeBase,
      now: 3,
    });
    assert.equal(reused.n, claimed.n);
  });
});
