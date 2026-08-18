"use strict";

/**
 * Issue #511: a thread configured to run in a worktree must never start
 * the agent in the main checkout when `git worktree add` fails.
 *
 * Fake git on PATH (same writeFakeBin pattern as worktrees.test.js's
 * fake-gh): every command except `worktree add` is delegated to the real
 * git so uniqueCoderBranch still works.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { setupWorktree, clearMissingWorktree } = require("../worktrees.js");
const { writeFakeBin } = require("./support/fakeBin.js");

/** Distinctive multiline git stderr — must appear verbatim, not first-line-only. */
const GIT_STDERR =
  "fatal: cannot lock ref 'refs/heads/coder/blocked-abc123'\n" +
  "error: there are still logs under 'refs/heads/coder/blocked-abc123'\n";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function realGitPath() {
  return execFileSync("which", ["git"], { encoding: "utf8" }).trim();
}

/**
 * Write a `git` that fails only `worktree add`, with the given stderr.
 * Other argv is delegated to `realGit` so branch probes still work.
 * @param {string} dir
 * @param {string} realGit
 * @param {string} stderrText
 * @returns {string} directory to prepend to PATH
 */
function writeFakeGit(dir, realGit, stderrText) {
  const binDir = path.join(dir, "fake-git-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const body = `
"use strict";
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "worktree" && args[1] === "add") {
  process.stderr.write(${JSON.stringify(stderrText)});
  process.exit(128);
}
const r = spawnSync(${JSON.stringify(realGit)}, args, {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status == null ? 1 : r.status);
`;
  writeFakeBin(path.join(binDir, "git"), body);
  return binDir;
}

function writeFakeClaude(dir) {
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
if (process.env.CODER_FAKE_CLAUDE_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
emit({ type: "system", subtype: "init", session_id: "sess-wt-fail", model: "m" });
emit({
  type: "assistant",
  message: { content: [{ type: "text", text: "should not run" }] },
});
emit({
  type: "result",
  subtype: "success",
  result: "ok",
  session_id: "sess-wt-fail",
  usage: { input_tokens: 1, output_tokens: 1 },
  total_cost_usd: 0,
});
process.exit(0);
`;
  return writeFakeBin(path.join(dir, "fake-claude-wtfail"), body);
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

describe("worktree setup failure must not start the agent (#511)", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let repo;
  let project;
  let argvFile;
  let prevBin;
  let prevArgv;
  let prevSimulate;
  let prevPath;
  let realGit;

  beforeEach(async () => {
    prevBin = process.env.CODER_CLAUDE_BIN;
    prevArgv = process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    prevSimulate = process.env.CODER_SIMULATE;
    prevPath = process.env.PATH;
    realGit = realGitPath();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtfail-"));
    store = new Store(path.join(tmpDir, "store.json"));
    argvFile = path.join(tmpDir, "argv.json");
    process.env.CODER_CLAUDE_BIN = writeFakeClaude(tmpDir);
    process.env.CODER_FAKE_CLAUDE_ARGV_FILE = argvFile;
    delete process.env.CODER_SIMULATE;

    const fakeGitDir = writeFakeGit(tmpDir, realGit, GIT_STDERR);
    process.env.PATH = `${fakeGitDir}${path.delimiter}${prevPath || ""}`;

    core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      userDataPath: tmpDir,
    });

    repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    project = await services.addProject(store, repo);
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    process.env.PATH = prevPath;
    if (prevBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevBin;
    if (prevArgv === undefined) delete process.env.CODER_FAKE_CLAUDE_ARGV_FILE;
    else process.env.CODER_FAKE_CLAUDE_ARGV_FILE = prevArgv;
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a setup error and spawns zero agent processes when worktree add fails", async () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Blocked",
    });
    store.updateThread(thread.id, { pendingWorktree: true });
    store.saveNow();

    if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);

    let thrown = null;
    try {
      await runner.startRun({
        threadId: thread.id,
        prompt: "do isolated work",
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "startRun must not start the turn");
    assert.match(
      String(thrown.message),
      /cannot lock ref 'refs\/heads\/coder\/blocked-abc123'/,
    );
    assert.match(
      String(thrown.message),
      /there are still logs under 'refs\/heads\/coder\/blocked-abc123'/,
      "git stderr must be surfaced verbatim, not first-line-only",
    );

    assert.equal(
      fs.existsSync(argvFile),
      false,
      "fake claude must not spawn",
    );
    assert.equal(runner.isRunning(thread.id), false);

    const after = store.getThread(thread.id);
    assert.equal(after.status, "failed");
    assert.equal(Boolean(after.pendingWorktree), true, "flag survives for retry");
    assert.equal(after.worktreePath, null);
    assert.ok(after.lastError, "setup error recorded on the thread");
    assert.match(String(after.lastError), /cannot lock ref/);

    const msgs = store.getMessages(thread.id);
    const users = msgs.filter((m) => m.role === "user");
    const events = msgs.filter((m) => m.role === "event");
    assert.equal(users.length, 1);
    assert.equal(users[0].text, "do isolated work");
    assert.ok(
      events.some((m) => String(m.text).includes(GIT_STDERR.trim())),
      `expected event with verbatim git stderr, got ${JSON.stringify(events.map((m) => m.text))}`,
    );
    assert.equal(
      msgs[msgs.length - 1].role,
      "event",
      "last message is the setup-error event so Retry-turn can attach",
    );
  });

  it("setupWorktree keeps the full git stderr, not just the first line", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Blocked",
    });
    assert.throws(
      () =>
        setupWorktree({
          store,
          threadId: thread.id,
          worktreeBase: path.join(tmpDir, "worktrees"),
        }),
      (err) => {
        const msg = String(err && err.message);
        assert.match(msg, /cannot lock ref/);
        assert.match(msg, /there are still logs under/);
        return true;
      },
    );
    assert.equal(store.getThread(thread.id).worktreePath, null);
  });
});

describe("missing worktree must not fall back to the project checkout (#511)", () => {
  let tmpDir;
  let store;
  let runner;
  let repo;
  let project;
  let worktreeBase;
  let prevSimulate;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtgone2-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");

    repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    project = await services.addProject(store, repo);

    const corePath = path.join(__dirname, "../../core/dist/index.js");
    const core = await import(pathToFileURL(corePath).href);
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      userDataPath: tmpDir,
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clearMissingWorktree re-arms pendingWorktree instead of converting to a checkout thread", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Gone",
    });
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
    });
    git(repo, ["worktree", "remove", "--force", setup.worktreePath]);

    const dropped = clearMissingWorktree({ store, threadId: thread.id });
    assert.equal(dropped, setup.worktreePath);
    const after = store.getThread(thread.id);
    assert.equal(after.worktreePath, null);
    assert.equal(after.pendingWorktree, true);
  });

  it("startRun rematerializes a missing worktree instead of running in the project folder", async () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Gone",
    });
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
    });
    git(repo, ["worktree", "remove", "--force", setup.worktreePath]);
    store.updateThread(thread.id, { worktreePath: setup.worktreePath });
    store.saveNow();

    await runner.startRun({ threadId: thread.id, prompt: "keep going" });

    const after = store.getThread(thread.id);
    assert.ok(after.worktreePath, "must rematerialize a worktree");
    assert.ok(fs.existsSync(after.worktreePath));
    assert.notEqual(after.worktreePath, repo);
    const events = store
      .getMessages(thread.id)
      .filter((m) => m.role === "event");
    assert.ok(
      !events.some((m) =>
        String(m.text).includes("running in the project folder"),
      ),
      "must not announce a silent fallback to the checkout",
    );
  });
});
