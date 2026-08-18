/**
 * Issue #373: Teach mode — standing note, autonomy ladder, permission cap.
 * Run: npm run test:electron
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  teachNoteFor,
  teachAutonomyFor,
  teachAllowedModes,
  teachPermissionAllowed,
  TEACH_REVIEW_THRESHOLDS,
  TEACH_REVIEW_PROMPT,
  startTeach,
  stopTeach,
  recordTeachReview,
  requestTeachReview,
  setPermissionMode,
  forkThread,
} = require("../services.js");

/** Fake store over plain data, matching the Store read/write API. */
function makeStore(threadOverrides = {}) {
  const thread = {
    id: "t1",
    projectId: "p1",
    title: "Learn the parser",
    status: "idle",
    permissionMode: "default",
    provider: "claude",
    model: null,
    sessionId: null,
    worktreePath: null,
    ...threadOverrides,
  };
  const threads = [thread];
  return {
    getThread: (id) => threads.find((t) => t.id === id) || null,
    getProject: (id) => (id === "p1" ? { id: "p1", path: "/tmp/proj" } : null),
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
  };
}

describe("teach mode gate", () => {
  it("startTeach is idempotent and begins at hint", () => {
    const store = makeStore();
    const first = startTeach(store, { threadId: "t1" });
    assert.deepEqual(first.teach, { autonomy: "hint", reviewsPassed: 0 });
    startTeach(store, { threadId: "t1" });
    store.thread.teach.reviewsPassed = 4;
    store.thread.teach.autonomy = "review";
    startTeach(store, { threadId: "t1" });
    assert.equal(store.thread.teach.autonomy, "review");
    assert.equal(store.thread.teach.reviewsPassed, 4);
  });

  it("startTeach downgrades a permission mode above the hint cap", () => {
    const store = makeStore({ permissionMode: "bypassPermissions" });
    startTeach(store, { threadId: "t1" });
    assert.equal(store.thread.permissionMode, "default");
    assert.equal(store.thread.teach.autonomy, "hint");
  });

  it("startTeach keeps plan (allowed at hint)", () => {
    const store = makeStore({ permissionMode: "plan" });
    startTeach(store, { threadId: "t1" });
    assert.equal(store.thread.permissionMode, "plan");
  });

  it("stopTeach clears the field and leaves permission mode", () => {
    const store = makeStore({ permissionMode: "plan" });
    startTeach(store, { threadId: "t1" });
    stopTeach(store, { threadId: "t1" });
    assert.equal(store.thread.teach, null);
    assert.equal(store.thread.permissionMode, "plan");
    stopTeach(store, { threadId: "t1" });
    assert.equal(store.thread.teach, null);
  });

  it("the note names TODO(human) and goes quiet when off", () => {
    const store = makeStore();
    assert.equal(teachNoteFor(store.thread), "");
    startTeach(store, { threadId: "t1" });
    const note = teachNoteFor(store.thread);
    assert.match(note, /Teach mode/);
    assert.match(note, /TODO\(human\)/);
    assert.match(note, /Autonomy: hint/);
    assert.match(note, /teach_review/);
    assert.equal(teachNoteFor({}), "");
    assert.equal(teachNoteFor({ teach: null }), "");
  });

  it("autonomy promotes at the documented thresholds", () => {
    assert.equal(teachAutonomyFor(0), "hint");
    assert.equal(teachAutonomyFor(TEACH_REVIEW_THRESHOLDS.review - 1), "hint");
    assert.equal(teachAutonomyFor(TEACH_REVIEW_THRESHOLDS.review), "review");
    assert.equal(teachAutonomyFor(TEACH_REVIEW_THRESHOLDS.pair - 1), "review");
    assert.equal(teachAutonomyFor(TEACH_REVIEW_THRESHOLDS.pair), "pair");
  });

  it("recordTeachReview increments only on pass and may promote", () => {
    const store = makeStore();
    startTeach(store, { threadId: "t1" });
    const fail = recordTeachReview(store, { threadId: "t1", passed: false });
    assert.equal(fail.reviewsPassed, 0);
    assert.equal(fail.promoted, false);
    assert.equal(store.thread.teach.reviewsPassed, 0);

    for (let i = 0; i < TEACH_REVIEW_THRESHOLDS.review - 1; i++) {
      recordTeachReview(store, { threadId: "t1", passed: true });
    }
    assert.equal(store.thread.teach.autonomy, "hint");
    const promo = recordTeachReview(store, { threadId: "t1", passed: true });
    assert.equal(promo.autonomy, "review");
    assert.equal(promo.promoted, true);
    assert.equal(promo.reviewsPassed, TEACH_REVIEW_THRESHOLDS.review);
  });

  it("recordTeachReview rejects a thread that is not in teach mode", () => {
    const store = makeStore();
    assert.throws(
      () => recordTeachReview(store, { threadId: "t1", passed: true }),
      /not in teach mode/,
    );
  });

  it("setPermissionMode rejects a mode above the current cap", () => {
    const store = makeStore();
    startTeach(store, { threadId: "t1" });
    assert.throws(
      () =>
        setPermissionMode(store, {
          threadId: "t1",
          mode: "bypassPermissions",
        }),
      /does not allow permission mode bypassPermissions/,
    );
    assert.throws(
      () =>
        setPermissionMode(store, { threadId: "t1", mode: "acceptEdits" }),
      /does not allow/,
    );
    const ok = setPermissionMode(store, { threadId: "t1", mode: "plan" });
    assert.equal(ok.permissionMode, "plan");
  });

  it("pair autonomy unlocks full access", () => {
    assert.ok(teachAllowedModes("pair").includes("bypassPermissions"));
    assert.ok(
      teachPermissionAllowed("bypassPermissions", {
        autonomy: "pair",
        reviewsPassed: 8,
      }),
    );
    assert.equal(
      teachPermissionAllowed("bypassPermissions", {
        autonomy: "hint",
        reviewsPassed: 0,
      }),
      false,
    );
  });

  it("requestTeachReview returns the review prompt", () => {
    const store = makeStore();
    assert.throws(
      () => requestTeachReview(store, { threadId: "t1" }),
      /not in teach mode/,
    );
    startTeach(store, { threadId: "t1" });
    const { prompt } = requestTeachReview(store, { threadId: "t1" });
    assert.equal(prompt, TEACH_REVIEW_PROMPT);
    assert.match(prompt, /TODO\(human\)/);
  });

  it("fork copies teach onto the worker so other providers stay in teach mode", () => {
    const store = makeStore();
    startTeach(store, { threadId: "t1" });
    store.thread.teach.reviewsPassed = 4;
    store.thread.teach.autonomy = "review";
    const fork = forkThread(store, { threadId: "t1", provider: "codex" });
    assert.ok(fork.teach);
    assert.equal(fork.teach.autonomy, "review");
    assert.equal(fork.teach.reviewsPassed, 4);
    assert.equal(fork.provider, "codex");
    assert.equal(fork.handoffFrom, "t1");
    assert.match(teachNoteFor(fork), /Autonomy: review/);
  });
});
