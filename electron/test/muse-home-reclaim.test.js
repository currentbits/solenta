"use strict";

/**
 * Reclaim muse-homes/<threadId> overlays (#873).
 *
 * The overlay is a handful of symlinks into the user's real
 * ~/.config/muse and ~/.local/share/muse plus a rewritten settings.json.
 * Retention must delete the overlay directory without following those links.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { materializeMuseHome } = require("../muse.js");
const { scheduleRetention } = require("../worktrees.js");

const AUTH_BODY = "do-not-delete-me\n";
const SESSION = '{"id":"live-session"}\n';

function makeSourceDirs(root) {
  const sourceConfigDir = path.join(root, "real-muse-config");
  const sourceDataDir = path.join(root, "real-muse-data");
  fs.mkdirSync(sourceConfigDir);
  fs.mkdirSync(sourceDataDir);
  fs.writeFileSync(path.join(sourceConfigDir, "auth.json"), AUTH_BODY);
  const sessions = path.join(sourceDataDir, "sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, "keep-me.json"), SESSION);
  return { sourceConfigDir, sourceDataDir };
}

function overlayPath(userDataPath, threadId) {
  return path.join(userDataPath, "muse-homes", threadId);
}

describe("muse-home reclaim (#873)", () => {
  let tmpDir;
  let sourceConfigDir;
  let sourceDataDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-muse-reclaim-"));
    ({ sourceConfigDir, sourceDataDir } = makeSourceDirs(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scheduleRetention removes a stale overlay and leaves symlink targets intact", async () => {
    const staleId = "stale-thread-id";
    const runningId = "running-thread-id";
    const staleDest = overlayPath(tmpDir, staleId);
    const runningDest = overlayPath(tmpDir, runningId);

    materializeMuseHome({
      dest: staleDest,
      sourceConfigDir,
      sourceDataDir,
      mcpServers: {},
    });
    materializeMuseHome({
      dest: runningDest,
      sourceConfigDir,
      sourceDataDir,
      mcpServers: {},
    });

    assert.ok(
      fs
        .lstatSync(path.join(staleDest, "config", "muse", "auth.json"))
        .isSymbolicLink(),
    );
    assert.ok(
      fs
        .lstatSync(path.join(staleDest, "share", "muse", "sessions"))
        .isSymbolicLink(),
    );

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
      fs.readFileSync(path.join(sourceConfigDir, "auth.json"), "utf8"),
      AUTH_BODY,
      "auth.json symlink target must not be deleted",
    );
    assert.equal(
      fs.readFileSync(path.join(sourceDataDir, "sessions", "keep-me.json"), "utf8"),
      SESSION,
      "sessions/ dir symlink must not be followed into ~/.local/share/muse",
    );
    assert.equal(fs.existsSync(sourceConfigDir), true);
    assert.equal(fs.existsSync(sourceDataDir), true);
  });

  it("first-run overlay sessions is a symlink so reclaim does not delete live sessions", async () => {
    const emptyConfig = path.join(tmpDir, "empty-cfg");
    const emptyData = path.join(tmpDir, "empty-data");
    fs.mkdirSync(emptyConfig);
    fs.mkdirSync(emptyData);
    const dest = overlayPath(tmpDir, "first-run");

    materializeMuseHome({
      dest,
      sourceConfigDir: emptyConfig,
      sourceDataDir: emptyData,
      mcpServers: {},
    });

    const overlaySessions = path.join(dest, "share", "muse", "sessions");
    assert.ok(
      fs.lstatSync(overlaySessions).isSymbolicLink(),
      "first-run overlay sessions must be a symlink, not a real dir",
    );
    fs.writeFileSync(path.join(overlaySessions, "new.json"), SESSION);

    const store = {
      getProjects: () => [],
      getThread: () => ({ id: "first-run", status: "idle" }),
    };
    await scheduleRetention({
      store,
      worktreeBase: path.join(tmpDir, "worktrees"),
      userDataPath: tmpDir,
    });

    assert.equal(fs.existsSync(dest), false, "idle overlay must be reclaimed");
    assert.equal(
      fs.readFileSync(path.join(emptyData, "sessions", "new.json"), "utf8"),
      SESSION,
      "first-run session files must survive reclaim through the symlink",
    );
  });
});
