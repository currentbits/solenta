/**
 * Felt-estimate card (issue #401): one-tap estimate asked once when a run
 * completes; Skip declines; answered/declined threads never see it again.
 *
 * Run: npm run test:renderer -- test/feltCard.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
} from "../src/shared/ipc";

const HOUR = 3_600_000;

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
    title: "felt card",
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "done",
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
    worktreePath: null,
    handoffFrom: null,
    ...extra,
  };
}

function detail(extra: Partial<ThreadInfo> = {}): ThreadDetail {
  return {
    thread: thread(extra),
    messages: [],
    workLog: [],
    workflow: null,
    usage: null,
    pendingPermission: null,
  };
}

async function mountView(
  d: ThreadDetail,
  extras: {
    onSetFeltEstimate?: (threadId: string, savedMs: number | null) => void;
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
      onSetFeltEstimate={extras.onSetFeltEstimate}
      changesOpen={false}
      changesNonce={0}
      onCloseChanges={() => {}}
      onFetchDiff={async () => ({ files: [], patch: "" })}
      onCommitChanges={async () => ({ subject: "" })}
      onRevertFile={async () => ({ path: "" })}
      onSuggestCommitMessage={async () => ({ message: "" })}
    />,
  );
  await view.flush();
  return view;
}

describe("FeltEstimateCard", () => {
  it("asks once a run completed and no estimate exists", async () => {
    const view = await mountView(detail(), { onSetFeltEstimate: () => {} });
    assert.ok(view.query("[data-felt-card]"), "card shown");
    assert.match(view.text(), /How much time did this save you/);
    assert.ok(view.query('[data-felt-estimate-btn="900000"]'), "15 min bucket");
    assert.ok(view.query('[data-felt-estimate-btn="14400000"]'), "4 h+ bucket");
    assert.ok(view.query("[data-felt-skip-btn]"), "skip");
    view.unmount();
  });

  it("one tap records the bucket in ms", async () => {
    const calls: Array<[string, number | null]> = [];
    const view = await mountView(detail(), {
      onSetFeltEstimate: (id, savedMs) => {
        calls.push([id, savedMs]);
      },
    });
    await view.click(view.query('[data-felt-estimate-btn="3600000"]'));
    assert.deepEqual(calls, [["t1", HOUR]]);
    view.unmount();
  });

  it("Skip records a decline (null), not a zero", async () => {
    const calls: Array<[string, number | null]> = [];
    const view = await mountView(detail(), {
      onSetFeltEstimate: (id, savedMs) => {
        calls.push([id, savedMs]);
      },
    });
    await view.click(view.query("[data-felt-skip-btn]"));
    assert.deepEqual(calls, [["t1", null]]);
    view.unmount();
  });

  it("never asks an answered or declined thread again", async () => {
    const saved = await mountView(
      detail({ feltEstimate: { kind: "saved", savedMs: HOUR, at: 1 } }),
      { onSetFeltEstimate: () => {} },
    );
    assert.equal(saved.query("[data-felt-card]"), null);
    saved.unmount();
    const declined = await mountView(
      detail({ feltEstimate: { kind: "declined", at: 1 } }),
      { onSetFeltEstimate: () => {} },
    );
    assert.equal(declined.query("[data-felt-card]"), null);
    declined.unmount();
  });

  it("stays hidden while a run is active or failed", async () => {
    for (const status of ["working", "failed", "idle"] as const) {
      const view = await mountView(detail({ status }), {
        onSetFeltEstimate: () => {},
      });
      assert.equal(view.query("[data-felt-card]"), null, status);
      view.unmount();
    }
  });

  it("stays hidden in ask/teach mode", async () => {
    const view = await mountView(detail({ ask: true }), {
      onSetFeltEstimate: () => {},
    });
    assert.equal(view.query("[data-felt-card]"), null);
    view.unmount();
  });

  it("renders nothing without the callback (web/dev surfaces)", async () => {
    const view = await mountView(detail());
    assert.equal(view.query("[data-felt-card]"), null);
    view.unmount();
  });
});
