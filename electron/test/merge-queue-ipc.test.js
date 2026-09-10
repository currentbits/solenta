/**
 * #346 product surface: merge-queue IPC + CoderApi + laneEnv on
 * devserver:start. Handlers call the existing mergeQueue module.
 * Recycle never closes issues.
 *
 * Run: node --test electron/test/merge-queue-ipc.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const Module = require("node:module");

// ipc.js requires('electron') at load time. Stub before the first require.
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") {
    return {
      BrowserWindow: { getAllWindows: () => [] },
      shell: {},
      nativeTheme: { themeSource: "system" },
      ipcMain: { handle() {} },
      dialog: {},
      app: { getPath: () => os.tmpdir() },
    };
  }
  return origLoad.apply(this, arguments);
};

const { Store } = require("../store.js");
const services = require("../services.js");
const issues = require("../issues.js");
const { IPC_HANDLERS } = require("../ipc.js");
const { DEFAULT_WEDGE_MS, DEFAULT_PORT_BASE } = require("../mergeQueue.js");
const devservers = require("../devservers.js");

const CHANNELS = [
  "mergeQueue:claimLane",
  "mergeQueue:listLanes",
  "mergeQueue:previewLane",
  "mergeQueue:restorePreview",
  "mergeQueue:recycleWedgedLanes",
];

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

describe("merge queue IPC (#346 product surface)", () => {
  let tmpDir;
  let store;
  let project;
  let worktreeBase;
  let ctx;
  let spy;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mq-ipc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "app", scripts: { dev: "vite" } }),
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);

    project = await services.addProject(store, repo);
    store.save();
    ctx = { store, worktreeBase, broadcast() {} };
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

  it("registers claim, list, preview, restore, and recycle handlers", () => {
    for (const ch of CHANNELS) {
      assert.equal(typeof IPC_HANDLERS[ch], "function", ch);
    }
  });

  it("lists the new channels on the CoderApi table", async () => {
    const { IPC_CHANNELS, ipcChannelName } = await import(
      pathToFileURL(path.join(__dirname, "../../src/shared/ipcChannels.ts")).href
    );
    const table = new Set(IPC_CHANNELS.map(ipcChannelName));
    for (const ch of CHANNELS) {
      assert.ok(table.has(ch), `IPC_CHANNELS missing ${ch}`);
    }
  });

  it("claims a numbered lane and lists it with portBase + n", async () => {
    const thread = makeThread("Lead");
    const claimed = await IPC_HANDLERS["mergeQueue:claimLane"](ctx, {
      threadId: thread.id,
    });
    assert.equal(claimed.n, 1);
    assert.equal(claimed.port, DEFAULT_PORT_BASE + 1);
    assert.equal(claimed.branch, "lane/1");
    assert.equal(claimed.path, path.join(worktreeBase, "app-lane-1"));
    assert.ok(fs.existsSync(path.join(claimed.path, "README.md")));

    const lanes = await IPC_HANDLERS["mergeQueue:listLanes"](ctx, {
      projectId: project.id,
    });
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].n, 1);
    assert.equal(lanes[0].threadId, thread.id);
    assert.equal(lanes[0].port, DEFAULT_PORT_BASE + 1);
  });

  it("previews a lane onto main and restores it", async () => {
    const thread = makeThread("Lead");
    const claimed = await IPC_HANDLERS["mergeQueue:claimLane"](ctx, {
      threadId: thread.id,
    });
    fs.writeFileSync(path.join(claimed.path, "feature.js"), "export const n = 1;\n");
    const mainBefore = head(project.path);

    const preview = await IPC_HANDLERS["mergeQueue:previewLane"](ctx, {
      projectId: project.id,
      lane: 1,
    });
    assert.equal(preview.lane, 1);
    assert.equal(
      fs.readFileSync(path.join(project.path, "feature.js"), "utf8"),
      "export const n = 1;\n",
    );

    const restored = await IPC_HANDLERS["mergeQueue:restorePreview"](ctx, {
      projectId: project.id,
    });
    assert.equal(restored.restored, true);
    assert.equal(fs.existsSync(path.join(project.path, "feature.js")), false);
    assert.equal(head(project.path), mainBefore);
  });

  it("recycles a wedged lane without closing issues or moving main", async () => {
    const thread = makeThread("Stuck");
    store.updateThread(thread.id, { issueNumber: 346 });
    store.save();
    const claimed = await IPC_HANDLERS["mergeQueue:claimLane"](ctx, {
      threadId: thread.id,
    });
    const live = store.getThread(thread.id);
    store.updateThread(thread.id, {
      lane: { ...live.lane, lastBeat: 1, claimedAt: 1 },
    });
    store.save();
    const mainBefore = head(project.path);

    const recycled = await IPC_HANDLERS["mergeQueue:recycleWedgedLanes"](ctx, {
      projectId: project.id,
    });
    assert.deepEqual(
      recycled.map((r) => r.n),
      [1],
    );
    const after = store.getThread(thread.id);
    assert.equal(after.lane, undefined);
    assert.equal(after.worktreePath, null);
    assert.equal(fs.existsSync(claimed.path), false);
    assert.equal(head(project.path), mainBefore);
    assert.deepEqual(spy.seen.map((c) => c.number), []);
  });

  it("starts a claimed lane's dev server with laneEnv PORT", async () => {
    const thread = makeThread("Lead");
    await IPC_HANDLERS["mergeQueue:claimLane"](ctx, {
      threadId: thread.id,
    });
    const calls = [];
    const orig = devservers.start;
    devservers.start = (threadId, root, script, opts) => {
      calls.push({ threadId, root, script, opts });
      return { running: true, script };
    };
    try {
      await IPC_HANDLERS["devserver:start"](ctx, {
        threadId: thread.id,
        script: "dev",
      });
    } finally {
      devservers.start = orig;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].script, "dev");
    const env = calls[0].opts && calls[0].opts.env;
    assert.equal(env.PORT, String(DEFAULT_PORT_BASE + 1));
    assert.equal(env.SOLENTA_LANE, "1");
  });

  it("does not expose a second issue closer on the mergeQueue surface", () => {
    const src = fs.readFileSync(path.join(__dirname, "../ipc.js"), "utf8");
    assert.equal(
      /completeThreadIssue|completeIssue/.test(src),
      false,
      "ipc.js must not grow a second closer for lanes",
    );
    assert.equal(typeof IPC_HANDLERS["mergeQueue:completeIssue"], "undefined");
    assert.ok(DEFAULT_WEDGE_MS > 0);
  });
});
