/**
 * `/btw` side-question card (issue #471): question, answer, dismiss, promote.
 *
 * Run: npm run test:renderer -- --test-name-pattern="BtwCard"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  BtwCard,
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
    title: "btw card",
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "working",
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: 1,
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

function card(extra: Partial<BtwCard> & Pick<BtwCard, "id" | "question">): BtwCard {
  return {
    status: "done",
    createdAt: 1,
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
    onDismissBtw?: (threadId: string, id: string) => void;
    onPromoteBtw?: (threadId: string, id: string) => void;
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
      onDismissBtw={extras.onDismissBtw}
      onPromoteBtw={extras.onPromoteBtw}
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

describe("BtwCard", () => {
  it("is absent when the thread has no side questions", async () => {
    const view = await mountView(detail());
    assert.equal(view.query("[data-btw-card]"), null);
  });

  it("renders a running card without an answer", async () => {
    const view = await mountView(
      detail({
        btw: [
          card({
            id: "b1",
            question: "where is createThread",
            status: "running",
          }),
        ],
      }),
    );
    const el = view.query("[data-btw-card]");
    assert.ok(el);
    assert.equal(el.getAttribute("data-btw-status"), "running");
    assert.match(view.text(), /where is createThread/);
    assert.match(view.text(), /Answering from the repo map/);
  });

  it("renders the answer and promote/dismiss", async () => {
    const dismissed: string[] = [];
    const promoted: string[] = [];
    const view = await mountView(
      detail({
        btw: [
          card({
            id: "b1",
            question: "where is createThread",
            answer: "electron/services.js",
          }),
        ],
      }),
      {
        onDismissBtw: (_tid, id) => {
          dismissed.push(id);
        },
        onPromoteBtw: (_tid, id) => {
          promoted.push(id);
        },
      },
    );
    assert.match(view.text(), /electron\/services\.js/);
    await view.click(view.query("[data-btw-promote-btn]"));
    await view.click(view.query("[data-btw-dismiss-btn]"));
    assert.deepEqual(promoted, ["b1"]);
    assert.deepEqual(dismissed, ["b1"]);
  });
});
