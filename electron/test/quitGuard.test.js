"use strict";

/**
 * Accidental-quit guard (issue #1195).
 * Run: node --test electron/test/quitGuard.test.js
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  collectActiveWork,
  formatQuitDialog,
  shouldBlockWindowClose,
  createQuitPolicy,
} = require("../quitGuard.js");
const { installShutdown } = require("../shutdown.js");
const { resetShutdownForTests } = require("../proc.js");
const { IPC_HANDLERS } = require("../ipc.js");
const updater = require("../updater.js");

afterEach(() => {
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  resetShutdownForTests();
  if (typeof updater.resetStaged === "function") updater.resetStaged();
});

function quitEvent() {
  const prevented = { count: 0 };
  return {
    prevented,
    event: {
      preventDefault() {
        prevented.count += 1;
      },
    },
  };
}

describe("collectActiveWork", () => {
  it("is idle when nothing is managed", () => {
    const snap = collectActiveWork({
      listActiveThreadIds: () => [],
      listActiveBtwCount: () => 0,
      listThreads: () => [{ id: "t1", title: "Idle", status: "idle" }],
      listLiveTerminals: () => [],
      listLiveDevServers: () => [],
    });
    assert.equal(snap.hasWork, false);
    assert.equal(snap.runs, 0);
    assert.equal(snap.questions, 0);
    assert.equal(snap.approvals, 0);
    assert.equal(snap.terminals, 0);
    assert.equal(snap.servers, 0);
  });

  it("counts live runs and ignores threads that are merely idle", () => {
    const snap = collectActiveWork({
      listActiveThreadIds: () => ["t1"],
      listThreads: () => [
        { id: "t1", title: "Fix login" },
        { id: "t2", title: "Warm idle session" },
      ],
    });
    assert.equal(snap.hasWork, true);
    assert.equal(snap.runs, 1);
    assert.deepEqual(snap.runTitles, ["Fix login"]);
  });

  it("counts side questions as running work", () => {
    const snap = collectActiveWork({
      listActiveThreadIds: () => [],
      listActiveBtwCount: () => 2,
    });
    assert.equal(snap.runs, 2);
    assert.equal(snap.hasWork, true);
  });

  it("counts pending questions and plans, including approvals that outlive a run", () => {
    const snap = collectActiveWork({
      listActiveThreadIds: () => ["running"],
      listThreads: () => [
        { id: "running", title: "Busy", awaitingInput: true },
        {
          id: "asked",
          title: "Grok asked",
          pendingQuestion: { questions: [{ question: "Which?" }] },
        },
        { id: "plan", title: "Plan", pendingPlan: { plan: "do it" } },
        { id: "stale", title: "Stale prompt", awaitingInput: true },
      ],
    });
    assert.equal(snap.runs, 1);
    assert.equal(snap.questions, 1);
    assert.equal(snap.approvals, 2);
    assert.equal(snap.hasWork, true);
  });

  it("counts live terminals and servers, not empty lists", () => {
    const snap = collectActiveWork({
      listLiveTerminals: () => ["t1"],
      listLiveDevServers: () => ["t1", "t2"],
    });
    assert.equal(snap.terminals, 1);
    assert.equal(snap.servers, 2);
    assert.equal(snap.hasWork, true);
  });
});

describe("formatQuitDialog", () => {
  it("summarizes each kind of work for an ordinary quit", () => {
    const spec = formatQuitDialog({
      runs: 2,
      questions: 1,
      approvals: 1,
      terminals: 1,
      servers: 1,
      runTitles: ["Fix login", "Review PR"],
      hasWork: true,
    });
    assert.equal(spec.title, "Stop work and quit?");
    assert.equal(spec.confirmLabel, "Stop work and quit");
    assert.equal(spec.cancelLabel, "Cancel");
    assert.match(spec.detail, /2 running agents/);
    assert.match(spec.detail, /1 question waiting for an answer/);
    assert.match(spec.detail, /1 plan or approval waiting/);
    assert.match(spec.detail, /1 terminal session/);
    assert.match(spec.detail, /1 dev server/);
    assert.match(spec.detail, /Fix login/);
    assert.match(spec.detail, /Review PR/);
    assert.equal(spec.checkboxLabel, "Don't ask again");
  });

  it("uses restart copy for a planned updater relaunch", () => {
    const spec = formatQuitDialog(
      { runs: 1, questions: 0, approvals: 0, terminals: 0, servers: 0, runTitles: ["A"], hasWork: true },
      { reason: "update" },
    );
    assert.equal(spec.title, "Stop work and restart?");
    assert.equal(spec.confirmLabel, "Stop work and restart");
    assert.match(spec.message, /Restarting to update/);
  });
});

describe("shouldBlockWindowClose", () => {
  it("never blocks macOS window close", () => {
    assert.equal(
      shouldBlockWindowClose({
        platform: "darwin",
        wouldConfirm: true,
      }),
      false,
    );
  });

  it("never blocks serve-web or an in-flight shutdown", () => {
    assert.equal(
      shouldBlockWindowClose({
        platform: "win32",
        serveWeb: true,
        wouldConfirm: true,
      }),
      false,
    );
    assert.equal(
      shouldBlockWindowClose({
        platform: "linux",
        shuttingDown: true,
        wouldConfirm: true,
      }),
      false,
    );
  });

  it("blocks last-window close on Windows and Linux when a confirm would show", () => {
    assert.equal(
      shouldBlockWindowClose({
        platform: "win32",
        wouldConfirm: () => true,
      }),
      true,
    );
    assert.equal(
      shouldBlockWindowClose({
        platform: "linux",
        wouldConfirm: () => false,
      }),
      false,
    );
  });
});

describe("createQuitPolicy", () => {
  it("skips the dialog when idle or when the user opted out", async () => {
    const shown = [];
    const idle = createQuitPolicy({
      collect: () => ({ hasWork: false }),
      showDialog: async (spec) => {
        shown.push(spec);
        return { response: 1 };
      },
    });
    assert.equal(idle.wouldConfirm(), false);
    assert.equal(await idle.confirmQuit(), true);
    assert.equal(shown.length, 0);

    const opted = createQuitPolicy({
      collect: () => ({ hasWork: true, runs: 1 }),
      getSettings: () => ({ confirmQuitWithActiveWork: false }),
      showDialog: async (spec) => {
        shown.push(spec);
        return { response: 1 };
      },
    });
    assert.equal(opted.wouldConfirm(), false);
    assert.equal(await opted.confirmQuit(), true);
    assert.equal(shown.length, 0);
  });

  it("cancel leaves work alone; confirm returns true", async () => {
    const policy = createQuitPolicy({
      collect: () => ({
        hasWork: true,
        runs: 1,
        questions: 0,
        approvals: 0,
        terminals: 0,
        servers: 0,
        runTitles: ["Fix login"],
      }),
      showDialog: async () => ({ response: 0 }),
    });
    assert.equal(policy.wouldConfirm(), true);
    assert.equal(await policy.confirmQuit(), false);

    const yes = createQuitPolicy({
      collect: () => ({
        hasWork: true,
        runs: 1,
        questions: 0,
        approvals: 0,
        terminals: 0,
        servers: 0,
        runTitles: [],
      }),
      showDialog: async () => ({ response: 1 }),
    });
    assert.equal(await yes.confirmQuit(), true);
  });

  it("Don't ask again persists only after a confirmed quit", async () => {
    const patches = [];
    const cancel = createQuitPolicy({
      collect: () => ({ hasWork: true, runs: 1, runTitles: [] }),
      setSettings: (p) => patches.push(p),
      showDialog: async () => ({ response: 0, checkboxChecked: true }),
    });
    assert.equal(await cancel.confirmQuit(), false);
    assert.deepEqual(patches, []);

    const ok = createQuitPolicy({
      collect: () => ({ hasWork: true, runs: 1, runTitles: [] }),
      setSettings: (p) => patches.push(p),
      showDialog: async () => ({ response: 1, checkboxChecked: true }),
    });
    assert.equal(await ok.confirmQuit(), true);
    assert.deepEqual(patches, [{ confirmQuitWithActiveWork: false }]);
  });

  it("skip-once lets a planned updater relaunch through without a second dialog", async () => {
    let shown = 0;
    const policy = createQuitPolicy({
      collect: () => ({ hasWork: true, runs: 1, runTitles: [] }),
      showDialog: async () => {
        shown += 1;
        return { response: 1 };
      },
    });
    assert.equal(await policy.confirmQuit("update"), true);
    assert.equal(shown, 1);
    policy.markSkipOnce();
    assert.equal(policy.wouldConfirm(), false);
    assert.equal(await policy.confirmQuit(), true);
    assert.equal(shown, 1);
    // consumed: a later quit would confirm again
    assert.equal(policy.wouldConfirm(), true);
  });

  it("a second confirm while the dialog is up does not stack another dialog", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let shown = 0;
    const policy = createQuitPolicy({
      collect: () => ({ hasWork: true, runs: 1, runTitles: [] }),
      showDialog: async () => {
        shown += 1;
        await gate;
        return { response: 1 };
      },
    });
    const first = policy.confirmQuit();
    await Promise.resolve();
    assert.equal(await policy.confirmQuit(), false);
    release();
    assert.equal(await first, true);
    assert.equal(shown, 1);
  });
});

describe("installShutdown confirmQuit", () => {
  it("cancel happens before cleanup and does not exit", async () => {
    const calls = [];
    const app = new EventEmitter();
    installShutdown({
      app,
      exit: (code) => calls.push(["exit", code]),
      cleanup: () => calls.push(["cleanup"]),
      confirmQuit: async () => false,
    });
    const { event, prevented } = quitEvent();
    app.emit("before-quit", event);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(prevented.count, 1);
    assert.deepEqual(calls, []);
  });

  it("confirm runs cleanup exactly once and then exits", async () => {
    const calls = [];
    const app = new EventEmitter();
    installShutdown({
      app,
      exit: (code) => calls.push(["exit", code]),
      cleanup: () => calls.push(["cleanup"]),
      confirmQuit: async () => true,
    });
    app.emit("before-quit", quitEvent().event);
    app.emit("before-quit", quitEvent().event);
    const start = Date.now();
    while (!calls.some((c) => c[0] === "exit")) {
      if (Date.now() - start > 1000) {
        throw new Error(`no exit; saw ${JSON.stringify(calls)}`);
      }
      await new Promise((r) => setImmediate(r));
    }
    assert.deepEqual(calls, [["cleanup"], ["exit", 0]]);
  });

  it("SIGINT skips the dialog and still cleans up", async () => {
    const calls = [];
    let confirmCalls = 0;
    const app = new EventEmitter();
    const shutdown = installShutdown({
      app,
      exit: (code) => calls.push(["exit", code]),
      cleanup: () => calls.push(["cleanup"]),
      confirmQuit: async () => {
        confirmCalls += 1;
        return false;
      },
    });
    process.emit("SIGINT");
    await shutdown();
    await Promise.resolve();
    assert.equal(confirmCalls, 0);
    assert.deepEqual(calls, [["cleanup"], ["exit", 0]]);
  });

  it("SIGINT during a pending dialog still starts cleanup", async () => {
    const calls = [];
    const app = new EventEmitter();
    const shutdown = installShutdown({
      app,
      exit: (code) => calls.push(["exit", code]),
      cleanup: () => calls.push(["cleanup"]),
      confirmQuit: () => new Promise(() => {}),
    });
    app.emit("before-quit", quitEvent().event);
    await Promise.resolve();
    assert.deepEqual(calls, []);
    process.emit("SIGTERM");
    await shutdown();
    await Promise.resolve();
    assert.deepEqual(calls, [["cleanup"], ["exit", 0]]);
  });
});

describe("app:applyUpdate confirm hook", () => {
  it("does not relaunch when the user cancels", async () => {
    const calls = [];
    const original = updater.applyUpdate;
    updater.applyUpdate = () => calls.push("apply");
    try {
      await IPC_HANDLERS["app:applyUpdate"]({
        confirmApplyUpdate: async () => false,
      });
      assert.deepEqual(calls, []);
    } finally {
      updater.applyUpdate = original;
    }
  });

  it("applies after confirm", async () => {
    const calls = [];
    const original = updater.applyUpdate;
    updater.applyUpdate = () => calls.push("apply");
    try {
      await IPC_HANDLERS["app:applyUpdate"]({
        confirmApplyUpdate: async () => true,
      });
      assert.deepEqual(calls, ["apply"]);
    } finally {
      updater.applyUpdate = original;
    }
  });
});
