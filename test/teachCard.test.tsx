/**
 * Teach mode card (issue #373): autonomy ladder, review my code, turn off.
 *
 * Run: node --import=./test/support/render.mjs --test test/teachCard.test.tsx
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
    title: "teach card",
    branch: "coder/teach-card",
    prNumber: null,
    prUrl: null,
    status: "idle",
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    muted: false,
    notes: "",
    queued: null,
    lastVisitedAt: null,
    prState: null,
    verifyCommand: null,
    verify: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: "/tmp/wt",
    handoffFrom: null,
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
    onStartTeach?: (threadId: string) => void;
    onStopTeach?: (threadId: string) => void;
    onRequestTeachReview?: (threadId: string) => void;
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
      onStartTeach={extras.onStartTeach}
      onStopTeach={extras.onStopTeach}
      onRequestTeachReview={extras.onRequestTeachReview}
    />,
  );
  await view.flush();
  return view;
}

describe("TeachCard", () => {
  it("Teach mode button calls startTeach for a thread without teach", async () => {
    const started: string[] = [];
    const view = await mountView(detail(), {
      onStartTeach: (id) => {
        started.push(id);
      },
    });
    assert.equal(view.query("[data-teach-card]"), null);
    const btn = view.query("[data-teach-mode-btn]");
    assert.ok(btn);
    await view.click(btn);
    assert.deepEqual(started, ["t1"]);
  });

  it("renders the autonomy ladder and review count", async () => {
    const view = await mountView(
      detail({
        teach: { autonomy: "review", reviewsPassed: 4 },
      }),
      {
        onStopTeach: () => {},
        onRequestTeachReview: () => {},
      },
    );
    assert.ok(view.query("[data-teach-card]"));
    assert.equal(
      view.query('[data-teach-autonomy="review"]')?.getAttribute("data-plan-step"),
      "doing",
    );
    assert.equal(
      view.query('[data-teach-autonomy="hint"]')?.getAttribute("data-plan-step"),
      "done",
    );
    assert.equal(
      view.query('[data-teach-autonomy="pair"]')?.getAttribute("data-plan-step"),
      "todo",
    );
    assert.match(view.text(), /4 reviews passed/);
    assert.match(view.text(), /TODO\(human\)/);
  });

  it("Review my code and Turn off call the handlers", async () => {
    const reviews: string[] = [];
    const stopped: string[] = [];
    const view = await mountView(
      detail({ teach: { autonomy: "hint", reviewsPassed: 0 } }),
      {
        onRequestTeachReview: (id) => {
          reviews.push(id);
        },
        onStopTeach: (id) => {
          stopped.push(id);
        },
      },
    );
    await view.click(view.query("[data-teach-review-btn]"));
    await view.click(view.query("[data-teach-stop-btn]"));
    assert.deepEqual(reviews, ["t1"]);
    assert.deepEqual(stopped, ["t1"]);
  });

  it("hides the Teach mode button once teach is on", async () => {
    const view = await mountView(
      detail({ teach: { autonomy: "hint", reviewsPassed: 0 } }),
      { onStartTeach: () => {} },
    );
    assert.equal(view.query("[data-teach-mode-btn]"), null);
    assert.ok(view.query("[data-teach-card]"));
  });
});
