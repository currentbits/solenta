/**
 * Agent question prompt (AskUserQuestion): renders numbered options, a click
 * or a 1-9 key answers a lone single-select question immediately, multi-select
 * collects picks behind an Answer button, Dismiss denies. Issue #1219 adds
 * per-question file attach, isolated from the composer draft.
 *
 * Run: node --import=./test/support/render.mjs --test test/questionPrompt.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount, unmountAll, type Mounted } from "./support/dom.ts";
import {
  ThreadView,
  formatQuestionAnswer,
} from "../src/components/ThreadView";
import type {
  AttachmentInfo,
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

const FILE: AttachmentInfo = {
  kind: "file",
  path: "/tmp/app.log",
  name: "app.log",
};
const IMAGE: AttachmentInfo = {
  kind: "image",
  path: "/tmp/shot.png",
  name: "shot.png",
};

interface Spy {
  calls: Array<{
    requestId: string;
    decision: PermissionDecision;
    answers?: Record<string, string>;
  }>;
}

function threadView(over: {
  pending?: PendingPermissionInfo | null;
  persisted?: boolean;
  project?: ProjectInfo;
  onStartRun?: (
    prompt: string,
    threadId?: string,
    attachments?: AttachmentInfo[],
  ) => void | Promise<void>;
  onRespondPermission?: (
    requestId: string,
    decision: PermissionDecision,
    answers?: Record<string, string>,
  ) => void | Promise<void>;
  onPickAttachments?: (opts?: {
    includeImages?: boolean;
  }) => Promise<AttachmentInfo[]>;
  onSaveAttachmentImage?: (dataUrl: string) => Promise<AttachmentInfo | null>;
  onDropAttachmentFiles?: (
    files: File[],
  ) => Promise<AttachmentInfo[]>;
} = {}) {
  const t = thread();
  if (over.persisted) {
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
  }
  return (
    <ThreadView
      detail={
        over.persisted
          ? {
              thread: t,
              messages: [],
              workLog: [],
              workflow: null,
              usage: null,
              pendingPermission: null,
            }
          : detail(over.pending ?? singleQuestion)
      }
      project={over.project ?? project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={over.onStartRun ?? (() => {})}
      onStartWorkflow={() => {}}
      onSaveWorkflow={async () => ({ id: "w", name: "s", phases: [] })}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onRespondPermission={over.onRespondPermission ?? (() => {})}
      onClearQuestion={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      onPickAttachments={over.onPickAttachments}
      onSaveAttachmentImage={over.onSaveAttachmentImage}
      onLoadAttachmentImage={async () => null}
      onDropAttachmentFiles={over.onDropAttachmentFiles}
    />
  );
}

function mountView(
  pending: PendingPermissionInfo,
  over: {
    onRespondPermission?: (
      requestId: string,
      decision: PermissionDecision,
      answers?: Record<string, string>,
    ) => void | Promise<void>;
    onPickAttachments?: (opts?: {
      includeImages?: boolean;
    }) => Promise<AttachmentInfo[]>;
    onSaveAttachmentImage?: (
      dataUrl: string,
    ) => Promise<AttachmentInfo | null>;
    project?: ProjectInfo;
  } = {},
): {
  m: Promise<Mounted>;
  spy: Spy;
} {
  const spy: Spy = { calls: [] };
  const m = mount(
    threadView({
      pending,
      project: over.project,
      onPickAttachments: over.onPickAttachments,
      onSaveAttachmentImage: over.onSaveAttachmentImage,
      onRespondPermission:
        over.onRespondPermission ??
        ((requestId, decision, answers) => {
          spy.calls.push({ requestId, decision, answers });
        }),
    }),
  );
  return { m, spy };
}

afterEach(unmountAll);

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

const twoQuestions: PendingPermissionInfo = {
  requestId: "req-two",
  toolName: "AskUserQuestion",
  summary: "AskUserQuestion",
  input: "{}",
  questions: [
    {
      question: "Need a screenshot?",
      header: "Shot",
      multiSelect: false,
      options: [
        { label: "Yes", description: "" },
        { label: "No", description: "" },
      ],
    },
    {
      question: "Need a log?",
      header: "Log",
      multiSelect: false,
      options: [
        { label: "App log", description: "" },
        { label: "Skip", description: "" },
      ],
    },
  ],
};

describe("question answer attachments (#1219)", () => {
  it("does not advertise attach when no picker is wired", async () => {
    const { m } = mountView(singleQuestion);
    const view = await m;
    assert.equal(view.query("[data-question-attach]"), null);
    assert.ok(view.query('input[placeholder="Other…"]'));
  });

  it("hides Other and attach on a choice-only question", async () => {
    const pending: PendingPermissionInfo = {
      ...singleQuestion,
      questions: [
        {
          ...singleQuestion.questions![0],
          customAnswer: false,
        },
      ],
    };
    const { m } = mountView(pending, {
      onPickAttachments: async () => [FILE],
    });
    const view = await m;
    assert.equal(view.query("[data-question-attach]"), null);
    assert.equal(view.query('input[placeholder="Other…"]'), null);
  });

  it("states unsupported remote transfer instead of offering attach", async () => {
    const { m } = mountView(singleQuestion, {
      project: { ...project, remoteHost: "user@box" },
      onPickAttachments: async () => [FILE],
    });
    const view = await m;
    assert.equal(view.query("[data-question-attach]"), null);
    assert.ok(view.query("[data-question-remote-files]"));
    assert.match(view.text(), /running remotely/);
  });

  it("attaching to one question does not modify another or the composer draft", async () => {
    const { m, spy } = mountView(twoQuestions, {
      onPickAttachments: async () => [FILE],
    });
    const view = await m;
    const attach0 = view.query('[data-question-attach="0"]');
    assert.ok(attach0);
    await view.click(attach0);
    await view.flush();
    assert.ok(view.query('[data-question-attachments="0"]'));
    assert.equal(view.query('[data-question-attachments="1"]'), null);
    assert.equal(
      view.query('[aria-label="Attachments"]'),
      null,
      "composer draft must stay empty",
    );
    assert.equal(spy.calls.length, 0);
  });

  it("file-only answers submit path lines without a picked option", async () => {
    const { m, spy } = mountView(singleQuestion, {
      onPickAttachments: async () => [FILE],
    });
    const view = await m;
    await view.click(view.query('[data-question-attach="0"]'));
    await view.flush();
    const answer = view.byText("Answer");
    assert.ok(answer, "file-only must enable Answer");
    await view.click(answer);
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].decision, "allow");
    assert.equal(
      spy.calls[0].answers?.["Which database?"],
      "File: /tmp/app.log",
    );
  });

  it("keeps selected text and includes saved paths on a supported answer", async () => {
    const { m, spy } = mountView(singleQuestion, {
      onPickAttachments: async () => [IMAGE],
    });
    const view = await m;
    await view.click(view.query('[data-question-attach="0"]'));
    await view.flush();
    await view.click(view.byText("Postgres"));
    assert.equal(spy.calls.length, 0, "attach context must not auto-submit");
    await view.click(view.byText("Answer"));
    assert.equal(
      spy.calls[0].answers?.["Which database?"],
      "Postgres\nImage: /tmp/shot.png",
    );
  });

  it("does not auto-submit a number shortcut while a save is in flight", async () => {
    let resolvePick: (items: AttachmentInfo[]) => void = () => {};
    const pick = () =>
      new Promise<AttachmentInfo[]>((resolve) => {
        resolvePick = resolve;
      });
    const { m, spy } = mountView(singleQuestion, {
      onPickAttachments: pick,
    });
    const view = await m;
    await view.click(view.query('[data-question-attach="0"]'));
    await view.flush();
    assert.ok(view.query("[data-question-attach-pending]"));
    await view.press(view.container, "1");
    assert.equal(spy.calls.length, 0, "pending save must block instant submit");
    resolvePick([FILE]);
    await view.flush();
    assert.equal(spy.calls.length, 0);
    await view.click(view.byText("Answer"));
    assert.equal(spy.calls.length, 1);
    assert.match(spy.calls[0].answers?.["Which database?"] ?? "", /File:/);
  });

  it("keeps text and chips after a failed answer so the user can retry", async () => {
    let fails = 1;
    const spy: Spy = { calls: [] };
    const { m } = mountView(singleQuestion, {
      onPickAttachments: async () => [FILE],
      onRespondPermission: async (requestId, decision, answers) => {
        spy.calls.push({ requestId, decision, answers });
        if (fails > 0) {
          fails -= 1;
          throw new Error("delivery failed");
        }
      },
    });
    const view = await m;
    await view.click(view.query('[data-question-attach="0"]'));
    await view.flush();
    const other = view.query('input[placeholder="Other…"]');
    await view.type(other, "see log");
    await view.click(view.byText("Answer"));
    await view.flush();
    assert.equal(spy.calls.length, 1);
    assert.ok(view.query('[data-question-attachments="0"]'));
    assert.equal((other as HTMLInputElement).value, "see log");
    await view.click(view.byText("Answer"));
    await view.flush();
    assert.equal(spy.calls.length, 2);
    assert.match(spy.calls[1].answers?.["Which database?"] ?? "", /see log/);
    assert.match(spy.calls[1].answers?.["Which database?"] ?? "", /File:/);
  });

  it("drops a late save after the request is replaced", async () => {
    let resolvePick: (items: AttachmentInfo[]) => void = () => {};
    const pick = () =>
      new Promise<AttachmentInfo[]>((resolve) => {
        resolvePick = resolve;
      });
    const spy: Spy = { calls: [] };
    const respond = (
      requestId: string,
      decision: PermissionDecision,
      answers?: Record<string, string>,
    ) => {
      spy.calls.push({ requestId, decision, answers });
    };
    const view = await mount(
      threadView({
        pending: singleQuestion,
        onPickAttachments: pick,
        onRespondPermission: respond,
      }),
    );
    await view.click(view.query('[data-question-attach="0"]'));
    await view.flush();
    await view.rerender(
      threadView({
        pending: { ...singleQuestion, requestId: "req-replaced" },
        onPickAttachments: async () => [FILE],
        onRespondPermission: respond,
      }),
    );
    resolvePick([FILE]);
    await view.flush();
    assert.equal(
      view.query("[data-question-attachments]"),
      null,
      "late save must not land on the replacement card",
    );
  });

  it("persisted answers pass attachments on the follow-up turn", async () => {
    const runs: Array<{
      prompt: string;
      attachments?: AttachmentInfo[];
    }> = [];
    const view = await mount(
      threadView({
        persisted: true,
        onPickAttachments: async () => [FILE],
        onStartRun: (prompt, _tid, attachments) => {
          runs.push({ prompt, attachments });
        },
      }),
    );
    await view.click(view.query('[data-question-attach="0"]'));
    await view.flush();
    await view.click(view.byText("Merge"));
    await view.click(view.byText("Answer"));
    assert.equal(runs.length, 1);
    assert.match(runs[0].prompt, /Merge or open a PR\?/);
    assert.match(runs[0].prompt, /→ Merge/);
    assert.match(runs[0].prompt, /File: \/tmp\/app\.log/);
    assert.deepEqual(runs[0].attachments, [FILE]);
  });
});
