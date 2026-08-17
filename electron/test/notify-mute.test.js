/**
 * Issue #87: global notifications toggle + per-thread mute.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store, normalizeSettings } = require("../store.js");
const services = require("../services.js");

describe("notifications setting", () => {
  it("only an explicit false turns it off", () => {
    assert.equal(normalizeSettings({}).notifications, true);
    assert.equal(normalizeSettings({ notifications: false }).notifications, false);
    // Junk on disk must not silence the app.
    assert.equal(normalizeSettings({ notifications: "no" }).notifications, true);
    assert.equal(normalizeSettings({ notifications: 0 }).notifications, true);
  });
});

describe("mute", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mute-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Worker",
    }).id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("setSettings rejects a non-boolean and persists false", () => {
    assert.throws(
      () => services.setSettings(store, { notifications: "off" }),
      /notifications must be a boolean/,
    );
    assert.equal(
      services.setSettings(store, { notifications: false }).notifications,
      false,
    );
    assert.equal(store.getSettings().notifications, false);
  });

  it("setMuted round-trips through the store without bumping updatedAt", () => {
    assert.equal(store.getThread(threadId).muted, false);
    const before = store.getThread(threadId).updatedAt;

    const muted = services.setMuted(store, { threadId, muted: true });
    assert.equal(muted.muted, true);
    assert.equal(muted.updatedAt, before);

    // Survives a reload: normalizeThread must keep the flag.
    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getThread(threadId).muted, true);

    assert.equal(
      services.setMuted(store, { threadId, muted: false }).muted,
      false,
    );
  });

  it("setMuted throws on an unknown thread", () => {
    assert.throws(
      () => services.setMuted(store, { threadId: "nope", muted: true }),
      /Unknown thread/,
    );
  });
});
