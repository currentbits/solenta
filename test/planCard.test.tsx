/**
 * Plan overview card (issue #75): the thread's steps and approved plan stay in
 * the main panel after the approval prompt is gone.
 *
 * Run: node --import=./test/support/render.mjs --test test/planCard.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  PendingPermissionInfo,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
} from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

const providers: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

function thread(extra: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "plan card",
    branch: "coder/plan-card",
    prNumber: null,
    prUrl: null,
    status: "working",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: 1,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: "/tmp/wt",
    ...extra,
  };
}

function detail(
  extra: Partial<ThreadInfo> = {},
  pendingPermission: PendingPermissionInfo | null = null,
): ThreadDetail {
  return {
    thread: thread(extra),
    messages: [],
    workLog: [],
    workflow: null,
    usage: null,
    pendingPermission,
  };
}

function mountView(d: ThreadDetail) {
  return mount(
    <ThreadView
      detail={d}
      project={project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={async () => ({ id: "w", name: "s", phases: [] })}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onRespondPermission={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
    />,
  );
}

const steps: ThreadInfo["planSteps"] = [
  { step: "Read the runner", status: "done" },
  { step: "Persist the plan", status: "doing" },
  { step: "Render the card", status: "todo" },
];

describe("PlanCard", () => {
  it("shows the steps and how many are done", async () => {
    const view = await mountView(detail({ planSteps: steps }));
    assert.ok(view.query("[data-plan-card]"));
    assert.match(view.text(), /1\/3 done/);
    assert.match(view.text(), /Read the runner/);
    assert.match(view.text(), /Render the card/);
    // Statuses drive the step markers.
    const doing = view.query('[data-plan-step="doing"]');
    assert.equal(doing?.textContent, "Persist the plan");
  });

  it("keeps the approved plan behind a toggle once steps exist", async () => {
    const view = await mountView(
      detail({ planSteps: steps, plan: "## Steps\n\nShip the card" }),
    );
    assert.ok(!view.text().includes("Ship the card"));
    await view.click(view.byText("Show full plan"));
    assert.match(view.text(), /Ship the card/);
    await view.click(view.byText("Hide full plan"));
    assert.ok(!view.text().includes("Ship the card"));
  });

  it("expands the plan when there are no steps yet", async () => {
    const view = await mountView(detail({ plan: "## Steps\n\nShip the card" }));
    assert.match(view.text(), /Ship the card/);
  });

  it("stays hidden with no plan, and while a plan prompt is pending", async () => {
    const bare = await mountView(detail());
    assert.equal(bare.query("[data-plan-card]"), null);

    const pending = await mountView(
      detail(
        { planSteps: steps, plan: "## Steps\n\nShip the card" },
        {
          requestId: "req-1",
          toolName: "ExitPlanMode",
          summary: "ExitPlanMode",
          input: "{}",
          questions: null,
          plan: "## Steps\n\nShip the card",
        },
      ),
    );
    assert.equal(pending.query("[data-plan-card]"), null);
    assert.ok(pending.byText("Approve plan"));
  });
});
