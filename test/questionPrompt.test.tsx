/**
 * Agent question prompt (AskUserQuestion): renders numbered options, a click
 * or a 1-9 key answers a lone single-select question immediately, multi-select
 * collects picks behind an Answer button, Dismiss denies.
 *
 * Run: node --import=./test/support/render.mjs --test test/questionPrompt.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount, type Mounted } from "./support/dom.ts";
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
    title: "question flow",
    branch: "coder/question-flow",
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
  };
}

function detail(pending: PendingPermissionInfo): ThreadDetail {
  return {
    thread: thread(),
    messages: [],
    workLog: [],
    workflow: null,
    usage: null,
    pendingPermission: pending,
  };
}

const singleQuestion: PendingPermissionInfo = {
  requestId: "req-1",
  toolName: "AskUserQuestion",
  summary: "AskUserQuestion",
  input: "{}",
  questions: [
    {
      question: "Which database?",
      header: "Database",
      multiSelect: false,
      options: [
        { label: "Postgres", description: "Relational" },
        { label: "SQLite", description: "Embedded" },
      ],
    },
  ],
};

const multiQuestion: PendingPermissionInfo = {
  requestId: "req-2",
  toolName: "AskUserQuestion",
  summary: "AskUserQuestion",
  input: "{}",
  questions: [
    {
      question: "Which features?",
      header: "Features",
      multiSelect: true,
      options: [
        { label: "Auth", description: "" },
        { label: "Search", description: "" },
        { label: "Billing", description: "" },
      ],
    },
  ],
};

interface Spy {
  calls: Array<{
    requestId: string;
    decision: PermissionDecision;
    answers?: Record<string, string>;
  }>;
}

function mountView(pending: PendingPermissionInfo): {
  m: Promise<Mounted>;
  spy: Spy;
} {
  const spy: Spy = { calls: [] };
  const m = mount(
    <ThreadView
      detail={detail(pending)}
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
      onRespondPermission={(requestId, decision, answers) => {
        spy.calls.push({ requestId, decision, answers });
      }}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
    />,
  );
  return { m, spy };
}

describe("QuestionPrompt", () => {
  it("renders the question with numbered options instead of raw JSON", async () => {
    const { m } = mountView(singleQuestion);
    const view = await m;
    assert.match(view.text(), /Which database\?/);
    assert.match(view.text(), /Postgres/);
    assert.match(view.text(), /Embedded/);
    // Option key hints 1 and 2 are shown; no Accept/Deny tool prompt.
    assert.ok(view.byText("Postgres"));
    assert.equal(view.byText("Accept"), null);
    assert.ok(view.byText("Dismiss"));
  });

  it("clicking an option answers a lone single-select question immediately", async () => {
    const { m, spy } = mountView(singleQuestion);
    const view = await m;
    await view.click(view.byText("Postgres"));
    assert.deepEqual(spy.calls, [
      {
        requestId: "req-1",
        decision: "allow",
        answers: { "Which database?": "Postgres" },
      },
    ]);
  });

  it("number keys pick the matching option", async () => {
    const { m, spy } = mountView(singleQuestion);
    const view = await m;
    await view.press(view.container, "2");
    assert.deepEqual(spy.calls, [
      {
        requestId: "req-1",
        decision: "allow",
        answers: { "Which database?": "SQLite" },
      },
    ]);
  });

  it("multi-select collects picks and submits joined on Answer", async () => {
    const { m, spy } = mountView(multiQuestion);
    const view = await m;
    await view.click(view.byText("Auth"));
    await view.click(view.byText("Billing"));
    assert.equal(spy.calls.length, 0, "picks alone do not submit");
    await view.click(view.byText("Answer"));
    assert.deepEqual(spy.calls, [
      {
        requestId: "req-2",
        decision: "allow",
        answers: { "Which features?": "Auth, Billing" },
      },
    ]);
  });

  it("Dismiss denies the request", async () => {
    const { m, spy } = mountView(singleQuestion);
    const view = await m;
    await view.click(view.byText("Dismiss"));
    assert.deepEqual(spy.calls, [
      { requestId: "req-1", decision: "deny", answers: undefined },
    ]);
  });
});
