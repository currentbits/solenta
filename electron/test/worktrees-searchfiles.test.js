const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { searchFiles, listFiles } = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("worktrees searchFiles", () => {
  let tmpDir;
  let store;
  let repo;
  let thread;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grep-"));
    store = new Store(path.join(tmpDir, "store.json"));
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "App.tsx"), "export function App() {\n  return 1;\n}\n");
    fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "Search files",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns path/line/text hits for a fixed string", async () => {
    const { hits } = await searchFiles({
      store,
      threadId: thread.id,
      query: "export function",
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, "src/App.tsx");
    assert.equal(hits[0].line, 1);
    assert.match(hits[0].text, /export function App/);
  });

  it("is case-insensitive and empty on no match", async () => {
    const hit = await searchFiles({
      store,
      threadId: thread.id,
      query: "EXPORT FUNCTION",
    });
    assert.equal(hit.hits.length, 1);
    const miss = await searchFiles({
      store,
      threadId: thread.id,
      query: "definitely-not-in-the-repo-xyz",
    });
    assert.deepEqual(miss.hits, []);
  });

  it("empty query is no work", async () => {
    const { hits } = await searchFiles({
      store,
      threadId: thread.id,
      query: "  ",
    });
    assert.deepEqual(hits, []);
  });

  it("rejects unknown threads", async () => {
    await assert.rejects(
      () => searchFiles({ store, threadId: "nope", query: "app" }),
      /unknown/i,
    );
  });

  it("listFiles honour an explicit limit", async () => {
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(repo, `n${i}.txt`), "x\n");
    }
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "more"]);
    const { files } = await listFiles({
      store,
      threadId: thread.id,
      query: "n",
      limit: 5,
    });
    assert.equal(files.length, 5);
  });
});
