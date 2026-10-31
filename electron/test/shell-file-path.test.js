/**
 * shell:reveal / shell:openPath against a FILE inside the thread worktree,
 * not just the worktree root (#1766, Changes panel "Open in editor" /
 * "Reveal in Finder"). resolveAllowedShellPath (ipc-files.js) already
 * joins a relative path against the thread root and rejects anything that
 * resolves outside it or does not exist — this pins that contract down for
 * a per-file target, since nothing exercised it before.
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
  const calls = { showItemInFolder: [], openPath: [] };
  const stub = {
    ipcMain: { handle() {} },
    app: { getPath: () => os.tmpdir(), getVersion: () => "0.0.0-test" },
    dialog: {},
    shell: {
      showItemInFolder: (p) => calls.showItemInFolder.push(p),
      openPath: async (p) => {
        calls.openPath.push(p);
        return "";
      },
    },
    BrowserWindow: class {},
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return stub;
    return origLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve("../ipc.js")];
    delete require.cache[require.resolve("../ipc-files.js")];
    delete require.cache[require.resolve("../store.js")];
    delete require.cache[require.resolve("../services.js")];
    delete require.cache[require.resolve("../worktrees.js")];
    const { createHandlers } = require("../ipc.js");
    const { Store } = require("../store.js");
    const services = require("../services.js");
    const worktrees = require("../worktrees.js");
    return await fn({ createHandlers, Store, services, worktrees, calls });
  } finally {
    Module._load = origLoad;
  }
}

describe("shell:reveal / shell:openPath on a file inside the worktree", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-shell-file-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function setup() {
    return withHandlers(async ({ createHandlers, Store, services, worktrees, calls }) => {
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
        title: "shell-file",
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
      return { handlers, thread, wt, calls };
    });
  }

  it("reveal resolves a relative file path under the worktree and calls showItemInFolder", async () => {
    const { handlers, thread, wt, calls } = await setup();
    await handlers["shell:reveal"]({ threadId: thread.id, path: "src/foo.ts" });
    assert.deepEqual(calls.showItemInFolder, [path.join(wt, "src", "foo.ts")]);
  });

  it("openPath resolves a relative file path under the worktree and calls shell.openPath", async () => {
    const { handlers, thread, wt, calls } = await setup();
    await handlers["shell:openPath"]({ threadId: thread.id, path: "src/foo.ts" });
    assert.deepEqual(calls.openPath, [path.join(wt, "src", "foo.ts")]);
  });

  it("also accepts the already-absolute in-worktree path", async () => {
    const { handlers, thread, wt, calls } = await setup();
    const abs = path.join(wt, "src", "foo.ts");
    await handlers["shell:reveal"]({ threadId: thread.id, path: abs });
    assert.deepEqual(calls.showItemInFolder, [abs]);
  });

  it("rejects a file outside the worktree (path containment)", async () => {
    const { handlers, thread } = await setup();
    const escape = path.join(tmp, "outside.txt");
    fs.writeFileSync(escape, "nope\n");
    await assert.rejects(
      handlers["shell:reveal"]({ threadId: thread.id, path: escape }),
      /outside the thread workspace/,
    );
    await assert.rejects(
      handlers["shell:openPath"]({ threadId: thread.id, path: escape }),
      /outside the thread workspace/,
    );
  });

  it("rejects a path that escapes via .. even when it is relative", async () => {
    const { handlers, thread, wt } = await setup();
    // The escape target must exist, or the existence check would short
    // circuit before the containment check runs.
    fs.writeFileSync(path.join(path.dirname(wt), "outside.txt"), "nope\n");
    await assert.rejects(
      handlers["shell:reveal"]({ threadId: thread.id, path: "../outside.txt" }),
      /outside the thread workspace/,
    );
  });

  it("rejects a deleted file (does not exist) — the UI must fall back to the parent folder", async () => {
    const { handlers, thread } = await setup();
    await assert.rejects(
      handlers["shell:openPath"]({ threadId: thread.id, path: "src/gone.ts" }),
      /does not exist/,
    );
  });
});

/**
 * Chat attachments (pasted images, dropped files) live under
 * `<userDataPath>/attachments`, outside every thread's worktree
 * (electron/attachments.js DIR_NAME). "Reveal in Finder" / "Open" on an
 * attachment chip (#1794) needs resolveAllowedShellPath to accept that
 * directory too, not just the thread worktree.
 */
describe("shell:reveal / shell:openPath on a chat attachment", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-shell-attachment-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function setup() {
    return withHandlers(async ({ createHandlers, Store, services, worktrees, calls }) => {
      const repo = path.join(tmp, "repo");
      fs.mkdirSync(repo);
      git(repo, ["init", "-q", "-b", "main"]);
      git(repo, ["config", "user.email", "t@example.com"]);
      git(repo, ["config", "user.name", "t"]);
      fs.writeFileSync(path.join(repo, "README.md"), "x\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-qm", "init"]);

      const store = new Store(path.join(tmp, "store.json"));
      const project = await services.addProject(store, repo);
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "shell-attachment",
      });
      worktrees.setupWorktree({
        store,
        threadId: thread.id,
        worktreeBase: path.join(tmp, "wt"),
      });

      const attachmentDir = path.join(tmp, "attachments", thread.id);
      fs.mkdirSync(attachmentDir, { recursive: true });
      const attachment = path.join(attachmentDir, "pasted.png");
      fs.writeFileSync(attachment, "fake-png\n");

      const handlers = createHandlers({
        store,
        runner: { start() {}, stop() {}, stopAll() {} },
        broadcast() {},
        worktreeBase: path.join(tmp, "wt"),
        userDataPath: tmp,
      });
      return { handlers, thread, attachment, calls };
    });
  }

  it("reveal accepts an attachment path outside the worktree", async () => {
    const { handlers, thread, attachment, calls } = await setup();
    await handlers["shell:reveal"]({ threadId: thread.id, path: attachment });
    assert.deepEqual(calls.showItemInFolder, [attachment]);
  });

  it("openPath accepts the same attachment path", async () => {
    const { handlers, thread, attachment, calls } = await setup();
    await handlers["shell:openPath"]({ threadId: thread.id, path: attachment });
    assert.deepEqual(calls.openPath, [attachment]);
  });

  it("still rejects a path that is neither the worktree nor the attachments dir", async () => {
    const { handlers, thread } = await setup();
    const escape = path.join(tmp, "outside.txt");
    fs.writeFileSync(escape, "nope\n");
    await assert.rejects(
      handlers["shell:reveal"]({ threadId: thread.id, path: escape }),
      /outside the thread workspace/,
    );
  });

  it("rejects a missing attachment path (does not exist)", async () => {
    const { handlers, thread } = await setup();
    const gone = path.join(tmp, "attachments", thread.id, "gone.png");
    await assert.rejects(
      handlers["shell:reveal"]({ threadId: thread.id, path: gone }),
      /does not exist/,
    );
  });
});
