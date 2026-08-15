/**
 * Plan approval prompt (ExitPlanMode): the plan renders as markdown in the
 * permission panel — not raw JSON — and approve/keep-planning answer it.
 *
 * Run: node --import=./test/support/render.mjs --test test/planPrompt.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  PendingPermissionInfo,
  PermissionDecision,
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

function thread(): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "plan flow",
    branch: "coder/plan-flow",
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
    permissionMode: "plan",
    reasoningEffort: null,
    worktreePath: "/tmp/wt",
  };
}

const pending: PendingPermissionInfo = {
  requestId: "req-plan-1",
  toolName: "ExitPlanMode",
  summary: "ExitPlanMode: ## Steps",
  input: '{\n  "plan": "## Steps\\n\\n1. Add the card"\n}',
  questions: null,
  plan: "## Steps\n\n1. Add the card\n2. Wire the buttons",
};

function detail(): ThreadDetail {
  return {
    thread: thread(),
    messages: [],
    workLog: [],
    workflow: null,
    usage: null,
    pendingPermission: pending,
  };
}

interface Spy {
  calls: Array<{ requestId: string; decision: PermissionDecision }>;
}

function mountView(): { m: ReturnType<typeof mount>; spy: Spy } {
  const spy: Spy = { calls: [] };
  const m = mount(
    <ThreadView
      detail={detail()}
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
      onRespondPermission={(requestId, decision) => {
        spy.calls.push({ requestId, decision });
      }}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
    />,
  );
  return { m, spy };
}

describe("PlanPrompt", () => {
  it("renders the plan as markdown instead of the raw tool JSON", async () => {
    const { m } = mountView();
    const view = await m;
    assert.match(view.text(), /Add the card/);
    assert.match(view.text(), /Wire the buttons/);
    // Markdown, not the JSON blob, and not the generic tool prompt.
    assert.ok(!view.text().includes('"plan":'));
    assert.equal(view.byText("Accept"), null);
    assert.ok(view.byText("Approve plan"));
  });

  it("Approve plan allows, Keep planning denies", async () => {
    const { m, spy } = mountView();
    const view = await m;
    await view.click(view.byText("Approve plan"));
    assert.deepEqual(spy.calls, [
      { requestId: "req-plan-1", decision: "allow" },
    ]);

    const second = mountView();
    const view2 = await second.m;
    await view2.click(view2.byText("Keep planning"));
    assert.deepEqual(second.spy.calls, [
      { requestId: "req-plan-1", decision: "deny" },
    ]);
  });
});
