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
  SHELL_TIMEOUT_MS,
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

  it("summarizes failure in one line; the output rides on commandResult (#1216)", () => {
    const text = eventText("Lint", "end", {
      command: "npm run lint",
      ok: false,
      exitCode: 1,
      durationMs: 800,
    });
    assert.equal(text, "[Lint] failed: exit 1 in 0.8s");
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
    const msgs = store.getMessages(thread.id);
    assert.match(msgs.map((m) => m.text).join("\n"), /failed: exit 1/);
    const end = msgs.find((m) => m.commandResult);
    assert.match(end.commandResult.log, /npm ERR/);
    assert.equal(end.commandResult.cwd, updated.worktreePath);
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

  it("keeps each run's bounded output on its own end event (#1216)", async () => {
    const outcomes = [
      { ok: true, exitCode: 0, timedOut: false, log: "Coverage 91.2%", durationMs: 5 },
      { ok: false, exitCode: 2, timedOut: false, log: "x".repeat(50_000), durationMs: 6 },
      { ok: false, exitCode: null, timedOut: true, log: "hung", durationMs: 7 },
    ];
    setRunCommandFn(() => Promise.resolve(outcomes.shift()));
    services.updateProject(store, project.id, {
      quickActions: [{ id: "cov", name: "Coverage", command: "npm run cov" }],
    });
    const deps = { runner: { isRunning: () => false } };
    const returned = [];
    for (let i = 0; i < 3; i++) {
      returned.push(await runCommand(store, { threadId, actionId: "cov" }, deps));
    }
    const ends = store.getMessages(threadId).filter((m) => m.commandResult);
    assert.equal(ends.length, 3, "one result per invocation, same action");
    assert.deepEqual(
      ends.map((m) => m.commandResult),
      returned,
      "the API result is what the transcript keeps",
    );
    assert.equal(ends[0].commandResult.log, "Coverage 91.2%");
    assert.equal(ends[0].commandResult.cwd, project.path);
    assert.equal(ends[0].text, "[Coverage] ok in 0.0s");
    assert.ok(ends[1].commandResult.log.length < 8100, "log stays bounded");
    assert.match(ends[1].commandResult.log, /^…\[42000 chars trimmed\]…/);
    assert.equal(ends[1].text, "[Coverage] failed: exit 2 in 0.0s");
    assert.equal(ends[2].commandResult.timedOut, true);
    assert.equal(ends[2].text, "[Coverage] timed out in 0.0s");
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
    assert.deepEqual(store.getMessages(threadId), [], "a rejected start logs nothing");
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

  it("runs a typed `!` line as one live card, capped at 60s (#470)", async () => {
    // Real shell + real runner: output must reach the card before exit.
    const pushes = [];
    const broadcast = (channel, payload) => {
      if (channel !== "thread:updated") return;
      const card = payload.messages.find((m) => m.commandResult);
      if (card) pushes.push(card.commandResult);
    };
    const result = await runCommand(
      store,
      { threadId, command: "  printf first; sleep 1; printf second; exit 3  " },
      { runner: { isRunning: () => false }, broadcast },
    );
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.equal(result.shell, true);
    assert.equal(result.cwd, project.path);
    assert.equal(result.log, "firstsecond");
    assert.ok(
      pushes.some((r) => r.running && r.log === "first"),
      "partial output was pushed while the command ran",
    );
    const cards = store.getMessages(threadId);
    assert.equal(cards.length, 1, "start and end share one event");
    assert.match(cards[0].text, /^\$ printf first; sleep 1; printf second; exit 3 · exit 3 · /);
    assert.equal(cards[0].commandResult.running, undefined);
    assert.equal(SHELL_TIMEOUT_MS, 60_000);
  });

  it("passes the 60s cap to the runner and rejects an empty `!` (#470)", async () => {
    const calls = [];
    setRunCommandFn((input) => {
      calls.push(input);
      return Promise.resolve({ ok: true, exitCode: 0, timedOut: false, log: "", durationMs: 1 });
    });
    const deps = { runner: { isRunning: () => false } };
    await runCommand(store, { threadId, command: "git status" }, deps);
    assert.equal(calls[0].timeoutMs, SHELL_TIMEOUT_MS);
    assert.equal(calls[0].command, "git status");
    await assert.rejects(
      () => runCommand(store, { threadId, command: "   " }, deps),
      /type a command/i,
    );
    await assert.rejects(
      () => runCommand(store, { threadId, command: "x".repeat(VERIFY_COMMAND_MAX + 1) }, deps),
      /limited to/i,
      "never runs a silently truncated line",
    );
    assert.equal(calls.length, 1);
    await assert.rejects(
      () =>
        runCommand(store, { threadId, command: "ls" }, { runner: { isRunning: () => true } }),
      /run is already active/i,
    );
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
