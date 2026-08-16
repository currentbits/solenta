"use strict";

/**
 * parsePlanJson: .solenta/plan.json contents → ThreadPlan steps.
 * listPlans: a project's non-archived threads → their published plans.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PLAN_FILE_REL, parsePlanJson, listPlans } = require("../plans.js");

describe("parsePlanJson", () => {
  it("maps steps, statuses, and the optional title", () => {
    const plan = parsePlanJson(
      JSON.stringify({
        title: "Rollout",
        steps: [
          { text: "one", status: "done" },
          { text: "two", status: "doing" },
          { text: "three", status: "todo" },
        ],
      }),
    );
    assert.deepEqual(plan, {
      title: "Rollout",
      steps: [
        { text: "one", status: "done" },
        { text: "two", status: "doing" },
        { text: "three", status: "todo" },
      ],
    });
  });

  it("null title when the file has none", () => {
    const plan = parsePlanJson(
      JSON.stringify({ steps: [{ text: "one", status: "todo" }] }),
    );
    assert.equal(plan.title, null);
  });

  it("returns null for bad JSON, non-object roots, and empty steps", () => {
    assert.equal(parsePlanJson("not json"), null);
    assert.equal(parsePlanJson("[1,2]"), null);
    assert.equal(parsePlanJson('"steps"'), null);
    assert.equal(parsePlanJson("{}"), null);
    assert.equal(parsePlanJson('{"steps": []}'), null);
  });

  it("skips malformed steps and defaults unknown statuses to todo", () => {
    const plan = parsePlanJson(
      JSON.stringify({
        steps: [
          null,
          "nope",
          { text: "   " },
          { status: "done" },
          { text: "kept", status: "weird" },
          { text: "plain" },
        ],
      }),
    );
    assert.deepEqual(plan.steps, [
      { text: "kept", status: "todo" },
      { text: "plain", status: "todo" },
    ]);
  });

  it("caps the step count and step text length", () => {
    const steps = Array.from({ length: 60 }, (_, i) => ({
      text: `step ${i}`,
      status: "todo",
    }));
    const plan = parsePlanJson(JSON.stringify({ steps }));
    assert.equal(plan.steps.length, 50);
    const long = parsePlanJson(
      JSON.stringify({ steps: [{ text: "x".repeat(500), status: "todo" }] }),
    );
    assert.equal(long.steps[0].text.length, 200);
  });
});

describe("listPlans", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thread-plans-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function writePlan(root, plan) {
    fs.mkdirSync(path.join(root, ".solenta"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".solenta", "plan.json"),
      JSON.stringify(plan),
    );
  }

  function fakeStore({ project, threads }) {
    return {
      getProject: (id) => (project && project.id === id ? project : null),
      getThreads: () => threads,
    };
  }

  it("reads plans from thread worktrees, newest-updated first", () => {
    const project = { id: "p1", path: path.join(tmp, "repo-a") };
    const wtOld = path.join(tmp, "wt-old");
    const wtNew = path.join(tmp, "wt-new");
    writePlan(wtOld, { steps: [{ text: "old", status: "todo" }] });
    writePlan(wtNew, { steps: [{ text: "new", status: "doing" }] });
    fs.utimesSync(
      path.join(wtOld, PLAN_FILE_REL),
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z"),
    );
    const store = fakeStore({
      project,
      threads: [
        { id: "t1", projectId: "p1", title: "Old", worktreePath: wtOld },
        { id: "t2", projectId: "p1", title: "New", worktreePath: wtNew },
      ],
    });
    const res = listPlans(store, "p1");
    assert.equal(res.ok, true);
    assert.deepEqual(
      res.plans.map((p) => p.threadId),
      ["t2", "t1"],
    );
    assert.equal(res.plans[1].threadTitle, "Old");
    assert.equal(res.plans[1].steps[0].text, "old");
    assert.ok(res.plans[0].updatedMs > res.plans[1].updatedMs);
  });

  it("falls back to the project checkout for threads without a worktree", () => {
    const project = { id: "p2", path: path.join(tmp, "repo-b") };
    writePlan(project.path, { steps: [{ text: "root plan", status: "todo" }] });
    const store = fakeStore({
      project,
      threads: [{ id: "t1", projectId: "p2", title: "Root", worktreePath: null }],
    });
    const res = listPlans(store, "p2");
    assert.equal(res.ok, true);
    assert.equal(res.plans.length, 1);
    assert.equal(res.plans[0].steps[0].text, "root plan");
  });

  it("dedupes threads that share one root", () => {
    const project = { id: "p3", path: path.join(tmp, "repo-c") };
    writePlan(project.path, { steps: [{ text: "shared", status: "todo" }] });
    const store = fakeStore({
      project,
      threads: [
        { id: "t1", projectId: "p3", title: "One", worktreePath: null },
        { id: "t2", projectId: "p3", title: "Two", worktreePath: null },
      ],
    });
    const res = listPlans(store, "p3");
    assert.equal(res.plans.length, 1);
    assert.equal(res.plans[0].threadId, "t1");
  });

  it("skips archived threads, other projects, and missing or bad files", () => {
    const project = { id: "p4", path: path.join(tmp, "repo-d") };
    const wtArchived = path.join(tmp, "wt-archived");
    const wtBad = path.join(tmp, "wt-bad");
    writePlan(wtArchived, { steps: [{ text: "gone", status: "todo" }] });
    fs.mkdirSync(path.join(wtBad, ".solenta"), { recursive: true });
    fs.writeFileSync(path.join(wtBad, ".solenta", "plan.json"), "junk{");
    const store = fakeStore({
      project,
      threads: [
        {
          id: "t1",
          projectId: "p4",
          title: "Archived",
          worktreePath: wtArchived,
          archived: true,
        },
        { id: "t2", projectId: "p4", title: "Bad", worktreePath: wtBad },
        { id: "t3", projectId: "p4", title: "None", worktreePath: null },
        {
          id: "t4",
          projectId: "other",
          title: "Other",
          worktreePath: wtArchived,
        },
      ],
    });
    const res = listPlans(store, "p4");
    assert.equal(res.ok, true);
    assert.deepEqual(res.plans, []);
  });

  it("unknown project comes back in-band", () => {
    const store = fakeStore({ project: null, threads: [] });
    assert.deepEqual(listPlans(store, "nope"), {
      ok: false,
      reason: "Unknown project",
    });
    assert.deepEqual(listPlans(store, ""), {
      ok: false,
      reason: "Unknown project",
    });
  });
});
