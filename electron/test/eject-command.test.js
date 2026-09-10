"use strict";

/**
 * #554 remaining: eject copies (and optionally runs in $TERMINAL) the
 * per-provider command to continue the thread in the raw CLI.
 *
 * Run: node --test electron/test/eject-command.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { ejectCommand } = require("../providers.js");
const { posixQuote } = require("../ssh.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("ejectCommand (#554)", () => {
  const cwd = "/tmp/solenta-wt";

  it("Claude copies cd && claude --resume <sessionId>", () => {
    const { command } = ejectCommand({
      provider: "claude",
      sessionId: "sess-claude",
      cwd,
    });
    assert.equal(
      command,
      `cd ${posixQuote(cwd)} && claude --resume ${posixQuote("sess-claude")}`,
    );
  });

  it("Codex copies cd && codex exec resume <id>", () => {
    const { command } = ejectCommand({
      provider: "codex",
      sessionId: "01a072f7-10e0-7fd2-b691-7d481327516f",
      cwd,
    });
    assert.equal(
      command,
      `cd ${posixQuote(cwd)} && codex exec resume ${posixQuote("01a072f7-10e0-7fd2-b691-7d481327516f")}`,
    );
  });

  it("Codex eject warns from the session-start model even after usage catches up to the picker", () => {
    const sessionId = "01a072f7-10e0-7fd2-b691-7d481327516f";
    const { command, note } = ejectCommand({
      provider: "codex",
      sessionId,
      cwd,
      model: "gpt-6-astra",
      sessionStartModel: "gpt-5.6-sol",
      usageModel: "gpt-6-astra",
    });
    const resume =
      `cd ${posixQuote(cwd)} && codex exec resume ${posixQuote(sessionId)}`;
    assert.equal(command.split("\n")[0], resume);
    assert.equal(command.includes("-m"), false, "must not pretend -m switches the rollout");
    assert.ok(note);
    assert.match(note, /cannot honor/i);
    assert.match(note, /gpt-6-astra/);
    assert.match(note, /gpt-5.6-sol/);
    assert.match(command, /# /);
  });

  it("Claude model-only switch does not add an exec-resume warning", () => {
    const { command, note } = ejectCommand({
      provider: "claude",
      sessionId: "sess-claude",
      cwd,
      model: "claude-sonnet-5",
      sessionStartModel: "claude-opus-5",
    });
    assert.equal(
      command,
      `cd ${posixQuote(cwd)} && claude --resume ${posixQuote("sess-claude")}`,
    );
    assert.equal(note, undefined);
  });

  it("a provider without resume still copies cd", () => {
    const { command, note } = ejectCommand({
      provider: "simulate",
      sessionId: "ignored",
      cwd,
    });
    assert.match(command, new RegExp(`^cd ${posixQuote(cwd)}`));
    assert.equal(command.includes("&&"), false);
    assert.ok(note);
  });
});

describe("setEjected copies the command (#554)", () => {
  let tmpDir;
  let store;
  let threadId;
  let projectPath;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-eject-cmd-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    projectPath = project.path;
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    }).id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("eject copies the Codex resume command", () => {
    let copied = null;
    services.setProvider(store, { threadId, provider: "codex" });
    store.updateThread(threadId, { sessionId: "codex-sess" });
    services.setEjected(
      store,
      { threadId, ejected: true },
      { writeText: (text) => { copied = text; } },
    );
    assert.equal(
      copied,
      `cd ${posixQuote(projectPath)} && codex exec resume ${posixQuote("codex-sess")}`,
    );
  });

  it("eject still warns when usage.model has caught up to the picker but the rollout has not", () => {
    let copied = null;
    services.setProvider(store, { threadId, provider: "codex" });
    store.updateThread(threadId, { model: "gpt-5.6-sol" });
    store.updateThread(threadId, { sessionId: "codex-sess" });
    store.updateThread(threadId, { model: "gpt-6-astra" });
    store.setUsage(threadId, {
      model: "gpt-6-astra",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      turns: 1,
    });
    services.setEjected(
      store,
      { threadId, ejected: true },
      { writeText: (text) => { copied = text; } },
    );
    assert.equal(
      copied.split("\n")[0],
      `cd ${posixQuote(projectPath)} && codex exec resume ${posixQuote("codex-sess")}`,
    );
    assert.equal(copied.includes("-m"), false);
    assert.match(copied, /cannot honor/i);
    assert.match(copied, /gpt-6-astra/);
    assert.match(copied, /gpt-5.6-sol/);
  });

  it("eject cds into the bound worktree, not the project checkout", () => {
    let copied = null;
    const wt = path.join(tmpDir, "wt");
    fs.mkdirSync(wt);
    services.setProvider(store, { threadId, provider: "claude" });
    store.updateThread(threadId, { sessionId: "sess", worktreePath: wt });
    services.setEjected(
      store,
      { threadId, ejected: true },
      { writeText: (text) => { copied = text; } },
    );
    assert.equal(
      copied,
      `cd ${posixQuote(wt)} && claude --resume ${posixQuote("sess")}`,
    );
    assert.equal(copied.includes(projectPath), false);
  });

  it("eject copies the Claude resume command", () => {
    let copied = null;
    services.setProvider(store, { threadId, provider: "claude" });
    store.updateThread(threadId, { sessionId: "claude-sess" });
    services.setEjected(
      store,
      { threadId, ejected: true },
      { writeText: (text) => { copied = text; } },
    );
    assert.equal(
      copied,
      `cd ${posixQuote(projectPath)} && claude --resume ${posixQuote("claude-sess")}`,
    );
  });

  it("eject of a provider without resume still copies cd", () => {
    let copied = null;
    // simulate is not in setProvider's catalog unless CODER_SIMULATE=1.
    store.updateThread(threadId, { provider: "simulate", sessionId: "nope" });
    services.setEjected(
      store,
      { threadId, ejected: true },
      { writeText: (text) => { copied = text; } },
    );
    assert.match(copied, new RegExp(`^cd ${posixQuote(projectPath)}`));
    assert.equal(copied.includes("&&"), false);
  });

  it("reclaim does not copy", () => {
    let copied = null;
    services.setEjected(store, { threadId, ejected: true }, { writeText() {} });
    services.setEjected(
      store,
      { threadId, ejected: false },
      { writeText: (text) => { copied = text; } },
    );
    assert.equal(copied, null);
  });

  it("runs $TERMINAL -e when TERMINAL is set", () => {
    const spawned = [];
    services.setProvider(store, { threadId, provider: "claude" });
    store.updateThread(threadId, { sessionId: "sess" });
    services.setEjected(
      store,
      { threadId, ejected: true },
      {
        writeText() {},
        env: { TERMINAL: "/usr/bin/xterm" },
        spawn(cmd, args) {
          spawned.push({ cmd, args });
          return { unref() {} };
        },
      },
    );
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cmd, "/usr/bin/xterm");
    assert.equal(spawned[0].args[0], "-e");
    assert.ok(
      spawned[0].args.some(
        (a) =>
          typeof a === "string" &&
          a.includes("claude") &&
          a.includes("--resume"),
      ),
      JSON.stringify(spawned[0].args),
    );
  });
});
