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
  isAutomationCreateTool,
  parseAutomationCreateResult,
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

describe("isAutomationCreateTool", () => {
  it("matches bare and mcp-prefixed names (#1589)", () => {
    assert.equal(isAutomationCreateTool("automation_create"), true);
    assert.equal(
      isAutomationCreateTool("mcp__coder-threads__automation_create"),
      true,
    );
    assert.equal(isAutomationCreateTool("Read"), false);
    assert.equal(isAutomationCreateTool(undefined), false);
  });
});

describe("parseAutomationCreateResult", () => {
  it("reads id, name, and trigger from the tool output", () => {
    const parsed = parseAutomationCreateResult(
      JSON.stringify({
        id: "a1",
        name: "Triage CI",
        provider: "claude",
        trigger: {
          type: "github",
          event: "ci_completed",
          branch: "main",
          conclusion: "failure",
        },
      }),
    );
    assert.equal(parsed?.id, "a1");
    assert.equal(parsed?.name, "Triage CI");
    assert.equal(parsed?.trigger?.event, "ci_completed");
    assert.equal(parsed?.trigger?.branch, "main");
  });

  it("returns null when the output is not a created automation", () => {
    assert.equal(parseAutomationCreateResult(""), null);
    assert.equal(parseAutomationCreateResult("not json"), null);
    assert.equal(parseAutomationCreateResult("{}"), null);
  });
});
