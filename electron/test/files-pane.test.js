/**
 * files:tree / files:read back the Files pane (#1506): lazy listing that
 * respects .gitignore, previews with a size cap and binary sniff, and no
 * read outside the thread root (dot-dot, absolute, or via a symlink).
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
    const { createHandlers } = require("../ipc.js");
    const { Store } = require("../store.js");
    const services = require("../services.js");
    return await fn({ createHandlers, Store, services });
  } finally {
    Module._load = origLoad;
  }
}

describe("files pane IPC", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coder-files-pane-")));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function setup() {
    return withHandlers(async ({ createHandlers, Store, services }) => {
      const repo = path.join(tmp, "repo");
      fs.mkdirSync(path.join(repo, "src"), { recursive: true });
      fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
      git(repo, ["init", "-q", "-b", "main"]);
      git(repo, ["config", "user.email", "t@example.com"]);
      git(repo, ["config", "user.name", "t"]);
      fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n*.log\n");
      fs.writeFileSync(path.join(repo, "README.md"), "# hi\n");
      fs.writeFileSync(path.join(repo, "src", "a.ts"), "const a = 1;\n");
      fs.writeFileSync(path.join(repo, "debug.log"), "noise\n");
      fs.writeFileSync(path.join(repo, "node_modules", "dep", "i.js"), "x\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-qm", "init"]);
      fs.writeFileSync(path.join(tmp, "secret.txt"), "outside\n");

      const store = new Store(path.join(tmp, "store.json"));
      const project = await services.addProject(store, repo);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "files",
      });
      const handlers = createHandlers({
        store,
        runner: { start() {}, stop() {}, stopAll() {} },
        broadcast() {},
        worktreeBase: path.join(tmp, "wt"),
        userDataPath: tmp,
      });
      return { handlers, store, project, thread, repo };
    });
  }

  it("lists a directory dirs-first, hiding .git and ignored entries", async () => {
    const { handlers, thread } = await setup();
    const out = await handlers["files:tree"]({ threadId: thread.id });
    assert.deepEqual(
      out.entries.map((e) => [e.path, e.dir]),
      [
        ["src", true],
        [".gitignore", false],
        ["README.md", false],
      ],
    );
    assert.equal(out.truncated, false);
    const src = await handlers["files:tree"]({ threadId: thread.id, dir: "src" });
    assert.deepEqual(src.entries, [{ name: "a.ts", path: "src/a.ts", dir: false }]);
  });

  it("shows ignored entries flagged when asked", async () => {
    const { handlers, thread } = await setup();
    const out = await handlers["files:tree"]({ threadId: thread.id, showIgnored: true });
    const ignored = out.entries.filter((e) => e.ignored).map((e) => e.path);
    assert.deepEqual(ignored.sort(), ["debug.log", "node_modules"]);
    assert.ok(!out.entries.some((e) => e.name === ".git"));
  });

  it("lists every non-ignored file for the filter", async () => {
    const { handlers, thread } = await setup();
    const out = await handlers["files:tree"]({ threadId: thread.id, all: true });
    assert.deepEqual(out.entries.map((e) => e.path).sort(), [
      ".gitignore",
      "README.md",
      "src/a.ts",
    ]);
  });

  it("previews text, images, binaries and oversized files", async () => {
    const { handlers, thread, repo } = await setup();
    const text = await handlers["files:read"]({ threadId: thread.id, path: "src/a.ts" });
    assert.deepEqual(text, { kind: "text", size: 13, text: "const a = 1;\n" });

    fs.writeFileSync(path.join(repo, "dot.png"), Buffer.from([0x89, 0x50, 0, 1]));
    const img = await handlers["files:read"]({ threadId: thread.id, path: "dot.png" });
    assert.equal(img.kind, "image");
    assert.equal(img.dataUrl, "data:image/png;base64,iVAAAQ==");

    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    assert.deepEqual(
      await handlers["files:read"]({ threadId: thread.id, path: "blob.bin" }),
      { kind: "binary", size: 4 },
    );

    fs.writeFileSync(path.join(repo, "big.txt"), "a".repeat(1024 * 1024 + 1));
    assert.deepEqual(
      await handlers["files:read"]({ threadId: thread.id, path: "big.txt" }),
      { kind: "tooLarge", size: 1024 * 1024 + 1 },
    );
  });

  it("refuses dot-dot and absolute paths outside the root", async () => {
    const { handlers, thread } = await setup();
    await assert.rejects(
      handlers["files:read"]({ threadId: thread.id, path: "../secret.txt" }),
      /outside the thread workspace/,
    );
    await assert.rejects(
      handlers["files:read"]({ threadId: thread.id, path: path.join(tmp, "secret.txt") }),
      /outside the thread workspace/,
    );
    await assert.rejects(
      handlers["files:tree"]({ threadId: thread.id, dir: ".." }),
      /outside the thread workspace/,
    );
  });

  it("refuses symlinks that point outside the root", async () => {
    const { handlers, thread, repo } = await setup();
    fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(repo, "leak.txt"));
    fs.symlinkSync(tmp, path.join(repo, "up"));
    await assert.rejects(
      handlers["files:read"]({ threadId: thread.id, path: "leak.txt" }),
      /outside the thread workspace/,
    );
    await assert.rejects(
      handlers["files:tree"]({ threadId: thread.id, dir: "up" }),
      /outside the thread workspace/,
    );
    await assert.rejects(
      handlers["files:read"]({ threadId: thread.id, path: "up/secret.txt" }),
      /outside the thread workspace/,
    );
  });

  it("refuses remote projects", async () => {
    const { handlers, store, project, thread } = await setup();
    store.setProjects(
      store.getProjects().map((p) =>
        p.id === project.id ? { ...p, remoteHost: "me@box", remotePath: "/srv/app" } : p,
      ),
    );
    await assert.rejects(
      handlers["files:tree"]({ threadId: thread.id }),
      /not available for remote projects/,
    );
  });
});
