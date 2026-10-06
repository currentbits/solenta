/**
 * Plan approval prompt (ExitPlanMode): the plan renders as markdown in the
 * permission panel — not raw JSON — and approve/keep-planning answer it.
 *
 * Run: node --import=./test/support/render.mjs --test test/planPrompt.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import {
  createFakeCoder,
  installFakeCoder,
  project as fakeProject,
  thread as fakeThread,
  detail as fakeDetail,
} from "./support/fakeCoder.ts";
import App from "../src/App";
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
  calls: Array<{ requestId: string; decision: PermissionDecision; feedback?: string }>;
  implemented: string[];
  saved: string[];
}

function mountView(
  save: (plan: string) => Promise<string> = async () => "docs/plans/2026-10-06-steps.md",
): { m: ReturnType<typeof mount>; spy: Spy } {
  const spy: Spy = { calls: [], implemented: [], saved: [] };
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
      onRespondPermission={(requestId, decision, _a, _c, _v, feedback) => {
        spy.calls.push(
          feedback ? { requestId, decision, feedback } : { requestId, decision },
        );
      }}
      onImplementPlan={(plan) => {
        spy.implemented.push(plan);
      }}
      onSavePlan={(plan) => {
        spy.saved.push(plan);
        return save(plan);
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

  it("sends Keep planning notes, and Approve ignores them (#1501)", async () => {
    const { m, spy } = mountView();
    const view = await m;
    const notes = view.query("textarea[data-plan-feedback]") as HTMLTextAreaElement;
    assert.ok(notes, "Keep planning offers an optional notes field");
    await view.type(notes, "  split step 2  ");
    await view.click(view.byText("Keep planning"));
    assert.deepEqual(spy.calls, [
      { requestId: "req-plan-1", decision: "deny", feedback: "split step 2" },
    ]);

    const second = mountView();
    const view2 = await second.m;
    await view2.type(view2.query("textarea[data-plan-feedback]"), "ignored");
    await view2.click(view2.byText("Approve plan"));
    assert.deepEqual(second.spy.calls, [
      { requestId: "req-plan-1", decision: "allow" },
    ]);
  });

  it("Implement in a new thread hands over the plan (#1501)", async () => {
    const { m, spy } = mountView();
    const view = await m;
    await view.click(view.query("button[data-implement-plan]"));
    assert.deepEqual(spy.implemented, [pending.plan]);
    assert.deepEqual(spy.calls, [], "the source prompt is left for the user");
  });

  it("Save plan to file shows the path, or the refusal (#1501)", async () => {
    const { m, spy } = mountView();
    const view = await m;
    await view.click(view.query("button[data-save-plan]"));
    await view.flush();
    assert.deepEqual(spy.saved, [pending.plan]);
    assert.match(
      view.query("[data-plan-saved]")?.textContent || "",
      /docs\/plans\/2026-10-06-steps\.md/,
    );
    assert.equal(
      (view.query("button[data-save-plan]") as HTMLButtonElement).disabled,
      true,
      "one save per prompt",
    );

    const refused = mountView(async () => {
      throw new Error("docs/plans/x.md already exists; not overwriting it");
    });
    const view2 = await refused.m;
    await view2.click(view2.query("button[data-save-plan]"));
    await view2.flush();
    assert.match(view2.query("[data-plan-save-error]")?.textContent || "", /not overwriting/);
    assert.equal(view2.query("[data-plan-saved]"), null);
  });
});

describe("Implement in a new thread, through App (#1501)", () => {
  it("forks out of plan mode and starts the plan on the fork", async () => {
    const src = fakeThread({
      id: "t-plan",
      title: "plan source",
      status: "working",
      permissionMode: "plan",
    });
    const fake = createFakeCoder({
      projects: [fakeProject()],
      threads: [src],
      details: {
        "t-plan": fakeDetail({ thread: src, pendingPermission: pending }),
      },
    });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const view = await mount(<App />);
    await view.flush();
    const row = view.query('button[aria-label^="Select thread: plan source"]');
    if (row) {
      await view.click(row);
      await view.flush();
    }
    await view.click(view.query("button[data-implement-plan]"));
    await view.flush();

    const forks = fake.of("threads.fork");
    assert.equal(forks.length, 1);
    assert.deepEqual(forks[0]!.args[0], { threadId: "t-plan", leavePlan: true });
    const starts = fake.of("runs.start");
    assert.equal(starts.length, 1);
    const input = starts[0]!.args[0] as { threadId: string; prompt: string };
    assert.notEqual(input.threadId, "t-plan", "the plan runs on the fork");
    assert.match(input.prompt, /^Implement this plan:\n\n## Steps/);
    view.unmount();
  });
});
