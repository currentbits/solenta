/**
 * Wait state derived from handoffFrom + subagents (issue #42).
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildWaitStates,
  isDelegating,
  subagentNames,
  waitLabel,
  waitTooltip,
  type WaitRow,
} from "../src/waiting";

const NOW = 1_000_000;

function row(over: Partial<WaitRow> & Pick<WaitRow, "id">): WaitRow {
  return {
    title: over.id,
    status: "idle",
    handoffFrom: null,
    ...over,
  };
}

describe("buildWaitStates", () => {
  it("counts live workers under their orchestrator, earliest run first", () => {
    const states = buildWaitStates([
      row({ id: "orch", status: "done" }),
      row({
        id: "w1",
        handoffFrom: "orch",
        status: "working",
        runStartedAt: NOW - 180_000,
      }),
      row({
        id: "w2",
        handoffFrom: "orch",
        status: "working",
        runStartedAt: NOW - 60_000,
      }),
    ]);

    const wait = states.get("orch");
    assert.ok(wait, "orchestrator has wait state");
    assert.equal(wait.children.length, 2);
    assert.equal(wait.blocked, 0);
    assert.equal(wait.since, NOW - 180_000, "anchors on the oldest run");
    assert.equal(waitLabel(wait, NOW), "Waiting on 2 workers · 3m");
    assert.equal(states.has("w1"), false, "a leaf worker waits on nothing");
  });

  it("settled children never count: only working ones are live", () => {
    const states = buildWaitStates([
      row({ id: "orch" }),
      row({ id: "done", handoffFrom: "orch", status: "done" }),
      row({ id: "failed", handoffFrom: "orch", status: "failed" }),
      row({ id: "never-ran", handoffFrom: "orch", status: "idle" }),
    ]);
    assert.equal(states.get("orch"), undefined);
  });

  it("a worker stalled on a permission prompt reads as blocked", () => {
    const states = buildWaitStates([
      row({ id: "orch" }),
      row({
        id: "w1",
        title: "Fork: migrate",
        handoffFrom: "orch",
        status: "working",
        awaitingInput: true,
        runStartedAt: NOW - 3_600_000,
      }),
    ]);

    const wait = states.get("orch")!;
    assert.equal(wait.blocked, 1);
    assert.equal(waitLabel(wait, NOW), "Waiting on 1 worker · 1h · 1 blocked");
    assert.match(waitTooltip(wait), /Fork: migrate — blocked on you/);
  });

  it("a worker stopped mid-run counts under its own label (issue #183)", () => {
    const states = buildWaitStates([
      row({ id: "orch", status: "done" }),
      row({
        id: "w1",
        title: "Fork: migrate",
        handoffFrom: "orch",
        status: "idle",
        runStartedAt: null,
        stoppedAt: NOW - 120_000,
      }),
      // Same idle+null shape minus the stamp: a fork that never ran stays invisible.
      row({ id: "w2", handoffFrom: "orch", status: "idle", runStartedAt: null }),
    ]);

    const wait = states.get("orch")!;
    assert.equal(wait.children.length, 1);
    assert.equal(wait.stopped, 1);
    assert.equal(wait.blocked, 0);
    assert.equal(wait.since, NOW - 120_000, "anchors on the stop stamp");
    assert.equal(waitLabel(wait, NOW), "Waiting on 1 worker · 2m · 1 stopped");
    assert.match(waitTooltip(wait), /Fork: migrate — stopped mid-run/);
    assert.equal(
      isDelegating("done", wait),
      true,
      "the parent is still owed the stopped work",
    );
  });

  it("a stale stoppedAt on a working worker counts as working, not stopped", () => {
    const states = buildWaitStates([
      row({ id: "orch" }),
      row({
        id: "w1",
        handoffFrom: "orch",
        status: "working",
        runStartedAt: NOW - 30_000,
        stoppedAt: NOW - 300_000,
      }),
    ]);

    const wait = states.get("orch")!;
    assert.equal(wait.stopped, 0);
    assert.equal(wait.children[0]!.state, "working");
    assert.equal(wait.since, NOW - 30_000);
  });

  it("in-agent subagents count on the thread that spawned them", () => {
    const states = buildWaitStates([
      row({
        id: "t1",
        status: "working",
        runStartedAt: NOW - 5_000,
        subagents: [
          { id: "a", description: "Map the panel", agentType: null, status: "running" },
          { id: "b", description: "Old one", agentType: null, status: "done" },
        ],
      }),
    ]);

    const wait = states.get("t1")!;
    assert.equal(wait.children.length, 1, "only running subagents");
    assert.equal(wait.children[0]!.id, null, "no thread to navigate to");
    assert.equal(wait.since, null, "no spawn stamp: elapsed stays off");
    // #542: the noun distinguishes an in-agent subagent from a forked thread.
    assert.equal(waitLabel(wait, NOW), "Waiting on 1 subagent");
    assert.deepEqual(subagentNames(wait), ["Map the panel"]);
    assert.match(waitTooltip(wait), /Map the panel/);
  });

  it("a mixed fan-out counts workers and subagents separately", () => {
    const states = buildWaitStates([
      row({
        id: "t1",
        status: "working",
        subagents: [
          { id: "a", description: "Map the panel", agentType: null, status: "running" },
        ],
      }),
      row({
        id: "w1",
        status: "working",
        handoffFrom: "t1",
        runStartedAt: NOW - 3 * 60_000,
      }),
    ]);

    const wait = states.get("t1")!;
    assert.equal(
      waitLabel(wait, NOW),
      "Waiting on 1 worker · 1 subagent · 3m",
    );
    assert.deepEqual(subagentNames(wait), ["Map the panel"]);
  });

  it("isDelegating: a finished turn with live workers is not done", () => {
    const wait = buildWaitStates([
      row({ id: "orch", status: "done" }),
      row({ id: "w1", handoffFrom: "orch", status: "working" }),
    ]).get("orch")!;
    assert.equal(isDelegating("done", wait), true);
    assert.equal(isDelegating("idle", wait), true);
    assert.equal(isDelegating("working", wait), false, "already reads Working");
    assert.equal(isDelegating("failed", wait), false, "failure is the news");
    assert.equal(isDelegating("done", null), false, "no workers: plain done");
  });

  it("ignores a self-referential handoffFrom (corrupt row)", () => {
    const states = buildWaitStates([
      row({ id: "t1", handoffFrom: "t1", status: "working" }),
    ]);
    assert.equal(states.size, 0);
  });
});
