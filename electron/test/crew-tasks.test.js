const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  crewRootOf,
  listCrewTasks,
  addCrewTasks,
  claimCrewTask,
  completeCrewTask,
  releaseCrewTasks,
  crewTaskNoteFor,
  CREW_TASK_ATTEMPT_CAP,
} = require("../services.js");

/** Fake store over plain data, matching the Store API these functions use. */
function makeStore(threads) {
  const list = threads.slice();
  /** @type {Record<string, Array<object>>} */
  const tasks = {};
  return {
    getThread: (id) => list.find((t) => t.id === id) || null,
    getThreads: () => list,
    getCrewTasks: (root) =>
      Array.isArray(tasks[root]) ? tasks[root].map((t) => ({ ...t })) : [],
    setCrewTasks: (root, next) => {
      if (!Array.isArray(next) || next.length === 0) delete tasks[root];
      else tasks[root] = next.map((t) => ({ ...t }));
    },
    save: () => {},
  };
}

/** Orchestrator "root" with two workers forked off it. */
function makeCrew() {
  return makeStore([
    { id: "root", projectId: "p1", status: "idle" },
    { id: "w1", projectId: "p1", orchWorker: true, handoffFrom: "root" },
    { id: "w2", projectId: "p1", orchWorker: true, handoffFrom: "root" },
    { id: "w3", projectId: "p1", orchWorker: true, handoffFrom: "w1" },
    { id: "other", projectId: "p1", status: "idle" },
  ]);
}

describe("crewRootOf", () => {
  it("walks orchWorker handoffFrom to the top, plain threads are their own root", () => {
    const store = makeCrew();
    assert.equal(crewRootOf(store, "root"), "root");
    assert.equal(crewRootOf(store, "w1"), "root");
    assert.equal(crewRootOf(store, "w3"), "root", "nested worker joins the crew");
    assert.equal(crewRootOf(store, "other"), "other");
    assert.equal(crewRootOf(store, "gone"), "gone");
  });

  it("survives a handoffFrom cycle", () => {
    const store = makeStore([
      { id: "a", orchWorker: true, handoffFrom: "b" },
      { id: "b", orchWorker: true, handoffFrom: "a" },
    ]);
    assert.ok(["a", "b"].includes(crewRootOf(store, "a")));
  });
});

describe("crew task list", () => {
  /** @type {ReturnType<typeof makeCrew>} */
  let store;
  beforeEach(() => {
    store = makeCrew();
  });

  it("is shared: a worker sees the tasks another worker added", () => {
    addCrewTasks(store, {
      threadId: "w1",
      tasks: [{ title: "API contract" }, { title: "UI", needs: ["t1"] }],
    });
    const seen = listCrewTasks(store, { threadId: "w2" });
    assert.equal(seen.rootThreadId, "root");
    assert.deepEqual(
      seen.tasks.map((t) => [t.id, t.title, t.blocked]),
      [
        ["t1", "API contract", false],
        ["t2", "UI", true],
      ],
    );
  });

  it("rejects a dependency on an unknown task", () => {
    assert.throws(
      () => addCrewTasks(store, { threadId: "root", tasks: [{ title: "x", needs: ["t9"] }] }),
      /needs unknown task/,
    );
    assert.deepEqual(listCrewTasks(store, { threadId: "root" }).tasks, []);
  });

  it("self-claim takes the first unblocked task and skips blocked ones", () => {
    addCrewTasks(store, {
      threadId: "root",
      tasks: [{ title: "backend" }, { title: "frontend", needs: ["t1"] }],
    });
    const first = claimCrewTask(store, { threadId: "w1" });
    assert.equal(first.task.id, "t1");
    assert.equal(first.task.owner, "w1");

    const second = claimCrewTask(store, { threadId: "w2" });
    assert.equal(second.task, null, "t2 is blocked on t1, t1 is taken");
    assert.match(second.reason, /waiting on dependencies/);

    const taken = claimCrewTask(store, { threadId: "w2", taskId: "t1" });
    assert.equal(taken.task, null);
    assert.match(taken.reason, /already claimed by thread w1/);
  });

  it("completing a task reports exactly the tasks it unblocked", () => {
    addCrewTasks(store, {
      threadId: "root",
      tasks: [
        { title: "backend" },
        { title: "frontend", needs: ["t1"] },
        { title: "docs", needs: ["t1", "t2"] },
      ],
    });
    claimCrewTask(store, { threadId: "w1", taskId: "t1" });
    const done = completeCrewTask(store, {
      threadId: "w1",
      taskId: "t1",
      note: "coder/api:contract.md",
    });
    assert.deepEqual(done.unblocked.map((t) => t.id), ["t2"], "t3 still needs t2");
    assert.equal(done.task.note, "coder/api:contract.md");
    assert.equal(done.task.owner, null);

    const after = claimCrewTask(store, { threadId: "w2" });
    assert.equal(after.task.id, "t2", "the unblocked task is now claimable");
  });

  it("a worker cannot complete a peer's task, the root can", () => {
    addCrewTasks(store, { threadId: "root", tasks: [{ title: "x" }, { title: "y" }] });
    claimCrewTask(store, { threadId: "w1", taskId: "t1" });
    assert.throws(
      () => completeCrewTask(store, { threadId: "w2", taskId: "t1" }),
      /claimed by thread w1/,
    );
    completeCrewTask(store, { threadId: "root", taskId: "t1", note: "closed by lead" });
    assert.equal(listCrewTasks(store, { threadId: "w2" }).tasks[0].status, "done");
  });

  it("release hands a task back with the outcome the next claimer reads", () => {
    addCrewTasks(store, { threadId: "root", tasks: [{ title: "flaky" }] });
    claimCrewTask(store, { threadId: "w1", taskId: "t1" });
    const released = releaseCrewTasks(store, {
      threadId: "w1",
      outcome: "tsc fails in the worktree",
    });
    assert.equal(released.length, 1);
    const next = claimCrewTask(store, { threadId: "w2", taskId: "t1" });
    assert.equal(next.task.id, "t1");
    assert.deepEqual(
      next.attempts.map((a) => [a.threadId, a.outcome]),
      [["w1", "tsc fails in the worktree"]],
    );
  });

  it("refuses a task past the attempt cap instead of looping", () => {
    addCrewTasks(store, { threadId: "root", tasks: [{ title: "cursed" }] });
    for (let i = 0; i < CREW_TASK_ATTEMPT_CAP; i++) {
      const claim = claimCrewTask(store, { threadId: "w1", taskId: "t1" });
      assert.equal(claim.task.id, "t1", `claim ${i + 1} allowed`);
      releaseCrewTasks(store, { threadId: "w1", outcome: `attempt ${i + 1} failed` });
    }
    const refused = claimCrewTask(store, { threadId: "w2", taskId: "t1" });
    assert.equal(refused.task, null);
    assert.match(refused.reason, /attempt cap/);
  });
});

describe("crewTaskNoteFor", () => {
  it("is silent for a thread holding nothing", () => {
    const store = makeCrew();
    addCrewTasks(store, { threadId: "root", tasks: [{ title: "x" }] });
    assert.equal(crewTaskNoteFor(store, store.getThread("w1")), "");
  });

  it("names the held task and forces a reflection on a retry", () => {
    const store = makeCrew();
    addCrewTasks(store, { threadId: "root", tasks: [{ title: "wire the API" }] });
    claimCrewTask(store, { threadId: "w1", taskId: "t1" });

    const fresh = crewTaskNoteFor(store, store.getThread("w1"));
    assert.match(fresh, /\[Crew task\]/);
    assert.match(fresh, /t1: wire the API/);
    assert.doesNotMatch(fresh, /Reflect first/, "first attempt owes no reflection");

    releaseCrewTasks(store, { threadId: "w1", outcome: "wrong endpoint" });
    claimCrewTask(store, { threadId: "w2", taskId: "t1" });
    const retry = crewTaskNoteFor(store, store.getThread("w2"));
    assert.match(retry, /Reflect first/);
    assert.match(retry, /already attempted by thread w1: wrong endpoint/);
  });

  it("folds the thread's own last error into the reflection", () => {
    const store = makeCrew();
    addCrewTasks(store, { threadId: "root", tasks: [{ title: "x" }] });
    claimCrewTask(store, { threadId: "w1", taskId: "t1" });
    const thread = { ...store.getThread("w1"), lastError: "exit code 1" };
    assert.match(crewTaskNoteFor(store, thread), /your own last run failed: exit code 1/);
  });
});
