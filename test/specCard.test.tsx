/**
 * Spec mode card (issue #269): gated requirements → design → tasks → build
 * strip, current artifact, and the approve / request-changes gate.
 *
 * Run: node --import=./test/support/render.mjs --test test/specCard.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  PendingPermissionInfo,
  ProjectInfo,
  ProviderInfo,
  SpecArtifact,
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
    title: "spec card",
    branch: "coder/spec-card",
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

async function mountView(
  d: ThreadDetail,
  extras: {
    onStartSpec?: (threadId: string) => void;
    onReviewSpec?: (
      threadId: string,
      decision: "approve" | "revise",
      feedback?: string,
    ) => void;
    onSpecArtifact?: (
      threadId: string,
      stage: SpecArtifact,
    ) => Promise<{ path: string; text: string | null }>;
  } = {},
) {
  const view = await mount(
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
      onStartSpec={extras.onStartSpec}
      onReviewSpec={extras.onReviewSpec}
      onSpecArtifact={extras.onSpecArtifact}
    />,
  );
  await view.flush();
  return view;
}

describe("SpecCard", () => {
  it("renders the current stage and artifact text", async () => {
    const fetched: SpecArtifact[] = [];
    const view = await mountView(
      detail({
        spec: { slug: "foo", stage: "design", awaitingApproval: true },
      }),
      {
        onReviewSpec: () => {},
        onSpecArtifact: async (_id, stage) => {
          fetched.push(stage);
          return {
            path: ".solenta/specs/foo/design.md",
            text: "Use a card in the thread view",
          };
        },
      },
    );
    assert.ok(view.query("[data-spec-card]"));
    assert.equal(
      view.query('[data-spec-stage="design"]')?.getAttribute("data-plan-step"),
      "doing",
    );
    assert.equal(
      view.query('[data-spec-stage="requirements"]')?.getAttribute("data-plan-step"),
      "done",
    );
    assert.equal(
      view.query('[data-spec-stage="tasks"]')?.getAttribute("data-plan-step"),
      "todo",
    );
    assert.match(view.text(), /Use a card in the thread view/);
    assert.deepEqual(fetched, ["design"]);
  });

  it("Approve calls the api with decision approve", async () => {
    const calls: Array<{
      threadId: string;
      decision: string;
      feedback?: string;
    }> = [];
    const view = await mountView(
      detail({
        spec: { slug: "foo", stage: "requirements", awaitingApproval: true },
      }),
      {
        onReviewSpec: (threadId, decision, feedback) => {
          calls.push({ threadId, decision, feedback });
        },
        onSpecArtifact: async () => ({
          path: ".solenta/specs/foo/requirements.md",
          text: "## Acceptance",
        }),
      },
    );
    await view.click(view.byText("Approve"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].threadId, "t1");
    assert.equal(calls[0].decision, "approve");
    assert.equal(calls[0].feedback, undefined);
  });

  it("Request changes sends the typed feedback", async () => {
    const calls: Array<{
      threadId: string;
      decision: string;
      feedback?: string;
    }> = [];
    const view = await mountView(
      detail({
        spec: { slug: "foo", stage: "requirements", awaitingApproval: true },
      }),
      {
        onReviewSpec: (threadId, decision, feedback) => {
          calls.push({ threadId, decision, feedback });
        },
        onSpecArtifact: async () => ({
          path: ".solenta/specs/foo/requirements.md",
          text: "## Acceptance",
        }),
      },
    );
    await view.click(view.byText("Request changes"));
    const ta = view.query("[data-spec-feedback]");
    assert.ok(ta, "textarea must appear after Request changes");
    await view.type(ta, "add acceptance criteria");
    await view.click(view.byText("Request changes"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].decision, "revise");
    assert.equal(calls[0].feedback, "add acceptance criteria");
  });

  it("hides the gate buttons when awaitingApproval is false", async () => {
    const view = await mountView(
      detail({
        spec: { slug: "foo", stage: "design", awaitingApproval: false },
      }),
      {
        onReviewSpec: () => {},
        onSpecArtifact: async () => ({
          path: ".solenta/specs/foo/design.md",
          text: "Drafting the design",
        }),
      },
    );
    assert.equal(view.byText("Approve"), null);
    assert.equal(view.byText("Request changes"), null);
    assert.match(view.text(), /working on this stage/);
  });

  it("Spec mode button calls startSpec for a thread without a spec", async () => {
    const started: string[] = [];
    const view = await mountView(detail(), {
      onStartSpec: (id) => {
        started.push(id);
      },
    });
    assert.equal(view.query("[data-spec-card]"), null);
    const btn = view.query("[data-spec-mode-btn]");
    assert.ok(btn);
    await view.click(btn);
    assert.deepEqual(started, ["t1"]);
  });

  it("shows the path when the artifact is not written yet", async () => {
    const view = await mountView(
      detail({
        spec: { slug: "foo", stage: "tasks", awaitingApproval: true },
      }),
      {
        onReviewSpec: () => {},
        onSpecArtifact: async () => ({
          path: ".solenta/specs/foo/tasks.md",
          text: null,
        }),
      },
    );
    assert.match(view.text(), /\.solenta\/specs\/foo\/tasks\.md/);
    assert.match(view.text(), /not written yet/);
  });

  it("at build says the spec is approved and does not fetch an artifact", async () => {
    let fetches = 0;
    const view = await mountView(
      detail({
        spec: { slug: "foo", stage: "build", awaitingApproval: false },
      }),
      {
        onReviewSpec: () => {},
        onSpecArtifact: async () => {
          fetches += 1;
          return { path: ".solenta/specs/foo/tasks.md", text: "nope" };
        },
      },
    );
    assert.match(view.text(), /spec is approved/);
    assert.equal(view.byText("Approve"), null);
    assert.equal(fetches, 0);
    assert.equal(
      view.query('[data-spec-stage="build"]')?.getAttribute("data-plan-step"),
      "doing",
    );
  });
});
