"use strict";

/**
 * Issue #153: per-project setupCommand + named quickActions.
 * Run: npm run test:electron -- electron/test/project-commands.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree } = require("../worktrees.js");
const {
  SETUP_ID,
  QUICK_ACTION_MAX,
  ACTION_NAME_MAX,
  normalizeSetupCommand,
  normalizeQuickActions,
  waitForCommand,
  runCommand,
  setRunCommandFn,
  kickWorktreeSetup,
  eventText,
  formatDuration,
} = require("../projectCommands.js");
const { VERIFY_COMMAND_MAX } = require("../verify.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("normalizeSetupCommand / normalizeQuickActions", () => {
  it("treats empty setup as unset", () => {
    assert.equal(normalizeSetupCommand(""), null);
    assert.equal(normalizeSetupCommand("  "), null);
    assert.equal(normalizeSetupCommand(null), null);
    assert.equal(normalizeSetupCommand(12), null);
  });

  it("trims and caps setup like verify", () => {
    assert.equal(normalizeSetupCommand("  npm i  "), "npm i");
    assert.equal(
      normalizeSetupCommand("x".repeat(VERIFY_COMMAND_MAX + 20)).length,
      VERIFY_COMMAND_MAX,
    );
  });

  it("drops junk quick-action rows and caps the list", () => {
    assert.equal(normalizeQuickActions(null), null);
    assert.equal(normalizeQuickActions("nope"), null);
    assert.equal(normalizeQuickActions([{ name: "Lint" }]), null);
    const rows = normalizeQuickActions([
      { id: "lint", name: " Lint ", command: " npm run lint " },
      { name: "", command: "echo x" },
      { id: SETUP_ID, name: "Install", command: "npm i" },
      { id: "lint", name: "Dup", command: "echo dup" },
    ]);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].id, "lint");
    assert.equal(rows[0].name, "Lint");
    assert.equal(rows[0].command, "npm run lint");
    assert.notEqual(rows[1].id, SETUP_ID);
    assert.equal(rows[1].name, "Install");
    assert.notEqual(rows[2].id, "lint");
    assert.equal(rows[2].name, "Dup");
  });

  it("caps name length and list size", () => {
    const long = "n".repeat(ACTION_NAME_MAX + 10);
    const many = Array.from({ length: QUICK_ACTION_MAX + 3 }, (_, i) => ({
      name: `a${i}`,
      command: `echo ${i}`,
    }));
    const rows = normalizeQuickActions([
      { name: long, command: "echo x" },
      ...many,
    ]);
    assert.equal(rows[0].name.length, ACTION_NAME_MAX);
    assert.equal(rows.length, QUICK_ACTION_MAX);
  });
});

describe("event text", () => {
  it("formats start and success without an em dash", () => {
    assert.equal(
      eventText("setup", "start", { command: "npm i" }),
      "[setup] running npm i",
    );
    assert.equal(
      eventText("setup", "end", {
        command: "npm i",
        ok: true,
        durationMs: 12400,
      }),
      "[setup] ok in 12s",
    );
    assert.match(formatDuration(4100), /4\.1s/);
  });

  it("includes the log tail on failure", () => {
    const text = eventText("Lint", "end", {
      command: "npm run lint",
      ok: false,
      exitCode: 1,
      durationMs: 800,
      log: "boom",
    });
    assert.match(text, /\[Lint\] failed: exit 1 in 0\.8s/);
    assert.match(text, /boom/);
  });
});

describe("setup on worktree create", () => {
  let tmpDir;
  let store;
  let repo;
  let project;
  let thread;
  let worktreeBase;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pcmd-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    try {
      git(repo, ["checkout", "-b", "main"]);
    } catch {
      // already on main
    }
    project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "Setup work",
    });
  });

  afterEach(async () => {
    if (thread) await waitForCommand(thread.id);
    setRunCommandFn(null);
    try {
      for (const t of store.getThreads()) {
        if (t && t.worktreePath && fs.existsSync(t.worktreePath)) {
          try {
            git(repo, ["worktree", "remove", "--force", t.worktreePath]);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not spawn when no setupCommand is set", async () => {
    const calls = [];
    setRunCommandFn((input) => {
      calls.push(input);
      return Promise.resolve({
        ok: true,
        exitCode: 0,
        timedOut: false,
        log: "",
        durationMs: 1,
      });
    });
    setupWorktree({ store, threadId: thread.id, worktreeBase, broadcast: () => {} });
    await waitForCommand(thread.id);
    assert.equal(calls.length, 0);
  });

  it("runs setupCommand in the new worktree and logs events", async () => {
    const calls = [];
    setRunCommandFn((input) => {
      calls.push(input);
      return Promise.resolve({
        ok: true,
        exitCode: 0,
        timedOut: false,
        log: "added 12 packages",
        durationMs: 42,
      });
    });
    services.updateProject(store, project.id, { setupCommand: "npm install" });
    const live = store.getProject(project.id);
    const updated = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    await waitForCommand(thread.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "npm install");
    assert.equal(calls[0].cwd, updated.worktreePath);
    assert.equal(calls[0].project.id, live.id);
    const texts = store.getMessages(thread.id).map((m) => m.text);
    assert.ok(texts.some((t) => t.includes("[setup] running npm install")));
    assert.ok(texts.some((t) => t.includes("[setup] ok")));
  });

  it("does not re-run on the idempotent second setupWorktree call", async () => {
    const calls = [];
    setRunCommandFn((input) => {
      calls.push(input);
      return Promise.resolve({
        ok: true,
        exitCode: 0,
        timedOut: false,
        log: "",
        durationMs: 1,
      });
    });
    services.updateProject(store, project.id, { setupCommand: "npm i" });
    setupWorktree({ store, threadId: thread.id, worktreeBase, broadcast: () => {} });
    await waitForCommand(thread.id);
    assert.equal(calls.length, 1);
    setupWorktree({ store, threadId: thread.id, worktreeBase, broadcast: () => {} });
    await waitForCommand(thread.id);
    assert.equal(calls.length, 1);
  });

  it("keeps the worktree when setup fails", async () => {
    setRunCommandFn(() =>
      Promise.resolve({
        ok: false,
        exitCode: 1,
        timedOut: false,
        log: "npm ERR! missing",
        durationMs: 8,
      }),
    );
    services.updateProject(store, project.id, { setupCommand: "npm install" });
    const updated = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    await waitForCommand(thread.id);
    assert.ok(updated.worktreePath);
    assert.ok(fs.existsSync(updated.worktreePath));
    const texts = store.getMessages(thread.id).map((m) => m.text).join("\n");
    assert.match(texts, /failed: exit 1/);
    assert.match(texts, /npm ERR/);
  });

  it("writes a marker via a real shell command", async () => {
    services.updateProject(store, project.id, {
      setupCommand: "echo SETUP_OK > .setup-flag",
    });
    const updated = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const result = await waitForCommand(thread.id);
    assert.equal(result.ok, true);
    const flag = fs.readFileSync(
      path.join(updated.worktreePath, ".setup-flag"),
      "utf8",
    );
    assert.match(flag, /SETUP_OK/);
  });
});

describe("runCommand", () => {
  let tmpDir;
  let store;
  let project;
  let threadId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pcmd-run-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Actions",
    }).id;
  });

  afterEach(async () => {
    if (threadId) await waitForCommand(threadId);
    setRunCommandFn(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs a named quick action in the project path when there is no worktree", async () => {
    const calls = [];
    setRunCommandFn((input) => {
      calls.push(input);
      return Promise.resolve({
        ok: true,
        exitCode: 0,
        timedOut: false,
        log: "clean",
        durationMs: 3,
      });
    });
    services.updateProject(store, project.id, {
      quickActions: [{ id: "lint", name: "Lint", command: "npm run lint" }],
    });
    const result = await runCommand(
      store,
      { threadId, actionId: "lint" },
      { runner: { isRunning: () => false } },
    );
    assert.equal(result.ok, true);
    assert.equal(result.name, "Lint");
    assert.equal(calls[0].command, "npm run lint");
    assert.equal(calls[0].cwd, project.path);
    const texts = store.getMessages(threadId).map((m) => m.text);
    assert.ok(texts.some((t) => t.includes("[Lint] running npm run lint")));
    assert.ok(texts.some((t) => t.includes("[Lint] ok")));
  });

  it("rejects an unknown action, a missing setup, and an active run", async () => {
    await assert.rejects(
      () =>
        runCommand(
          store,
          { threadId, actionId: "nope" },
          { runner: { isRunning: () => false } },
        ),
      /unknown quick action/i,
    );
    await assert.rejects(
      () =>
        runCommand(
          store,
          { threadId, actionId: SETUP_ID },
          { runner: { isRunning: () => false } },
        ),
      /no setup command/i,
    );
    services.updateProject(store, project.id, { setupCommand: "npm i" });
    await assert.rejects(
      () =>
        runCommand(
          store,
          { threadId, actionId: SETUP_ID },
          { runner: { isRunning: () => true } },
        ),
      /run is already active/i,
    );
  });

  it("rejects a second command while one is in flight", async () => {
    let release;
    setRunCommandFn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              exitCode: 0,
              timedOut: false,
              log: "",
              durationMs: 1,
            });
        }),
    );
    services.updateProject(store, project.id, { setupCommand: "npm i" });
    const first = runCommand(
      store,
      { threadId, actionId: SETUP_ID },
      { runner: { isRunning: () => false } },
    );
    await assert.rejects(
      () =>
        runCommand(
          store,
          { threadId, actionId: SETUP_ID },
          { runner: { isRunning: () => false } },
        ),
      /already running/i,
    );
    release();
    await first;
  });
});

describe("kickWorktreeSetup with no command", () => {
  it("resolves null without touching the runner", async () => {
    const calls = [];
    setRunCommandFn((input) => {
      calls.push(input);
      return Promise.resolve({
        ok: true,
        exitCode: 0,
        timedOut: false,
        log: "",
        durationMs: 1,
      });
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pcmd-kick-"));
    try {
      const store = new Store(path.join(tmpDir, "store.json"));
      const result = await kickWorktreeSetup({
        store,
        threadId: "missing",
        cwd: tmpDir,
        project: { path: tmpDir },
      });
      assert.equal(result, null);
      assert.equal(calls.length, 0);
    } finally {
      setRunCommandFn(null);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
