/**
 * Issue #392: Ask mode gate — start/stop, no worktree, fork stays ask.
 * Run: npm run test:electron
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  startAsk,
  stopAsk,
  startTeach,
  askNoteFor,
  forkThread,
  forkWorkerThread,
} = require("../services.js");

let repoDir;

before(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-ask-"));
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
});

after(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

function makeStore(threadOverrides = {}, projectOverrides = {}) {
  const thread = {
    id: "t1",
    projectId: "p1",
    title: "What owns createThread",
    status: "idle",
    permissionMode: "default",
    provider: "claude",
    model: null,
    sessionId: null,
    worktreePath: null,
    pendingWorktree: false,
    ...threadOverrides,
  };
  const project = {
    id: "p1",
    path: repoDir,
    ...projectOverrides,
  };
  const threads = [thread];
  return {
    getThread: (id) => threads.find((t) => t.id === id) || null,
    getProject: (id) => (id === project.id ? project : null),
    getThreads: () => threads,
    setThreads: (next) => {
      threads.splice(0, threads.length, ...next);
    },
    setMessages: () => {},
    setWorkLog: () => {},
    updateThread: (id, patch) => {
      const t = threads.find((x) => x.id === id);
      if (!t) return null;
      Object.assign(t, patch);
      return t;
    },
    save: () => {},
    thread,
    threads,
    project,
  };
}

describe("ask mode gate", () => {
  it("startAsk is idempotent and drops a pending worktree", () => {
    const store = makeStore({ pendingWorktree: true });
    const first = startAsk(store, { threadId: "t1" });
    assert.equal(first.ask, true);
    assert.equal(first.pendingWorktree, false);
    startAsk(store, { threadId: "t1" });
    assert.equal(store.thread.ask, true);
    assert.equal(store.thread.pendingWorktree, false);
  });

  it("startAsk turns teach off", () => {
    const store = makeStore({
      teach: { autonomy: "hint", reviewsPassed: 0 },
    });
    startAsk(store, { threadId: "t1" });
    assert.equal(store.thread.ask, true);
    assert.equal(store.thread.teach, null);
  });

  it("startTeach turns ask off", () => {
    const store = makeStore({ ask: true });
    startTeach(store, { threadId: "t1" });
    assert.equal(store.thread.ask, false);
    assert.equal(store.thread.teach.autonomy, "hint");
  });

  it("stopAsk is idempotent and can arm a worktree for Start work", () => {
    const store = makeStore({ ask: true });
    stopAsk(store, { threadId: "t1" });
    assert.equal(store.thread.ask, false);
    assert.equal(store.thread.pendingWorktree, false);
    store.thread.ask = true;
    stopAsk(store, { threadId: "t1", worktree: true });
    assert.equal(store.thread.ask, false);
    assert.equal(store.thread.pendingWorktree, true);
  });

  it("stopAsk does not arm a worktree on a remote project", () => {
    const store = makeStore({ ask: true }, { remoteHost: "box", remotePath: "/x" });
    stopAsk(store, { threadId: "t1", worktree: true });
    assert.equal(store.thread.ask, false);
    assert.notEqual(store.thread.pendingWorktree, true);
  });

  it("the note is silent when off", () => {
    assert.equal(askNoteFor({}), "");
    assert.equal(askNoteFor({ ask: false }), "");
    assert.match(askNoteFor({ ask: true }), /Ask mode/);
  });

  it("fork copies ask and a worker does not get a worktree", () => {
    const store = makeStore({ ask: true });
    // forkThread / forkWorkerThread use createThread via the real store API
    // shape: getThreads/setThreads/setMessages/setWorkLog/save/updateThread.
    const fork = forkThread(store, { threadId: "t1" });
    assert.equal(fork.ask, true);
    const worker = forkWorkerThread(store, { threadId: "t1" });
    assert.equal(worker.ask, true);
    assert.notEqual(worker.pendingWorktree, true);
  });
});
