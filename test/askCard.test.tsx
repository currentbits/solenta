/**
 * Ask mode card (issue #392): read-only Q&A, Start work, turn off.
 *
 * Run: npm run test:renderer -- --test-name-pattern="AskCard"
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
    title: "ask card",
    branch: null,
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
    onStartAsk?: (threadId: string) => void;
    onStopAsk?: (threadId: string, opts?: { worktree?: boolean }) => void;
    defaultWorktree?: boolean;
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
      onStartAsk={extras.onStartAsk}
      onStopAsk={extras.onStopAsk}
      defaultWorktree={extras.defaultWorktree}
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

describe("AskCard", () => {
  it("Ask mode button calls startAsk for a thread without ask", async () => {
    const started: string[] = [];
    const view = await mountView(detail(), {
      onStartAsk: (id) => {
        started.push(id);
      },
    });
    assert.equal(view.query("[data-ask-card]"), null);
    await view.click(view.query("[aria-label='Thread actions']"));
    const btn = view.query("[data-ask-mode-btn]");
    assert.ok(btn);
    await view.click(btn);
    assert.deepEqual(started, ["t1"]);
  });

  it("renders the card and hides teach/spec/git when ask is on", async () => {
    const view = await mountView(
      detail({ ask: true }),
      { onStopAsk: () => {}, onStartAsk: () => {} },
    );
    assert.ok(view.query("[data-ask-card]"));
    assert.match(view.text(), /repo map and memory/);
    assert.equal(view.query("[data-ask-mode-btn]"), null);
    assert.equal(view.query("[data-teach-mode-btn]"), null);
    assert.equal(view.query("[data-spec-mode-btn]"), null);
    assert.match(
      view.query("textarea")?.getAttribute("placeholder") || "",
      /Ask about this repo/,
    );
  });

  it("Start work passes worktree when defaultWorktree is on", async () => {
    const stopped: Array<[string, { worktree?: boolean } | undefined]> = [];
    const view = await mountView(detail({ ask: true }), {
      defaultWorktree: true,
      onStopAsk: (id, opts) => {
        stopped.push([id, opts]);
      },
    });
    await view.click(view.query("[data-ask-start-work-btn]"));
    assert.deepEqual(stopped, [["t1", { worktree: true }]]);
  });

  it("Turn off clears ask without a worktree", async () => {
    const stopped: Array<[string, { worktree?: boolean } | undefined]> = [];
    const view = await mountView(detail({ ask: true }), {
      onStopAsk: (id, opts) => {
        stopped.push([id, opts]);
      },
    });
    await view.click(view.query("[data-ask-stop-btn]"));
    assert.deepEqual(stopped, [["t1", undefined]]);
  });
});
