/**
 * Automation run status labels (issue #938).
 * Run: npm run test:renderer -- test/automations.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  automationRunDisplayStatus,
  automationRunStatusLabel,
} from "../src/automations";
import type { ThreadStatus } from "../src/shared/ipc";

describe("automationRunDisplayStatus", () => {
  it("maps thread statuses for the run list", () => {
    const cases: Array<[ThreadStatus, string, string]> = [
      ["working", "working", "Working"],
      ["failed", "failed", "Failed"],
      ["quota-wait", "paused", "Paused"],
      ["done", "completed", "Completed"],
      ["idle", "completed", "Completed"],
    ];
    for (const [status, display, label] of cases) {
      assert.equal(automationRunDisplayStatus(status), display, status);
      assert.equal(automationRunStatusLabel(status), label, status);
    }
  });
});
