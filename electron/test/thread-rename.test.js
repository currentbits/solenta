/**
 * Issue #139: threads:rename — persist a new title without bumping updatedAt.
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

describe("renameThread", () => {
  let tmpDir;
  let store;
  let threadId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-rename-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    }).id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips through the store", () => {
    const updated = services.renameThread(store, {
      threadId,
      title: "Ship checklist",
    });
    assert.equal(updated.title, "Ship checklist");
    assert.equal(store.getThread(threadId).title, "Ship checklist");

    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getThread(threadId).title, "Ship checklist");
  });

  it("trims the incoming title", () => {
    const updated = services.renameThread(store, {
      threadId,
      title: "  Hello world  ",
    });
    assert.equal(updated.title, "Hello world");
  });

  it("truncates a title longer than THREAD_TITLE_MAX", () => {
    const updated = services.renameThread(store, {
      threadId,
      title: "x".repeat(80),
    });
    assert.equal(updated.title.length, services.THREAD_TITLE_MAX);
    assert.equal(updated.title, "x".repeat(services.THREAD_TITLE_MAX));
  });

  it("throws on an empty or whitespace-only title", () => {
    assert.throws(
      () => services.renameThread(store, { threadId, title: "" }),
      /Thread title cannot be empty/,
    );
    assert.throws(
      () => services.renameThread(store, { threadId, title: "   " }),
      /Thread title cannot be empty/,
    );
    assert.equal(store.getThread(threadId).title, "New Thread");
  });

  it("throws on an unknown thread", () => {
    assert.throws(
      () => services.renameThread(store, { threadId: "nope", title: "x" }),
      /Unknown thread/,
    );
  });

  it("does not bump updatedAt", () => {
    const before = store.getThread(threadId).updatedAt;
    const updated = services.renameThread(store, {
      threadId,
      title: "Keep order",
    });
    assert.equal(updated.updatedAt, before);
    assert.equal(store.getThread(threadId).updatedAt, before);
  });

  it("REGRESSION: first-run auto-titling stays gated on the default title", () => {
    // A renamed thread must survive its first run. runner.js and workflow.js
    // each derive a title from the first prompt line only when the title is
    // still "New Thread". Driving a real run here would need the whole runner
    // harness, so pin the guard at the source instead — crude, but it fails
    // if someone drops the check, which is the only regression that matters.
    // ponytail: source-text pin; replace with a runner test if one gets cheap.
    for (const file of ["../runner.js", "../workflow.js"]) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      assert.match(src, /if \(title === "New Thread"\)/, `${file} lost the guard`);
    }
  });
});
