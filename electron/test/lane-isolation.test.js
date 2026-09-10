/**
 * #250 remainder: two claimed lanes of the same app get distinct data
 * dirs (cookies / localStorage) and display names. PORT stays
 * mergeQueue.laneEnv. Recycle is not a closer.
 *
 * Run: node --test electron/test/lane-isolation.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");

const { Store } = require("../store.js");
const services = require("../services.js");
const { claimLane, listLanes, laneEnv, recycleWedgedLanes } = require("../mergeQueue.js");
const {
  isolationEnv,
  withChromiumUserDataDir,
  rewriteChromiumScriptBody,
  materializeElectronIdentity,
} = require("../worktreeEnv.js");
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

describe("claimed lanes isolate data dirs and app identity (#250)", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-lane-iso-"));
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
    store.getProject(project.id).name = "Acme";
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

  it("listLanes shows two claimed lanes with distinct ports from laneEnv", () => {
    const lanes = listLanes(store, project.id);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].n, 1);
    assert.equal(lanes[1].n, 2);
    assert.equal(lanes[0].port, Number(laneEnv(1).PORT));
    assert.equal(lanes[1].port, Number(laneEnv(2).PORT));
    assert.notEqual(lanes[0].port, lanes[1].port);
    assert.ok(lanes[0].path);
    assert.ok(lanes[1].path);
    assert.notEqual(lanes[0].path, lanes[1].path);
  });

  it("devserver:start gives each claimed lane its own data dir and display name", async () => {
    delete require.cache[require.resolve("../ipc.js")];
    const { IPC_HANDLERS } = require("../ipc.js");
    await IPC_HANDLERS["devserver:start"](ctx, { threadId: a.id, script: "dev" });
    await IPC_HANDLERS["devserver:start"](ctx, { threadId: b.id, script: "dev" });
    assert.equal(starts.length, 2);
    const envA = starts[0].opts.env;
    const envB = starts[1].opts.env;
    assert.ok(envA.SOLENTA_DATA_DIR, "lane A needs a data dir for cookies/localStorage");
    assert.ok(envB.SOLENTA_DATA_DIR, "lane B needs a data dir for cookies/localStorage");
    assert.notEqual(envA.SOLENTA_DATA_DIR, envB.SOLENTA_DATA_DIR);
    assert.notEqual(envA.XDG_CONFIG_HOME, envB.XDG_CONFIG_HOME);
    assert.equal(envA.SOLENTA_DATA_DIR, path.join(tmpDir, "dev-homes", a.id));
    assert.equal(envB.SOLENTA_DATA_DIR, path.join(tmpDir, "dev-homes", b.id));
    assert.equal(envA.SOLENTA_APP_NAME, `Acme · ${a.id.slice(0, 8)}`);
    assert.equal(envB.SOLENTA_APP_NAME, `Acme · ${b.id.slice(0, 8)}`);
    assert.notEqual(envA.SOLENTA_APP_NAME, envB.SOLENTA_APP_NAME);
    assert.equal(envA.PORT, "3001");
    assert.equal(envB.PORT, "3002");
    assert.equal(envA.SOLENTA_LANE, "1");
    assert.equal(envB.SOLENTA_LANE, "2");
  });

  it("does not add a second closer; recycleWedgedLanes still only tears down stale lanes", () => {
    delete require.cache[require.resolve("../ipc.js")];
    const { IPC_HANDLERS } = require("../ipc.js");
    assert.equal(
      typeof IPC_HANDLERS["mergeQueue:completeIssue"],
      "undefined",
      "must not add a second issue closer",
    );
    const src = fs.readFileSync(path.join(__dirname, "../mergeQueue.js"), "utf8");
    const recycleFn = src.slice(src.indexOf("function recycleWedgedLanes"));
    const recycleBody = recycleFn.slice(0, recycleFn.indexOf("\nfunction "));
    assert.equal(
      /completeIssue|completeThreadIssue/.test(recycleBody),
      false,
      "recycleWedgedLanes must not close issues",
    );
    const recycled = recycleWedgedLanes({
      store,
      projectId: project.id,
      now: 1,
      wedgeMs: 1,
    });
    assert.equal(recycled.length, 0, "fresh heartbeats must not be recycled");
  });

  it("Electron children get distinct --user-data-dir from each claimed lane's isolationEnv", () => {
    const lanes = listLanes(store, project.id);
    assert.equal(lanes.length, 2);
    assert.notEqual(lanes[0].port, lanes[1].port);
    assert.equal(lanes[0].port, Number(laneEnv(1).PORT));
    assert.equal(lanes[1].port, Number(laneEnv(2).PORT));

    const envA = isolationEnv({
      threadId: a.id,
      userDataPath: tmpDir,
      platform: "darwin",
    });
    const envB = isolationEnv({
      threadId: b.id,
      userDataPath: tmpDir,
      platform: "darwin",
    });
    const argsA = withChromiumUserDataDir(["run", "electron"], envA, "electron .");
    const argsB = withChromiumUserDataDir(["run", "electron"], envB, "electron .");
    const flagA = argsA.find((x) => String(x).startsWith("--user-data-dir="));
    const flagB = argsB.find((x) => String(x).startsWith("--user-data-dir="));
    assert.ok(flagA, "lane A Electron child needs --user-data-dir");
    assert.ok(flagB, "lane B Electron child needs --user-data-dir");
    assert.notEqual(flagA, flagB);
    assert.ok(String(flagA).includes(envA.SOLENTA_DATA_DIR));
    assert.ok(String(flagB).includes(envB.SOLENTA_DATA_DIR));
    assert.ok(String(flagA).includes("chrome-profile"));
    assert.ok(String(flagB).includes("chrome-profile"));
  });

  it("concurrently script bodies isolate the inner Electron child's profile per claimed lane", () => {
    const lanes = listLanes(store, project.id);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].port, Number(laneEnv(1).PORT));
    assert.equal(lanes[1].port, Number(laneEnv(2).PORT));

    const envA = isolationEnv({
      threadId: a.id,
      userDataPath: tmpDir,
      platform: "darwin",
    });
    const envB = isolationEnv({
      threadId: b.id,
      userDataPath: tmpDir,
      platform: "darwin",
    });
    const pkg = JSON.parse(
      fs.readFileSync(path.join(project.path, "package.json"), "utf8"),
    );
    pkg.scripts.dev = 'concurrently "vite" "electron ."';
    fs.writeFileSync(
      path.join(project.path, "package.json"),
      JSON.stringify(pkg),
    );
    const body = pkg.scripts.dev;
    assert.deepEqual(
      withChromiumUserDataDir(["run", "dev"], envA, body),
      ["run", "dev"],
      "npm extra args would land on concurrently, not electron",
    );
    const rewrittenA = rewriteChromiumScriptBody(body, envA);
    const rewrittenB = rewriteChromiumScriptBody(body, envB);
    assert.ok(rewrittenA.includes(`--user-data-dir=${path.join(envA.SOLENTA_DATA_DIR, "chrome-profile")}`));
    assert.ok(rewrittenB.includes(`--user-data-dir=${path.join(envB.SOLENTA_DATA_DIR, "chrome-profile")}`));
    assert.notEqual(rewrittenA, rewrittenB);
    assert.doesNotMatch(rewrittenA, /vite[^\n"]*--user-data-dir/);
    assert.equal(
      typeof require("../mergeQueue.js").mergeWorktree,
      "undefined",
      "promote stays git.mergeWorktree; mergeQueue must not grow a second promote",
    );
  });

  it("Electron children get distinct dock/Spotlight names from each claimed lane's isolationEnv", () => {
    const lanes = listLanes(store, project.id);
    assert.equal(lanes.length, 2);
    assert.equal(lanes[0].port, Number(laneEnv(1).PORT));
    assert.equal(lanes[1].port, Number(laneEnv(2).PORT));

    const envA = isolationEnv({
      threadId: a.id,
      userDataPath: tmpDir,
      project: { name: "Acme" },
      identity: true,
      platform: "darwin",
    });
    const envB = isolationEnv({
      threadId: b.id,
      userDataPath: tmpDir,
      project: { name: "Acme" },
      identity: true,
      platform: "darwin",
    });
    const bundleA = materializeElectronIdentity(envA, { platform: "darwin" });
    const bundleB = materializeElectronIdentity(envB, { platform: "darwin" });
    assert.ok(bundleA, "lane A needs a stub .app so macOS can show a distinct name");
    assert.ok(bundleB, "lane B needs a stub .app so macOS can show a distinct name");
    assert.notEqual(bundleA, bundleB);
    const plistA = fs.readFileSync(path.join(bundleA, "Contents", "Info.plist"), "utf8");
    const plistB = fs.readFileSync(path.join(bundleB, "Contents", "Info.plist"), "utf8");
    assert.ok(plistA.includes(`<string>${envA.SOLENTA_APP_NAME}</string>`));
    assert.ok(plistB.includes(`<string>${envB.SOLENTA_APP_NAME}</string>`));
    assert.notEqual(envA.SOLENTA_APP_NAME, envB.SOLENTA_APP_NAME);
    assert.equal(
      typeof require("../mergeQueue.js").mergeWorktree,
      "undefined",
      "promote stays git.mergeWorktree; mergeQueue must not grow a second promote",
    );
  });
});
