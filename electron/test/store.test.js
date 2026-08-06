const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");

describe("Store", () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-store-"));
    filePath = path.join(tmpDir, "coder-store.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts empty when file is missing", () => {
    const store = new Store(filePath);
    assert.deepEqual(store.getProjects(), []);
    assert.deepEqual(store.getThreads(), []);
    assert.deepEqual(store.getMessages("any"), []);
    assert.deepEqual(store.getWorkLog("any"), []);
  });

  it("round-trips projects, threads, messages, work log", () => {
    const store = new Store(filePath);
    const project = {
      id: "p1",
      slug: "owner/repo",
      name: "repo",
      path: "/tmp/repo",
    };
    const thread = {
      id: "t1",
      projectId: "p1",
      title: "Hello",
      branch: "main",
      prNumber: null,
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    };
    const msg = {
      id: "m1",
      role: "user",
      text: "hi",
      createdAt: 3,
    };
    const log = {
      id: "w1",
      label: "Analyze started",
      done: false,
      timestamp: 4,
    };

    store.setProjects([project]);
    store.setThreads([thread]);
    store.setMessages("t1", [msg]);
    store.setWorkLog("t1", [log]);
    store.save();

    const reloaded = new Store(filePath);
    assert.deepEqual(reloaded.getProjects(), [project]);
    assert.deepEqual(reloaded.getThreads(), [thread]);
    assert.deepEqual(reloaded.getMessages("t1"), [msg]);
    assert.deepEqual(reloaded.getWorkLog("t1"), [log]);
  });

  it("tolerates corrupt JSON by starting empty", () => {
    fs.writeFileSync(filePath, "{not valid json!!!", "utf8");
    const store = new Store(filePath);
    assert.deepEqual(store.getProjects(), []);
    assert.deepEqual(store.getThreads(), []);
  });

  it("writes atomically via tmp then rename", () => {
    const store = new Store(filePath);
    store.setProjects([{ id: "p", slug: "a/b", name: "b", path: "/x" }]);
    store.save();
    assert.equal(fs.existsSync(filePath), true);
    // no leftover tmp in same dir
    const leftovers = fs
      .readdirSync(tmpDir)
      .filter((n) => n !== "coder-store.json");
    assert.deepEqual(leftovers, []);
  });
});
