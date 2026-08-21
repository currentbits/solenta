"use strict";

/**
 * Issue #420: delayed post-merge re-check, reopen / spawn on regression.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  parseIssueNumberFromText,
  normalizeIssueNumber,
  normalizePostMerge,
  issueNumberFromThread,
  shouldSchedule,
  schedulePostMergeVerify,
  onThreadPrState,
  duePostMergeChecks,
  prepareMergedCheckout,
  buildReopenComment,
  runPostMergeCheck,
  startPostMergeScheduler,
  completeThreadIssue,
  DEFAULT_DELAY_MS,
} = require("../postmerge.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function makeStore() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-postmerge-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "ok\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const project = await services.addProject(store, repo);
  return { tmpDir, store, repo, project };
}

describe("parseIssueNumberFromText", () => {
  it("reads the start-from-issue prompt shape", () => {
    assert.equal(
      parseIssueNumberFromText(
        "GitHub issue #420: Post-merge verification\nhttps://github.com/x/y/issues/420\n\nbody",
      ),
      420,
    );
  });

  it("is case-insensitive and rejects junk", () => {
    assert.equal(parseIssueNumberFromText("github issue #12: hi"), 12);
    assert.equal(parseIssueNumberFromText("see issue #12 later"), null);
    assert.equal(parseIssueNumberFromText(""), null);
    assert.equal(normalizeIssueNumber(0), null);
    assert.equal(normalizeIssueNumber("nope"), null);
  });
});

describe("normalizePostMerge", () => {
  it("drops garbage and heals a crash mid-check to scheduled-due", () => {
    assert.equal(normalizePostMerge(null), null);
    assert.equal(normalizePostMerge({ status: "scheduled" }), null);
    const healed = normalizePostMerge({
      dueAt: Date.now() + 60_000,
      status: "running",
      at: Date.now() - 1000,
      result: null,
      fixThreadId: null,
    });
    assert.equal(healed.status, "scheduled");
    assert.ok(healed.dueAt <= Date.now());
  });
});

describe("schedulePostMergeVerify", () => {
  let tmpDir;
  let store;
  let project;
  let threadId;

  beforeEach(async () => {
    const fx = await makeStore();
    tmpDir = fx.tmpDir;
    store = fx.store;
    project = fx.project;
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Ship it",
      issueNumber: 420,
    }).id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createThread persists issueNumber and starts with no check", () => {
    const t = store.getThread(threadId);
    assert.equal(t.issueNumber, 420);
    assert.equal(t.postMergeVerify, null);
  });

  it("a legacy store row without the fields migrates to null", () => {
    store.saveNow();
    const filePath = path.join(tmpDir, "store.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    delete raw.threads[0].issueNumber;
    delete raw.threads[0].postMergeVerify;
    fs.writeFileSync(filePath, JSON.stringify(raw), "utf8");
    const upgraded = new Store(filePath);
    assert.equal(upgraded.getThread(threadId).issueNumber, null);
    assert.equal(upgraded.getThread(threadId).postMergeVerify, null);
  });

  it("arms only a MERGED thread that has a verify command", () => {
    const now = 1_700_000_000_000;
    assert.equal(shouldSchedule(store.getThread(threadId)), false);
    store.updateThread(threadId, { prState: "MERGED", verifyCommand: "npm test" });
    assert.equal(shouldSchedule(store.getThread(threadId)), true);

    const updated = schedulePostMergeVerify(store, threadId, now, {
      delayMs: 3_600_000,
    });
    assert.equal(updated.postMergeVerify.status, "scheduled");
    assert.equal(updated.postMergeVerify.dueAt, now + 3_600_000);
    assert.equal(updated.issueNumber, 420);

    assert.equal(
      schedulePostMergeVerify(store, threadId, now + 10, { delayMs: 0 }),
      null,
      "already armed",
    );
  });

  it("onThreadPrState is a no-op unless MERGED", () => {
    store.updateThread(threadId, { verifyCommand: "npm test", prState: "OPEN" });
    assert.equal(onThreadPrState(store, threadId, "OPEN"), null);
    store.updateThread(threadId, { prState: "CLOSED" });
    assert.equal(onThreadPrState(store, threadId, "CLOSED"), null);
    // Callers stamp prState first (refreshPrStates / prStatus), then hook.
    store.updateThread(threadId, { prState: "MERGED" });
    const armed = onThreadPrState(store, threadId, "MERGED", 1_000);
    assert.ok(armed);
    assert.equal(armed.postMergeVerify.status, "scheduled");
    assert.equal(armed.postMergeVerify.dueAt, 1_000 + DEFAULT_DELAY_MS);
  });

  it("parses the issue number from the first user prompt when unset", () => {
    store.updateThread(threadId, { issueNumber: null });
    store.setMessages(threadId, [
      {
        id: "m1",
        role: "user",
        text: "GitHub issue #77: Fix the leak\nhttps://example/issues/77\n\nbody",
        createdAt: 1,
      },
    ]);
    assert.equal(
      issueNumberFromThread(store, store.getThread(threadId)),
      77,
    );
    store.updateThread(threadId, {
      prState: "MERGED",
      verifyCommand: "npm test",
    });
    const armed = schedulePostMergeVerify(store, threadId, 0, { delayMs: 0 });
    assert.equal(armed.issueNumber, 77);
  });

  it("duePostMergeChecks is empty until dueAt", () => {
    store.updateThread(threadId, { prState: "MERGED", verifyCommand: "npm test" });
    schedulePostMergeVerify(store, threadId, 1_000, { delayMs: 500 });
    assert.deepEqual(duePostMergeChecks(store, 1_499).map((t) => t.id), []);
    assert.deepEqual(duePostMergeChecks(store, 1_500).map((t) => t.id), [
      threadId,
    ]);
  });
});

describe("runPostMergeCheck", () => {
  let tmpDir;
  let store;
  let project;
  let threadId;

  beforeEach(async () => {
    const fx = await makeStore();
    tmpDir = fx.tmpDir;
    store = fx.store;
    project = fx.project;
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Ship it",
      issueNumber: 420,
    });
    threadId = thread.id;
    store.updateThread(threadId, {
      prState: "MERGED",
      verifyCommand: "npm test",
      prNumber: 12,
    });
    schedulePostMergeVerify(store, threadId, 0, { delayMs: 0 });
    store.saveNow();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function result(over) {
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      log: "ok\n",
      durationMs: 12,
      ...over,
    };
  }

  it("marks passed and does not reopen or spawn", async () => {
    const reopens = [];
    const spawns = [];
    await runPostMergeCheck(
      {
        store,
        prepareCheckout: async () => ({
          cwd: project.path,
          sha: "abc1234deadbeef",
          cleanup: async () => {},
        }),
        runVerify: async () => result(),
        reopenIssue: async (...args) => {
          reopens.push(args);
          return { ok: true };
        },
        spawnFix: async (...args) => {
          spawns.push(args);
          return { id: "fix-1", title: "Regression" };
        },
      },
      store.getThread(threadId),
      10,
    );
    const check = store.getThread(threadId).postMergeVerify;
    assert.equal(check.status, "passed");
    assert.equal(check.result.ok, true);
    assert.equal(check.result.sha, "abc1234deadbeef");
    assert.equal(check.result.runId, "postmerge");
    assert.deepEqual(reopens, []);
    assert.deepEqual(spawns, []);
    const events = store
      .getMessages(threadId)
      .filter((m) => m.role === "event");
    assert.match(events[0].text, /Post-merge verification passed/);
  });

  it("on failure reopens the issue and spawns a fix thread", async () => {
    const reopens = [];
    let started = null;
    const runner = {
      startRun: async (input) => {
        started = input;
      },
    };
    await runPostMergeCheck(
      {
        store,
        runner,
        prepareCheckout: async () => ({
          cwd: project.path,
          sha: "def4567",
          cleanup: async () => {},
        }),
        runVerify: async () =>
          result({ ok: false, exitCode: 1, log: "not ok\n" }),
        reopenIssue: async (cwd, number, opts) => {
          reopens.push({ cwd, number, comment: opts.comment });
          return { ok: true };
        },
      },
      store.getThread(threadId),
      10,
    );
    const check = store.getThread(threadId).postMergeVerify;
    assert.equal(check.status, "failed");
    assert.equal(check.result.ok, false);
    assert.ok(check.fixThreadId);
    assert.equal(reopens.length, 1);
    assert.equal(reopens[0].number, 420);
    assert.match(reopens[0].comment, /Post-merge verification failed/);
    assert.match(reopens[0].comment, /Merged PR: #12/);
    assert.ok(started);
    assert.equal(started.threadId, check.fixThreadId);
    assert.match(started.prompt, /post-merge regression/);
    assert.match(started.prompt, /Planboard issue: #420/);
    const fix = store.getThread(check.fixThreadId);
    assert.equal(fix.handoffFrom, threadId);
    assert.equal(fix.verifyCommand, "npm test");
    assert.equal(fix.issueNumber, 420);
    assert.equal(fix.pendingWorktree, true);
    assert.match(fix.title, /^Regression:/);
  });

  it("skips a remote project and a cleared command", async () => {
    store.updateThread(threadId, { verifyCommand: null });
    await runPostMergeCheck(
      { store, prepareCheckout: async () => {
        throw new Error("should not checkout");
      } },
      store.getThread(threadId),
      10,
    );
    assert.equal(store.getThread(threadId).postMergeVerify.status, "skipped");
    assert.equal(
      store.getThread(threadId).postMergeVerify.skipReason,
      "verify command cleared",
    );

    store.updateThread(threadId, {
      verifyCommand: "npm test",
      postMergeVerify: {
        dueAt: 0,
        status: "scheduled",
        at: null,
        result: null,
        fixThreadId: null,
      },
    });
    store.setProjects(
      store.getProjects().map((p) =>
        p.id === project.id ? { ...p, remoteHost: "box" } : p,
      ),
    );
    await runPostMergeCheck(
      { store },
      store.getThread(threadId),
      10,
    );
    assert.equal(store.getThread(threadId).postMergeVerify.status, "skipped");
    assert.equal(
      store.getThread(threadId).postMergeVerify.skipReason,
      "remote project",
    );
  });

  it("skips when the checkout cannot be prepared", async () => {
    await runPostMergeCheck(
      {
        store,
        prepareCheckout: async () => {
          throw new Error("could not check out merged state");
        },
      },
      store.getThread(threadId),
      10,
    );
    assert.equal(store.getThread(threadId).postMergeVerify.status, "skipped");
    assert.match(
      store.getThread(threadId).postMergeVerify.skipReason,
      /could not check out/,
    );
  });
});

describe("startPostMergeScheduler", () => {
  it("fires a due check once and ignores a second tick while in flight", async () => {
    const fx = await makeStore();
    const thread = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Ship it",
    });
    fx.store.updateThread(thread.id, {
      prState: "MERGED",
      verifyCommand: "true",
    });
    schedulePostMergeVerify(fx.store, thread.id, 0, { delayMs: 0 });
    fx.store.saveNow();

    let runs = 0;
    const { tick, stop } = startPostMergeScheduler({
      store: fx.store,
      intervalMs: 60_000,
      now: () => 5_000,
      prepareCheckout: async () => ({
        cwd: fx.project.path,
        sha: "aaa",
        cleanup: async () => {},
      }),
      runVerify: async () => {
        runs += 1;
        return { ok: true, exitCode: 0, timedOut: false, log: "", durationMs: 1 };
      },
    });
    await tick();
    await tick();
    stop();
    assert.equal(runs, 1);
    assert.equal(fx.store.getThread(thread.id).postMergeVerify.status, "passed");
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  });
});

describe("prepareMergedCheckout", () => {
  it("checks out HEAD in a detached worktree and cleans up", async () => {
    const fx = await makeStore();
    const checkout = await prepareMergedCheckout(fx.project, {
      tmpDir: fx.tmpDir,
    });
    try {
      assert.ok(fs.existsSync(checkout.cwd));
      assert.notEqual(checkout.cwd, fx.project.path);
      assert.ok(checkout.sha);
      assert.match(checkout.sha, /^[0-9a-f]{40}$/);
      assert.ok(fs.existsSync(path.join(checkout.cwd, "README.md")));
    } finally {
      await checkout.cleanup();
    }
    assert.equal(fs.existsSync(checkout.cwd), false);
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  });
});

describe("buildReopenComment", () => {
  it("includes command, result, and log", () => {
    const text = buildReopenComment(
      {
        command: "npm test",
        ok: false,
        exitCode: 1,
        timedOut: false,
        log: "boom",
        sha: "abcdef0",
        durationMs: 4000,
        at: 1,
        attempt: 0,
        runId: "postmerge",
      },
      { fixThreadTitle: "Regression: Ship it", prNumber: 9 },
    );
    assert.match(text, /Command: npm test/);
    assert.match(text, /exited 1/);
    assert.match(text, /Merged PR: #9/);
    assert.match(text, /Fix thread started in Solenta: Regression: Ship it/);
    assert.match(text, /boom/);
  });
});

describe("completeThreadIssue (#632)", () => {
  let tmpDir;
  let store;
  let project;

  function thread(title, issueNumber) {
    return services.createThread(store, {
      projectId: project.id,
      title,
      issueNumber,
    }).id;
  }

  /** Records what would have been closed. */
  function spy() {
    const seen = [];
    return {
      seen,
      completeIssue: async (projectPath, number, opts) => {
        seen.push({ projectPath, number, comment: opts && opts.comment });
        return { ok: true };
      },
    };
  }

  beforeEach(async () => {
    const fx = await makeStore();
    tmpDir = fx.tmpDir;
    store = fx.store;
    project = fx.project;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("closes the linked issue once and notes it on the thread", async () => {
    const id = thread("Ship it", 901);
    const deps = spy();
    assert.deepEqual(await completeThreadIssue(store, id, deps), { ok: true });
    assert.equal(deps.seen.length, 1);
    assert.equal(deps.seen[0].number, 901);
    assert.equal(deps.seen[0].projectPath, project.path);
    assert.match(deps.seen[0].comment, /Ship it/);
    assert.ok(
      (store.getMessages(id) || []).some(
        (m) => m.role === "event" && /#901 moved to Done/.test(m.text),
      ),
    );
    // A second landing signal (interactive prStatus re-reporting MERGED)
    // must not spawn another round of gh calls.
    assert.equal(await completeThreadIssue(store, id, deps), null);
    assert.equal(deps.seen.length, 1);
  });

  it("falls back to `issue #N` in the first prompt, not a later mention", async () => {
    const id = thread("Fork worker", null);
    store.setMessages(id, [
      { id: "m1", role: "user", text: "Fix issue #902 on this branch", createdAt: 1 },
      { id: "m2", role: "user", text: "see issue #903 for context", createdAt: 2 },
    ]);
    const deps = spy();
    await completeThreadIssue(store, id, deps);
    assert.deepEqual(
      deps.seen.map((c) => c.number),
      [902],
    );
  });

  it("does nothing when no prompt names an issue", async () => {
    const id = thread("No issue here", null);
    store.setMessages(id, [
      { id: "m1", role: "user", text: "just make the button blue", createdAt: 1 },
    ]);
    const deps = spy();
    assert.equal(await completeThreadIssue(store, id, deps), null);
    assert.deepEqual(deps.seen, []);
  });
});
