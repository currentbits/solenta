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
      runStartedAt: null,
      archived: false,
      provider: "claude",
      model: null,
      sessionId: null,
      permissionMode: "default",
      worktreePath: null,
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

  it("migrates old-shape threads missing session fields on load", () => {
    const old = {
      projects: [],
      threads: [
        {
          id: "t-old",
          projectId: "p1",
          title: "Legacy",
          branch: null,
          prNumber: null,
          status: "idle",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");

    const store = new Store(filePath);
    const t = store.getThreads()[0];
    assert.equal(t.provider, "claude");
    assert.equal(t.model, null);
    assert.equal(t.sessionId, null);
    assert.equal(t.permissionMode, "default");
    assert.equal(t.worktreePath, null);
    assert.equal(t.archived, false);
  });

  it("migration adds archived false without changing updatedAt", () => {
    const old = {
      projects: [],
      threads: [
        {
          id: "t-old",
          projectId: "p1",
          title: "Legacy",
          branch: null,
          prNumber: null,
          status: "idle",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");

    const store = new Store(filePath);
    const t = store.getThreads()[0];
    assert.equal(t.archived, false);
    assert.equal(t.updatedAt, 2);
  });

  it("removeThread cascades every *ByThread map through save/reload", () => {
    const store = new Store(filePath);
    store.setThreads([
      {
        id: "t1",
        projectId: "p1",
        title: "Hello",
        branch: null,
        prNumber: null,
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
        runStartedAt: null,
        archived: false,
        provider: "claude",
        sessionId: null,
        permissionMode: "default",
        worktreePath: null,
      },
      {
        id: "t2",
        projectId: "p1",
        title: "Keep",
        branch: null,
        prNumber: null,
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
        runStartedAt: null,
        archived: false,
        provider: "claude",
        sessionId: null,
        permissionMode: "default",
        worktreePath: null,
      },
    ]);
    store.setMessages("t1", [
      { id: "m1", role: "user", text: "hi", createdAt: 3 },
    ]);
    store.setWorkLog("t1", [
      { id: "w1", runId: "r1", label: "Step", done: true, timestamp: 4 },
    ]);
    store.setUsage("t1", {
      model: "m",
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.01,
      turns: 1,
    });
    store.setMessages("t2", [
      { id: "m2", role: "user", text: "stay", createdAt: 5 },
    ]);
    store.setUsage("t2", {
      model: "m",
      inputTokens: 3,
      outputTokens: 4,
      costUsd: 0.02,
      turns: 1,
    });

    // Sanity: every known ByThread map currently holds t1.
    const byThreadKeys = Object.keys(store.data).filter((k) =>
      k.endsWith("ByThread"),
    );
    assert.ok(byThreadKeys.length >= 3, "expect messages/workLog/usage maps");
    for (const key of byThreadKeys) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(store.data[key], "t1"),
        true,
        `${key} should hold t1 before remove`,
      );
    }

    store.removeThread("t1");
    store.save();

    assert.equal(store.getThread("t1"), null);
    assert.equal(store.getThreads().length, 1);
    assert.equal(store.getThreads()[0].id, "t2");
    assert.deepEqual(store.getMessages("t1"), []);
    assert.deepEqual(store.getWorkLog("t1"), []);
    assert.equal(store.getUsage("t1"), null);
    assert.equal(store.getMessages("t2").length, 1);

    // In-memory: no *ByThread map may retain the deleted id.
    for (const key of Object.keys(store.data).filter((k) =>
      k.endsWith("ByThread"),
    )) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(store.data[key], "t1"),
        false,
        `${key} must not retain t1 after removeThread`,
      );
    }

    // Persist + reload: re-enumerate *ByThread maps from store data (future-proof).
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getThread("t1"), null);
    assert.equal(reloaded.getThreads().length, 1);
    assert.equal(reloaded.getThreads()[0].id, "t2");
    assert.ok(reloaded.getUsage("t2"));
    for (const key of Object.keys(reloaded.data).filter((k) =>
      k.endsWith("ByThread"),
    )) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(reloaded.data[key], "t1"),
        false,
        `persisted ${key} must not retain t1 after save/reload`,
      );
    }
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        reloaded.data.messagesByThread,
        "t2",
      ),
      true,
    );
  });

  it("persists usage by thread", () => {
    const store = new Store(filePath);
    store.setUsage("t1", {
      model: "m",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.02,
      turns: 1,
    });
    store.save();
    const reloaded = new Store(filePath);
    assert.deepEqual(reloaded.getUsage("t1"), {
      model: "m",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.02,
      turns: 1,
    });
  });

  it("updateThread without touch preserves updatedAt", () => {
    const store = new Store(filePath);
    const fixed = 1_700_000_000_000;
    store.setThreads([
      {
        id: "t1",
        projectId: "p1",
        title: "Hello",
        branch: null,
        prNumber: null,
        status: "idle",
        createdAt: fixed,
        updatedAt: fixed,
        runStartedAt: null,
        provider: "claude",
        sessionId: null,
        permissionMode: "default",
        worktreePath: null,
      },
    ]);

    const before = Date.now();
    const updated = store.updateThread("t1", {
      permissionMode: "plan",
      sessionId: "sess-1",
    });
    assert.ok(updated);
    assert.equal(updated.permissionMode, "plan");
    assert.equal(updated.sessionId, "sess-1");
    assert.equal(updated.updatedAt, fixed);
    assert.ok(updated.updatedAt < before);
  });

  it("updateThread with touch bumps updatedAt", () => {
    const store = new Store(filePath);
    const fixed = 1_700_000_000_000;
    store.setThreads([
      {
        id: "t1",
        projectId: "p1",
        title: "Hello",
        branch: null,
        prNumber: null,
        status: "idle",
        createdAt: fixed,
        updatedAt: fixed,
        runStartedAt: null,
        provider: "claude",
        sessionId: null,
        permissionMode: "default",
        worktreePath: null,
      },
    ]);

    const updated = store.updateThread(
      "t1",
      { status: "working", runStartedAt: Date.now() },
      { touch: true },
    );
    assert.ok(updated);
    assert.equal(updated.status, "working");
    assert.ok(updated.updatedAt > fixed);
    assert.ok(typeof updated.runStartedAt === "number");
  });

  it("appendMessage bumps owning thread updatedAt", () => {
    const store = new Store(filePath);
    const fixed = 1_700_000_000_000;
    store.setThreads([
      {
        id: "t1",
        projectId: "p1",
        title: "Hello",
        branch: null,
        prNumber: null,
        status: "idle",
        createdAt: fixed,
        updatedAt: fixed,
        runStartedAt: null,
        provider: "claude",
        sessionId: null,
        permissionMode: "default",
        worktreePath: null,
      },
    ]);

    store.appendMessage("t1", {
      id: "m1",
      role: "user",
      text: "hi",
      createdAt: Date.now(),
    });
    const t = store.getThread("t1");
    assert.ok(t.updatedAt > fixed);
  });

  it("migration adds runStartedAt null without changing updatedAt", () => {
    const old = {
      projects: [],
      threads: [
        {
          id: "t-old",
          projectId: "p1",
          title: "Legacy",
          branch: null,
          prNumber: null,
          status: "idle",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");

    const store = new Store(filePath);
    const t = store.getThreads()[0];
    assert.equal(t.runStartedAt, null);
    assert.equal(t.updatedAt, 2);
    assert.equal(t.provider, "claude");
  });

  it("load recovery normalizes working threads to failed", () => {
    const fixed = 1_700_000_000_000;
    const raw = {
      projects: [],
      threads: [
        {
          id: "t-work",
          projectId: "p1",
          title: "Mid run",
          branch: null,
          prNumber: null,
          status: "working",
          createdAt: fixed,
          updatedAt: fixed,
          runStartedAt: fixed + 100,
          provider: "claude",
          sessionId: "s1",
          permissionMode: "default",
          worktreePath: null,
        },
      ],
      messagesByThread: {
        "t-work": [
          {
            id: "m0",
            role: "user",
            text: "do work",
            createdAt: fixed + 50,
          },
        ],
      },
      workLogByThread: {},
      usageByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(raw), "utf8");

    const store = new Store(filePath);
    const t = store.getThread("t-work");
    assert.equal(t.status, "failed");
    assert.equal(t.runStartedAt, null);

    const msgs = store.getMessages("t-work");
    assert.ok(msgs.length >= 2);
    const last = msgs[msgs.length - 1];
    assert.equal(last.role, "event");
    assert.equal(last.text, "Run interrupted by app restart");
  });
});
