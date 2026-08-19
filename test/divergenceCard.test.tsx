/**
 * Divergence card: first split between two runs of the same task (#393).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
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
  ChatMessage,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  ToolCallInfo,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";
import {
  setDivergenceCardEnabled,
  type ComparePeer,
} from "../src/divergence";

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
  {
    id: "codex",
    name: "Codex",
    available: true,
    supportsResume: true,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t-claude",
    projectId: "p1",
    title: "Fork: task",
    branch: "coder/task-claude",
    prNumber: null,
    prUrl: null,
    status: "done",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
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
    handoffFrom: "t-src",
    ...over,
  };
}

function toolMsg(over: {
  id: string;
  name: string;
  input: string;
  output?: string;
  runId?: string;
  createdAt?: number;
  isError?: boolean;
}): ChatMessage {
  const tool: ToolCallInfo = {
    id: over.id,
    name: over.name,
    input: over.input,
    output: over.output ?? "ok",
    isError: over.isError ?? false,
    done: true,
  };
  return {
    id: over.id,
    role: "tool",
    text: `${over.name}: ${over.input}`,
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? "run-a",
    tool,
  };
}

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    thread: over.thread ?? thread(),
    messages: over.messages ?? [
      toolMsg({ id: "c1", name: "Read", input: "a.ts" }),
      toolMsg({ id: "c2", name: "Bash", input: "npm test", createdAt: 2 }),
    ],
    workLog: over.workLog ?? [],
    workflow: over.workflow ?? null,
    usage: over.usage ?? null,
  };
}

const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

function view(props: {
  detail?: ThreadDetail;
  comparePeers?: ComparePeer[];
  onPeekThread?: (id: string) => Promise<ThreadDetail>;
}) {
  return (
    <ThreadView
      detail={props.detail ?? detail()}
      project={project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={noopSave}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      changesOpen={false}
      changesNonce={0}
      onCloseChanges={() => {}}
      onFetchDiff={async () => ({ files: [], patch: "", truncated: false })}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
      comparePeers={props.comparePeers}
      onPeekThread={props.onPeekThread}
    />
  );
}

afterEach(unmountAll);

const codexPeer: ComparePeer = {
  id: "t-codex",
  label: "Codex",
  status: "done",
  provider: "codex",
};

const codexDetail = detail({
  thread: thread({ id: "t-codex", provider: "codex", title: "Fork: task" }),
  messages: [
    toolMsg({ id: "x1", name: "Read", input: "a.ts" }),
    toolMsg({ id: "x2", name: "Read", input: "b.ts", createdAt: 2 }),
  ],
});

describe("divergence card", () => {
  it("is absent when there is no sibling and only one run", async () => {
    const m = await mount(view({ comparePeers: [] }));
    assert.equal(m.query("[data-divergence-card]"), null);
    m.unmount();
  });

  it("peeks the sibling and names the first tool-name split", async () => {
    const peeked: string[] = [];
    const m = await mount(
      view({
        comparePeers: [codexPeer],
        onPeekThread: async (id) => {
          peeked.push(id);
          return codexDetail;
        },
      }),
    );
    await m.flush();
    assert.deepEqual(peeked, ["t-codex"]);
    const card = m.query("[data-divergence-card]");
    assert.ok(card, "card must render when a sibling exists");
    const headline = m.query("[data-divergence-headline]");
    assert.ok(headline, "headline must render");
    assert.match(
      headline!.textContent ?? "",
      /Diverged at step 2 · name · Bash vs Read/,
    );
    assert.equal(
      m.query("[data-divergence-left='name']")?.textContent,
      "Bash",
    );
    assert.equal(
      m.query("[data-divergence-right='name']")?.textContent,
      "Read",
    );
    assert.equal(
      m.query("[data-divergence-field='name']")?.getAttribute("data-differs"),
      "1",
    );
    m.unmount();
  });

  it("compares two completed runs on the same thread without peeking", async () => {
    let peeks = 0;
    const twoRuns = detail({
      messages: [
        toolMsg({ id: "a1", name: "Read", input: "a.ts", runId: "r1" }),
        toolMsg({
          id: "a2",
          name: "Bash",
          input: "npm test",
          runId: "r2",
          createdAt: 2,
        }),
      ],
    });
    const m = await mount(
      view({
        detail: twoRuns,
        comparePeers: [],
        onPeekThread: async () => {
          peeks += 1;
          return twoRuns;
        },
      }),
    );
    await m.flush();
    assert.equal(peeks, 0, "same-thread compare must not peek another thread");
    const headline = m.query("[data-divergence-headline]");
    assert.ok(headline);
    assert.match(
      headline!.textContent ?? "",
      /Diverged at step 1 · name · Bash vs Read/,
    );
    const select = m.query("[data-divergence-peer]") as HTMLSelectElement | null;
    assert.ok(select);
    assert.equal(select!.value, "run:r1");
    m.unmount();
  });

  it("surfaces a peek failure instead of a fake match", async () => {
    const m = await mount(
      view({
        comparePeers: [codexPeer],
        onPeekThread: async () => {
          throw new Error("thread gone");
        },
      }),
    );
    await m.flush();
    const headline = m.query("[data-divergence-headline]");
    assert.equal(headline?.getAttribute("role"), "alert");
    assert.match(headline?.textContent ?? "", /thread gone/);
    assert.equal(m.query("[data-divergence-fields]"), null);
    m.unmount();
  });

  it("hides entirely (and skips the peek) when the Environment toggle is off", async () => {
    setDivergenceCardEnabled(false);
    try {
      let peeks = 0;
      const m = await mount(
        view({
          comparePeers: [codexPeer],
          onPeekThread: async () => {
            peeks += 1;
            return codexDetail;
          },
        }),
      );
      await m.flush();
      assert.equal(m.query("[data-divergence-card]"), null);
      assert.equal(peeks, 0);
      m.unmount();
    } finally {
      setDivergenceCardEnabled(true);
    }
  });
});

describe("App wires peek, not get, for the other run", () => {
  it("loads the sibling via threads.peek and leaves lastVisitedAt alone", async () => {
    const decoy = fakeThread({
      id: "t-decoy",
      title: "decoy first thread",
      provider: "claude",
      handoffFrom: null,
    });
    const src = fakeThread({
      id: "t-src",
      title: "source task",
      provider: "claude",
      handoffFrom: null,
    });
    const claude = fakeThread({
      id: "t-claude",
      title: "Claude attempt",
      provider: "claude",
      handoffFrom: "t-src",
    });
    const codex = fakeThread({
      id: "t-codex",
      title: "Codex attempt",
      provider: "codex",
      handoffFrom: "t-src",
      lastVisitedAt: 42,
    });
    const fake = createFakeCoder({
      projects: [fakeProject()],
      providers,
      threads: [decoy, src, claude, codex],
      details: {
        "t-decoy": fakeDetail({ thread: decoy }),
        "t-src": fakeDetail({ thread: src }),
        "t-claude": fakeDetail({
          thread: claude,
          messages: [
            toolMsg({ id: "c1", name: "Read", input: "a.ts" }),
            toolMsg({ id: "c2", name: "Bash", input: "npm test", createdAt: 2 }),
          ],
        }),
        "t-codex": fakeDetail({
          thread: { ...codex, lastVisitedAt: 42 },
          messages: [
            toolMsg({ id: "x1", name: "Read", input: "a.ts" }),
            toolMsg({ id: "x2", name: "Read", input: "b.ts", createdAt: 2 }),
          ],
        }),
      },
    });
    const shell = await mount(<div />);
    installFakeCoder(fake);
    shell.unmount();
    const m = await mount(<App />);
    const card = m.query('button[aria-label="Select thread: Claude attempt"]');
    assert.ok(card, "claude sibling must be in the sidebar");
    await m.click(card as HTMLElement);
    await m.flush();

    const peeks = fake.of("threads.peek");
    assert.ok(peeks.length >= 1, "must peek the sibling at least once");
    assert.ok(
      peeks.every((c) => c.args[0] === "t-codex"),
      "peek must only load the sibling, never another thread",
    );
    const gets = fake.of("threads.get").map((c) => c.args[0]);
    assert.ok(gets.includes("t-claude"));
    assert.ok(
      !gets.includes("t-codex"),
      "comparing must not visit the other run",
    );
    const headline = m.query("[data-divergence-headline]");
    assert.match(
      headline?.textContent ?? "",
      /Diverged at step 2 · name · Bash vs Read/,
    );
    m.unmount();
  });
});
