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
const PROVIDERS = [
  { id: "claude", name: "Claude Code", available: true },
  { id: "codex", name: "Codex", available: true },
  { id: "opencode", name: "OpenCode", available: true },
];

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

  async function send() {
    const { payload, tree } = teleport.packThread(laptop.store, thread.id);
    const got = await teleport.receiveThread(remote.store, JSON.parse(JSON.stringify(payload)), {
      worktreeBase: remote.worktreeBase,
      providers: PROVIDERS,
      claudeHome: remote.claudeHome,
      from: { threadId: thread.id },
    });
    laptop.store.updateThread(thread.id, {
      teleportedTo: { host: "box", remotePort: 4620, label: "box", threadId: got.threadId, tree },
    });
    return { payload, remoteThread: remote.store.getThread(got.threadId) };
  }

  it("moves branch, uncommitted diff, session, model and effort; ignored files stay", async () => {
    const { payload, remoteThread } = await send();
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
    assert.equal(remoteThread.replayContext, false);
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

  it("comes back: new commits, new edits, transcript and session land on the original thread", async () => {
    const { remoteThread } = await send();
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

  it("refuses to bring a thread back over local edits made since it left", async () => {
    const { remoteThread } = await send();
    fs.writeFileSync(path.join(thread.worktreePath, "a.txt"), "typed here meanwhile\n");
    process.env.CLAUDE_CONFIG_DIR = remote.claudeHome;
    const back = teleport.packThread(remote.store, remoteThread.id).payload;
    assert.throws(() => teleport.returnThread(laptop.store, thread.id, back), /changed here since it was teleported/);
    assert.equal(fs.readFileSync(path.join(thread.worktreePath, "a.txt"), "utf8"), "typed here meanwhile\n");
  });

  it("refuses busy, worktree-less, queued-file and already-teleported threads", () => {
    assert.match(teleport.refuseToPack({ ...thread, status: "working" }), /Stop and teleport/);
    assert.match(teleport.refuseToPack(thread, { isRunning: () => true }), /Stop and teleport/);
    assert.match(teleport.refuseToPack({ ...thread, queued: { prompt: "x", attachments: [{ path: "/a.png" }] } }), /files attached/);
    assert.equal(teleport.refuseToPack({ ...thread, queued: { prompt: "x", items: ["x"] } }), null);
    assert.equal(teleport.refuseToPack({ ...thread, provider: "codex" }), null);
    assert.match(teleport.refuseToPack({ ...thread, worktreePath: null }), /own worktree/);
    assert.match(teleport.refuseToPack({ ...thread, teleportedTo: { host: "box" } }), /already on box/);
    assert.equal(teleport.refuseToPack(thread), null);
  });

  it("refuses on arrival without the repo, the provider, the effort, or a fast-forward", async () => {
    const { payload } = teleport.packThread(laptop.store, thread.id);
    const opts = { worktreeBase: remote.worktreeBase, providers: PROVIDERS, claudeHome: remote.claudeHome };
    await assert.rejects(
      teleport.receiveThread(remote.store, payload, { ...opts, providers: [{ id: "claude", name: "Claude Code", available: false }] }),
      /Claude Code is not installed or not signed in/,
    );
    await assert.rejects(teleport.receiveThread(remote.store, { ...payload, provider: "kimi" }, opts), /kimi is not installed/);
    await assert.rejects(
      teleport.receiveThread(remote.store, { ...payload, thread: { ...payload.thread, reasoningEffort: "ludicrous" } }, opts),
      /Effort "ludicrous" is not available/,
    );
    // v1 senders carry no originUrl: still the old refusal.
    await assert.rejects(
      teleport.receiveThread(remote.store, { ...payload, version: 1, originUrl: undefined, originSlug: "other/repo" }, opts),
      /No project for other\/repo/,
    );
    assert.throws(() => teleport.validatePayload({ ...payload, version: 1, provider: "codex" }), /Claude threads only/);
    git(remote.repo, ["branch", payload.branch, "origin/main"]);
    git(remote.repo, ["checkout", "-q", payload.branch]);
    git(remote.repo, ["config", "user.email", "t@example.com"]);
    git(remote.repo, ["config", "user.name", "T"]);
    git(remote.repo, ["commit", "-q", "--allow-empty", "-m", "diverged"]);
    git(remote.repo, ["checkout", "-q", "main"]);
    await assert.rejects(teleport.receiveThread(remote.store, payload, opts), /already exists here with different commits/);
    assert.equal(remote.store.getThreads().length, 0);
  });

  it("non-Claude: no session travels, both sides replay the transcript; queued prompts ride along", async () => {
    laptop.store.updateThread(thread.id, {
      provider: "codex",
      model: null,
      queued: { prompt: "next\n\nthen", items: ["next", "then"] },
    });
    thread = laptop.store.getThread(thread.id);
    const { payload, remoteThread } = await send();
    assert.equal(payload.version, 2);
    assert.equal(payload.provider, "codex");
    assert.equal(payload.sessionId, null);
    assert.equal(payload.session, "");
    assert.equal(remoteThread.provider, "codex");
    assert.equal(remoteThread.sessionId, null);
    assert.equal(remoteThread.replayContext, true);
    assert.equal(remoteThread.reasoningEffort, "high");
    assert.deepEqual(remoteThread.queued.items, ["next", "then"]);
    assert.deepEqual(remote.store.getMessages(remoteThread.id).map((m) => m.text), ["hi", "hello"]);

    // Ran there (the replay was consumed), queue edited, then back.
    remote.store.updateThread(remoteThread.id, { replayContext: false, sessionId: "codex-sess", queued: { prompt: "last", items: ["last"] } });
    const back = teleport.packThread(remote.store, remoteThread.id).payload;
    assert.equal(back.sessionId, null);
    const updated = teleport.returnThread(laptop.store, thread.id, JSON.parse(JSON.stringify(back)), { providers: PROVIDERS });
    assert.equal(updated.provider, "codex");
    assert.equal(updated.sessionId, null);
    assert.equal(updated.replayContext, true);
    assert.deepEqual(updated.queued.items, ["last"]);
    assert.equal(updated.teleportedTo, null);
  });

  it("skips the effort check for providers without efforts", async () => {
    laptop.store.updateThread(thread.id, { provider: "opencode", model: null, reasoningEffort: "whatever" });
    thread = laptop.store.getThread(thread.id);
    const { remoteThread } = await send();
    assert.equal(remoteThread.provider, "opencode");
  });

  it("clones the repo when the receiver has no project for it", async () => {
    // An https origin the clone accepts, rewritten to the bare repo by a
    // throwaway global git config, so nothing touches the network.
    const bare = path.join(root, "acme", "demo.git");
    const url = "https://git.example.invalid/acme/demo.git";
    const gitconfig = path.join(root, "gitconfig");
    fs.writeFileSync(gitconfig, `[url "${bare}"]\n\tinsteadOf = ${url}\n`);
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gitconfig;
    try {
      git(thread.worktreePath, ["remote", "set-url", "origin", url]);
      // The remote only knows an unrelated repo; clones land beside it.
      const other = path.join(root, "remote", "repos", "other");
      fs.mkdirSync(other, { recursive: true });
      git(other, ["init", "-q"]);
      remote.store.setProjects([{ id: "p-other", slug: "other", name: "other", path: other }]);

      const { payload, remoteThread } = await send();
      assert.equal(payload.originUrl, url);
      const project = remote.store.getProject(remoteThread.projectId);
      assert.equal(realDir(project.path), realDir(path.join(root, "remote", "repos", "demo")));
      assert.equal(fs.readFileSync(path.join(remoteThread.worktreePath, "a.txt"), "utf8"), "a edited\n");
      assert.equal(fs.readFileSync(path.join(remoteThread.worktreePath, "committed.txt"), "utf8"), "local commit\n");
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
  });
});
