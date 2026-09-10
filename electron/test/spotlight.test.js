/**
 * #250 stretch (Conductor Spotlight): per-repo opt-in so ONE heavy app
 * instance at the project checkout hot-swaps which claimed lane it
 * serves. Mirrors through previewLane / restorePreview — no second
 * closer. Promote stays git.mergeWorktree. Recycle stays
 * recycleWedgedLanes (heartbeat-stale only).
 *
 * Run: node --test electron/test/spotlight.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const Module = require("node:module");

const { Store } = require("../store.js");
const services = require("../services.js");
const {
  claimLane,
  listLanes,
  laneEnv,
  previewLane,
  restorePreview,
  recycleWedgedLanes,
  setSpotlight,
  spotlightLane,
} = require("../mergeQueue.js");
const devservers = require("../devservers.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function stubElectron() {
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
  return () => {
    Module._load = origLoad;
  };
}

describe("Conductor Spotlight (#250 stretch)", () => {
  let tmpDir;
  let store;
  let project;
  let a;
  let b;
  let ctx;
  let origStart;
  /** @type {object[]} */
  let starts;
  let unstub;

  beforeEach(async () => {
    unstub = stubElectron();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-spotlight-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    project = await services.addProject(store, repo);
    a = services.createThread(store, { projectId: project.id, title: "Lane A" });
    b = services.createThread(store, { projectId: project.id, title: "Lane B" });
    ctx = {
      store,
      userDataPath: tmpDir,
      worktreeBase: path.join(tmpDir, "worktrees"),
      broadcast() {},
    };
    claimLane({ store, threadId: a.id, worktreeBase: ctx.worktreeBase });
    claimLane({ store, threadId: b.id, worktreeBase: ctx.worktreeBase });
    const lanes = listLanes(store, project.id);
    fs.writeFileSync(path.join(lanes[0].path, "from-a.txt"), "A\n");
    fs.writeFileSync(path.join(lanes[1].path, "from-b.txt"), "B\n");
    starts = [];
    origStart = devservers.start;
    devservers.start = (threadId, root, script, opts) => {
      starts.push({ threadId, root, script, opts });
      return { running: false };
    };
  });

  afterEach(() => {
    devservers.start = origStart;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    unstub();
  });

  it("spotlightLane throws when the project has not opted in", () => {
    assert.equal(typeof spotlightLane, "function");
    assert.equal(store.getProject(project.id).spotlight, undefined);
    assert.throws(
      () => spotlightLane({ store, projectId: project.id, lane: 1 }),
      { message: /Spotlight is off/ },
    );
    assert.equal(
      fs.existsSync(path.join(project.path, "from-a.txt")),
      false,
      "must not mirror without opt-in",
    );
  });

  it("setSpotlight persists a per-repo opt-in and clears it", () => {
    const on = setSpotlight({
      store,
      projectId: project.id,
      enabled: true,
    });
    assert.equal(on.spotlight, true);
    assert.equal(store.getProject(project.id).spotlight, true);
    const off = setSpotlight({
      store,
      projectId: project.id,
      enabled: false,
    });
    assert.equal(off.spotlight, false);
    assert.equal("spotlight" in store.getProject(project.id), false);
  });

  it("spotlightLane mirrors the selected lane onto main via previewLane", () => {
    setSpotlight({ store, projectId: project.id, enabled: true });
    const result = spotlightLane({ store, projectId: project.id, lane: 1 });
    assert.equal(result.lane, 1);
    assert.equal(result.spotlight, true);
    assert.equal(
      fs.readFileSync(path.join(project.path, "from-a.txt"), "utf8"),
      "A\n",
    );
    assert.equal(store.getProject(project.id).mergePreview.lane, 1);
    const previewed = previewLane({
      store,
      projectId: project.id,
      lane: 1,
    });
    assert.equal(previewed.lane, 1);
    assert.equal(previewed.sha, result.sha);
  });

  it("switching spotlight lanes restores then previews; restorePreview is the closer", () => {
    setSpotlight({ store, projectId: project.id, enabled: true });
    spotlightLane({ store, projectId: project.id, lane: 1 });
    const swapped = spotlightLane({ store, projectId: project.id, lane: 2 });
    assert.equal(swapped.lane, 2);
    assert.equal(
      fs.readFileSync(path.join(project.path, "from-b.txt"), "utf8"),
      "B\n",
    );
    assert.equal(
      fs.existsSync(path.join(project.path, "from-a.txt")),
      false,
      "lane A leftover must be gone after restore+preview",
    );
    assert.equal(store.getProject(project.id).mergePreview.lane, 2);
    const restored = restorePreview({ store, projectId: project.id });
    assert.equal(restored.restored, true);
    assert.equal(store.getProject(project.id).mergePreview, undefined);
    assert.equal(fs.existsSync(path.join(project.path, "from-b.txt")), false);
  });

  it("devserver:start with spotlight on uses the project checkout and a shared PORT", async () => {
    setSpotlight({ store, projectId: project.id, enabled: true });
    delete require.cache[require.resolve("../ipc.js")];
    const { IPC_HANDLERS } = require("../ipc.js");
    await IPC_HANDLERS["devserver:start"](ctx, {
      threadId: a.id,
      script: "dev",
    });
    await IPC_HANDLERS["devserver:start"](ctx, {
      threadId: b.id,
      script: "dev",
    });
    assert.equal(starts.length, 2);
    assert.equal(starts[0].root, project.path);
    assert.equal(starts[1].root, project.path);
    const envA = starts[0].opts && starts[0].opts.env;
    const envB = starts[1].opts && starts[1].opts.env;
    assert.ok(envA && envB, "spotlight start must pass env");
    assert.equal(envA.PORT, envB.PORT);
    assert.equal(envA.PORT, "3000");
    assert.equal(envA.SOLENTA_SPOTLIGHT, "1");
    assert.equal(envB.SOLENTA_SPOTLIGHT, "1");
    assert.notEqual(envA.PORT, laneEnv(1).PORT);
    assert.equal(store.getProject(project.id).mergePreview.lane, 2);
  });

  it("devserver:start with spotlight off still uses per-lane ports and worktrees", async () => {
    delete require.cache[require.resolve("../ipc.js")];
    const { IPC_HANDLERS } = require("../ipc.js");
    await IPC_HANDLERS["devserver:start"](ctx, {
      threadId: a.id,
      script: "dev",
    });
    await IPC_HANDLERS["devserver:start"](ctx, {
      threadId: b.id,
      script: "dev",
    });
    const lanes = listLanes(store, project.id);
    assert.equal(starts[0].root, lanes[0].path);
    assert.equal(starts[1].root, lanes[1].path);
    assert.equal(starts[0].opts.env.PORT, laneEnv(1).PORT);
    assert.equal(starts[1].opts.env.PORT, laneEnv(2).PORT);
    assert.notEqual(starts[0].opts.env.SOLENTA_SPOTLIGHT, "1");
  });

  it("does not add a second closer; recycle stays heartbeat-stale only", () => {
    delete require.cache[require.resolve("../ipc.js")];
    const { IPC_HANDLERS } = require("../ipc.js");
    assert.equal(
      typeof IPC_HANDLERS["mergeQueue:completeIssue"],
      "undefined",
      "must not add a second issue closer",
    );
    assert.equal(typeof IPC_HANDLERS["mergeQueue:setSpotlight"], "function");
    assert.equal(typeof IPC_HANDLERS["mergeQueue:spotlightLane"], "function");
    const src = fs.readFileSync(path.join(__dirname, "../mergeQueue.js"), "utf8");
    const recycleFn = src.slice(src.indexOf("function recycleWedgedLanes"));
    const recycleBody = recycleFn.slice(0, recycleFn.indexOf("\nfunction "));
    assert.equal(
      /completeIssue|completeThreadIssue/.test(recycleBody),
      false,
      "recycleWedgedLanes must not close issues",
    );
    const spotlightFn = src.slice(src.indexOf("function spotlightLane"));
    const spotlightBody = spotlightFn.slice(0, spotlightFn.indexOf("\nfunction "));
    assert.equal(
      /mergeWorktree|completeIssue|completeThreadIssue/.test(spotlightBody),
      false,
      "spotlightLane must not promote or close issues",
    );
    setSpotlight({ store, projectId: project.id, enabled: true });
    spotlightLane({ store, projectId: project.id, lane: 1 });
    const recycled = recycleWedgedLanes({
      store,
      projectId: project.id,
      now: 1,
      wedgeMs: 1,
    });
    assert.equal(recycled.length, 0, "fresh heartbeats must not be recycled");
    assert.equal(
      store.getProject(project.id).mergePreview.lane,
      1,
      "recycle must not restore or move main",
    );
  });
});

describe("mergeQueue Spotlight on CoderApi (#250 stretch)", () => {
  it("lists setSpotlight and spotlightLane on the CoderApi table", async () => {
    const { IPC_CHANNELS, ipcChannelName } = await import(
      pathToFileURL(path.join(__dirname, "../../src/shared/ipcChannels.ts")).href
    );
    const table = new Set(IPC_CHANNELS.map(ipcChannelName));
    assert.ok(table.has("mergeQueue:setSpotlight"));
    assert.ok(table.has("mergeQueue:spotlightLane"));
    assert.equal(
      table.has("mergeQueue:completeIssue"),
      false,
      "must not add a second issue closer",
    );
  });
});
