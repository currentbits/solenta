"use strict";

/**
 * Teleport (#1702): pack an idle Claude thread on one host, receive it on
 * another, and bring it back. Two Stores and two clones of one bare origin
 * stand in for the laptop and the remote.
 * Run: node --test electron/test/teleport.test.js
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
const { encodeClaudeProjectDir } = require("../cli-sessions-claude.js");
const teleport = require("../teleport.js");
const { rmTree } = require("./support/rmTree.js");

const SID = "11111111-2222-4333-8444-555555555555";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function host(root, name, origin) {
  const repo = path.join(root, name, "demo");
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  git(root, ["clone", "-q", origin, repo]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  const store = new Store(path.join(root, name, "store.json"));
  store.setProjects([{ id: `p-${name}`, slug: "demo", name: "demo", path: repo }]);
  return {
    store,
    repo,
    projectId: `p-${name}`,
    worktreeBase: path.join(root, name, "worktrees"),
    claudeHome: path.join(root, name, "claude"),
  };
}

function realDir(p) {
  return fs.realpathSync(p).normalize("NFC");
}

function sessionPath(home, cwd) {
  return path.join(home, "projects", encodeClaudeProjectDir(realDir(cwd)), `${SID}.jsonl`);
}

describe("teleport", () => {
  let root;
  let laptop;
  let remote;
  let thread;
  let prevClaude;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-teleport-"));
    const origin = path.join(root, "acme", "demo.git");
    git(root, ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = path.join(root, "seed");
    git(root, ["clone", "-q", origin, seed]);
    git(seed, ["config", "user.email", "t@example.com"]);
    git(seed, ["config", "user.name", "T"]);
    fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
    fs.writeFileSync(path.join(seed, "gone.txt"), "bye\n");
    fs.writeFileSync(path.join(seed, ".gitignore"), "secret.env\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", "seed"]);
    git(seed, ["push", "-q", "origin", "HEAD:main"]);

    laptop = host(root, "laptop", origin);
    remote = host(root, "remote", origin);
    prevClaude = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = laptop.claudeHome;

    const t = services.createThread(laptop.store, {
      projectId: laptop.projectId,
      title: "Teleport me",
      provider: "claude",
      model: "claude-opus-5-5",
      projectDefaults: false,
    });
    laptop.store.updateThread(t.id, { reasoningEffort: "high", permissionMode: "acceptEdits" });
    const ready = setupWorktree({ store: laptop.store, threadId: t.id, worktreeBase: laptop.worktreeBase });
    const wt = ready.worktreePath;
    git(wt, ["config", "user.email", "t@example.com"]);
    git(wt, ["config", "user.name", "T"]);
    // A commit origin does not have, then uncommitted work on top.
    fs.writeFileSync(path.join(wt, "committed.txt"), "local commit\n");
    git(wt, ["add", "committed.txt"]);
    git(wt, ["commit", "-qm", "wip commit"]);
    fs.writeFileSync(path.join(wt, "a.txt"), "a edited\n");
    fs.rmSync(path.join(wt, "gone.txt"));
    fs.writeFileSync(path.join(wt, "new.txt"), "untracked\n");
    fs.writeFileSync(path.join(wt, "bin.dat"), Buffer.from([0, 1, 2, 255]));
    fs.writeFileSync(path.join(wt, "secret.env"), "TOKEN=1\n");

    const file = sessionPath(laptop.claudeHome, wt);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ type: "user", cwd: wt, sessionId: SID, message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", cwd: wt, sessionId: SID, message: { role: "assistant", content: "hello" } }),
      "",
    ].join("\n"));
    laptop.store.updateThread(t.id, { sessionId: SID });
    laptop.store.setMessages(t.id, [
      { id: "m1", role: "user", text: "hi", createdAt: 1 },
      { id: "m2", role: "assistant", text: "hello", createdAt: 2 },
    ]);
    thread = laptop.store.getThread(t.id);
  });

  afterEach(() => {
    laptop.store.saveNow();
    remote.store.saveNow();
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    rmTree(root);
  });

  function send() {
    const { payload, tree } = teleport.packThread(laptop.store, thread.id);
    const got = teleport.receiveThread(remote.store, JSON.parse(JSON.stringify(payload)), {
      worktreeBase: remote.worktreeBase,
      claudeAvailable: true,
      claudeHome: remote.claudeHome,
      from: { threadId: thread.id },
    });
    laptop.store.updateThread(thread.id, {
      teleportedTo: { host: "box", remotePort: 4620, label: "box", threadId: got.threadId, tree },
    });
    return { payload, remoteThread: remote.store.getThread(got.threadId) };
  }

  it("moves branch, uncommitted diff, session, model and effort; ignored files stay", () => {
    const { payload, remoteThread } = send();
    assert.deepEqual(payload.ignored, ["secret.env"]);
    const wt = remoteThread.worktreePath;
    assert.equal(remoteThread.branch, thread.branch);
    assert.equal(git(wt, ["rev-parse", "HEAD"]), git(thread.worktreePath, ["rev-parse", "HEAD"]));
    assert.equal(fs.readFileSync(path.join(wt, "a.txt"), "utf8"), "a edited\n");
    assert.equal(fs.existsSync(path.join(wt, "gone.txt")), false);
    assert.equal(fs.readFileSync(path.join(wt, "new.txt"), "utf8"), "untracked\n");
    assert.deepEqual([...fs.readFileSync(path.join(wt, "bin.dat"))], [0, 1, 2, 255]);
    assert.equal(fs.existsSync(path.join(wt, "secret.env")), false);
    assert.equal(remoteThread.model, "claude-opus-5-5");
    assert.equal(remoteThread.reasoningEffort, "high");
    assert.equal(remoteThread.permissionMode, "acceptEdits");
    assert.equal(remoteThread.sessionId, SID);
    assert.equal(remoteThread.teleportedFrom.threadId, thread.id);
    assert.deepEqual(remote.store.getMessages(remoteThread.id).map((m) => m.text), ["hi", "hello"]);
    const lines = fs.readFileSync(sessionPath(remote.claudeHome, wt), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.equal(JSON.parse(line).cwd, realDir(wt));
  });

  it("isolated CLI home (#1808): packThread reads the instance's own CLAUDE_CONFIG_DIR, not the shared home", () => {
    const userDataPath = path.join(root, "userdata");
    const isoHome = path.join(userDataPath, "provider-homes", "iso", "claude");
    const wt = thread.worktreePath;
    // Same session id as the shared-home file beforeEach wrote, but
    // distinct content, so a wrong fallback to the shared home is
    // observable (it would return "hello", not "iso hello").
    const file = sessionPath(isoHome, wt);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ type: "user", cwd: wt, sessionId: SID, message: { role: "user", content: "iso hi" } }),
      JSON.stringify({ type: "assistant", cwd: wt, sessionId: SID, message: { role: "assistant", content: "iso hello" } }),
      "",
    ].join("\n"));
    laptop.store.setSettings({
      providerInstances: [{ id: "iso", name: "solo", provider: "claude", isolatedHome: true, env: {} }],
    });
    laptop.store.updateThread(thread.id, { providerInstance: "iso" });

    const { payload } = teleport.packThread(laptop.store, thread.id, { userDataPath });
    assert.match(payload.session, /iso hello/);

    // Without userDataPath there is nowhere to resolve the isolated home,
    // so it falls back to the default/shared CLAUDE_CONFIG_DIR - never a
    // silent merge of the two homes.
    const { payload: fallback } = teleport.packThread(laptop.store, thread.id);
    assert.doesNotMatch(fallback.session, /iso hello/);
    assert.match(fallback.session, /hello/);
  });

  it("comes back: new commits, new edits, transcript and session land on the original thread", () => {
    const { remoteThread } = send();
    const rwt = remoteThread.worktreePath;
    git(rwt, ["config", "user.email", "t@example.com"]);
    git(rwt, ["config", "user.name", "T"]);
    git(rwt, ["add", "-A"]);
    git(rwt, ["commit", "-qm", "on the remote"]);
    fs.writeFileSync(path.join(rwt, "later.txt"), "after\n");
    remote.store.setMessages(remoteThread.id, [
      ...remote.store.getMessages(remoteThread.id),
      { id: "m3", role: "user", text: "keep going", createdAt: 3 },
    ]);
    fs.appendFileSync(sessionPath(remote.claudeHome, rwt), JSON.stringify({ type: "user", cwd: rwt, message: { role: "user", content: "keep going" } }) + "\n");

    process.env.CLAUDE_CONFIG_DIR = remote.claudeHome;
    const back = teleport.packThread(remote.store, remoteThread.id).payload;
    process.env.CLAUDE_CONFIG_DIR = laptop.claudeHome;
    const updated = teleport.returnThread(laptop.store, thread.id, JSON.parse(JSON.stringify(back)));

    const wt = thread.worktreePath;
    assert.equal(updated.teleportedTo, null);
    assert.equal(git(wt, ["rev-parse", "HEAD"]), git(rwt, ["rev-parse", "HEAD"]));
    assert.equal(git(wt, ["log", "-1", "--format=%s"]), "on the remote");
    assert.equal(fs.readFileSync(path.join(wt, "later.txt"), "utf8"), "after\n");
    assert.equal(fs.readFileSync(path.join(wt, "secret.env"), "utf8"), "TOKEN=1\n");
    assert.deepEqual(laptop.store.getMessages(thread.id).map((m) => m.text), ["hi", "hello", "keep going"]);
    const lines = fs.readFileSync(sessionPath(laptop.claudeHome, wt), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[2]).cwd, realDir(wt));
  });

  it("refuses to bring a thread back over local edits made since it left", () => {
    const { remoteThread } = send();
    fs.writeFileSync(path.join(thread.worktreePath, "a.txt"), "typed here meanwhile\n");
    process.env.CLAUDE_CONFIG_DIR = remote.claudeHome;
    const back = teleport.packThread(remote.store, remoteThread.id).payload;
    assert.throws(() => teleport.returnThread(laptop.store, thread.id, back), /changed here since it was teleported/);
    assert.equal(fs.readFileSync(path.join(thread.worktreePath, "a.txt"), "utf8"), "typed here meanwhile\n");
  });

  it("refuses busy, non-Claude, worktree-less, and already-teleported threads", () => {
    assert.match(teleport.refuseToPack({ ...thread, status: "working" }), /run to finish/);
    assert.match(teleport.refuseToPack(thread, { isRunning: () => true }), /run to finish/);
    assert.match(teleport.refuseToPack({ ...thread, queued: [{ prompt: "x" }] }), /queued prompts/);
    assert.match(teleport.refuseToPack({ ...thread, provider: "codex" }), /Claude threads only/);
    assert.match(teleport.refuseToPack({ ...thread, worktreePath: null }), /own worktree/);
    assert.match(teleport.refuseToPack({ ...thread, teleportedTo: { host: "box" } }), /already on box/);
    assert.equal(teleport.refuseToPack(thread), null);
  });

  it("refuses on arrival without the repo, Claude, the effort, or a fast-forward", () => {
    const { payload } = teleport.packThread(laptop.store, thread.id);
    const opts = { worktreeBase: remote.worktreeBase, claudeAvailable: true, claudeHome: remote.claudeHome };
    assert.throws(() => teleport.receiveThread(remote.store, payload, { ...opts, claudeAvailable: false }), /not installed or not signed in/);
    assert.throws(
      () => teleport.receiveThread(remote.store, { ...payload, thread: { ...payload.thread, reasoningEffort: "ludicrous" } }, opts),
      /Effort "ludicrous" is not available/,
    );
    assert.throws(() => teleport.receiveThread(remote.store, { ...payload, originSlug: "other/repo" }, opts), /No project for other\/repo/);
    git(remote.repo, ["branch", payload.branch, "origin/main"]);
    git(remote.repo, ["checkout", "-q", payload.branch]);
    git(remote.repo, ["config", "user.email", "t@example.com"]);
    git(remote.repo, ["config", "user.name", "T"]);
    git(remote.repo, ["commit", "-q", "--allow-empty", "-m", "diverged"]);
    git(remote.repo, ["checkout", "-q", "main"]);
    assert.throws(() => teleport.receiveThread(remote.store, payload, opts), /already exists here with different commits/);
    assert.equal(remote.store.getThreads().length, 0);
  });
});
