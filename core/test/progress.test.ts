import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorkflow,
  tick,
  markAgentFailed,
  isComplete,
} from "../src/engine.js";
import { phaseProgress } from "../src/progress.js";
import type { Workflow } from "../src/types.js";

function requirePhase(workflow: Workflow, phaseIndex: number) {
  const phase = workflow.phases[phaseIndex];
  if (!phase) throw new Error(`missing phase ${phaseIndex}`);
  return phase;
}

describe("phaseProgress", () => {
  it("reports pending for a fresh multi-phase workflow", () => {
    const wf = createWorkflow({
      id: "wf-p0",
      name: "PROG",
      phases: [
        { name: "seed", agentCount: 1 },
        { name: "analyze", agentCount: 2 },
        { name: "verify", agentCount: 1 },
      ],
    });

    const rows = phaseProgress(wf);
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.running, 0);
      assert.equal(row.settled, 0);
      assert.equal(row.failed, 0);
      assert.equal(row.state, "pending");
    }
    assert.equal(rows[0]!.name, "seed");
    assert.equal(rows[0]!.total, 1);
    assert.equal(rows[1]!.name, "analyze");
    assert.equal(rows[1]!.total, 2);
    assert.equal(rows[2]!.name, "verify");
    assert.equal(rows[2]!.total, 1);
  });

  it("marks a phase active when any agent is running", () => {
    let wf = createWorkflow({
      id: "wf-p1",
      name: "ACTIVE",
      phases: [{ name: "seed", agentCount: 2 }],
    });
    wf = tick(wf);
    const row = phaseProgress(wf)[0]!;
    assert.equal(row.running, 1);
    assert.equal(row.settled, 0);
    assert.equal(row.state, "active");
  });

  it("marks a phase active when partially settled (some settled, rest pending)", () => {
    let wf = createWorkflow({
      id: "wf-p2",
      name: "PARTIAL",
      phases: [{ name: "seed", agentCount: 2 }],
    });

    // Drive until first agent settles but second is not yet done
    let guard = 0;
    while (guard < 40) {
      wf = tick(wf);
      guard += 1;
      const settled = requirePhase(wf, 0).agents.filter(
        (a) => a.status === "settled",
      ).length;
      if (settled === 1) break;
    }
    const settled = requirePhase(wf, 0).agents.filter(
      (a) => a.status === "settled",
    ).length;
    assert.equal(settled, 1, "fixture: need exactly one settled agent");

    const row = phaseProgress(wf)[0]!;
    assert.equal(row.settled, 1);
    assert.equal(row.total, 2);
    assert.equal(row.state, "active");
  });

  it("marks a phase done when all agents are settled", () => {
    let wf = createWorkflow({
      id: "wf-p3",
      name: "DONE",
      phases: [
        { name: "seed", agentCount: 1 },
        { name: "analyze", agentCount: 1 },
      ],
    });

    let guard = 0;
    while (!isComplete(wf) && guard < 50) {
      wf = tick(wf);
      guard += 1;
    }
    assert.equal(isComplete(wf), true);

    const rows = phaseProgress(wf);
    for (const row of rows) {
      assert.equal(row.state, "done");
      assert.equal(row.settled, row.total);
      assert.equal(row.running, 0);
      assert.equal(row.failed, 0);
    }
  });

  it("marks a phase failed when any agent failed and none are running", () => {
    let wf = createWorkflow({
      id: "wf-p-fail",
      name: "FAIL",
      phases: [
        { name: "seed", agentCount: 2 },
        { name: "analyze", agentCount: 1 },
      ],
    });

    wf = tick(wf);
    const running = requirePhase(wf, 0).agents.find((a) => a.status === "running");
    assert.ok(running);
    wf = markAgentFailed(wf, running!.id);

    // Ensure nothing is running in seed after fail (other agent still pending)
    assert.equal(
      requirePhase(wf, 0).agents.every((a) => a.status !== "running"),
      true,
    );

    const seedRow = phaseProgress(wf)[0]!;
    assert.equal(seedRow.failed, 1);
    assert.equal(seedRow.running, 0);
    assert.equal(seedRow.state, "failed");

    // analyze still pending overall
    const analyzeRow = phaseProgress(wf)[1]!;
    assert.equal(analyzeRow.state, "pending");
  });

  it("prefers active over failed while an agent is still running", () => {
    let wf = createWorkflow({
      id: "wf-p-mix",
      name: "MIX",
      phases: [{ name: "seed", agentCount: 2 }],
    });

    // Start first agent, fail it, then start second so one is running
    wf = tick(wf);
    const firstId = requirePhase(wf, 0).agents[0]!.id;
    wf = markAgentFailed(wf, firstId);
    wf = tick(wf); // should start second agent
    assert.equal(requirePhase(wf, 0).agents[1]!.status, "running");

    const row = phaseProgress(wf)[0]!;
    assert.equal(row.failed, 1);
    assert.equal(row.running, 1);
    assert.equal(row.state, "active");
  });
});
