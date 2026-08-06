import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorkflow,
  isComplete,
  isFailed,
  isStuck,
  markAgentFailed,
  tick,
  tokenUsage,
  workflowProgress,
  TOKENS_PER_TICK,
  TICKS_TO_SETTLE,
} from "../src/engine.js";
import type { Workflow } from "../src/types.js";

function requirePhase(workflow: Workflow, phaseIndex: number) {
  const phase = workflow.phases[phaseIndex];
  if (!phase) {
    throw new Error(`missing phase ${phaseIndex}`);
  }
  return phase;
}

function allSettled(workflow: Workflow, phaseIndex: number): boolean {
  return requirePhase(workflow, phaseIndex).agents.every(
    (a) => a.status === "settled",
  );
}

function anyRunning(workflow: Workflow, phaseIndex: number): boolean {
  return requirePhase(workflow, phaseIndex).agents.some(
    (a) => a.status === "running",
  );
}

function anySettled(workflow: Workflow, phaseIndex: number): boolean {
  return requirePhase(workflow, phaseIndex).agents.some(
    (a) => a.status === "settled",
  );
}

function countByStatus(
  workflow: Workflow,
  status: "pending" | "running" | "settled" | "failed",
): number {
  return workflow.phases
    .flatMap((p) => p.agents)
    .filter((a) => a.status === status).length;
}

describe("createWorkflow", () => {
  it("builds phases with N agents each and deterministic ids", () => {
    const wf = createWorkflow({
      id: "wf-1",
      name: "INTEGER-SAFARI",
      phases: [
        { name: "seed", agentCount: 2, model: "sonnet-5" },
        { name: "analyze", agentCount: 3, model: "sonnet-5" },
      ],
    });

    assert.equal(wf.id, "wf-1");
    assert.equal(wf.name, "INTEGER-SAFARI");
    assert.equal(wf.phases.length, 2);
    assert.equal(wf.phases[0]!.name, "seed");
    assert.equal(wf.phases[0]!.agents.length, 2);
    assert.equal(wf.phases[1]!.agents.length, 3);
    assert.equal(wf.phases[0]!.agents[0]!.id, "seed:0");
    assert.equal(wf.phases[1]!.agents[2]!.id, "analyze:2");
    assert.equal(wf.phases[0]!.agents[0]!.status, "pending");
    assert.equal(wf.phases[0]!.agents[0]!.tokensUsed, 0);
    assert.equal(wf.phases[0]!.agents[0]!.model, "sonnet-5");
  });

  it("rejects non-positive or fractional agentCount", () => {
    assert.throws(
      () =>
        createWorkflow({
          id: "bad",
          name: "BAD",
          phases: [{ name: "seed", agentCount: 0 }],
        }),
      /agentCount/,
    );
    assert.throws(
      () =>
        createWorkflow({
          id: "bad",
          name: "BAD",
          phases: [{ name: "seed", agentCount: -1 }],
        }),
      /agentCount/,
    );
    assert.throws(
      () =>
        createWorkflow({
          id: "bad",
          name: "BAD",
          phases: [{ name: "seed", agentCount: 1.5 }],
        }),
      /agentCount/,
    );
  });
});

describe("sequential (non-pipelined) phase order", () => {
  it("runs phases in order: next phase waits for previous to fully settle", () => {
    let wf = createWorkflow({
      id: "wf-seq",
      name: "SEQ",
      phases: [
        { name: "seed", agentCount: 2 },
        { name: "analyze", agentCount: 2 },
        { name: "verify", agentCount: 1 },
      ],
    });

    // First tick: one seed agent starts (staggered starts within a phase)
    wf = tick(wf);
    assert.equal(countByStatus(wf, "running"), 1);
    assert.ok(anyRunning(wf, 0));
    assert.equal(countByStatus(wf, "pending"), 4); // seed(1 left)+analyze(2)+verify(1)
    assert.ok(!anyRunning(wf, 1));

    // Keep ticking until seed fully settles; analyze must stay pending until then
    let guard = 0;
    while (!allSettled(wf, 0) && guard < 40) {
      assert.ok(
        !anyRunning(wf, 1),
        "analyze must not start before seed fully settles",
      );
      assert.ok(
        !anySettled(wf, 1),
        "analyze must not settle before seed fully settles",
      );
      wf = tick(wf);
      guard += 1;
    }
    assert.ok(allSettled(wf, 0));
    assert.equal(
      wf.phases[0]!.agents.every((a) => a.status === "settled"),
      true,
    );

    // After seed settled, analyze may start same tick or shortly after
    guard = 0;
    while (!anyRunning(wf, 1) && !allSettled(wf, 1) && guard < 5) {
      wf = tick(wf);
      guard += 1;
    }
    // verify must not start before analyze fully settles
    while (!allSettled(wf, 1) && guard < 40) {
      assert.ok(
        !anyRunning(wf, 2),
        "verify must not start before analyze fully settles",
      );
      wf = tick(wf);
      guard += 1;
    }
    assert.ok(allSettled(wf, 1));
  });
});

describe("pipelined phase", () => {
  it("starts before the previous phase fully settles", () => {
    let wf = createWorkflow({
      id: "wf-pipe",
      name: "PIPE",
      phases: [
        { name: "seed", agentCount: 3 },
        { name: "analyze", agentCount: 3, pipelined: true },
      ],
    });

    // Drive until first seed agent settles; pipelined analyze agent 0 may start
    let sawPipelineOverlap = false;
    let guard = 0;
    while (!allSettled(wf, 0) && guard < 40) {
      wf = tick(wf);
      guard += 1;
      const seedSettled = wf.phases[0]!.agents.filter(
        (a) => a.status === "settled",
      ).length;
      const analyzeStarted = wf.phases[1]!.agents.some(
        (a) => a.status === "running" || a.status === "settled",
      );
      if (seedSettled > 0 && seedSettled < 3 && analyzeStarted) {
        sawPipelineOverlap = true;
        break;
      }
    }

    assert.ok(
      sawPipelineOverlap,
      "pipelined analyze should start while some seed agents are still not settled",
    );
  });

  it("extra agents beyond upstream count wait for full previous phase", () => {
    let wf = createWorkflow({
      id: "wf-pipe-extra",
      name: "PIPE-EXTRA",
      phases: [
        { name: "seed", agentCount: 1 },
        { name: "analyze", agentCount: 2, pipelined: true },
      ],
    });

    // Until the single seed agent settles, neither analyze agent may start
    // (analyze:0 waits for seed:0 settle; analyze:1 has no lane and waits for full terminal).
    let guard = 0;
    while (wf.phases[0]!.agents[0]!.status !== "settled" && guard < 20) {
      assert.ok(
        wf.phases[1]!.agents.every((a) => a.status === "pending"),
        "analyze must not start before seed:0 settles",
      );
      wf = tick(wf);
      guard += 1;
    }
    assert.equal(wf.phases[0]!.agents[0]!.status, "settled");

    // After seed terminal: analyze:0 unlocks via matching lane; analyze:1
    // unlocks via the "no upstream lane → wait for full previous phase" path.
    // Both should eventually settle.
    guard = 0;
    while (
      !wf.phases[1]!.agents.every((a) => a.status === "settled") &&
      guard < 40
    ) {
      wf = tick(wf);
      guard += 1;
    }
    assert.ok(
      wf.phases[1]!.agents.every((a) => a.status === "settled"),
      "both analyze agents (including extra lane) should complete",
    );
    assert.equal(isComplete(wf), true);
  });
});

describe("progress and tokens", () => {
  it("reports settled/total counts and accrues fixed tokens per running tick", () => {
    let wf = createWorkflow({
      id: "wf-prog",
      name: "PROG",
      phases: [
        { name: "seed", agentCount: 1 },
        { name: "analyze", agentCount: 1 },
      ],
    });

    let p = workflowProgress(wf);
    assert.deepEqual(p, { settled: 0, total: 2, tokensTotal: 0 });
    assert.equal(isComplete(wf), false);

    // Run to completion
    let guard = 0;
    while (!isComplete(wf) && guard < 50) {
      wf = tick(wf);
      guard += 1;
    }

    assert.equal(isComplete(wf), true);
    p = workflowProgress(wf);
    assert.equal(p.settled, 2);
    assert.equal(p.total, 2);

    const expectedPerAgent = TOKENS_PER_TICK * TICKS_TO_SETTLE;
    assert.equal(p.tokensTotal, expectedPerAgent * 2);
    for (const phase of wf.phases) {
      for (const agent of phase.agents) {
        assert.equal(agent.status, "settled");
        assert.equal(agent.tokensUsed, expectedPerAgent);
      }
    }

    const usage = tokenUsage(wf);
    assert.equal(usage.total, expectedPerAgent * 2);
    assert.equal(usage.byPhase.seed, expectedPerAgent);
    assert.equal(usage.byPhase.analyze, expectedPerAgent);
  });
});

describe("completion", () => {
  it("reaches completion for a multi-phase workflow", () => {
    let wf = createWorkflow({
      id: "wf-done",
      name: "INTEGER-SAFARI",
      phases: [
        { name: "seed", agentCount: 2 },
        { name: "analyze", agentCount: 2, pipelined: true },
        { name: "verify", agentCount: 1 },
        { name: "judge", agentCount: 1 },
        { name: "synthesize", agentCount: 1 },
      ],
    });

    let guard = 0;
    while (!isComplete(wf) && guard < 100) {
      wf = tick(wf);
      guard += 1;
    }

    assert.equal(isComplete(wf), true);
    const progress = workflowProgress(wf);
    assert.equal(progress.settled, progress.total);
    assert.equal(progress.total, 7);
    assert.ok(progress.tokensTotal > 0);
    assert.ok(guard < 100, "should complete without hanging");
  });
});

describe("failed agents", () => {
  it("treats failed as terminal so the workflow is not stuck waiting for settled", () => {
    let wf = createWorkflow({
      id: "wf-fail",
      name: "FAIL",
      phases: [
        { name: "seed", agentCount: 1 },
        { name: "analyze", agentCount: 1 },
      ],
    });

    // Start seed agent
    wf = tick(wf);
    assert.equal(wf.phases[0]!.agents[0]!.status, "running");

    // Agent errors out
    wf = markAgentFailed(wf, "seed:0");
    assert.equal(wf.phases[0]!.agents[0]!.status, "failed");
    assert.equal(isFailed(wf), true);
    assert.equal(isComplete(wf), false);

    // Seed is terminal (failed). Non-pipelined analyze may start; no deadlock.
    wf = tick(wf);
    assert.equal(
      wf.phases[1]!.agents[0]!.status,
      "running",
      "analyze should start once previous phase is terminal (failed counts)",
    );
    assert.equal(isStuck(wf), false);

    // Finish analyze successfully
    let guard = 0;
    while (!isStuck(wf) && !isComplete(wf) && guard < 20) {
      wf = tick(wf);
      guard += 1;
    }

    // Not complete (seed failed), but analyze settled; stuck because seed failed
    // and nothing left runnable.
    assert.equal(isComplete(wf), false);
    assert.equal(isFailed(wf), true);
    assert.equal(wf.phases[1]!.agents[0]!.status, "settled");
    assert.equal(isStuck(wf), true);

    // Further ticks do not change stuck state
    const before = workflowProgress(wf);
    wf = tick(wf);
    const after = workflowProgress(wf);
    assert.deepEqual(after, before);
  });

  it("isStuck when a failed upstream blocks a pipelined lane forever", () => {
    let wf = createWorkflow({
      id: "wf-pipe-fail",
      name: "PIPE-FAIL",
      phases: [
        { name: "seed", agentCount: 1 },
        { name: "analyze", agentCount: 1, pipelined: true },
      ],
    });

    wf = tick(wf);
    wf = markAgentFailed(wf, "seed:0");
    assert.equal(isFailed(wf), true);
    assert.equal(isStuck(wf), true);

    // Pipelined analyze must not start on failed upstream
    wf = tick(wf);
    assert.equal(wf.phases[1]!.agents[0]!.status, "pending");
    assert.equal(isStuck(wf), true);
    assert.equal(isComplete(wf), false);
  });
});

describe("immutable tick", () => {
  it("returns a new top-level object and does not mutate the input", () => {
    const original = createWorkflow({
      id: "wf-immut",
      name: "IMMUT",
      phases: [{ name: "seed", agentCount: 1 }],
    });
    const originalStatus = original.phases[0]!.agents[0]!.status;

    const next = tick(original);

    assert.notEqual(next, original);
    assert.equal(original.phases[0]!.agents[0]!.status, originalStatus);
    assert.equal(next.phases[0]!.agents[0]!.status, "running");
  });
});
