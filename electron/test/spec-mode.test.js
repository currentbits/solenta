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
