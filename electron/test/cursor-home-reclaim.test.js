"use strict";

/**
 * Reclaim cursor-homes/<threadId> overlays (#700).
 *
 * The overlay is a handful of symlinks into the user's real $HOME /
 * ~/.cursor plus one mcp.json. Retention must delete the overlay
 * directory without following those links.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { materializeCursorHome } = require("../cursor.js");
const { scheduleRetention } = require("../worktrees.js");

const GITCONFIG = "[user]\n\tname = Keep Me\n";
const CLI = '{"auth":true}\n';

function makeSourceHome(root) {
  const sourceHome = path.join(root, "real-home");
  fs.mkdirSync(sourceHome);
  fs.writeFileSync(path.join(sourceHome, ".gitconfig"), GITCONFIG);
  const cursorDir = path.join(sourceHome, ".cursor");
  fs.mkdirSync(cursorDir);
  fs.writeFileSync(path.join(cursorDir, "cli-config.json"), CLI);
  fs.writeFileSync(
    path.join(cursorDir, "mcp.json"),
    JSON.stringify({ mcpServers: { girder: { command: "/tmp/girder" } } }),
  );
  return sourceHome;
}

function overlayPath(userDataPath, threadId) {
  return path.join(userDataPath, "cursor-homes", threadId);
}

describe("cursor-home reclaim (#700)", () => {
  let tmpDir;
  let sourceHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cursor-reclaim-"));
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

    materializeCursorHome({
      dest: staleDest,
      sourceHome,
      mcpServers: {},
    });
    materializeCursorHome({
      dest: runningDest,
      sourceHome,
      mcpServers: {},
    });

    assert.ok(fs.lstatSync(path.join(staleDest, ".gitconfig")).isSymbolicLink());
    assert.ok(
      fs
        .lstatSync(path.join(staleDest, ".cursor", "cli-config.json"))
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
      fs.readFileSync(path.join(sourceHome, ".gitconfig"), "utf8"),
      GITCONFIG,
      "home symlink target must not be deleted",
    );
    assert.equal(
      fs.readFileSync(path.join(sourceHome, ".cursor", "cli-config.json"), "utf8"),
      CLI,
      "~/.cursor symlink must not be followed",
    );
    assert.equal(fs.existsSync(sourceHome), true);
  });
});
