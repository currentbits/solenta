const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { listFiles } = require("../worktrees.js");
const ssh = require("../ssh.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("worktrees listFiles", () => {
  let tmpDir;
  let store;
  let repo;
  let thread;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-ls-"));
    store = new Store(path.join(tmpDir, "store.json"));

    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "App.tsx"), "x\n");
    fs.writeFileSync(path.join(repo, "src", "main.tsx"), "x\n");
    fs.writeFileSync(path.join(repo, "README.md"), "x\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    // Untracked but not ignored: should be listed.
    fs.writeFileSync(path.join(repo, "scratch.ts"), "x\n");
    // Ignored: never listed.
    fs.writeFileSync(path.join(repo, "ignored.txt"), "x\n");

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "List files",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists tracked and untracked files, never gitignored ones", async () => {
    const { files } = await listFiles({ store, threadId: thread.id });
    assert.ok(files.includes("src/App.tsx"));
    assert.ok(files.includes("scratch.ts"));
    assert.ok(!files.includes("ignored.txt"));
  });

  it("filters case-insensitively by substring", async () => {
    const { files } = await listFiles({ store, threadId: thread.id, query: "APP" });
    assert.deepEqual(files, ["src/App.tsx"]);
  });

  it("prefix matches rank above mid-string matches", async () => {
    // Contains "src" mid-string (not as a prefix).
    fs.writeFileSync(path.join(repo, "libsrc.txt"), "x\n");
    const { files } = await listFiles({ store, threadId: thread.id, query: "src" });
    const idxLib = files.indexOf("libsrc.txt");
    assert.ok(idxLib > 0, "mid-string match still listed, not first");
    assert.ok(
      files.slice(0, idxLib).every((f) => f.startsWith("src")),
      "every entry before it is a prefix match",
    );
  });

  it("caps results at 20", async () => {
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(repo, `f${String(i).padStart(2, "0")}.txt`), "x\n");
    }
    const { files } = await listFiles({ store, threadId: thread.id, query: "f" });
    assert.ok(files.length <= 20);
  });

  it("reuses the cached file list across queries", async () => {
    await listFiles({ store, threadId: thread.id, query: "src" });
    fs.writeFileSync(path.join(repo, "fresh.ts"), "x\n");
    // Within the TTL the new file is invisible: proof git was not re-run.
    const { files } = await listFiles({ store, threadId: thread.id, query: "fresh" });
    assert.deepEqual(files, []);
  });

  it("rejects unknown threads", async () => {
    await assert.rejects(
      () => listFiles({ store, threadId: "nope" }),
      /unknown/i,
    );
  });

  it("listFiles does not call execFileSync", async () => {
    ssh.setExecFileSync(() => {
      throw new Error("execFileSync should not run on the listFiles path");
    });
    try {
      const { files } = await listFiles({ store, threadId: thread.id });
      assert.ok(files.includes("src/App.tsx"));
    } finally {
      ssh.setExecFileSync(null);
    }
  });
});
