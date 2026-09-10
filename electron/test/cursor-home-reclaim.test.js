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

const { materializeCursorHome, reclaimCursorHomes } = require("../cursor.js");
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

  it("does not dangle ~/.local/bin/cursor-agent after reclaim (#879)", () => {
    const versions = path.join(
      sourceHome,
      ".local",
      "share",
      "cursor-agent",
      "versions",
      "v1",
    );
    const localBin = path.join(sourceHome, ".local", "bin");
    fs.mkdirSync(versions, { recursive: true });
    fs.mkdirSync(localBin, { recursive: true });
    const realBin = path.join(versions, "cursor-agent");
    fs.writeFileSync(realBin, "#!/bin/sh\necho real\n", { mode: 0o755 });
    const userShim = path.join(localBin, "cursor-agent");
    fs.symlinkSync(realBin, userShim);

    const threadId = "stale-cursor-home";
    const dest = overlayPath(tmpDir, threadId);
    materializeCursorHome({ dest, sourceHome, mcpServers: {} });

    // cursor-agent installer rewrites $HOME/.local/bin/cursor-agent with a
    // HOME-qualified target. If overlay .local is the user's .local, this
    // retargets the user shim at the overlay path; reclaim then dangles it.
    const overlayBinDir = path.join(dest, ".local", "bin");
    fs.mkdirSync(overlayBinDir, { recursive: true });
    const overlayShim = path.join(overlayBinDir, "cursor-agent");
    try {
      fs.unlinkSync(overlayShim);
    } catch {
      // no existing overlay shim
    }
    fs.symlinkSync(
      path.join(
        dest,
        ".local",
        "share",
        "cursor-agent",
        "versions",
        "v1",
        "cursor-agent",
      ),
      overlayShim,
    );

    reclaimCursorHomes({
      userDataPath: tmpDir,
      store: {
        getThread(id) {
          return id === threadId ? { id, status: "idle" } : null;
        },
      },
    });

    assert.equal(fs.existsSync(dest), false, "idle overlay must be reclaimed");
    const shimStat = fs.lstatSync(userShim);
    assert.ok(shimStat.isSymbolicLink(), "user cursor-agent shim must survive");
    assert.equal(fs.readlinkSync(userShim), realBin);
    assert.equal(
      fs.existsSync(realBin),
      true,
      "real cursor-agent binary must still exist",
    );
  });
});
