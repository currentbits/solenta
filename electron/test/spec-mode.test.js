const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SPEC_ARTIFACTS,
  nextSpecStage,
  specNoteFor,
  startSpec,
  stopSpec,
  submitSpec,
  reviewSpec,
  dispatchSpec,
  forkSpecWave,
  convergeSpec,
  listCrewTasks,
  completeCrewTask,
  readSpecArtifact,
} = require("../services.js");

/** Fake store over plain data, matching the Store read/write API. */
function makeStore(threadOverrides = {}, projectPath = "/tmp/proj") {
  const thread = {
    id: "t1",
    projectId: "p1",
    title: "Add spec mode",
    status: "idle",
    worktreePath: null,
    ...threadOverrides,
  };
  return {
    getThread: (id) => (id === "t1" ? thread : null),
    getProject: (id) => (id === "p1" ? { id: "p1", path: projectPath } : null),
    updateThread: (id, patch) => (id === "t1" ? Object.assign(thread, patch) : null),
    save: () => {},
    thread,
  };
}

describe("spec mode gate", () => {
  it("walks requirements -> design -> tasks -> build, one approval each", () => {
    const store = makeStore();
    startSpec(store, { threadId: "t1" });
    assert.equal(store.thread.spec.stage, "requirements");
    assert.equal(store.thread.spec.awaitingApproval, false);
    assert.equal(store.thread.spec.slug, "add-spec-mode");

    for (const stage of SPEC_ARTIFACTS) {
      assert.equal(store.thread.spec.stage, stage);
      submitSpec(store, { threadId: "t1" });
      assert.equal(store.thread.spec.awaitingApproval, true);
      const { prompt } = reviewSpec(store, {
        threadId: "t1",
        decision: "approve",
      });
      assert.equal(store.thread.spec.awaitingApproval, false);
      assert.match(prompt, /\S/);
    }
    assert.equal(store.thread.spec.stage, "build");
    assert.equal(nextSpecStage("build"), null);
  });

  it("revise keeps the stage and hands the feedback back", () => {
    const store = makeStore();
    startSpec(store, { threadId: "t1" });
    submitSpec(store, { threadId: "t1" });
    const { prompt } = reviewSpec(store, {
      threadId: "t1",
      decision: "revise",
      feedback: "no acceptance criteria for the error path",
    });
    assert.equal(store.thread.spec.stage, "requirements");
    assert.match(prompt, /error path/);
  });

  it("rejects a review with no artifact awaiting approval", () => {
    const store = makeStore();
    startSpec(store, { threadId: "t1" });
    assert.throws(
      () => reviewSpec(store, { threadId: "t1", decision: "approve" }),
      /awaiting approval/,
    );
  });

  it("startSpec is idempotent — a second call cannot rewind a stage", () => {
    const store = makeStore();
    startSpec(store, { threadId: "t1" });
    submitSpec(store, { threadId: "t1" });
    reviewSpec(store, { threadId: "t1", decision: "approve" });
    startSpec(store, { threadId: "t1" });
    assert.equal(store.thread.spec.stage, "design");
  });

  it("the note names the stage file and goes quiet at build", () => {
    const store = makeStore();
    startSpec(store, { threadId: "t1" });
    const note = specNoteFor(store.thread, "/work/tree");
    assert.match(note, /Spec mode/);
    assert.ok(
      note.includes(
        path.join("/work/tree", ".solenta/specs/add-spec-mode/requirements.md"),
      ),
      note,
    );
    store.thread.spec.stage = "build";
    assert.equal(specNoteFor(store.thread, "/work/tree"), "");
    assert.equal(specNoteFor({}, "/work/tree"), "");
  });

  it("stopSpec drops thread.spec so specNoteFor goes quiet", () => {
    const store = makeStore();
    startSpec(store, { threadId: "t1" });
    assert.match(specNoteFor(store.thread, "/work/tree"), /Spec mode/);
    const after = stopSpec(store, { threadId: "t1" });
    assert.equal(after.spec, undefined);
    assert.equal(store.thread.spec, undefined);
    assert.equal("spec" in store.thread, false);
    assert.equal(specNoteFor(store.thread, "/work/tree"), "");
  });

  it("stopSpec is idempotent on a thread that is not in spec mode", () => {
    const store = makeStore();
    const after = stopSpec(store, { threadId: "t1" });
    assert.equal(after.spec, undefined);
    assert.equal(store.thread.spec, undefined);
  });

  it("stopSpec works mid-gate and at build, then startSpec can start over", () => {
    const store = makeStore();
    startSpec(store, { threadId: "t1" });
    submitSpec(store, { threadId: "t1" });
    assert.equal(store.thread.spec.awaitingApproval, true);
    stopSpec(store, { threadId: "t1" });
    assert.equal(store.thread.spec, undefined);

    startSpec(store, { threadId: "t1" });
    store.thread.spec.stage = "build";
    stopSpec(store, { threadId: "t1" });
    assert.equal(store.thread.spec, undefined);

    startSpec(store, { threadId: "t1" });
    assert.equal(store.thread.spec.stage, "requirements");
    assert.equal(store.thread.spec.awaitingApproval, false);
  });

  it("stopSpec rejects an unknown thread", () => {
    const store = makeStore();
    assert.throws(
      () => stopSpec(store, { threadId: "nope" }),
      /Unknown thread/,
    );
  });

  it("reads the artifact off disk, null until it is written", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-mode-"));
    const store = makeStore({}, dir);
    startSpec(store, { threadId: "t1" });
    const before = readSpecArtifact(store, {
      threadId: "t1",
      stage: "requirements",
    });
    assert.equal(before.text, null);
    fs.mkdirSync(path.dirname(before.path), { recursive: true });
    fs.writeFileSync(before.path, "1. WHEN x THE SYSTEM SHALL y\n");
    const after = readSpecArtifact(store, {
      threadId: "t1",
      stage: "requirements",
    });
    assert.match(after.text, /SHALL y/);
    assert.throws(
      () => readSpecArtifact(store, { threadId: "t1", stage: "nope" }),
      /Invalid spec stage/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/** Store that also hosts a crew-task list and extra threads (issue #537). */
function makeCrewStore(projectPath, threadOverrides = {}) {
  const threads = [
    {
      id: "t1",
      projectId: "p1",
      title: "Add spec mode",
      status: "idle",
      worktreePath: null,
      ...threadOverrides,
    },
  ];
  /** @type {Record<string, Array<object>>} */
  const crew = {};
  return {
    getThread: (id) => threads.find((t) => t.id === id) || null,
    getThreads: () => threads,
    getProject: (id) => (id === "p1" ? { id: "p1", path: projectPath } : null),
    updateThread: (id, patch) => {
      const t = threads.find((x) => x.id === id);
      if (!t) return null;
      Object.assign(t, patch);
      return t;
    },
    getCrewTasks: (root) =>
      Array.isArray(crew[root]) ? crew[root].map((t) => ({ ...t })) : [],
    setCrewTasks: (root, next) => {
      if (!Array.isArray(next) || next.length === 0) delete crew[root];
      else crew[root] = next.map((t) => ({ ...t }));
    },
    save: () => {},
    addThread: (t) => {
      threads.push(t);
      return t;
    },
    threads,
  };
}

function fakeFork(store, input) {
  const source = store.getThread(input.threadId);
  const worker = {
    id: `w${store.getThreads().length}`,
    projectId: source.projectId,
    title: `Fork: ${source.title}`,
    orchWorker: true,
    handoffFrom: source.id,
    status: "idle",
  };
  store.addThread(worker);
  return worker;
}

function writeTasks(dir, slug, body) {
  const file = path.join(dir, ".solenta", "specs", slug, "tasks.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

describe("spec dispatch + converge (issue #537)", () => {
  it("rejects dispatch before the spec is at build", () => {
    const store = makeCrewStore("/tmp/proj");
    startSpec(store, { threadId: "t1" });
    assert.throws(
      () => dispatchSpec(store, { threadId: "t1" }),
      /after tasks.md is approved/,
    );
  });

  it("rejects a missing or empty tasks.md", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-dispatch-"));
    const store = makeCrewStore(dir);
    startSpec(store, { threadId: "t1" });
    store.thread = store.getThread("t1");
    store.thread.spec.stage = "build";
    assert.throws(
      () => dispatchSpec(store, { threadId: "t1" }),
      /not written yet/,
    );
    writeTasks(dir, "add-spec-mode", "# Tasks\n\nNo boxes.\n");
    assert.throws(
      () => dispatchSpec(store, { threadId: "t1" }),
      /no checkbox tasks/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a cyclic tasks.md", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-dispatch-"));
    const store = makeCrewStore(dir);
    startSpec(store, { threadId: "t1" });
    store.getThread("t1").spec.stage = "build";
    writeTasks(
      dir,
      "add-spec-mode",
      "- [ ] 1. A — needs: 2\n- [ ] 2. B — needs: 1\n",
    );
    assert.throws(
      () => dispatchSpec(store, { threadId: "t1" }),
      /not a valid DAG/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads the DAG into crew tasks and forks one worker per current wave", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-dispatch-"));
    const store = makeCrewStore(dir);
    startSpec(store, { threadId: "t1" });
    store.getThread("t1").spec.stage = "build";
    writeTasks(
      dir,
      "add-spec-mode",
      "- [x] 1. Already done (`a.ts`) — req 1\n" +
        "- [ ] 2. Independent A (`b.ts`) — req 2\n" +
        "- [ ] 3. Independent B (`c.ts`) — req 3\n" +
        "- [ ] 4. Depends (`d.ts`) — req 4 — needs: 2, 3\n",
    );

    const result = dispatchSpec(store, { threadId: "t1" });
    const crew = listCrewTasks(store, { threadId: "t1" }).tasks;
    assert.equal(crew.length, 4);
    assert.equal(crew[0].status, "done", "ticked box is already done");
    assert.deepEqual(
      result.wave.map((t) => t.title),
      ["2. Independent A (`b.ts`) — req 2", "3. Independent B (`c.ts`) — req 3"],
    );
    assert.equal(
      crew.find((t) => t.title.startsWith("4.")).blocked,
      true,
    );

    const workers = forkSpecWave(
      store,
      { threadId: "t1", wave: result.wave },
      fakeFork,
    );
    assert.equal(workers.length, 2);
    assert.equal(workers[0].thread.handoffFrom, "t1");
    assert.match(workers[0].prompt, /\[Spec dispatch\]/);
    assert.match(workers[0].prompt, /Independent A/);
    assert.equal(
      listCrewTasks(store, { threadId: "t1" }).tasks.filter(
        (t) => t.status === "claimed",
      ).length,
      2,
    );

    const again = dispatchSpec(store, { threadId: "t1" });
    assert.equal(again.wave.length, 0, "claimed tasks are not re-dispatched");
    assert.match(again.reason, /blocked on dependencies/);

    for (const w of workers) {
      completeCrewTask(store, {
        threadId: w.thread.id,
        taskId: w.task.id,
        note: "landed",
      });
    }
    const nextWave = dispatchSpec(store, { threadId: "t1" });
    assert.equal(nextWave.wave.length, 1, "completing wave 1 unblocks wave 2");
    assert.match(nextWave.wave[0].title, /Depends/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("converge returns a prompt that names the three artifacts", () => {
    const store = makeCrewStore("/work/tree");
    startSpec(store, { threadId: "t1" });
    store.getThread("t1").spec.stage = "build";
    const { prompt } = convergeSpec(store, { threadId: "t1" });
    assert.match(prompt, /\[Spec converge\]/);
    assert.ok(prompt.includes(path.join("/work/tree", ".solenta/specs/add-spec-mode/requirements.md")));
    assert.ok(prompt.includes(path.join("/work/tree", ".solenta/specs/add-spec-mode/design.md")));
    assert.ok(prompt.includes(path.join("/work/tree", ".solenta/specs/add-spec-mode/tasks.md")));
    assert.match(prompt, /Only append/);
  });

  it("converge rejects a thread that is not at build", () => {
    const store = makeCrewStore("/tmp/proj");
    startSpec(store, { threadId: "t1" });
    assert.throws(
      () => convergeSpec(store, { threadId: "t1" }),
      /after tasks.md is approved/,
    );
  });
});
