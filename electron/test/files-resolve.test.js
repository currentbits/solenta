/**
 * files:resolve joins relative paths against the thread worktree and
 * returns null for missing / escaped paths (#492).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function withHandlers(fn) {
  const stub = {
    ipcMain: { handle() {} },
    app: { getPath: () => os.tmpdir(), getVersion: () => "0.0.0-test" },
    dialog: {},
    shell: {},
    BrowserWindow: class {},
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return stub;
    return origLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve("../ipc.js")];
    delete require.cache[require.resolve("../store.js")];
    delete require.cache[require.resolve("../services.js")];
    delete require.cache[require.resolve("../worktrees.js")];
    const { createHandlers } = require("../ipc.js");
    const { Store } = require("../store.js");
    const services = require("../services.js");
    const worktrees = require("../worktrees.js");
    return await fn({ createHandlers, Store, services, worktrees });
  } finally {
    Module._load = origLoad;
  }
}

describe("files:resolve", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-files-resolve-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function setup() {
    return withHandlers(async ({ createHandlers, Store, services, worktrees }) => {
      const repo = path.join(tmp, "repo");
      fs.mkdirSync(repo);
      git(repo, ["init", "-q", "-b", "main"]);
      git(repo, ["config", "user.email", "t@example.com"]);
      git(repo, ["config", "user.name", "t"]);
      fs.mkdirSync(path.join(repo, "src"));
      fs.writeFileSync(path.join(repo, "src", "foo.ts"), "x\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-qm", "init"]);

      const store = new Store(path.join(tmp, "store.json"));
      const project = await services.addProject(store, repo);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "resolve",
      });
      worktrees.setupWorktree({
        store,
        threadId: thread.id,
        worktreeBase: path.join(tmp, "wt"),
      });
      const wt = store.getThread(thread.id).worktreePath;
      assert.ok(wt);
      fs.mkdirSync(path.join(wt, "src"), { recursive: true });
      fs.writeFileSync(path.join(wt, "src", "foo.ts"), "worktree\n");

      const handlers = createHandlers({
        store,
        runner: { start() {}, stop() {}, stopAll() {} },
        broadcast() {},
        worktreeBase: path.join(tmp, "wt"),
        userDataPath: tmp,
      });
      return { handlers, thread, wt, repo };
    });
  }

  it("resolves a relative file against the worktree, not the main checkout", async () => {
    const { handlers, thread, wt } = await setup();
    const out = await handlers["files:resolve"]({
      threadId: thread.id,
      paths: ["src/foo.ts"],
    });
    assert.deepEqual(out.resolved, [
      { path: "src/foo.ts", abs: path.join(wt, "src", "foo.ts") },
    ]);
    const body = fs.readFileSync(out.resolved[0].abs, "utf8");
    assert.equal(body, "worktree\n");
  });

  it("returns null for a missing file", async () => {
    const { handlers, thread } = await setup();
    const out = await handlers["files:resolve"]({
      threadId: thread.id,
      paths: ["src/missing.ts"],
    });
    assert.deepEqual(out.resolved, [{ path: "src/missing.ts", abs: null }]);
  });

  it("strips :12 and still resolves", async () => {
    const { handlers, thread, wt } = await setup();
    const out = await handlers["files:resolve"]({
      threadId: thread.id,
      paths: ["src/foo.ts:12"],
    });
    assert.deepEqual(out.resolved, [
      { path: "src/foo.ts:12", abs: path.join(wt, "src", "foo.ts") },
    ]);
  });

  it("rejects a path outside the worktree", async () => {
    const { handlers, thread } = await setup();
    const escape = path.join(tmp, "outside.txt");
    fs.writeFileSync(escape, "nope\n");
    const out = await handlers["files:resolve"]({
      threadId: thread.id,
      paths: [escape],
    });
    assert.deepEqual(out.resolved, [{ path: escape, abs: null }]);
  });
});
