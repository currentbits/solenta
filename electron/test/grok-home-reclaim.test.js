"use strict";

/**
 * Reclaim grok-homes/<threadId> overlays (#706).
 *
 * The overlay is a handful of symlinks into the user's real ~/.grok plus a
 * rewritten config.toml. Retention must delete the overlay directory without
 * following those links.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { materializeGrokHome } = require("../grok.js");
const { scheduleRetention } = require("../worktrees.js");

const AUTH_BODY = "do-not-delete-me\n";
const SESSION = '{"id":"live-session"}\n';

function makeSourceHome(root) {
  const sourceHome = path.join(root, "real-grok");
  fs.mkdirSync(sourceHome);
  fs.writeFileSync(path.join(sourceHome, "auth.json"), AUTH_BODY);
  fs.writeFileSync(path.join(sourceHome, "config.toml"), "[plugins]\n");
  const sessions = path.join(sourceHome, "sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, "keep-me.json"), SESSION);
  return sourceHome;
}

function overlayPath(userDataPath, threadId) {
  return path.join(userDataPath, "grok-homes", threadId);
}

describe("grok-home reclaim (#706)", () => {
  let tmpDir;
  let sourceHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-reclaim-"));
    sourceHome = makeSourceHome(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scheduleRetention removes a stale overlay and leaves symlink targets intact", async () => {
    const staleId = "stale-thread-id";
    const runningId = "running-thread-id";
    const staleDest = overlayPath(tmpDir, staleId);
    const runningDest = overlayPath(tmpDir, runningId);

    materializeGrokHome({
      dest: staleDest,
      sourceHome,
      mcpServers: {},
    });
    materializeGrokHome({
      dest: runningDest,
      sourceHome,
      mcpServers: {},
    });

    assert.ok(fs.lstatSync(path.join(staleDest, "auth.json")).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(staleDest, "sessions")).isSymbolicLink());

    const store = {
      getProjects: () => [],
      getThread(id) {
        if (id === runningId) return { id, status: "working" };
        if (id === staleId) return { id, status: "idle" };
        return null;
      },
    };

    await scheduleRetention({
      store,
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    assert.equal(
      fs.existsSync(staleDest),
      false,
      "idle thread overlay must be reclaimed",
    );
    assert.equal(
      fs.existsSync(runningDest),
      true,
      "a running thread's overlay must survive",
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
    assert.equal(fs.existsSync(sourceHome), true);
  });
});
