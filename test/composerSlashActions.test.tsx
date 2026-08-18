/**
 * `/` palette verbs that live on ThreadView (issue #472): usage opens the
 * context ring, fork/new/clear call the parent, rewind opens the last-turn
 * confirm. Composer-only verbs are covered in composerCommands.test.tsx.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerSlashActions.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { inAct, mount, unmountAll, type Mounted } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import {
  project,
  thread,
  detail as baseDetail,
} from "./support/fakeCoder.ts";
import type {
  ChatMessage,
  ProviderInfo,
  SessionUsage,
  ThreadDetail,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

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

function msg(
  over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">,
): ChatMessage {
  return {
    id: over.id ?? `m-${over.role}-${over.createdAt ?? 1}`,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? null,
    tool: over.tool,
  };
}

const USAGE: SessionUsage = {
  model: "claude-sonnet-4",
  inputTokens: 10_000,
  outputTokens: 500,
  costUsd: 0,
  turns: 1,
  contextTokens: 12_000,
  contextWindow: 200_000,
};

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return baseDetail({
    thread: thread({
      title: "slash verbs",
      branch: "coder/slash-abc",
      worktreePath: "/tmp/wt",
    }),
    messages: [
      msg({ id: "u1", role: "user", text: "do the thing", createdAt: 1 }),
      msg({ id: "a1", role: "assistant", text: "done", createdAt: 2 }),
    ],
    usage: USAGE,
    ...over,
  });
}

const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

async function mountView(
  over: {
    detail?: ThreadDetail;
    onFork?: () => void;
    onNewThread?: () => void;
    onSettleThread?: () => void;
    onRewindAndResubmit?: (
      messageId: string,
      prompt: string,
    ) => void | Promise<void>;
  } = {},
) {
  return mount(
    <ThreadView
      detail={over.detail ?? detail()}
      project={project()}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onRewindAndResubmit={over.onRewindAndResubmit}
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
      onFork={over.onFork}
      onNewThread={over.onNewThread}
      onSettleThread={over.onSettleThread}
    />,
  );
}

function textarea(m: Mounted): HTMLTextAreaElement {
  const el = m.container.querySelector("textarea");
  assert.ok(el, "textarea present");
  return el as HTMLTextAreaElement;
}

async function acceptSlash(m: Mounted, token: string): Promise<void> {
  const el = textarea(m);
  await m.type(el, token);
  await inAct(() => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await m.press(el, "Enter");
}

afterEach(unmountAll);

describe("ThreadView / palette actions", () => {
  it("/usage pins the context breakdown open", async () => {
    const m = await mountView();
    assert.equal(m.query("[data-context-popover]"), null);
    await acceptSlash(m, "/usage");
    assert.ok(
      m.query("[data-context-popover]"),
      "context breakdown opened",
    );
    assert.equal(textarea(m).value, "", "token cleared");
  });

  it("/compact also opens the context breakdown until #318 lands", async () => {
    const m = await mountView();
    await acceptSlash(m, "/compact");
    assert.ok(
      m.query("[data-context-popover]"),
      "compact is not sent as a prompt",
    );
  });

  it("/fork calls the same handler as the Environment Fork card", async () => {
    const forks: number[] = [];
    const m = await mountView({ onFork: () => forks.push(1) });
    await acceptSlash(m, "/fork");
    assert.deepEqual(forks, [1]);
    assert.equal(textarea(m).value, "");
  });

  it("/new creates a thread", async () => {
    const created: number[] = [];
    const m = await mountView({ onNewThread: () => created.push(1) });
    await acceptSlash(m, "/new");
    assert.deepEqual(created, [1]);
  });

  it("/clear settles then starts a new draft", async () => {
    const order: string[] = [];
    const m = await mountView({
      onSettleThread: () => {
        order.push("settle");
      },
      onNewThread: () => {
        order.push("new");
      },
    });
    await acceptSlash(m, "/clear");
    await m.flush();
    assert.deepEqual(order, ["settle", "new"]);
  });

  it("/rewind opens the last-user-message confirm when there is no undo bar", async () => {
    const m = await mountView({
      onRewindAndResubmit: async () => {},
    });
    await acceptSlash(m, "/rewind");
    assert.ok(
      m.query("[data-rewind-confirm]"),
      "rewind confirm opened for the last user message",
    );
  });
});
