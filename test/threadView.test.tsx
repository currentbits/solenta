/**
 * ThreadView, the centre pane: messages, work-log cards, empty states.
 *
 * This file exists because ThreadView had ZERO render coverage. timeline.ts is
 * pure and well tested, but nothing proved the component calls buildTimeline or
 * paints what it returns. A reviewer twice deleted user-visible wiring at a
 * call site while the suite, tsc and vite build stayed green.
 *
 * Run: node --import=./test/support/render.mjs --test test/threadView.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { mount, unmountAll } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  ChatMessage,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  WorkLogItem,
  WorkflowTemplateInfo,
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

const workflows: WorkflowTemplateInfo[] = [];

const FRESH = Date.now();

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "fix the centre pane",
    branch: "coder/fix-centre-pane-abc123",
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: FRESH,
    updatedAt: FRESH,
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
    ...over,
  };
}

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">): ChatMessage {
  return {
    id: over.id ?? `m-${over.role}-${over.createdAt ?? 1}`,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? null,
    tool: over.tool,
  };
}

function work(over: Partial<WorkLogItem> & Pick<WorkLogItem, "label">): WorkLogItem {
  return {
    id: over.id ?? `w-${over.label}`,
    runId: over.runId ?? "run-1",
    label: over.label,
    done: over.done ?? false,
    timestamp: over.timestamp ?? 50,
  };
}

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    thread: over.thread ?? thread(),
    messages: over.messages ?? [],
    workLog: over.workLog ?? [],
    workflow: over.workflow ?? null,
    usage: over.usage ?? null,
  };
}

const noopAsync = async () => {};
const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

function view(props: {
  detail?: ThreadDetail | null;
  hasProjects?: boolean;
  project?: ProjectInfo | null;
  changesOpen?: boolean;
}) {
  return (
    <ThreadView
      detail={props.detail === undefined ? detail() : props.detail}
      project={props.project === undefined ? project : props.project}
      providers={providers}
      workflows={workflows}
      hasProjects={props.hasProjects ?? true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={noopSave}
      onRemoveWorkflow={noopAsync}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      changesOpen={props.changesOpen ?? false}
      changesNonce={0}
      onCloseChanges={() => {}}
      onFetchDiff={async () => ({ files: [], patch: "", truncated: false })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
    />
  );
}

function render(props: Parameters<typeof view>[0] = {}): string {
  return renderToStaticMarkup(view(props));
}

/** Interactive open/close tags must never nest (button or anchor inside same). */
function assertNoNestedInteractive(html: string): void {
  const opens = [...html.matchAll(/<\/?button\b|<\/?a\b/g)];
  // Cardinality guard: with no interactive elements at all (a component that
  // rendered null) the loop body never runs and this asserts nothing.
  assert.ok(
    opens.length > 0,
    "expected interactive elements to check, found none",
  );
  let depth = 0;
  for (const m of opens) {
    const tag = m[0];
    if (tag.startsWith("</")) {
      // Floor at zero: a stray close tag earlier in the document would drive
      // depth negative and let a genuinely nested pair slip through later.
      depth = Math.max(0, depth - 1);
    } else {
      depth += 1;
      assert.ok(
        depth <= 1,
        `interactive element nested inside another at index ${m.index}`,
      );
    }
  }
}

afterEach(unmountAll);

describe("ThreadView empty states", () => {
  it("asks for a project when none are registered", () => {
    const html = render({ hasProjects: false, detail: null });
    assert.ok(
      html.includes("Add a project to get started"),
      `expected project empty state, got: ${html.slice(0, 200)}`,
    );
    assert.ok(html.includes("Add project"), "must offer an add-project action");
  });

  it("asks to select a thread when none is open", () => {
    const html = render({ detail: null });
    assert.ok(
      html.includes("Select a thread"),
      `expected no-thread state, got: ${html.slice(0, 200)}`,
    );
  });

  it("shows the start prompt when the open thread has no messages", () => {
    const html = render({ detail: detail({ messages: [], workLog: [] }) });
    assert.ok(
      html.includes("Start by describing what to build"),
      `expected empty-thread prompt, got: ${html.slice(0, 240)}`,
    );
  });
});

describe("ThreadView message roles", () => {
  it("renders user and assistant messages with distinct structure", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "u1", role: "user", text: "USER_ONLY_PROMPT", createdAt: 10 }),
          msg({
            id: "a1",
            role: "assistant",
            text: "ASSISTANT_ONLY_REPLY",
            createdAt: 20,
          }),
        ],
      }),
    });
    assert.ok(html.includes("USER_ONLY_PROMPT"), "user text must appear");
    assert.ok(html.includes("ASSISTANT_ONLY_REPLY"), "assistant text must appear");
    // User messages use the userBubble; assistant uses plain <p> paragraphs.
    assert.ok(
      html.includes("userBubble"),
      "user role must render through the user bubble path",
    );
    const userIdx = html.indexOf("USER_ONLY_PROMPT");
    const asstIdx = html.indexOf("ASSISTANT_ONLY_REPLY");
    assert.ok(userIdx >= 0 && asstIdx >= 0 && userIdx < asstIdx, "order must be chronological");
    // Assistant text lives in a <p>, not the user bubble.
    const asstSlice = html.slice(asstIdx - 40, asstIdx + 40);
    assert.ok(
      asstSlice.includes("<p>") || asstSlice.includes("<p "),
      `assistant text must be in a paragraph, got near: ${asstSlice}`,
    );
    assert.ok(
      !asstSlice.includes("userBubble"),
      "assistant text must not share the user bubble class",
    );
  });

  it("renders event messages as event cards, not as user bubbles", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "e1", role: "event", text: "EVENT_STATUS_LINE", createdAt: 5 }),
        ],
      }),
    });
    assert.ok(html.includes("EVENT_STATUS_LINE"));
    assert.ok(html.includes("eventTitle"), "events use the event title class");
    const near = html.slice(
      html.indexOf("EVENT_STATUS_LINE") - 60,
      html.indexOf("EVENT_STATUS_LINE") + 20,
    );
    assert.ok(!near.includes("userBubble"), "events must not look like user messages");
  });

  it("renders tool messages as tool cards with the tool name", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({
            id: "t1",
            role: "tool",
            text: "Bash: npm test",
            createdAt: 15,
            runId: "run-1",
            tool: {
              id: "tc1",
              name: "Bash",
              input: "npm test",
              output: "ok",
              done: true,
              isError: false,
            },
          }),
        ],
      }),
    });
    assert.ok(html.includes("Bash"), "tool name must show");
    assert.ok(html.includes("Bash: npm test"), "tool summary must show");
    assert.ok(html.includes("toolCard") || html.includes("toolHeader"), "tool card chrome");
  });
});

describe("ThreadView timeline wiring", () => {
  it("renders work-log steps from buildTimeline, not a raw dump of the array", () => {
    // Two work-log items same run, one user message earlier: user then Work Log card.
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "u1", role: "user", text: "PROMPT_BEFORE_RUN", createdAt: 10 }),
        ],
        workLog: [
          work({ id: "w1", runId: "run-1", label: "STEP_READ_FILES", done: true, timestamp: 50 }),
          work({ id: "w2", runId: "run-1", label: "STEP_RUN_TESTS", done: false, timestamp: 60 }),
        ],
      }),
    });
    assert.ok(html.includes("PROMPT_BEFORE_RUN"), "user prompt stays");
    assert.ok(html.includes("Work Log"), "work log card title");
    assert.ok(html.includes("STEP_READ_FILES"), "first step label");
    assert.ok(html.includes("STEP_RUN_TESTS"), "second step label");
    // Chronology: prompt text before the work-log steps (timeline order).
    const p = html.indexOf("PROMPT_BEFORE_RUN");
    const s = html.indexOf("STEP_READ_FILES");
    assert.ok(p < s, "user prompt must precede its run's work log in markup");
  });

  it("keeps two runs as separate work-log cards", () => {
    const html = render({
      detail: detail({
        messages: [],
        workLog: [
          work({ id: "a", runId: "run-a", label: "RUN_A_ONLY_STEP", timestamp: 10 }),
          work({ id: "b", runId: "run-b", label: "RUN_B_ONLY_STEP", timestamp: 20 }),
        ],
      }),
    });
    // One "Work Log" header per group always (collapsed cards still title).
    const titles = html.match(/Work Log/g) ?? [];
    assert.equal(titles.length, 2, `expected 2 work-log cards, got ${titles.length}`);
    // Only the latest run's card is open by default, so its steps show.
    assert.ok(
      html.includes("RUN_B_ONLY_STEP"),
      "latest run's steps must render in the open card",
    );
  });
});

describe("ThreadView content structure", () => {
  it("splits assistant text on blank lines into separate paragraphs", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({
            id: "a1",
            role: "assistant",
            text: "FIRST_PARA_ONLY\n\nSECOND_PARA_ONLY",
            createdAt: 1,
          }),
        ],
      }),
    });
    assert.ok(html.includes("FIRST_PARA_ONLY"));
    assert.ok(html.includes("SECOND_PARA_ONLY"));
    // Two distinct <p> blocks, not one blob with a literal blank line only.
    const first = html.indexOf("FIRST_PARA_ONLY");
    const second = html.indexOf("SECOND_PARA_ONLY");
    const between = html.slice(first, second);
    assert.ok(
      between.includes("</p>"),
      "paragraphs must be separate elements so structure survives",
    );
  });

  it("keeps long single-line assistant output intact", () => {
    const long = "LONG_LINE_" + "x".repeat(400);
    const html = render({
      detail: detail({
        messages: [msg({ id: "a1", role: "assistant", text: long, createdAt: 1 })],
      }),
    });
    assert.ok(html.includes(long), "long text must not be truncated in render");
  });

  it("renders empty assistant text without crashing the pane", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "u1", role: "user", text: "hi", createdAt: 1 }),
          msg({ id: "a1", role: "assistant", text: "", createdAt: 2 }),
        ],
      }),
    });
    assert.ok(html.includes("hi"), "user message still present");
    assert.ok(html.includes("fix the centre pane"), "header title still present");
  });
});

describe("ThreadView interactive structure", () => {
  it("has no nested button or anchor elements", () => {
    const html = render({
      detail: detail({
        messages: [
          msg({ id: "u1", role: "user", text: "go", createdAt: 1 }),
          msg({
            id: "t1",
            role: "tool",
            text: "Read: foo.ts",
            createdAt: 2,
            runId: "run-1",
            tool: {
              id: "tc1",
              name: "Read",
              input: "foo.ts",
              output: "export {}",
              done: true,
              isError: false,
            },
          }),
        ],
        workLog: [work({ label: "Reading files", done: true, timestamp: 2 })],
        thread: thread({ status: "working", runStartedAt: 1 }),
      }),
    });
    assertNoNestedInteractive(html);
  });

  it("shows Stop while the thread is working", () => {
    const html = render({
      detail: detail({
        thread: thread({ status: "working", runStartedAt: Date.now() }),
        messages: [msg({ id: "u1", role: "user", text: "work", createdAt: 1 })],
      }),
    });
    assert.ok(html.includes("Stop"), "working strip must expose Stop");
    assert.ok(
      html.includes("working"),
      "status copy must indicate work in progress",
    );
  });
});

describe("ThreadView mounted interactions", () => {
  it("expands a tool card on click to show tool input", async () => {
    const m = await mount(
      view({
        detail: detail({
          messages: [
            msg({
              id: "t1",
              role: "tool",
              text: "Bash: echo hi",
              createdAt: 1,
              runId: "run-1",
              tool: {
                id: "tc1",
                name: "Bash",
                input: "TOOL_INPUT_SECRET_PAYLOAD",
                output: null,
                done: false,
                isError: false,
              },
            }),
          ],
          // No work log for this run, so autoExpand stays false (latestRunningToolId
          // requires a work-log group). Click must open it.
          workLog: [],
        }),
      }),
    );
    assert.ok(
      !m.text().includes("TOOL_INPUT_SECRET_PAYLOAD"),
      "collapsed tool body must hide input",
    );
    // Prefer the tool header class (CSS modules stub to the key name). Avoid
    // grabbing Composer/menu buttons that also use aria-expanded.
    const header =
      m.query("button.toolHeader") ??
      m.byText("Bash: echo hi");
    assert.ok(header, "tool header is a button");
    await m.click(header);
    assert.ok(
      m.text().includes("TOOL_INPUT_SECRET_PAYLOAD"),
      `expanded tool body must show input, got: ${m.text().slice(0, 200)}`,
    );
    m.unmount();
  });
});
