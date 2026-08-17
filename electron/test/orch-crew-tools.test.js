const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createToolHandlers, INSTRUCTIONS } = require("../orchServer.js");

/** Fake store over plain data, matching the Store API the crew tools use. */
function makeStore(threads) {
  const list = threads.slice();
  const projects = {
    p1: { id: "p1", name: "Alpha" },
    p2: { id: "p2", name: "Beta" },
  };
  /** @type {Record<string, Array<object>>} */
  const tasks = {};
  return {
    getThreads: () => list,
    getThread: (id) => list.find((t) => t.id === id) || null,
    getProject: (id) => projects[id] || null,
    getMessages: () => [],
    getCrewTasks: (root) =>
      Array.isArray(tasks[root]) ? tasks[root].map((t) => ({ ...t })) : [],
    setCrewTasks: (root, next) => {
      if (!Array.isArray(next) || next.length === 0) delete tasks[root];
      else tasks[root] = next.map((t) => ({ ...t }));
    },
    updateThread: (id, patch) => {
      const t = list.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
      return t || null;
    },
    save: () => {},
    threads: list,
  };
}

function makeCrew() {
  return makeStore([
    { id: "root", title: "Lead", projectId: "p1", status: "idle" },
    {
      id: "w1",
      title: "Backend",
      projectId: "p1",
      orchWorker: true,
      handoffFrom: "root",
    },
    {
      id: "w2",
      title: "Frontend",
      projectId: "p1",
      orchWorker: true,
      handoffFrom: "root",
    },
    { id: "other", title: "Other", projectId: "p2", status: "idle" },
  ]);
}

function makeDeps(store) {
  const notices = [];
  return {
    store,
    runner: {
      startRun: async () => ({}),
      deliverNotice: (input) => {
        notices.push(input);
      },
    },
    forkThread: () => ({ id: "fork-1" }),
    getProvider: () => null,
    notices,
  };
}

describe("crew task MCP tools", () => {
  it("instructions name the shared list, peer_send, and branch:path hand-off", () => {
    assert.match(INSTRUCTIONS, /task_list then task_claim/);
    assert.match(INSTRUCTIONS, /task_complete/);
    assert.match(INSTRUCTIONS, /task_release rather than looping/);
    assert.match(INSTRUCTIONS, /peer_send/);
    assert.match(INSTRUCTIONS, /branch:path/);
    assert.match(INSTRUCTIONS, /git show <branch>:<path>/);
    assert.match(INSTRUCTIONS, /Chat history is not a hand-off/);
  });

  it("task_add and task_list share one list across the crew", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    const added = await h.task_add({
      threadId: "w1",
      projectId: "p1",
      tasks: [{ title: "API contract" }, { title: "UI", needs: ["t1"] }],
    });
    assert.deepEqual(added.added, ["t1", "t2"]);
    assert.equal(added.rootThreadId, "root");

    const seen = await h.task_list({ threadId: "w2", projectId: "p1" });
    assert.equal(seen.rootThreadId, "root");
    assert.deepEqual(
      seen.tasks.map((t) => [t.id, t.title, t.blocked]),
      [
        ["t1", "API contract", false],
        ["t2", "UI", true],
      ],
    );
  });

  it("task_claim with no taskId takes the next unblocked task", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    await h.task_add({
      threadId: "root",
      projectId: "p1",
      tasks: [{ title: "backend" }, { title: "frontend", needs: ["t1"] }],
    });
    const first = await h.task_claim({ threadId: "w1", projectId: "p1" });
    assert.equal(first.task.id, "t1");
    assert.equal(first.task.owner, "w1");

    const second = await h.task_claim({ threadId: "w2", projectId: "p1" });
    assert.equal(second.task, null);
    assert.match(second.reason, /waiting on dependencies/);
  });

  it("task_claim returns reason as-is when task is null", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    const empty = await h.task_claim({ threadId: "w1", projectId: "p1" });
    assert.equal(empty.task, null);
    assert.equal(empty.reason, "No open tasks left.");
  });

  it("task_complete from a worker wakes the crew root with note and unblocked ids", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    await h.task_add({
      threadId: "root",
      projectId: "p1",
      tasks: [{ title: "backend" }, { title: "frontend", needs: ["t1"] }],
    });
    await h.task_claim({ threadId: "w1", projectId: "p1", taskId: "t1" });
    const done = await h.task_complete({
      threadId: "w1",
      projectId: "p1",
      taskId: "t1",
      note: "coder/api:contract.md",
    });
    assert.equal(done.task.id, "t1");
    assert.deepEqual(
      done.unblocked.map((t) => t.id),
      ["t2"],
    );
    assert.equal(deps.notices.length, 1);
    assert.equal(deps.notices[0].threadId, "root");
    assert.match(deps.notices[0].line, /finished t1 \("backend"\)/);
    assert.match(deps.notices[0].line, /coder\/api:contract\.md/);
    assert.match(deps.notices[0].line, /Unblocked: t2/);
  });

  it("task_complete from a worker wakes the root even when nothing unblocked", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    await h.task_add({
      threadId: "root",
      projectId: "p1",
      tasks: [{ title: "leaf" }],
    });
    await h.task_claim({ threadId: "w1", projectId: "p1", taskId: "t1" });
    await h.task_complete({
      threadId: "w1",
      projectId: "p1",
      taskId: "t1",
      note: "done",
    });
    assert.equal(deps.notices.length, 1);
    assert.equal(deps.notices[0].threadId, "root");
    assert.match(deps.notices[0].line, /finished t1 \("leaf"\): done/);
    assert.doesNotMatch(deps.notices[0].line, /Unblocked/);
  });

  it("task_complete from the root wakes only when dependents unblocked", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    await h.task_add({
      threadId: "root",
      projectId: "p1",
      tasks: [{ title: "solo" }, { title: "blocked", needs: ["t1"] }],
    });
    await h.task_claim({ threadId: "root", projectId: "p1", taskId: "t1" });
    await h.task_complete({
      threadId: "root",
      projectId: "p1",
      taskId: "t1",
      note: "done",
    });
    assert.equal(deps.notices.length, 1, "root complete that unblocks wakes itself");
    assert.match(deps.notices[0].line, /Unblocked: t2/);

    await h.task_claim({ threadId: "root", projectId: "p1", taskId: "t2" });
    await h.task_complete({
      threadId: "root",
      projectId: "p1",
      taskId: "t2",
      note: "also done",
    });
    assert.equal(deps.notices.length, 1, "root complete with nothing unblocked stays quiet");
  });

  it("task_complete still returns when deliverNotice throws", async () => {
    const deps = makeDeps(makeCrew());
    deps.runner.deliverNotice = () => {
      throw new Error("notice bus down");
    };
    const h = createToolHandlers(deps);
    await h.task_add({
      threadId: "root",
      projectId: "p1",
      tasks: [{ title: "x" }],
    });
    await h.task_claim({ threadId: "w1", projectId: "p1", taskId: "t1" });
    const done = await h.task_complete({
      threadId: "w1",
      projectId: "p1",
      taskId: "t1",
      note: "ok",
    });
    assert.equal(done.task.status, "done");
  });

  it("task_release hands the task back with the outcome", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    await h.task_add({
      threadId: "root",
      projectId: "p1",
      tasks: [{ title: "flaky" }],
    });
    await h.task_claim({ threadId: "w1", projectId: "p1", taskId: "t1" });
    const released = await h.task_release({
      threadId: "w1",
      projectId: "p1",
      outcome: "tsc fails in the worktree",
    });
    assert.equal(released.length, 1);
    assert.equal(released[0].status, "open");
    const next = await h.task_claim({ threadId: "w2", projectId: "p1", taskId: "t1" });
    assert.equal(next.task.id, "t1");
    assert.deepEqual(
      next.attempts.map((a) => [a.threadId, a.outcome]),
      [["w1", "tsc fails in the worktree"]],
    );
  });

  it("every task tool rejects a thread in another project", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    const cross = /belongs to "Beta".*not to "Alpha"/s;
    await assert.rejects(
      () =>
        h.task_add({
          threadId: "other",
          projectId: "p1",
          tasks: [{ title: "x" }],
        }),
      cross,
    );
    await assert.rejects(
      () => h.task_list({ threadId: "other", projectId: "p1" }),
      cross,
    );
    await assert.rejects(
      () => h.task_claim({ threadId: "other", projectId: "p1" }),
      cross,
    );
    await assert.rejects(
      () =>
        h.task_complete({
          threadId: "other",
          projectId: "p1",
          taskId: "t1",
          note: "x",
        }),
      cross,
    );
    await assert.rejects(
      () => h.task_release({ threadId: "other", projectId: "p1" }),
      cross,
    );
  });

  it("every task tool rejects an unknown thread", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.task_add({ threadId: "ghost", projectId: "p1", tasks: [{ title: "x" }] }),
      /Unknown thread: ghost/,
    );
    await assert.rejects(
      () => h.task_list({ threadId: "ghost", projectId: "p1" }),
      /Unknown thread: ghost/,
    );
    await assert.rejects(
      () => h.task_claim({ threadId: "ghost", projectId: "p1" }),
      /Unknown thread: ghost/,
    );
    await assert.rejects(
      () =>
        h.task_complete({
          threadId: "ghost",
          projectId: "p1",
          taskId: "t1",
          note: "x",
        }),
      /Unknown thread: ghost/,
    );
    await assert.rejects(
      () => h.task_release({ threadId: "ghost", projectId: "p1" }),
      /Unknown thread: ghost/,
    );
  });
});

describe("peer_send MCP tool", () => {
  it("delivers a notice to the peer, not the lead", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    const out = await h.peer_send({
      threadId: "w1",
      projectId: "p1",
      toThreadId: "w2",
      message: "coder/api:contract.md",
    });
    assert.deepEqual(out, { delivered: true, toThreadId: "w2" });
    assert.deepEqual(deps.notices, [
      {
        threadId: "w2",
        line: '[peer from w1 ("Backend")] coder/api:contract.md',
      },
    ]);
  });

  it("rejects sending to yourself", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.peer_send({
          threadId: "w1",
          projectId: "p1",
          toThreadId: "w1",
          message: "hi",
        }),
      /Cannot peer_send to yourself/,
    );
    assert.equal(deps.notices.length, 0);
  });

  it("rejects when the caller or the target is in another project", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.peer_send({
          threadId: "other",
          projectId: "p1",
          toThreadId: "w2",
          message: "hi",
        }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    await assert.rejects(
      () =>
        h.peer_send({
          threadId: "w1",
          projectId: "p1",
          toThreadId: "other",
          message: "hi",
        }),
      /belongs to "Beta".*not to "Alpha"/s,
    );
    assert.equal(deps.notices.length, 0);
  });

  it("rejects an unknown caller or target", async () => {
    const deps = makeDeps(makeCrew());
    const h = createToolHandlers(deps);
    await assert.rejects(
      () =>
        h.peer_send({
          threadId: "ghost",
          projectId: "p1",
          toThreadId: "w2",
          message: "hi",
        }),
      /Unknown thread: ghost/,
    );
    await assert.rejects(
      () =>
        h.peer_send({
          threadId: "w1",
          projectId: "p1",
          toThreadId: "ghost",
          message: "hi",
        }),
      /Unknown thread: ghost/,
    );
  });
});
