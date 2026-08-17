/**
 * Issue #194: threads:setNotes - persist a scratch pad without bumping updatedAt.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");

describe("setNotes", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-notes-"));
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

  it("createThread starts with an empty notes string", () => {
    assert.equal(store.getThread(threadId).notes, "");
  });

  it("trims incoming notes", () => {
    const updated = services.setNotes(store, {
      threadId,
      notes: "  Merge after #42 lands  ",
    });
    assert.equal(updated.notes, "Merge after #42 lands");
    assert.equal(store.getThread(threadId).notes, "Merge after #42 lands");
  });

  it("caps notes at THREAD_NOTES_MAX", () => {
    const updated = services.setNotes(store, {
      threadId,
      notes: "x".repeat(services.THREAD_NOTES_MAX + 50),
    });
    assert.equal(updated.notes.length, services.THREAD_NOTES_MAX);
    assert.equal(updated.notes, "x".repeat(services.THREAD_NOTES_MAX));
  });

  it("empty string clears notes", () => {
    services.setNotes(store, { threadId, notes: "parked" });
    const cleared = services.setNotes(store, { threadId, notes: "   " });
    assert.equal(cleared.notes, "");
    assert.equal(store.getThread(threadId).notes, "");
  });

  it("throws on an unknown thread", () => {
    assert.throws(
      () => services.setNotes(store, { threadId: "nope", notes: "x" }),
      /Unknown thread/,
    );
  });

  it("does not bump updatedAt", () => {
    const before = store.getThread(threadId).updatedAt;
    const updated = services.setNotes(store, {
      threadId,
      notes: "merge after #42",
    });
    assert.equal(updated.updatedAt, before);
    assert.equal(store.getThread(threadId).updatedAt, before);
  });

  it("round-trips through the store; missing notes upgrade to empty", () => {
    services.setNotes(store, {
      threadId,
      notes: "Merge after #42 lands",
    });
    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getThread(threadId).notes, "Merge after #42 lands");

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "store.json"), "utf8"),
    );
    delete raw.threads[0].notes;
    fs.writeFileSync(
      path.join(tmpDir, "store.json"),
      JSON.stringify(raw),
      "utf8",
    );
    const upgraded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(upgraded.getThread(threadId).notes, "");
  });
});
