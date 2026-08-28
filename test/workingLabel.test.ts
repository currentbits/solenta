/**
 * Live status-strip copy while a turn is running (issue #751 / #752).
 *
 * Run: node --experimental-strip-types --test test/workingLabel.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveWorkingLabel } from "../src/workingLabel.ts";

describe("liveWorkingLabel", () => {
  it("falls back to Agent working… when nothing more specific is known", () => {
    assert.equal(liveWorkingLabel({}), "Agent working…");
  });

  it("shows Thinking… while reasoning is streaming and no tool is running", () => {
    assert.equal(liveWorkingLabel({ thinking: true }), "Thinking…");
  });

  it("prefers the running tool summary over Thinking… or the generic fallback", () => {
    assert.equal(
      liveWorkingLabel({
        thinking: true,
        toolSummary: "Read: src/components/ThreadView.tsx",
      }),
      "Read: src/components/ThreadView.tsx",
    );
  });

  it("keeps the hung warning above live activity", () => {
    assert.equal(
      liveWorkingLabel({
        stalledElapsed: "12m",
        toolSummary: "Bash: npm test",
        thinking: true,
      }),
      "No output for 12m — the agent may be hung",
    );
  });

  it("keeps the workflow background count when a multi-agent run is live", () => {
    assert.equal(
      liveWorkingLabel({ workflowRunning: 1 }),
      "1 agent working in the background",
    );
    assert.equal(
      liveWorkingLabel({ workflowRunning: 3 }),
      "3 agents working in the background",
    );
  });
});
