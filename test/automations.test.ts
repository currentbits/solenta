/**
 * Automation run status labels (issue #938).
 * Run: npm run test:renderer -- test/automations.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  automationRunDisplayStatus,
  automationRunStatusLabel,
  createFormError,
  triggerLabel,
} from "../src/automations";
import type { ThreadStatus } from "../src/shared/ipc";

describe("triggerLabel / createFormError (#1588)", () => {
  it("labels Linear and Sentry triggers", () => {
    assert.equal(
      triggerLabel({ type: "linear", event: "linear_issue_created" }),
      "on Linear issue created",
    );
    assert.equal(
      triggerLabel({ type: "linear", event: "linear_issue_created", team: "ENG" }),
      "on Linear issue created in ENG",
    );
    assert.equal(
      triggerLabel({ type: "linear", event: "linear_status_changed" }),
      "on Linear status changed",
    );
    assert.equal(
      triggerLabel({
        type: "linear",
        event: "linear_status_changed",
        status: "Done",
        team: "ENG",
      }),
      "on Linear status changed to Done in ENG",
    );
    assert.equal(
      triggerLabel({ type: "sentry", event: "sentry_issue", org: "acme", project: "pump" }),
      "on Sentry issue acme/pump",
    );
    assert.equal(
      triggerLabel({
        type: "sentry",
        event: "sentry_issue",
        org: "acme",
        project: "pump",
        environment: "prod",
      }),
      "on Sentry issue acme/pump (prod)",
    );
  });

  it("requires Sentry org and project", () => {
    const base = {
      name: "n",
      projectId: "p",
      prompt: "go",
      provider: "claude",
      preset: "hourly" as const,
      hour: "",
    };
    assert.equal(createFormError({ ...base, event: "sentry_issue", org: "", project: "pump" }), "Sentry org is required");
    assert.equal(createFormError({ ...base, event: "sentry_issue", org: "acme", project: "" }), "Sentry project is required");
    assert.equal(createFormError({ ...base, event: "sentry_issue", org: "acme", project: "pump" }), null);
  });
});

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
