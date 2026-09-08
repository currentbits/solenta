/**
 * IPC wires #250 isolation + #188 project.env into devservers.start.
 * PORT still comes from mergeQueue.laneEnv when a lane is claimed.
 *
 * Run: node --test electron/test/devserver-isolation-ipc.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");

{
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return {
        ipcMain: { handle() {} },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        shell: {},
        nativeTheme: { themeSource: "system" },
        app: { getPath: () => os.tmpdir() },
      };
    }
    return origLoad.apply(this, arguments);
  };
}

const { Store } = require("../store.js");
const services = require("../services.js");
const { IPC_HANDLERS } = require("../ipc.js");
const devservers = require("../devservers.js");

describe("devserver:start isolation", () => {
  let tmpDir;
  let store;
  let project;
  let thread;
  let ctx;
  let origStart;
  /** @type {object[]} */
  let starts;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-deviso-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    fs.writeFileSync(path.join(repo, "mark.png"), "x");
    project = await services.addProject(store, repo);
    const live = store.getProject(project.id);
    live.env = { AWS_PROFILE: "bedrock" };
    live.iconPath = "mark.png";
    thread = services.createThread(store, {
      projectId: project.id,
      title: "Iso",
    });
    ctx = { store, userDataPath: tmpDir, broadcast: () => {} };
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
  });

  it("passes isolation + project.env as opts.env", async () => {
    await IPC_HANDLERS["devserver:start"](ctx, {
      threadId: thread.id,
      script: "dev",
    });
    assert.equal(starts.length, 1);
    const env = starts[0].opts.env;
    assert.equal(env.AWS_PROFILE, "bedrock");
    assert.equal(env.SOLENTA_THREAD_ID, thread.id);
    assert.equal(env.SOLENTA_WORKTREE, project.path);
    assert.equal(env.SOLENTA_APP_NAME, `${project.name} · ${thread.id.slice(0, 8)}`);
    assert.equal(env.SOLENTA_APP_ICON, path.join(project.path, "mark.png"));
    assert.equal(
      env.SOLENTA_DATA_DIR,
      path.join(tmpDir, "dev-homes", thread.id),
    );
    assert.equal(env.PORT, undefined);
    assert.equal(starts[0].opts.project.id, project.id);
  });

  it("lets a claimed lane's PORT win over project.env", async () => {
    const live = store.getThread(thread.id);
    live.lane = { n: 2 };
    store.getProject(project.id).env = { PORT: "1111", AWS_PROFILE: "bedrock" };
    await IPC_HANDLERS["devserver:start"](ctx, {
      threadId: thread.id,
      script: "dev",
    });
    const env = starts[0].opts.env;
    assert.equal(env.AWS_PROFILE, "bedrock");
    assert.equal(env.PORT, "3002");
    assert.equal(env.SOLENTA_LANE, "2");
  });
});
