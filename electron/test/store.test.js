const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, MAX_MESSAGES_PER_THREAD, MESSAGE_OVERFLOW_SLACK, MAX_WORKLOG_ITEMS_PER_THREAD, WORKLOG_OVERFLOW_SLACK, SAVE_DEBOUNCE_MS, SAVE_DEBOUNCE_MAX_MS } = require("../store.js");

describe("Store", () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-store-"));
    filePath = path.join(tmpDir, "coder-store.json");
  });

  afterEach(() => {
    // An in-flight bak copy (#618) can recreate the file during rmdir.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 10 });
  });

  it("starts empty when file is missing", () => {
    const store = new Store(filePath);
    assert.deepEqual(store.getProjects(), []);
    assert.deepEqual(store.getThreads(), []);
    assert.deepEqual(store.getMessages("any"), []);
    assert.deepEqual(store.getWorkLog("any"), []);
    assert.deepEqual(store.getAutomations(), []);
  });

  it("migrates missing automations to an empty array", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        messagesByThread: {},
        workLogByThread: {},
        usageByThread: {},
      }),
      "utf8",
    );
    const store = new Store(filePath);
    assert.deepEqual(store.getAutomations(), []);
  });

  it("migrates partial automations to default fields", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        messagesByThread: {},
        workLogByThread: {},
        usageByThread: {},
        automations: [
          {
            id: "a1",
            projectId: "p1",
            name: "Nightly",
            prompt: "go",
          },
        ],
      }),
      "utf8",
    );
    const store = new Store(filePath);
    const [auto] = store.getAutomations();
    assert.equal(auto.id, "a1");
    assert.equal(auto.provider, "claude");
    assert.equal(auto.model, null);
    assert.equal(auto.preset, "hourly");
    assert.equal(auto.hour, null);
    assert.equal(auto.enabled, true);
    assert.equal(auto.lastRunAt, null);
    assert.equal(auto.nextRunAt, 0);
    assert.equal(auto.lastError, null);
  });

  it("updateThread clears sessionId when worktreePath changes (cwd-scoped sessions)", () => {
    const store = new Store(filePath);
    store.setThreads([
      { id: "t1", sessionId: "sess-1", worktreePath: null },
    ]);

    // cwd flips into a worktree → session captured in project.path is stale
    store.updateThread("t1", { worktreePath: "/tmp/wt" });
    assert.equal(store.getThread("t1").sessionId, null);

    // same-value worktreePath patch must NOT drop the session
    store.updateThread("t1", { sessionId: "sess-2" });
    store.updateThread("t1", { worktreePath: "/tmp/wt", branch: "b" });
    assert.equal(store.getThread("t1").sessionId, "sess-2");

    // cwd flips back out (merged-worktree reclaim) → stale again
    store.updateThread("t1", { worktreePath: null, branch: null });
    assert.equal(store.getThread("t1").sessionId, null);

    // an explicit sessionId in the same patch wins over the guard
    store.updateThread("t1", {
      worktreePath: "/tmp/wt2",
      sessionId: "sess-3",
    });
    assert.equal(store.getThread("t1").sessionId, "sess-3");
  });

  it("round-trips projects, threads, messages, work log", () => {
    const store = new Store(filePath);
    const project = {
      id: "p1",
      slug: "owner/repo",
      name: "repo",
      path: "/tmp/repo",
      worktreeRetention: 10,
    };
    const thread = {
      id: "t1",
      projectId: "p1",
      title: "Hello",
      branch: "main",
      prNumber: null,
      prUrl: null,
      status: "idle",
      lastError: null,
      createdAt: 1,
      updatedAt: 2,
      runStartedAt: null,
      archived: false,
      settledOverride: null,
      settledAt: null,
      prState: null,
      prMergeable: null,
      quotaWaitUntil: null,
      quotaWaitResumed: false,
      quotaWaitAutoResume: null,
      lastVisitedAt: null,
      pinnedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      provider: "claude",
      model: null,
      sessionId: null,
      permissionMode: "default",
      reasoningEffort: null,
      worktreePath: null,
      handoffFrom: null,
      feltEstimate: null,
      replayContext: false,
      muted: false,
      notes: "",
      queued: null,
      verifyCommand: null,
      verify: null,
      issueNumber: null,
      postMergeVerify: null,
      reviewAcceptedHunks: [],
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
    store.saveNow();

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

  it("quarantines corrupt JSON instead of discarding it", () => {
    const corrupt = "{not valid json!!!";
    fs.writeFileSync(filePath, corrupt, "utf8");
    const store = new Store(filePath);
    assert.deepEqual(store.getProjects(), []);
    assert.deepEqual(store.getThreads(), []);
    const quarantined = fs
      .readdirSync(tmpDir)
      .filter((n) => n.startsWith("coder-store.json.corrupt-"));
    assert.equal(quarantined.length, 1);
    assert.equal(
      fs.readFileSync(path.join(tmpDir, quarantined[0]), "utf8"),
      corrupt,
    );
    assert.equal(fs.existsSync(filePath), false);
  });

  it("recovers from .bak when the main file is corrupt", () => {
    const good = {
      projects: [{ id: "p-bak", slug: "a/b", name: "b", path: "/x" }],
      threads: [],
      messagesByThread: {},
      workLogByThread: {},
      usageByThread: {},
    };
    fs.writeFileSync(`${filePath}.bak`, JSON.stringify(good), "utf8");
    fs.writeFileSync(filePath, "{not valid json!!!", "utf8");
    const store = new Store(filePath);
    assert.equal(store.getProjects()[0].id, "p-bak");
    const quarantined = fs
      .readdirSync(tmpDir)
      .filter((n) => n.startsWith("coder-store.json.corrupt-"));
    assert.equal(quarantined.length, 1);
  });

  it("writes a .bak copy after a successful load, off the constructor's sync path", async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [{ id: "p1", slug: "a/b", name: "b", path: "/x" }],
        threads: [],
        messagesByThread: {},
        workLogByThread: {},
      }),
      "utf8",
    );
    const store = new Store(filePath);
    assert.equal(store.getProjects()[0].id, "p1");
    assert.equal(
      fs.existsSync(`${filePath}.bak`),
      false,
      "bak must not land during the synchronous constructor",
    );
    await store._bakCopy;
    assert.equal(fs.existsSync(`${filePath}.bak`), true);
    const bak = JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf8"));
    assert.equal(bak.projects[0].id, "p1");
  });

  it("saveNow does not destroy a quarantined corrupt file", () => {
    const corrupt = "{not valid json!!!";
    fs.writeFileSync(filePath, corrupt, "utf8");
    const store = new Store(filePath);
    const quarantined = fs
      .readdirSync(tmpDir)
      .filter((n) => n.startsWith("coder-store.json.corrupt-"));
    assert.equal(quarantined.length, 1);
    const corruptPath = path.join(tmpDir, quarantined[0]);
    store.setProjects([{ id: "p-new", slug: "a/b", name: "b", path: "/x" }]);
    store.saveNow();
    assert.equal(fs.existsSync(corruptPath), true);
    assert.equal(fs.readFileSync(corruptPath, "utf8"), corrupt);
    assert.equal(
      JSON.parse(fs.readFileSync(filePath, "utf8")).projects[0].id,
      "p-new",
    );
  });

  it("writes atomically via tmp then rename", () => {
    const store = new Store(filePath);
    store.setProjects([{ id: "p", slug: "a/b", name: "b", path: "/x" }]);
    store.saveNow();
    assert.equal(fs.existsSync(filePath), true);
    // no leftover tmp in same dir
    const leftovers = fs
      .readdirSync(tmpDir)
      .filter((n) => n !== "coder-store.json" && n !== "coder-store.json.bak");
    assert.deepEqual(leftovers, []);
  });

  it("coalesces a burst of save() into one debounced write", async () => {
    const store = new Store(filePath);
    let writes = 0;
    const realOpen = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = await realOpen(...args);
      const realWrite = handle.writeFile.bind(handle);
      handle.writeFile = (...wargs) => {
        writes += 1;
        return realWrite(...wargs);
      };
      return handle;
    };
    try {
      for (let i = 0; i < 20; i += 1) {
        store.setProjects([{ id: `p${i}`, slug: "a/b", name: "b", path: "/x" }]);
        store.save();
      }
      assert.equal(writes, 0, "nothing written while the burst is in flight");
      await new Promise((r) => setTimeout(r, 400));
      await store.flushPending();
      assert.equal(writes, 1);
    } finally {
      fs.promises.open = realOpen;
    }
    assert.equal(new Store(filePath).getProjects()[0].id, "p19");
  });

  it("debounced save() writes asynchronously and never renames a stale payload", async () => {
    const store = new Store(filePath);
    store.setProjects([{ id: "p1", slug: "a/b", name: "b", path: "/x" }]);
    store.save();
    // Hold the in-flight flush inside writeFile, then land a synchronous
    // saveNow() with newer data: the async flush must not rename over it.
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const realOpen = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = await realOpen(...args);
      const realWrite = handle.writeFile.bind(handle);
      handle.writeFile = (...wargs) => gate.then(() => realWrite(...wargs));
      return handle;
    };
    try {
      await new Promise((r) => setTimeout(r, 300)); // debounce fired, flush gated
      store.setProjects([{ id: "p2", slug: "a/b", name: "b", path: "/x" }]);
      store.saveNow();
      release();
      await store.flushPending();
    } finally {
      fs.promises.open = realOpen;
    }
    assert.equal(new Store(filePath).getProjects()[0].id, "p2");
    // No leftover tmp files from the discarded flush.
    const leftovers = fs
      .readdirSync(tmpDir)
      .filter((n) => n !== "coder-store.json" && n !== "coder-store.json.bak");
    assert.deepEqual(leftovers, []);
  });

  it("backs off flush delay when save() keeps landing, then resets", async () => {
    const store = new Store(filePath);
    const realOpen = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = await realOpen(...args);
      const realWrite = handle.writeFile.bind(handle);
      handle.writeFile = (...wargs) => {
        store.setProjects([{ id: "p-dirty", slug: "a/b", name: "b", path: "/x" }]);
        store.save();
        return realWrite(...wargs);
      };
      return handle;
    };
    try {
      store.setProjects([{ id: "p1", slug: "a/b", name: "b", path: "/x" }]);
      store.save();
      await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 150));
      await store.flushPending();
      assert.equal(store._flushDelayMs, SAVE_DEBOUNCE_MS * 2);
    } finally {
      fs.promises.open = realOpen;
    }
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 150));
    await store.flushPending();
    assert.equal(store._flushDelayMs, SAVE_DEBOUNCE_MS);
    assert.ok(SAVE_DEBOUNCE_MAX_MS >= SAVE_DEBOUNCE_MS * 2);
  });

  it("markDirty remembers mutations without scheduling a flush (#636)", () => {
    const store = new Store(filePath);
    store.setProjects([{ id: "p", slug: "a/b", name: "b", path: "/x" }]);
    store.markDirty();
    assert.equal(store._dirty, true);
    assert.equal(store._timer, null, "must not arm the debounce timer");
    store.saveNow();
    assert.equal(new Store(filePath).getProjects()[0].id, "p");
  });

  it("saveNow() flushes a pending debounced save immediately", () => {
    const store = new Store(filePath);
    store.setProjects([{ id: "p", slug: "a/b", name: "b", path: "/x" }]);
    store.save();
    store.saveNow();
    assert.equal(new Store(filePath).getProjects()[0].id, "p");
  });

  it("leaves remoteHost/remotePath absent on old projects", () => {
    const old = {
      projects: [
        {
          id: "p-old",
          slug: "acme/app",
          name: "app",
          path: "/tmp/app",
        },
      ],
      threads: [],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");
    const store = new Store(filePath);
    const p = store.getProjects()[0];
    assert.equal(p.id, "p-old");
    assert.equal(p.path, "/tmp/app");
    assert.equal(
      Object.prototype.hasOwnProperty.call(p, "remoteHost"),
      false,
      "old projects must not gain a remoteHost key",
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(p, "remotePath"),
      false,
      "old projects must not gain a remotePath key",
    );
  });

  it("keeps remoteHost/remotePath when present and drops empty strings", () => {
    const old = {
      projects: [
        {
          id: "p-remote",
          slug: "app",
          name: "app",
          path: "/srv/app",
          remoteHost: "dev@box",
          remotePath: "/srv/app",
        },
        {
          id: "p-empty",
          slug: "local",
          name: "local",
          path: "/tmp/local",
          remoteHost: "",
          remotePath: "  ",
        },
      ],
      threads: [],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");
    const store = new Store(filePath);
    const remote = store.getProjects().find((p) => p.id === "p-remote");
    const empty = store.getProjects().find((p) => p.id === "p-empty");
    assert.equal(remote.remoteHost, "dev@box");
    assert.equal(remote.remotePath, "/srv/app");
    assert.equal(Object.prototype.hasOwnProperty.call(empty, "remoteHost"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(empty, "remotePath"), false);
  });

  it("defaults a missing worktreeRetention to 10 and keeps an explicit 0 (#559)", () => {
    const old = {
      projects: [
        {
          id: "p-keep",
          slug: "app",
          name: "app",
          path: "/tmp/app",
          worktreeRetention: 3,
        },
        {
          id: "p-zero",
          slug: "z",
          name: "z",
          path: "/tmp/z",
          worktreeRetention: 0,
        },
        {
          id: "p-missing",
          slug: "m",
          name: "m",
          path: "/tmp/m",
        },
        {
          id: "p-junk",
          slug: "j",
          name: "j",
          path: "/tmp/j",
          worktreeRetention: "3",
        },
      ],
      threads: [],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");
    const store = new Store(filePath);
    const keep = store.getProjects().find((p) => p.id === "p-keep");
    const zero = store.getProjects().find((p) => p.id === "p-zero");
    const missing = store.getProjects().find((p) => p.id === "p-missing");
    const junk = store.getProjects().find((p) => p.id === "p-junk");
    assert.equal(keep.worktreeRetention, 3);
    assert.equal(zero.worktreeRetention, 0);
    assert.equal(missing.worktreeRetention, 10);
    assert.equal(junk.worktreeRetention, 10);
  });

  it("keeps a valid setupCommand / quickActions and drops junk (#153)", () => {
    const old = {
      projects: [
        {
          id: "p-ok",
          slug: "app",
          name: "app",
          path: "/tmp/app",
          setupCommand: "  npm i  ",
          quickActions: [
            { id: "lint", name: "Lint", command: "npm run lint" },
            { name: "", command: "echo skip" },
            { id: "setup", name: "Install", command: "npm i" },
          ],
        },
        {
          id: "p-junk",
          slug: "j",
          name: "j",
          path: "/tmp/j",
          setupCommand: 12,
          quickActions: "nope",
        },
      ],
      threads: [],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");
    const store = new Store(filePath);
    const ok = store.getProjects().find((p) => p.id === "p-ok");
    const junk = store.getProjects().find((p) => p.id === "p-junk");
    assert.equal(ok.setupCommand, "npm i");
    assert.equal(ok.quickActions.length, 2);
    assert.equal(ok.quickActions[0].id, "lint");
    assert.notEqual(ok.quickActions[1].id, "setup");
    assert.equal("setupCommand" in junk, false);
    assert.equal("quickActions" in junk, false);
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
    assert.equal(t.reasoningEffort, null);
    assert.equal(t.worktreePath, null);
    assert.equal(t.archived, false);
    assert.equal(t.prUrl, null);
    assert.equal(t.settledOverride, null);
    assert.equal(t.settledAt, null);
    assert.equal(t.prState, null);
    assert.equal(t.lastVisitedAt, null);
    assert.equal(t.pinnedAt, null);
    assert.equal(t.snoozedUntil, null);
    assert.equal(t.snoozedAt, null);
  });

  it("heals leftover kimi cwd session sentinel to null (issue #220)", () => {
    const old = {
      projects: [],
      threads: [
        {
          id: "t-cwd",
          projectId: "p1",
          title: "Kimi leftover",
          provider: "kimi",
          sessionId: "cwd",
          status: "done",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");
    const store = new Store(filePath);
    assert.equal(store.getThread("t-cwd").sessionId, null);
  });

  it("migrates threads missing pin/snooze fields to null (not undefined)", () => {
    const old = {
      projects: [],
      threads: [
        {
          id: "t-pre-pin",
          projectId: "p1",
          title: "Legacy",
          branch: null,
          prNumber: null,
          prUrl: null,
          status: "idle",
          createdAt: 1,
          updatedAt: 2,
          provider: "claude",
          model: null,
          sessionId: null,
          permissionMode: "default",
          worktreePath: null,
          runStartedAt: null,
          archived: false,
          settledOverride: null,
          settledAt: null,
          prState: null,
          lastVisitedAt: null,
          // pinnedAt, snoozedUntil, snoozedAt deliberately absent
        },
      ],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");

    const store = new Store(filePath);
    const t = store.getThreads()[0];
    assert.equal(t.pinnedAt, null);
    assert.equal(t.snoozedUntil, null);
    assert.equal(t.snoozedAt, null);
    assert.ok(Object.prototype.hasOwnProperty.call(t, "pinnedAt"));
    assert.ok(Object.prototype.hasOwnProperty.call(t, "snoozedUntil"));
    assert.ok(Object.prototype.hasOwnProperty.call(t, "snoozedAt"));
    assert.equal(t.updatedAt, 2);
  });

  it("migrates threads missing lastVisitedAt to null (not undefined)", () => {
    const old = {
      projects: [],
      threads: [
        {
          id: "t-pre-visit",
          projectId: "p1",
          title: "Legacy",
          branch: null,
          prNumber: null,
          prUrl: null,
          status: "idle",
          createdAt: 1,
          updatedAt: 2,
          provider: "claude",
          model: null,
          sessionId: null,
          permissionMode: "default",
          worktreePath: null,
          runStartedAt: null,
          archived: false,
          settledOverride: null,
          settledAt: null,
          prState: null,
          // lastVisitedAt deliberately absent
        },
      ],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");

    const store = new Store(filePath);
    const t = store.getThreads()[0];
    assert.equal(t.lastVisitedAt, null);
    assert.ok(
      Object.prototype.hasOwnProperty.call(t, "lastVisitedAt"),
      "lastVisitedAt key must exist after migration",
    );
    assert.notEqual(t.lastVisitedAt, undefined);
    // Migration must not bump activity timestamp.
    assert.equal(t.updatedAt, 2);
  });

  it("migrates threads missing settle fields to null (not undefined)", () => {
    const old = {
      projects: [],
      threads: [
        {
          id: "t-pre-settle",
          projectId: "p1",
          title: "Legacy",
          branch: null,
          prNumber: null,
          prUrl: null,
          status: "idle",
          createdAt: 1,
          updatedAt: 2,
          provider: "claude",
          model: null,
          sessionId: null,
          permissionMode: "default",
          worktreePath: null,
          runStartedAt: null,
          archived: false,
          // settledOverride, settledAt, prState deliberately absent
        },
      ],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");

    const store = new Store(filePath);
    const t = store.getThreads()[0];
    assert.equal(t.settledOverride, null);
    assert.equal(t.settledAt, null);
    assert.equal(t.prState, null);
    assert.equal(t.prMergeable, null);
    assert.ok(
      Object.prototype.hasOwnProperty.call(t, "settledOverride"),
      "settledOverride key must exist after migration",
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(t, "settledAt"),
      "settledAt key must exist after migration",
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(t, "prState"),
      "prState key must exist after migration",
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(t, "prMergeable"),
      "prMergeable key must exist after migration",
    );
    assert.notEqual(t.settledOverride, undefined);
    assert.notEqual(t.settledAt, undefined);
    assert.notEqual(t.prState, undefined);
    assert.notEqual(t.prMergeable, undefined);
    // Migration must not bump activity timestamp.
    assert.equal(t.updatedAt, 2);
  });

  it("migrates threads missing prNumber/prUrl to null (not undefined)", () => {
    const old = {
      projects: [],
      threads: [
        {
          id: "t-pre-pr",
          projectId: "p1",
          title: "Legacy",
          branch: null,
          // prNumber and prUrl deliberately absent
          status: "idle",
          createdAt: 1,
          updatedAt: 2,
          provider: "claude",
          model: null,
          sessionId: null,
          permissionMode: "default",
          worktreePath: null,
          runStartedAt: null,
          archived: false,
        },
      ],
      messagesByThread: {},
      workLogByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(old), "utf8");

    const store = new Store(filePath);
    const t = store.getThreads()[0];
    assert.equal(t.prNumber, null);
    assert.equal(t.prUrl, null);
    assert.equal("prNumber" in t, true);
    assert.equal("prUrl" in t, true);
    assert.notEqual(t.prNumber, undefined);
    assert.notEqual(t.prUrl, undefined);
    // Migration must not bump activity timestamp.
    assert.equal(t.updatedAt, 2);
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
    store.saveNow();

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
    store.saveNow();
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

  it("leaves transcripts at or under cap + slack untouched", () => {
    const store = new Store(filePath);
    const msgs = [];
    for (let i = 0; i < MAX_MESSAGES_PER_THREAD + MESSAGE_OVERFLOW_SLACK; i += 1) {
      msgs.push({ id: `m${i}`, role: "assistant", text: `msg ${i}`, createdAt: i });
    }
    store.setMessages("t1", msgs);
    assert.deepEqual(store.getMessages("t1"), msgs);
  });

  it("caps transcript growth, dropping oldest behind a marker", () => {
    const store = new Store(filePath);
    const total = MAX_MESSAGES_PER_THREAD + MESSAGE_OVERFLOW_SLACK + 1;
    const msgs = [];
    for (let i = 0; i < total; i += 1) {
      msgs.push({ id: `m${i}`, role: "assistant", text: `msg ${i}`, createdAt: i });
    }
    store.setMessages("t1", msgs);
    const kept = store.getMessages("t1");
    assert.equal(kept.length, MAX_MESSAGES_PER_THREAD);
    assert.equal(kept[0].role, "event");
    assert.match(kept[0].text, /dropped to cap this transcript/);
    assert.equal(kept[0].id, msgs[total - MAX_MESSAGES_PER_THREAD].id);
    assert.equal(kept[1].text, `msg ${total - MAX_MESSAGES_PER_THREAD + 1}`);
    assert.equal(kept[kept.length - 1].text, `msg ${total - 1}`);
  });

  it("appendMessage caps growth and keeps exactly one marker", () => {
    const store = new Store(filePath);
    // Seed just under the overflow threshold, then append across it.
    const seed = MAX_MESSAGES_PER_THREAD + MESSAGE_OVERFLOW_SLACK;
    const msgs = [];
    for (let i = 0; i < seed; i += 1) {
      msgs.push({ id: `m${i}`, role: "assistant", text: `msg ${i}`, createdAt: i });
    }
    store.setMessages("t1", msgs);
    store.appendMessage("t1", {
      id: "m-new",
      role: "assistant",
      text: "newest",
      createdAt: seed,
    });
    const kept = store.getMessages("t1");
    assert.equal(kept.length, MAX_MESSAGES_PER_THREAD);
    assert.equal(kept.filter((m) => m.role === "event").length, 1);
    assert.equal(kept[kept.length - 1].text, "newest");
  });

  it("caps work-log growth without a marker", () => {
    const store = new Store(filePath);
    const total = MAX_WORKLOG_ITEMS_PER_THREAD + WORKLOG_OVERFLOW_SLACK + 1;
    const items = [];
    for (let i = 0; i < total; i += 1) {
      items.push({ id: `w${i}`, label: `step ${i}`, done: true, timestamp: i });
    }
    store.setWorkLog("t1", items);
    const kept = store.getWorkLog("t1");
    assert.equal(kept.length, MAX_WORKLOG_ITEMS_PER_THREAD);
    assert.equal(kept[0].label, `step ${total - MAX_WORKLOG_ITEMS_PER_THREAD}`);
    assert.equal(kept[kept.length - 1].label, `step ${total - 1}`);
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
    assert.equal(
      last.text,
      "Run interrupted: the app crashed or was force-quit mid-run",
    );
  });

  it("load recovery skips idle threads (clean quit already marked them)", () => {
    // stopAll leaves status idle; reload must NOT re-stamp failed.
    const fixed = 1_700_000_000_100;
    const raw = {
      projects: [],
      threads: [
        {
          id: "t-idle",
          projectId: "p1",
          title: "Clean quit",
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
      ],
      messagesByThread: {
        "t-idle": [
          {
            id: "m0",
            role: "event",
            text: "Run interrupted by app quit",
            createdAt: fixed,
          },
        ],
      },
      workLogByThread: {},
      usageByThread: {},
    };
    fs.writeFileSync(filePath, JSON.stringify(raw), "utf8");

    const store = new Store(filePath);
    const t = store.getThread("t-idle");
    assert.equal(t.status, "idle");
    assert.equal(t.runStartedAt, null);
    const msgs = store.getMessages("t-idle");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, "Run interrupted by app quit");
    assert.ok(
      !msgs.some((m) => /crashed|force-quit|failed/i.test(m.text)),
      "recoverInterruptedRuns must not append a crash event on idle",
    );
  });

  it("seeds builtin standard workflow template on empty store", () => {
    const store = new Store(filePath);
    const list = store.listTemplates();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "standard");
    assert.equal(list[0].name, "Plan and Verify");
    assert.equal(list[0].builtin, true);
    assert.equal(list[0].phases.length, 3);
    assert.deepEqual(
      list[0].phases.map((p) => [p.name, p.agentCount, p.provider]),
      [
        ["seed", 1, "claude"],
        ["analyze", 2, "claude"],
        ["synthesize", 1, "claude"],
      ],
    );
  });

  it("migrates missing workflowTemplates by seeding standard", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [],
        messagesByThread: {},
        workLogByThread: {},
        usageByThread: {},
      }),
      "utf8",
    );
    const store = new Store(filePath);
    assert.ok(store.getTemplate("standard"));
    assert.equal(store.listTemplates().length, 1);
  });

  it("saveTemplate creates with uuid when no id", () => {
    const store = new Store(filePath);
    const saved = store.saveTemplate({
      name: "Custom",
      phases: [
        {
          name: "only",
          agentCount: 1,
          instruction: "do it",
          provider: "claude",
          model: null,
        },
      ],
    });
    assert.ok(saved.id);
    assert.notEqual(saved.id, "standard");
    assert.equal(saved.builtin, false);
    assert.equal(saved.name, "Custom");
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.listTemplates().length, 2);
    assert.ok(reloaded.getTemplate(saved.id));
  });

  it("saveTemplate on builtin id creates a copy with (copy) name", () => {
    const store = new Store(filePath);
    const copy = store.saveTemplate({
      id: "standard",
      name: "Plan and Verify",
      phases: [
        {
          name: "seed",
          agentCount: 1,
          instruction: "plan",
          provider: "claude",
          model: null,
        },
      ],
    });
    assert.notEqual(copy.id, "standard");
    assert.equal(copy.builtin, false);
    assert.equal(copy.name, "Plan and Verify (copy)");
    assert.equal(store.getTemplate("standard").builtin, true);
    assert.equal(store.listTemplates().length, 2);
  });

  it("saveTemplate on builtin with renamed name does not suffix (copy)", () => {
    const store = new Store(filePath);
    const copy = store.saveTemplate({
      id: "standard",
      name: "My Plan",
      phases: [
        {
          name: "seed",
          agentCount: 1,
          instruction: "plan",
          provider: "claude",
          model: null,
        },
      ],
    });
    assert.equal(copy.name, "My Plan");
    assert.equal(copy.builtin, false);
  });

  it("saveTemplate updates non-builtin in place", () => {
    const store = new Store(filePath);
    const created = store.saveTemplate({
      name: "A",
      phases: [
        {
          name: "p",
          agentCount: 1,
          instruction: "x",
          provider: "claude",
          model: null,
        },
      ],
    });
    const updated = store.saveTemplate({
      id: created.id,
      name: "B",
      phases: [
        {
          name: "q",
          agentCount: 2,
          instruction: "y",
          provider: "codex",
          model: null,
        },
      ],
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "B");
    assert.equal(updated.phases[0].name, "q");
    assert.equal(store.listTemplates().filter((t) => t.id === created.id).length, 1);
  });

  it("removeTemplate rejects builtin and removes non-builtin", () => {
    const store = new Store(filePath);
    assert.throws(
      () => store.removeTemplate("standard"),
      /Cannot remove builtin template/,
    );
    const created = store.saveTemplate({
      name: "temp",
      phases: [
        {
          name: "p",
          agentCount: 1,
          instruction: "x",
          provider: "claude",
          model: null,
        },
      ],
    });
    store.removeTemplate(created.id);
    assert.equal(store.getTemplate(created.id), null);
    assert.throws(
      () => store.removeTemplate("missing-id"),
      /Unknown template/,
    );
  });

  describe("lazy messagesByThread (#639)", () => {
    const CANARY = "CANARY_" + "x".repeat(8000);

    function writeLazyFixture() {
      const payload = {
        projects: [],
        threads: [
          {
            id: "t-big",
            projectId: "p1",
            title: "Big",
            status: "idle",
            createdAt: 1,
            updatedAt: 2,
          },
          {
            id: "t-small",
            projectId: "p1",
            title: "Small",
            status: "idle",
            createdAt: 1,
            updatedAt: 3,
          },
        ],
        messagesByThread: {
          "t-big": [
            {
              id: "tool-1",
              role: "tool",
              tool: { name: "bash", input: CANARY },
              createdAt: 10,
            },
            {
              id: "asst-1",
              role: "assistant",
              text: "all done",
              createdAt: 11,
            },
          ],
          "t-small": [
            { id: "u1", role: "user", text: "ping", createdAt: 20 },
            { id: "a1", role: "assistant", text: "pong", createdAt: 21 },
          ],
        },
        workLogByThread: {},
        usageByThread: {},
      };
      fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");
    }

    it("does not JSON.parse transcript blobs at construct time", () => {
      writeLazyFixture();
      const orig = JSON.parse;
      const parsedCanary = [];
      JSON.parse = (text, ...rest) => {
        if (typeof text === "string" && text.includes("CANARY_")) {
          parsedCanary.push(text.length);
        }
        return orig(text, ...rest);
      };
      let store;
      try {
        store = new Store(filePath);
        assert.deepEqual(parsedCanary, [], "boot parse must skip tool payloads");
        assert.equal(
          Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-big"),
          false,
        );
        assert.equal(store.getLastAssistantMessage("t-big").text, "all done");
        assert.deepEqual(
          parsedCanary,
          [],
          "last-assistant peek must not parse the tool payload",
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-big"),
          false,
        );
        const msgs = store.getMessages("t-big");
        assert.equal(msgs[0].tool.input, CANARY);
        assert.equal(parsedCanary.length, 1);
        assert.equal(
          Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-small"),
          false,
        );
      } finally {
        JSON.parse = orig;
      }
    });

    it("save without opening a thread preserves unhydrated transcripts", () => {
      writeLazyFixture();
      const store = new Store(filePath);
      assert.equal(
        Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-big"),
        false,
      );
      store.setProjects([
        { id: "p1", slug: "a/b", name: "b", path: "/x" },
      ]);
      store.saveNow();
      const onDisk = fs.readFileSync(filePath, "utf8");
      assert.ok(onDisk.includes(CANARY));
      const reloaded = new Store(filePath);
      assert.equal(reloaded.getProjects()[0].id, "p1");
      assert.equal(reloaded.getMessages("t-big")[0].tool.input, CANARY);
      assert.equal(reloaded.getLastAssistantMessage("t-small").text, "pong");
    });

    it("mutating one thread does not rewrite the other's raw JSON", () => {
      writeLazyFixture();
      const store = new Store(filePath);
      store.appendMessage("t-small", {
        id: "a2",
        role: "assistant",
        text: "again",
        createdAt: 22,
      });
      store.saveNow();
      assert.equal(
        Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-big"),
        false,
      );
      const reloaded = new Store(filePath);
      assert.equal(reloaded.getMessages("t-small").at(-1).text, "again");
      assert.equal(reloaded.getMessages("t-big")[0].tool.input, CANARY);
    });

    it("removeThread drops a lazy range so reload does not resurrect it", () => {
      writeLazyFixture();
      const store = new Store(filePath);
      store.setThreads(store.getThreads().filter((t) => t.id !== "t-big"));
      store.removeThread("t-big");
      store.saveNow();
      const reloaded = new Store(filePath);
      assert.equal(reloaded.getThread("t-big"), null);
      assert.deepEqual(reloaded.getMessages("t-big"), []);
      assert.equal(
        Object.prototype.hasOwnProperty.call(reloaded.data.messagesByThread, "t-big"),
        false,
      );
      assert.ok(reloaded.getMessages("t-small").length > 0);
    });

    it("hasOwnProperty on messagesByThread is true for still-lazy ids", () => {
      writeLazyFixture();
      const store = new Store(filePath);
      assert.equal(
        Object.prototype.hasOwnProperty.call(store.data.messagesByThread, "t-big"),
        true,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-big"),
        false,
      );
    });

    it("crash recovery does not JSON.parse a working thread's tool payload (#643)", () => {
      const canaryA = "CANARY_A_" + "x".repeat(8000);
      const canaryB = "CANARY_B_" + "y".repeat(8000);
      const canaryIdle = "CANARY_IDLE_" + "z".repeat(8000);
      const payload = {
        projects: [],
        threads: [
          {
            id: "t-work-a",
            projectId: "p1",
            title: "Working A",
            status: "working",
            createdAt: 1,
            updatedAt: 2,
            runStartedAt: 3,
          },
          {
            id: "t-work-b",
            projectId: "p1",
            title: "Working B",
            status: "working",
            createdAt: 1,
            updatedAt: 4,
            runStartedAt: 5,
          },
          {
            id: "t-idle",
            projectId: "p1",
            title: "Idle",
            status: "idle",
            createdAt: 1,
            updatedAt: 6,
          },
        ],
        messagesByThread: {
          "t-work-a": [
            {
              id: "tool-a",
              role: "tool",
              tool: { name: "bash", input: canaryA },
              createdAt: 10,
            },
            {
              id: "asst-a",
              role: "assistant",
              text: "still going",
              createdAt: 11,
            },
          ],
          "t-work-b": [
            {
              id: "tool-b",
              role: "tool",
              tool: { name: "bash", input: canaryB },
              createdAt: 20,
            },
          ],
          "t-idle": [
            {
              id: "tool-idle",
              role: "tool",
              tool: { name: "bash", input: canaryIdle },
              createdAt: 30,
            },
          ],
        },
        workLogByThread: {},
        usageByThread: {},
      };
      fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");

      const orig = JSON.parse;
      const parsedCanary = [];
      JSON.parse = (text, ...rest) => {
        if (typeof text === "string" && /CANARY_/.test(text)) {
          parsedCanary.push(text.includes("CANARY_A_") ? "A" : text.includes("CANARY_B_") ? "B" : "IDLE");
        }
        return orig(text, ...rest);
      };
      let store;
      try {
        store = new Store(filePath);
        assert.deepEqual(
          parsedCanary,
          [],
          "boot recover must not JSON.parse working-thread tool payloads",
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-work-a"),
          false,
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-work-b"),
          false,
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-idle"),
          false,
        );
        assert.equal(store.getThread("t-work-a").status, "failed");
        assert.equal(store.getThread("t-work-b").status, "failed");
        assert.equal(store.getThread("t-idle").status, "idle");
        assert.equal(
          store.getThread("t-work-a").lastError,
          "Run error: app quit while the run was in flight",
        );
      } finally {
        JSON.parse = orig;
      }

      const msgsA = store.getMessages("t-work-a");
      assert.equal(msgsA[0].tool.input, canaryA);
      assert.equal(msgsA.at(-1).role, "event");
      assert.equal(
        msgsA.at(-1).text,
        "Run interrupted: the app crashed or was force-quit mid-run",
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-work-b"),
        false,
        "hydrating A must not hydrate B",
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-idle"),
        false,
      );

      store.saveNow();
      const reloaded = new Store(filePath);
      assert.equal(
        Object.prototype.hasOwnProperty.call(reloaded._messagesHydrated, "t-work-a"),
        false,
      );
      const again = reloaded.getMessages("t-work-a");
      assert.equal(again.at(-1).role, "event");
      assert.equal(again[0].tool.input, canaryA);
      const msgsB = reloaded.getMessages("t-work-b");
      assert.equal(msgsB[0].tool.input, canaryB);
      assert.equal(msgsB.at(-1).role, "event");
      assert.equal(reloaded.getMessages("t-idle")[0].tool.input, canaryIdle);
      assert.equal(reloaded.getMessages("t-idle").at(-1).role, "tool");
    });

    it("crash recovery on a working thread with no messages is a tiny hydrated tail", () => {
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          projects: [],
          threads: [
            {
              id: "t-empty",
              projectId: "p1",
              title: "Empty",
              status: "working",
              createdAt: 1,
              updatedAt: 2,
            },
            {
              id: "t-big",
              projectId: "p1",
              title: "Big",
              status: "idle",
              createdAt: 1,
              updatedAt: 3,
            },
          ],
          messagesByThread: {
            "t-big": [
              {
                id: "tool-1",
                role: "tool",
                tool: { name: "bash", input: CANARY },
                createdAt: 10,
              },
            ],
          },
          workLogByThread: {},
          usageByThread: {},
        }),
        "utf8",
      );
      const orig = JSON.parse;
      const parsedCanary = [];
      JSON.parse = (text, ...rest) => {
        if (typeof text === "string" && text.includes("CANARY_")) {
          parsedCanary.push(text.length);
        }
        return orig(text, ...rest);
      };
      let store;
      try {
        store = new Store(filePath);
        assert.deepEqual(parsedCanary, []);
        assert.equal(store.getThread("t-empty").status, "failed");
        assert.equal(
          Object.prototype.hasOwnProperty.call(store._messagesHydrated, "t-big"),
          false,
        );
      } finally {
        JSON.parse = orig;
      }
      const msgs = store.getMessages("t-empty");
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].role, "event");
      store.saveNow();
      const reloaded = new Store(filePath);
      assert.equal(reloaded.getMessages("t-empty").at(-1).role, "event");
      assert.equal(reloaded.getMessages("t-big")[0].tool.input, CANARY);
    });
  });
});
