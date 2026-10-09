/**
 * Live status-strip copy while a turn is running (issue #751 / #752).
 *
 * Run: node --experimental-strip-types --test test/workingLabel.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveWorkingLabel, thoughtLine } from "../src/workingLabel.ts";

describe("liveWorkingLabel", () => {
  it("falls back to Agent working… when nothing more specific is known", () => {
    assert.equal(liveWorkingLabel({}), "Agent working…");
  });

  it("shows Thinking… while reasoning is streaming and no tool is running", () => {
    assert.equal(liveWorkingLabel({ thinking: true }), "Thinking…");
  });

  it("shows the latest thought line while thinking (#1531)", () => {
    assert.equal(
      liveWorkingLabel({
        thinking: true,
        thought: "**Planning the fix**\n\nFirst read useCoder.ts.\n\n",
      }),
      "First read useCoder.ts.",
    );
    assert.equal(
      liveWorkingLabel({ thinking: true, thought: "  \n\n" }),
      "Thinking…",
    );
    assert.equal(
      liveWorkingLabel({ thinking: false, thought: "stale thought" }),
      "Agent working…",
    );
  });

  it("prefers the running tool summary over Thinking… or the generic fallback", () => {
    assert.equal(
      liveWorkingLabel({
        thinking: true,
        thought: "Reading the view",
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
      "No output for 12m. The agent may be hung",
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

  it("drops the background count once every workflow agent has finished", () => {
    assert.equal(liveWorkingLabel({ workflowRunning: 0 }), "Agent working…");
    assert.equal(
      liveWorkingLabel({ workflowRunning: 0, thinking: true }),
      "Thinking…",
    );
  });
});

describe("thoughtLine", () => {
  it("strips emphasis and heading markers but keeps snake_case", () => {
    assert.equal(thoughtLine("**Planning the fix**"), "Planning the fix");
    assert.equal(thoughtLine("## Check *every* `caller`"), "Check every caller");
    assert.equal(thoughtLine("- read run_tests.py"), "read run_tests.py");
    assert.equal(thoughtLine("a * b * c"), "a * b * c");
  });

  it("clamps long lines to about 120 characters with an ellipsis", () => {
    const line = thoughtLine("x".repeat(300));
    assert.equal(line.length, 120);
    assert.ok(line.endsWith("…"));
    assert.equal(thoughtLine("y".repeat(120)), "y".repeat(120));
  });

  it("returns empty for missing or blank text", () => {
    assert.equal(thoughtLine(null), "");
    assert.equal(thoughtLine("\r\n \n"), "");
  });
});
