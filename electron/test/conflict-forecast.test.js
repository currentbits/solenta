"use strict";

/**
 * git:conflictForecast — overlapping edits across parallel worktrees (#249).
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree, conflictForecast } = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitAt(cwd, rel, content, msg) {
  fs.writeFileSync(path.join(cwd, rel), content);
  git(cwd, ["add", rel]);
  git(cwd, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    msg,
  ]);
}

function rewriteLine(cwd, rel, lineNo, text) {
  const file = path.join(cwd, rel);
  const lines = fs.readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
  lines[lineNo - 1] = text;
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

async function makeForecastFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-forecast-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const worktreeBase = path.join(tmpDir, "worktrees");
  const repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(repo, "shared.txt"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(repo, "other.txt"), "other\n");
  git(repo, ["add", "shared.txt", "other.txt"]);
  git(repo, ["commit", "-m", "init"]);
  try {
    git(repo, ["checkout", "-b", "main"]);
  } catch {
    // already on main
  }
  const project = await services.addProject(store, repo);
  const threads = [];
  const worktreePaths = [];
  for (const title of ["Thread A", "Thread B"]) {
    const thread = services.createThread(store, {
      projectId: project.id,
      title,
    });
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    threads.push(store.getThread(thread.id));
    worktreePaths.push(setup.worktreePath);
  }
  return { tmpDir, store, project, threads, worktreePaths };
}

function sortedIds(threads) {
  return [threads[0].id, threads[1].id].slice().sort();
}

describe("conflictForecast", () => {
  let fx;

  afterEach(() => {
    if (fx) {
      try {
        fs.rmSync(fx.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      fx = null;
    }
  });

  it("returns no pairs when two threads change different files", async () => {
    fx = await makeForecastFixture();
    commitAt(fx.worktreePaths[0], "a-only.txt", "alpha\n", "a only");
    commitAt(fx.worktreePaths[1], "b-only.txt", "beta\n", "b only");

    const result = await conflictForecast({
      store: fx.store,
      projectId: fx.project.id,
    });
    assert.deepEqual(result.pairs, []);
    assert.equal(typeof result.computedAt, "number");
    assert.ok(result.computedAt > 0);
  });

  it("reports overlap without conflicts when the same file is edited far apart", async () => {
    fx = await makeForecastFixture();
    rewriteLine(fx.worktreePaths[0], "shared.txt", 1, "line 1 from A");
    git(fx.worktreePaths[0], ["add", "shared.txt"]);
    git(fx.worktreePaths[0], [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "a far",
    ]);
    rewriteLine(fx.worktreePaths[1], "shared.txt", 40, "line 40 from B");
    git(fx.worktreePaths[1], ["add", "shared.txt"]);
    git(fx.worktreePaths[1], [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "b far",
    ]);

    const result = await conflictForecast({
      store: fx.store,
      projectId: fx.project.id,
    });
    const [threadA, threadB] = sortedIds(fx.threads);
    assert.equal(result.pairs.length, 1);
    assert.deepEqual(result.pairs[0], {
      threadA,
      threadB,
      overlap: ["shared.txt"],
      conflicts: [],
    });
  });

  it("reports a conflict when two threads edit the same line", async () => {
    fx = await makeForecastFixture();
    rewriteLine(fx.worktreePaths[0], "shared.txt", 10, "line 10 from A");
    git(fx.worktreePaths[0], ["add", "shared.txt"]);
    git(fx.worktreePaths[0], [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "a same",
    ]);
    rewriteLine(fx.worktreePaths[1], "shared.txt", 10, "line 10 from B");
    git(fx.worktreePaths[1], ["add", "shared.txt"]);
    git(fx.worktreePaths[1], [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "b same",
    ]);

    const result = await conflictForecast({
      store: fx.store,
      projectId: fx.project.id,
    });
    const [threadA, threadB] = sortedIds(fx.threads);
    assert.equal(result.pairs.length, 1);
    assert.deepEqual(result.pairs[0], {
      threadA,
      threadB,
      overlap: ["shared.txt"],
      conflicts: ["shared.txt"],
    });
  });

  it("includes an uncommitted working-tree change in overlap", async () => {
    fx = await makeForecastFixture();
    rewriteLine(fx.worktreePaths[0], "shared.txt", 2, "line 2 from A");
    git(fx.worktreePaths[0], ["add", "shared.txt"]);
    git(fx.worktreePaths[0], [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-m",
      "a committed",
    ]);
    rewriteLine(fx.worktreePaths[1], "shared.txt", 3, "line 3 uncommitted B");

    const result = await conflictForecast({
      store: fx.store,
      projectId: fx.project.id,
    });
    const [threadA, threadB] = sortedIds(fx.threads);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].threadA, threadA);
    assert.equal(result.pairs[0].threadB, threadB);
    assert.deepEqual(result.pairs[0].overlap, ["shared.txt"]);
  });
});
