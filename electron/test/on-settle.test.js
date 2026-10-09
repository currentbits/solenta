"use strict";

/**
 * #1531: solenta.json `onSettle` runs once in a worktree thread's checkout
 * when it settles (explicit settle, or its PR merging/closing). Never
 * blocks or fails the settle.
 * Run: npm run test:electron -- electron/test/on-settle.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree, refreshPrStates } = require("../worktrees.js");
const { runOnSettle, runCommand, setRunCommandFn } = require("../projectCommands.js");
const { parseRepoConfig } = require("../repoConfig.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function events(store, threadId) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === "event")
    .map((m) => String(m.text));
}

const OK = { ok: true, exitCode: 0, timedOut: false, log: "", durationMs: 1 };

describe("solenta.json onSettle schema", () => {
  it("takes a command string or a quickActions name", () => {
    assert.equal(parseRepoConfig({ onSettle: " make down " }).onSettle, "make down");
    const named = parseRepoConfig({
      quickActions: [{ name: "Stop DB", command: "docker compose down" }],
      onSettle: "Stop DB",
    });
    assert.equal(named.onSettle, "docker compose down");
  });

  it("rejects a bad onSettle as a whole-file error", () => {
    for (const bad of [{ onSettle: 3 }, { onSettle: "  " }]) {
      const cfg = parseRepoConfig(bad);
      assert.ok(cfg && cfg.error, JSON.stringify(bad));
      assert.equal(cfg.onSettle, undefined);
    }
  });

  it("keeps old approval hashes and re-prompts when onSettle is added", () => {
    const old = createHash("sha256")
      .update(JSON.stringify({ setup: "npm ci", quickActions: [] }))
      .digest("hex");
    assert.equal(parseRepoConfig({ setup: "npm ci" }).hash, old);
    assert.notEqual(
      parseRepoConfig({ setup: "npm ci", onSettle: "make down" }).hash,
      old,
    );
  });
});

describe("onSettle runs", () => {
  let tmpDir;
  let store;
  let repo;
  let project;
  let thread;
  let ran;

  /** @param {object} cfg */
  function writeConfig(cfg) {
    const file = path.join(repo, "solenta.json");
    fs.writeFileSync(file, JSON.stringify(cfg));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
  }

  function approve() {
    const hash = services.listProjects(store)[0].repoConfig.hash;
    store.setProjects(store.getProjects().map((p) => ({ ...p, repoConfigTrust: hash })));
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-onsettle-"));
    store = new Store(path.join(tmpDir, "store.json"));
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    writeConfig({ onSettle: "make down" });
    project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "T" });
    thread = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase: path.join(tmpDir, "worktrees"),
      broadcast: () => {},
    });
    ran = [];
    setRunCommandFn(async (input) => {
      ran.push({ command: input.command, cwd: input.cwd, exists: fs.existsSync(input.cwd) });
      return OK;
    });
  });

  afterEach(() => {
    setRunCommandFn(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("an explicit settle runs it once in the worktree", async () => {
    approve();
    let done;
    const called = new Promise((r) => (done = r));
    setRunCommandFn(async (input) => {
      ran.push({ command: input.command, cwd: input.cwd });
      done();
      return OK;
    });
    const settled = services.setSettled(store, { threadId: thread.id, override: "settled" });
    assert.equal(settled.settledOverride, "settled");
    await called;
    assert.deepEqual(ran, [{ command: "make down", cwd: thread.worktreePath }]);

    // Settled again without new activity: no second teardown.
    services.setSettled(store, { threadId: thread.id, override: null });
    services.setSettled(store, { threadId: thread.id, override: "settled" });
    assert.equal(await runOnSettle({ store, threadId: thread.id }), null);
    assert.equal(ran.length, 1);
  });

  it("new activity re-arms it for the next settle", async () => {
    approve();
    await runOnSettle({ store, threadId: thread.id });
    const t = store.getThread(thread.id);
    store.updateThread(thread.id, services.clearSettledOnActivity(t));
    await runOnSettle({ store, threadId: thread.id });
    assert.equal(ran.length, 2);
    const ev = events(store, thread.id);
    assert.ok(ev.some((e) => e === "[onSettle] running make down"));
    assert.ok(ev.some((e) => /^\[onSettle\] ok in/.test(e)));
  });

  it("an unapproved file is skipped with an event", async () => {
    assert.equal(await runOnSettle({ store, threadId: thread.id }), null);
    assert.deepEqual(ran, []);
    assert.ok(events(store, thread.id).some((e) => /\[onSettle\] skipped/.test(e)));
  });

  it("a failing command never fails the settle", async () => {
    approve();
    setRunCommandFn(async () => {
      throw new Error("boom");
    });
    const settled = services.setSettled(store, { threadId: thread.id, override: "settled" });
    assert.equal(settled.settledOverride, "settled");
    const result = await runOnSettle({
      store,
      threadId: services.createThread(store, { projectId: project.id, title: "x" }).id,
    });
    assert.equal(result, null, "a thread without a worktree runs nothing");
  });

  it("is runnable by hand as actionId onSettle after approval", async () => {
    const hash = services.listProjects(store)[0].repoConfig.hash;
    await assert.rejects(
      runCommand(store, { threadId: thread.id, actionId: "onSettle" }),
      /REPO_CONFIG_UNTRUSTED/,
    );
    const result = await runCommand(store, {
      threadId: thread.id,
      actionId: "onSettle",
      trustRepoConfig: hash,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(ran.map((r) => r.command), ["make down"]);
  });

  describe("on a PR flip", () => {
    const gh = (state) => async () => ({
      ok: true,
      stdout: JSON.stringify({ number: 7, url: "https://github.com/acme/demo/pull/7", state }),
      stderr: "",
      combined: "",
    });

    beforeEach(() => {
      git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
      store.updateThread(thread.id, {
        prNumber: 7,
        prUrl: "https://github.com/acme/demo/pull/7",
        prState: "OPEN",
      });
      approve();
    });

    it("runs before the merged cleanup, while the checkout still exists", async () => {
      await refreshPrStates(store, { ghTryAsyncFn: gh("MERGED") });
      assert.deepEqual(ran, [{ command: "make down", cwd: thread.worktreePath, exists: true }]);
    });

    it("skips a thread the user kept active", async () => {
      store.updateThread(thread.id, { settledOverride: "active" });
      await refreshPrStates(store, { ghTryAsyncFn: gh("CLOSED") });
      assert.deepEqual(ran, []);
    });

    it("skips a merge when settle-on-merge is off", async () => {
      store.setSettings({ autoSettleOnMerge: false });
      await refreshPrStates(store, { ghTryAsyncFn: gh("MERGED") });
      assert.deepEqual(ran, []);
    });
  });
});
