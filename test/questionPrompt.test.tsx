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
import {
  ThreadView,
  formatQuestionAnswer,
} from "../src/components/ThreadView";
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

/**
 * The persisted card (issue #647): grok and kimi cannot block on an answer, so
 * their question outlives the run and answering it is the NEXT MESSAGE, not a
 * permission response.
 */
function mountPersisted(): {
  m: Promise<Mounted>;
  runs: string[];
  cleared: number[];
} {
  const runs: string[] = [];
  const cleared: number[] = [];
  const t = thread();
  t.status = "done";
  t.runStartedAt = null;
  t.pendingQuestion = {
    id: "card-1",
    askedAt: 1,
    questions: [
      {
        question: "Merge or open a PR?",
        header: "Landing",
        multiSelect: false,
        options: [
          { label: "Merge", description: "Squash onto main" },
          { label: "PR", description: "Open a pull request" },
        ],
      },
    ],
  };
  const m = mount(
    <ThreadView
      detail={{
        thread: t,
        messages: [],
        workLog: [],
        workflow: null,
        usage: null,
        pendingPermission: null,
      }}
      project={project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={(prompt) => {
        runs.push(prompt);
      }}
      onStartWorkflow={() => {}}
      onSaveWorkflow={async () => ({ id: "w", name: "s", phases: [] })}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onRespondPermission={() => {}}
      onClearQuestion={() => {
        cleared.push(1);
      }}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
    />,
  );
  return { m, runs, cleared };
}

describe("persisted question card (#647)", () => {
  it("renders after the run ended, with no permission prompt in flight", async () => {
    const { m } = mountPersisted();
    const view = await m;
    assert.match(view.text(), /Merge or open a PR\?/);
    assert.ok(view.byText("Squash onto main"));
    assert.ok(view.byText("Dismiss"));
  });

  it("answering starts the next turn instead of answering a permission", async () => {
    const { m, runs, cleared } = mountPersisted();
    const view = await m;
    await view.click(view.byText("Merge"));
    assert.equal(cleared.length, 0);
    assert.equal(runs.length, 1);
    // The message repeats the question: on a session that could not resume,
    // a bare "Merge" would be unreadable.
    assert.match(runs[0], /Merge or open a PR\?/);
    assert.match(runs[0], /→ Merge/);
  });

  it("Dismiss clears the card and sends nothing", async () => {
    const { m, runs, cleared } = mountPersisted();
    const view = await m;
    await view.click(view.byText("Dismiss"));
    assert.equal(cleared.length, 1);
    assert.deepEqual(runs, []);
  });
});

describe("formatQuestionAnswer", () => {
  it("quotes every answered question and drops the unanswered", () => {
    const text = formatQuestionAnswer({
      "Which database?": "Postgres",
      "Which cache?": "",
      "Which features?": "Auth, Billing",
    });
    assert.equal(
      text,
      "Answering your question:\n\n" +
        "Which database?\n→ Postgres\n\n" +
        "Which features?\n→ Auth, Billing",
    );
  });

  it("is empty when nothing was picked, so no turn is started", () => {
    assert.equal(formatQuestionAnswer({ "Which?": "" }), "");
  });
});
