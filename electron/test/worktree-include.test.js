/**
 * Issue #185: gitignored config (.env, certs) is copied into new worktrees,
 * from `.worktreeinclude` or the root `.env*` default.
 * Run: npm run test:electron -- --test-name-pattern="worktreeinclude"
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree, copyWorktreeIncludes } = require("../worktrees.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function write(root, rel, body) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

describe("worktreeinclude (#185)", () => {
  let tmpDir;
  let repo;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtinc-"));
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    write(repo, ".gitignore", ".env*\n!.env.example\ncerts/\nnode_modules/\n");
    write(repo, ".env.example", "TRACKED=1\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    write(repo, ".env", "SECRET=1\n");
    write(repo, ".env.local", "LOCAL=1\n");
    write(repo, "notes.txt", "untracked, not ignored\n");
  });

  afterEach(() => rmTree(tmpDir));

  it("setupWorktree copies root .env* by default, never tracked or unignored files", async () => {
    const store = new Store(path.join(tmpDir, "store.json"));
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, { projectId: project.id, title: "Env" });
    const wt = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase: path.join(tmpDir, "worktrees"),
    }).worktreePath;
    assert.equal(fs.readFileSync(path.join(wt, ".env"), "utf8"), "SECRET=1\n");
    assert.equal(fs.readFileSync(path.join(wt, ".env.local"), "utf8"), "LOCAL=1\n");
    assert.ok(!fs.existsSync(path.join(wt, "notes.txt")));
    assert.equal(git(wt, ["status", "--porcelain"]), "");
    git(repo, ["worktree", "remove", "--force", wt]);
  });

  it(".worktreeinclude picks nested paths, skips node_modules, never overwrites", () => {
    write(repo, ".worktreeinclude", ".env*\ncerts/\nnotes.txt\n");
    write(repo, "certs/dev.pem", "PEM\n");
    write(repo, "apps/web/.env", "WEB=1\n");
    write(repo, "node_modules/pkg/.env", "NOPE\n");
    const dir = path.join(tmpDir, "dest");
    write(dir, ".env", "KEEP\n");
    const copied = copyWorktreeIncludes(repo, dir).sort();
    assert.deepEqual(copied, [".env.local", "apps/web/.env", "certs/dev.pem"]);
    assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "KEEP\n");
    assert.ok(!fs.existsSync(path.join(dir, "node_modules")));
    assert.ok(!fs.existsSync(path.join(dir, "notes.txt")));
  });
});
