"use strict";

/**
 * Round 50: worktree turn checkpoints.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  setupWorktree,
  maybeCreateCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  CHECKPOINT_SUBJECT_PREFIX,
} = require("../worktrees.js");
const { createRunner } = require("../runner.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function loadCore() {
  return import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
}

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function fakeAgentSuccessScript() {
  return "process.stdout.write('Hello');setTimeout(()=>{process.stdout.write('_ok');setTimeout(()=>process.exit(0),40)},40)";
}

function fakeAgentFailScript() {
  return "process.stderr.write('nope');process.exit(1)";
}

/**
 * Real project + worktree fixture (same shape as worktrees.test.js).
 */
async function makeWorktreeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-ckpt-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const worktreeBase = path.join(tmpDir, "worktrees");
  const repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  try {
    git(repo, ["checkout", "-b", "main"]);
  } catch {
    // already on main
  }
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, {
    projectId: project.id,
    title: "Checkpoint thread",
  });
  const setup = setupWorktree({
    store,
    threadId: thread.id,
    worktreeBase,
    broadcast: () => {},
  });
  return {
    tmpDir,
    store,
    project,
    thread: store.getThread(thread.id),
    worktreePath: setup.worktreePath,
    worktreeBase,
  };
}

describe("maybeCreateCheckpoint", () => {
  let fx;

  afterEach(() => {
    if (fx) {
      try {
        fs.rmSync(fx.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      fx = null;
    }
  });

  it("auto-commits when worktree is dirty; N increments across turns", async () => {
    fx = await makeWorktreeFixture();
    const wt = fx.worktreePath;

    fs.writeFileSync(path.join(wt, "a.txt"), "one\n");
    const c1 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    assert.ok(c1);
    assert.equal(c1.turn, 1);
    assert.equal(c1.message, `${CHECKPOINT_SUBJECT_PREFIX}1`);
    assert.ok(c1.sha && c1.sha.length >= 7);

    // clean → skip
    const skip = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    assert.equal(skip, null);

    fs.writeFileSync(path.join(wt, "b.txt"), "two\n");
    const c2 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    assert.ok(c2);
    assert.equal(c2.turn, 2);
    assert.equal(c2.message, `${CHECKPOINT_SUBJECT_PREFIX}2`);

    const log = git(wt, ["log", "--oneline"]);
    assert.ok(log.includes("coder-checkpoint: turn 1"));
    assert.ok(log.includes("coder-checkpoint: turn 2"));
  });

  it("skips when thread has no worktree", async () => {
    fx = await makeWorktreeFixture();
    const bare = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "No wt",
    });
    assert.equal(bare.worktreePath, null);
    const r = await maybeCreateCheckpoint(fx.store, bare.id);
    assert.equal(r, null);
  });

  it("checkpoint failure does not throw (best-effort)", async () => {
    fx = await makeWorktreeFixture();
    // Point worktreePath at a non-git directory so git fails.
    const junk = path.join(fx.tmpDir, "not-a-git");
    fs.mkdirSync(junk);
    fs.writeFileSync(path.join(junk, "x.txt"), "x");
    fx.store.updateThread(fx.thread.id, { worktreePath: junk });
    fx.store.saveNow();
    const r = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    assert.equal(r, null);
  });
});

describe("listCheckpoints / restoreCheckpoint", () => {
  let fx;

  afterEach(() => {
    if (fx) {
      try {
        fs.rmSync(fx.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      fx = null;
    }
  });

  it("list is newest-first with correct turn/at; empty without worktree", async () => {
    fx = await makeWorktreeFixture();
    assert.deepEqual(
      await listCheckpoints({ store: fx.store, threadId: fx.thread.id }),
      [],
    );

    fs.writeFileSync(path.join(fx.worktreePath, "a.txt"), "1\n");
    await maybeCreateCheckpoint(fx.store, fx.thread.id);
    await new Promise((r) => setTimeout(r, 1100)); // ensure distinct committer times if needed
    fs.writeFileSync(path.join(fx.worktreePath, "b.txt"), "2\n");
    await maybeCreateCheckpoint(fx.store, fx.thread.id);

    const list = await listCheckpoints({
      store: fx.store,
      threadId: fx.thread.id,
    });
    assert.equal(list.length, 2);
    assert.equal(list[0].turn, 2, "newest first");
    assert.equal(list[1].turn, 1);
    assert.equal(list[0].message, "coder-checkpoint: turn 2");
    assert.ok(list[0].sha);
    assert.ok(typeof list[0].at === "number" && list[0].at > 0);

    const bare = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Bare",
    });
    assert.deepEqual(
      await listCheckpoints({ store: fx.store, threadId: bare.id }),
      [],
    );
  });

  it("restore guard table in order + foreign-sha + file content proof", async () => {
    fx = await makeWorktreeFixture();
    const wt = fx.worktreePath;
    const file = path.join(wt, "tracked.txt");

    fs.writeFileSync(file, "v1\n");
    const c1 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    fs.writeFileSync(file, "v2\n");
    const c2 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    assert.equal(fs.readFileSync(file, "utf8"), "v2\n");

    // 1) unknown thread
    await assert.rejects(
      () =>
        restoreCheckpoint({
          store: fx.store,
          threadId: "nope",
          sha: c1.sha,
        }),
      /Unknown thread: nope/,
    );

    // 2) run active
    await assert.rejects(
      () =>
        restoreCheckpoint({
          store: fx.store,
          threadId: fx.thread.id,
          sha: c1.sha,
          isRunning: () => true,
        }),
      /Cannot restore a checkpoint while a run is active/,
    );

    // 3) no worktree
    const bare = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Bare",
    });
    await assert.rejects(
      () =>
        restoreCheckpoint({
          store: fx.store,
          threadId: bare.id,
          sha: c1.sha,
        }),
      new RegExp(
        `Thread ${bare.id} has no worktree; call setupWorktree first`,
      ),
    );

    // 4) foreign sha — not in this thread's checkpoint list
    assert.ok(c1.sha && c1.sha.length >= 7, "c1 must record a real sha");
    assert.ok(c2.sha && c2.sha.length >= 7, "c2 must record a real sha");
    const foreign = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    await assert.rejects(
      () =>
        restoreCheckpoint({
          store: fx.store,
          threadId: fx.thread.id,
          sha: foreign,
        }),
      (err) => {
        assert.equal(String(err.message), `Unknown checkpoint: ${foreign}`);
        return true;
      },
    );

    // 5) resolvable non-checkpoint sha (init commit) — subject-validation alone
    const initSha = git(wt, ["rev-list", "--max-parents=0", "HEAD"]);
    assert.ok(initSha && initSha.length >= 7);
    assert.notEqual(initSha, c1.sha);
    assert.notEqual(initSha, c2.sha);
    await assert.rejects(
      () =>
        restoreCheckpoint({
          store: fx.store,
          threadId: fx.thread.id,
          sha: initSha,
        }),
      (err) => {
        assert.equal(String(err.message), `Unknown checkpoint: ${initSha}`);
        return true;
      },
    );

    // restore turn 1 content while still at turn 2 (both HEAD-reachable)
    const list = await listCheckpoints({
      store: fx.store,
      threadId: fx.thread.id,
    });
    assert.ok(
      list.some((c) => c.sha === c1.sha),
      `c1.sha ${c1.sha} must appear in ${JSON.stringify(list)}`,
    );
    await restoreCheckpoint({
      store: fx.store,
      threadId: fx.thread.id,
      sha: c1.sha,
    });
    assert.equal(fs.readFileSync(file, "utf8"), "v1\n");

    // After restore to turn 1, turn 2 is off-HEAD — must be rejected by list membership
    const afterRestore = await listCheckpoints({
      store: fx.store,
      threadId: fx.thread.id,
    });
    assert.equal(afterRestore.length, 1);
    assert.equal(afterRestore[0].turn, 1);
    await assert.rejects(
      () =>
        restoreCheckpoint({
          store: fx.store,
          threadId: fx.thread.id,
          sha: c2.sha,
        }),
      (err) => {
        assert.equal(String(err.message), `Unknown checkpoint: ${c2.sha}`);
        return true;
      },
    );
  });

  it("A-B1: sibling-thread checkpoint sha is rejected (shared object DB)", async () => {
    // Two worktrees of one project share objects — git log -1 <t2sha> in t1
    // would resolve. Membership in THIS thread's listCheckpoints must refuse.
    fx = await makeWorktreeFixture();
    const t1 = fx.thread;
    const t2 = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Sibling",
    });
    const setup2 = setupWorktree({
      store: fx.store,
      threadId: t2.id,
      worktreeBase: fx.worktreeBase,
      broadcast: () => {},
    });

    fs.writeFileSync(path.join(fx.worktreePath, "f.txt"), "t1 only\n");
    const c1 = await maybeCreateCheckpoint(fx.store, t1.id);
    assert.ok(c1 && c1.sha);

    fs.writeFileSync(path.join(setup2.worktreePath, "other.txt"), "t2 only\n");
    const c2 = await maybeCreateCheckpoint(fx.store, t2.id);
    assert.ok(c2 && c2.sha);
    assert.notEqual(c1.sha, c2.sha);

    // t1 must refuse t2's checkpoint sha by name
    await assert.rejects(
      () =>
        restoreCheckpoint({
          store: fx.store,
          threadId: t1.id,
          sha: c2.sha,
        }),
      (err) => {
        assert.equal(String(err.message), `Unknown checkpoint: ${c2.sha}`);
        return true;
      },
    );

    // t1 files unchanged (no data loss)
    assert.equal(
      fs.readFileSync(path.join(fx.worktreePath, "f.txt"), "utf8"),
      "t1 only\n",
    );
    assert.equal(
      fs.existsSync(path.join(fx.worktreePath, "other.txt")),
      false,
      "t1 must not gain t2's other.txt",
    );

    // t1 can still restore its own checkpoint
    await restoreCheckpoint({
      store: fx.store,
      threadId: t1.id,
      sha: c1.sha,
    });
    assert.equal(
      fs.readFileSync(path.join(fx.worktreePath, "f.txt"), "utf8"),
      "t1 only\n",
    );
  });

  it("A-n3: restore then new dirty turn renumbers from list length (turn 2, fresh sha)", async () => {
    fx = await makeWorktreeFixture();
    const wt = fx.worktreePath;
    const file = path.join(wt, "n.txt");

    fs.writeFileSync(file, "t1\n");
    const c1 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    fs.writeFileSync(file, "t2\n");
    const c2 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    assert.equal(c2.turn, 2);

    await restoreCheckpoint({
      store: fx.store,
      threadId: fx.thread.id,
      sha: c1.sha,
    });
    let list = await listCheckpoints({
      store: fx.store,
      threadId: fx.thread.id,
    });
    assert.deepEqual(
      list.map((c) => c.turn),
      [1],
      "after restore to turn 1, only turn 1 is HEAD-reachable",
    );

    fs.writeFileSync(file, "t2-fresh\n");
    const c2b = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    assert.ok(c2b);
    assert.equal(c2b.turn, 2, "next turn reuses number 2, not 3");
    assert.notEqual(c2b.sha, c2.sha, "fresh sha, not the discarded turn-2 object");

    list = await listCheckpoints({
      store: fx.store,
      threadId: fx.thread.id,
    });
    assert.deepEqual(
      list.map((c) => c.turn),
      [2, 1],
    );
    assert.equal(list[0].sha, c2b.sha);
  });

  it("checkpoints uncommitted work before the reset (issue #132)", async () => {
    fx = await makeWorktreeFixture();
    const wt = fx.worktreePath;
    const file = path.join(wt, "tracked.txt");

    fs.writeFileSync(file, "v1\n");
    const c1 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    fs.writeFileSync(file, "v2\n");
    await maybeCreateCheckpoint(fx.store, fx.thread.id);

    // Work that never got a post-turn checkpoint: an edit + an untracked file.
    fs.writeFileSync(file, "unsaved\n");
    fs.writeFileSync(path.join(wt, "scratch.txt"), "hand-written\n");

    await restoreCheckpoint({
      store: fx.store,
      threadId: fx.thread.id,
      sha: c1.sha,
    });

    // Reset happened...
    assert.equal(fs.readFileSync(file, "utf8"), "v1\n");
    assert.equal(fs.existsSync(path.join(wt, "scratch.txt")), false);

    // ...but the work survives in a commit, not in the void.
    const rescued = git(wt, ["log", "-g", "--format=%H %s"])
      .split("\n")
      .find((l) => l.includes("coder-checkpoint: turn 3"));
    assert.ok(rescued, "safety checkpoint must exist in the reflog");
    const sha = rescued.split(" ")[0];
    assert.equal(git(wt, ["show", `${sha}:tracked.txt`]), "unsaved");
    assert.equal(git(wt, ["show", `${sha}:scratch.txt`]), "hand-written");
  });

  it("clean worktree restore adds no safety checkpoint", async () => {
    fx = await makeWorktreeFixture();
    const file = path.join(fx.worktreePath, "c.txt");

    fs.writeFileSync(file, "v1\n");
    const c1 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    fs.writeFileSync(file, "v2\n");
    await maybeCreateCheckpoint(fx.store, fx.thread.id);

    const head = git(fx.worktreePath, ["rev-parse", "HEAD"]);
    await restoreCheckpoint({
      store: fx.store,
      threadId: fx.thread.id,
      sha: c1.sha,
    });
    assert.equal(
      git(fx.worktreePath, ["log", "--format=%s", `${head}..`]),
      "",
      "nothing to save → no commit on top of turn 2",
    );
  });
});

describe("runner auto-checkpoint on successful turn", () => {
  let fx;
  let runner;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    fx = await makeWorktreeFixture();
    const core = await loadCore();
    runner = createRunner({
      store: fx.store,
      core,
      pushFn: () => {},
      tickMs: 15,
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    if (fx) {
      try {
        fs.rmSync(fx.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      fx = null;
    }
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("successful dirty turn creates a checkpoint; clean turn does not; failure does not", async () => {
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSuccessScript()}`;

    // Dirty the worktree before the agent runs (agent itself doesn't need to edit).
    fs.writeFileSync(path.join(fx.worktreePath, "agent-edit.txt"), "from turn\n");

    await runner.startRun({
      threadId: fx.thread.id,
      prompt: "do work",
    });
    await waitFor(() => {
      const t = fx.store.getThread(fx.thread.id);
      return t && t.status === "done";
    });
    // Checkpoint is fire-and-forget async — poll until the commit appears.
    await waitFor(() => {
      try {
        const log = git(fx.worktreePath, [
          "log",
          "--grep=coder-checkpoint:",
          "--oneline",
        ]);
        return /coder-checkpoint: turn 1/.test(log);
      } catch {
        return false;
      }
    });

    let list = await listCheckpoints({
      store: fx.store,
      threadId: fx.thread.id,
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].turn, 1);

    // Clean worktree success → no new checkpoint
    await runner.startRun({
      threadId: fx.thread.id,
      prompt: "noop clean",
    });
    await waitFor(() => {
      const t = fx.store.getThread(fx.thread.id);
      return t && t.status === "done" && !runner.isRunning(fx.thread.id);
    });
    await new Promise((r) => setTimeout(r, 200));
    list = await listCheckpoints({
      store: fx.store,
      threadId: fx.thread.id,
    });
    assert.equal(list.length, 1, "clean success must not add a checkpoint");

    // Failed turn with dirty tree still does not checkpoint (only done path).
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentFailScript()}`;
    fs.writeFileSync(path.join(fx.worktreePath, "fail-edit.txt"), "x\n");
    await runner.startRun({
      threadId: fx.thread.id,
      prompt: "will fail",
    });
    await waitFor(() => {
      const t = fx.store.getThread(fx.thread.id);
      return t && t.status === "failed";
    });
    await new Promise((r) => setTimeout(r, 200));
    list = await listCheckpoints({
      store: fx.store,
      threadId: fx.thread.id,
    });
    assert.equal(list.length, 1, "failed turn must not checkpoint");
  });
});

describe("IPC seam git checkpoints", () => {
  it("preload exposes list/restore and main registers channels", () => {
    const Module = require("module");
    const handlers = new Map();
    const bridge = {};
    const electronStub = {
      ipcMain: {
        handle(channel, fn) {
          handlers.set(channel, fn);
        },
      },
      contextBridge: {
        exposeInMainWorld(name, api) {
          bridge[name] = api;
        },
      },
      ipcRenderer: {
        invoke: async () => null,
        on: () => {},
      },
    };
    const orig = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === "electron") return electronStub;
      return orig.apply(this, arguments);
    };
    try {
      delete require.cache[require.resolve("../ipc.js")];
      delete require.cache[require.resolve("../preload.js")];
      const { registerIpc } = require("../ipc.js");
      const s = new Store(
        path.join(os.tmpdir(), `coder-ckpt-ipc-${Date.now()}.json`),
      );
      registerIpc({
        ipcMain: electronStub.ipcMain,
        dialog: {},
        store: s,
        runner: {
          start() {},
          stop() {},
          stopAll() {},
          isRunning: () => false,
        },
        broadcast() {},
        worktreeBase: os.tmpdir(),
        userDataPath: os.tmpdir(),
      });
      require("../preload.js");
      assert.equal(typeof bridge.coder.git.listCheckpoints, "function");
      assert.equal(typeof bridge.coder.git.restoreCheckpoint, "function");
      assert.ok(handlers.has("git:listCheckpoints"));
      assert.ok(handlers.has("git:restoreCheckpoint"));
    } finally {
      Module.prototype.require = orig;
      delete require.cache[require.resolve("../ipc.js")];
      delete require.cache[require.resolve("../preload.js")];
    }
  });
});

describe("r49 cleanup riders", () => {
  it("dead services exports are gone; THREAD_TITLE_MAX remains", () => {
    assert.equal(typeof services.THREAD_TITLE_MAX, "number");
    assert.equal(services.normalizeModelForProvider, undefined);
    assert.equal(services.isKnownProviderId, undefined);
    assert.equal(services.truncateThreadTitle, undefined);
  });
});
