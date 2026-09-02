"use strict";

/**
 * Reclaim remote $HOME/.solenta/grok-homes/<threadId> overlays (#833).
 *
 * #821 deploys the PreToolUse overlay onto the ssh/WSL host. Local
 * userDataPath/grok-homes dirs are reclaimed by #706. Remote dests were
 * never removed. Retention must delete them without following the
 * auth/session symlinks into ~/.grok, and a dead host must not block
 * the local pass.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ssh = require("../ssh.js");
const {
  materializeGrokHome,
  remoteGrokHomeReclaimScript,
} = require("../grok.js");
const { scheduleRetention } = require("../worktrees.js");

const AUTH_BODY = "do-not-delete-me\n";
const SESSION = '{"id":"live-session"}\n';

const SSH_PROJECT = {
  id: "ssh-proj",
  path: "/unused",
  remoteHost: "dev@box",
  remotePath: "/srv/app",
};

const LOCAL_PROJECT = {
  id: "local-proj",
  path: "/local/repo",
};

function makeStore(threads, projects) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const projById = new Map(projects.map((p) => [p.id, p]));
  return {
    getProjects: () => projects,
    getProject: (id) => projById.get(id) || null,
    getThreads: () => threads,
    getThread: (id) => byId.get(id) || null,
    getSettings: () => ({}),
  };
}

function remoteScripts(calls) {
  return calls
    .filter((c) => c.bin === "ssh")
    .map((c) => String(c.args[c.args.length - 1] || ""));
}

describe("remote grok-home reclaim (#833)", () => {
  /** @type {Array<{ bin: string, args: string[], opts: object }>} */
  let calls;
  let tmpDir;
  let sourceHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-remote-reclaim-"));
    sourceHome = path.join(tmpDir, "real-grok");
    fs.mkdirSync(sourceHome);
    fs.writeFileSync(path.join(sourceHome, "auth.json"), AUTH_BODY);
    fs.mkdirSync(path.join(sourceHome, "sessions"));
    fs.writeFileSync(path.join(sourceHome, "sessions", "keep-me.json"), SESSION);
    calls = [];
    ssh.setExecFileSync((bin, args, opts) => {
      calls.push({ bin, args, opts: opts || {} });
      return "";
    });
  });

  afterEach(() => {
    ssh.setExecFileSync(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scheduleRetention deletes the remote overlay for an archived grok thread", async () => {
    const staleId = "stale-grok-thread";
    await scheduleRetention({
      store: makeStore(
        [
          {
            id: staleId,
            projectId: SSH_PROJECT.id,
            provider: "grok",
            status: "idle",
            archived: true,
          },
        ],
        [SSH_PROJECT],
      ),
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    const scripts = remoteScripts(calls);
    assert.ok(
      scripts.some(
        (s) =>
          s.includes(".solenta/grok-homes/") &&
          s.includes(staleId) &&
          !s.includes("rm -rf"),
      ),
      "archived ssh grok thread must reclaim ~/.solenta/grok-homes/<threadId>",
    );
    assert.ok(
      scripts.some((s) => s.includes("cd '/srv/app'") && s.includes("'sh' '-c'")),
      "delete must go through wrapCommand (ssh cd && sh -c)",
    );
  });

  it("scheduleRetention deletes the remote overlay for a settled grok thread", async () => {
    const settledId = "settled-grok-thread";
    await scheduleRetention({
      store: makeStore(
        [
          {
            id: settledId,
            projectId: SSH_PROJECT.id,
            provider: "grok",
            status: "done",
            settledOverride: "settled",
          },
        ],
        [SSH_PROJECT],
      ),
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    const scripts = remoteScripts(calls);
    assert.ok(
      scripts.some((s) => s.includes(".solenta/grok-homes/") && s.includes(settledId)),
      "settled ssh grok thread must reclaim ~/.solenta/grok-homes/<threadId>",
    );
  });

  it("skips working and quota-wait grok threads (same as isLiveGrokThread)", async () => {
    await scheduleRetention({
      store: makeStore(
        [
          {
            id: "working-grok",
            projectId: SSH_PROJECT.id,
            provider: "grok",
            status: "working",
            archived: true,
          },
          {
            id: "quota-grok",
            projectId: SSH_PROJECT.id,
            provider: "grok",
            status: "quota-wait",
            settledOverride: "settled",
          },
        ],
        [SSH_PROJECT],
      ),
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    const blob = remoteScripts(calls).join("\n");
    assert.equal(blob.includes("working-grok"), false, "working thread overlay must survive");
    assert.equal(blob.includes("quota-grok"), false, "quota-wait thread overlay must survive");
  });

  it("skips idle (not archived/settled) grok threads and local / non-grok threads", async () => {
    await scheduleRetention({
      store: makeStore(
        [
          {
            id: "idle-grok",
            projectId: SSH_PROJECT.id,
            provider: "grok",
            status: "idle",
          },
          {
            id: "local-archived-grok",
            projectId: LOCAL_PROJECT.id,
            provider: "grok",
            status: "idle",
            archived: true,
          },
          {
            id: "ssh-claude",
            projectId: SSH_PROJECT.id,
            provider: "claude",
            status: "idle",
            archived: true,
          },
        ],
        [SSH_PROJECT, LOCAL_PROJECT],
      ),
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    const blob = remoteScripts(calls).join("\n");
    assert.equal(blob.includes("idle-grok"), false);
    assert.equal(blob.includes("local-archived-grok"), false);
    assert.equal(blob.includes("ssh-claude"), false);
  });

  it("does not follow auth/session symlinks into ~/.grok", async () => {
    const staleId = "stale-symlink-thread";
    const remoteHome = path.join(tmpDir, "remote-home");
    const dest = path.join(remoteHome, ".solenta", "grok-homes", staleId);
    materializeGrokHome({ dest, sourceHome, mcpServers: {} });
    assert.ok(fs.lstatSync(path.join(dest, "auth.json")).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(dest, "sessions")).isSymbolicLink());

    await scheduleRetention({
      store: makeStore(
        [
          {
            id: staleId,
            projectId: SSH_PROJECT.id,
            provider: "grok",
            status: "idle",
            archived: true,
          },
        ],
        [SSH_PROJECT],
      ),
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    const wrapped = remoteScripts(calls).find(
      (s) => s.includes(".solenta/grok-homes/") && s.includes(staleId),
    );
    assert.ok(wrapped, "reclaim must go through wrapCommand");
    assert.match(wrapped, /cd '\/srv\/app' && 'sh' '-c'/);
    assert.equal(wrapped.includes("rm -rf"), false, "rm -rf would follow dir symlinks");

    const body = remoteGrokHomeReclaimScript([staleId]);
    execFileSync("/bin/sh", ["-c", body], {
      encoding: "utf8",
      env: { ...process.env, HOME: remoteHome },
    });

    assert.equal(
      fs.existsSync(dest),
      false,
      "remote overlay directory must be gone",
    );
    assert.equal(
      fs.readFileSync(path.join(sourceHome, "auth.json"), "utf8"),
      AUTH_BODY,
      "auth.json symlink target must not be deleted",
    );
    assert.equal(
      fs.readFileSync(path.join(sourceHome, "sessions", "keep-me.json"), "utf8"),
      SESSION,
      "sessions/ dir symlink must not be followed into ~/.grok",
    );
  });

  it("a remote exec failure does not block local overlay reclaim", async () => {
    const localStale = "local-stale";
    const localDest = path.join(tmpDir, "grok-homes", localStale);
    materializeGrokHome({ dest: localDest, sourceHome, mcpServers: {} });

    ssh.setExecFileSync((bin, args) => {
      calls.push({ bin, args, opts: {} });
      if (String(args[args.length - 1] || "").includes(".solenta/grok-homes/")) {
        throw new Error("ssh: connection refused");
      }
      return "";
    });

    await scheduleRetention({
      store: makeStore(
        [
          {
            id: localStale,
            projectId: LOCAL_PROJECT.id,
            provider: "grok",
            status: "idle",
          },
          {
            id: "remote-stale",
            projectId: SSH_PROJECT.id,
            provider: "grok",
            status: "idle",
            archived: true,
          },
        ],
        [SSH_PROJECT, LOCAL_PROJECT],
      ),
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    assert.equal(
      fs.existsSync(localDest),
      false,
      "local #706 reclaim must still run when the remote host is dead",
    );
  });
});
