/**
 * Issue #478: Esc / Ctrl+C stop a live turn; idle double-Esc rewinds.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerStop.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { inAct, mount, unmountAll, type Mounted } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import { ThreadView } from "../src/components/ThreadView";
import {
  project,
  thread,
  detail as baseDetail,
} from "./support/fakeCoder.ts";
import type {
  ChatMessage,
  ProviderInfo,
  ThreadDetail,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";
import type { SlashAction } from "../src/slashCommands";

const PROVIDERS: ProviderInfo[] = [
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

function mountComposer(
  over: {
    busy?: boolean;
    onStopRun?: () => void;
    onSlashAction?: (action: SlashAction) => void;
    onListFiles?: (query: string) => Promise<string[]>;
  } = {},
) {
  return mount(
    <Composer
      threadId="t1"
      branch="agentmux/abc"
      permissionMode="default"
      onPermissionModeChange={() => {}}
      provider="claude"
      model={null}
      reasoningEffort={null}
      providers={PROVIDERS}
      workflows={[]}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSaveWorkflow={async (t) => ({
        id: "saved",
        name: t.name,
        builtin: false,
        phases: t.phases,
      })}
      onRemoveWorkflow={async () => {}}
      sessionId={null}
      hasWorktree={true}
      busy={over.busy}
      onSend={() => {}}
      onBuild={() => {}}
      onSlashAction={over.onSlashAction}
      onStopRun={over.onStopRun}
      onListFiles={over.onListFiles}
    />,
  );
}

function textarea(m: Mounted): HTMLTextAreaElement {
  const el = m.container.querySelector("textarea");
  assert.ok(el, "textarea present");
  return el as HTMLTextAreaElement;
}

function commandList(m: Mounted): Element | null {
  return m.container.querySelector('[role="listbox"][aria-label="Commands"]');
}

afterEach(unmountAll);

describe("Composer stop keys (#478)", () => {
  it("working + Esc calls stopRun and keeps the draft", async () => {
    const stops: number[] = [];
    const m = await mountComposer({
      busy: true,
      onStopRun: () => {
        stops.push(1);
      },
    });
    const el = textarea(m);
    await m.type(el, "leave this");
    await m.press(el, "Escape");
    assert.deepEqual(stops, [1], "Esc must stop the live turn");
    assert.equal(el.value, "leave this", "draft stays");
    m.unmount();
  });

  it("idle + Esc does not stop", async () => {
    const stops: number[] = [];
    const m = await mountComposer({
      onStopRun: () => {
        stops.push(1);
      },
    });
    await m.press(textarea(m), "Escape");
    assert.deepEqual(stops, [], "idle Esc must not stop");
    m.unmount();
  });

  it("menu open + Esc closes the menu only", async () => {
    const stops: number[] = [];
    const m = await mountComposer({
      busy: true,
      onStopRun: () => {
        stops.push(1);
      },
    });
    const el = textarea(m);
    await m.type(el, "/");
    await inAct(() => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.dispatchEvent(new Event("select", { bubbles: true }));
    });
    assert.ok(commandList(m), "command menu open");
    await m.press(el, "Escape");
    assert.equal(commandList(m), null, "menu closed");
    assert.deepEqual(stops, [], "Esc on an open menu must not stop");
    assert.equal(el.value, "/", "token stays");
    m.unmount();
  });

  it("working + Ctrl+C on an empty composer stops", async () => {
    const stops: number[] = [];
    const m = await mountComposer({
      busy: true,
      onStopRun: () => {
        stops.push(1);
      },
    });
    await m.press(textarea(m), "c", { ctrlKey: true });
    assert.deepEqual(stops, [1], "Ctrl+C with no selection stops");
    m.unmount();
  });

  it("working + Ctrl+C with a selected draft does not stop", async () => {
    const stops: number[] = [];
    const m = await mountComposer({
      busy: true,
      onStopRun: () => {
        stops.push(1);
      },
    });
    const el = textarea(m);
    await m.type(el, "copy me");
    await inAct(() => {
      el.focus();
      el.setSelectionRange(0, el.value.length);
    });
    await m.press(el, "c", { ctrlKey: true });
    assert.deepEqual(stops, [], "selected draft keeps Ctrl+C as copy");
    assert.equal(el.value, "copy me");
    m.unmount();
  });

  it("idle + double Esc rewinds; a single Esc does not", async () => {
    const actions: SlashAction[] = [];
    const m = await mountComposer({
      onSlashAction: (action) => {
        actions.push(action);
      },
    });
    const el = textarea(m);
    await m.press(el, "Escape");
    assert.deepEqual(actions, [], "one Esc is not rewind");
    await m.press(el, "Escape");
    assert.deepEqual(actions, ["rewind"], "double Esc rewinds when idle");
    m.unmount();
  });

  it("working + Esc does not rewind", async () => {
    const actions: SlashAction[] = [];
    const stops: number[] = [];
    const m = await mountComposer({
      busy: true,
      onStopRun: () => {
        stops.push(1);
      },
      onSlashAction: (action) => {
        actions.push(action);
      },
    });
    const el = textarea(m);
    await m.press(el, "Escape");
    await m.press(el, "Escape");
    assert.deepEqual(stops, [1, 1], "each Esc stops while working");
    assert.deepEqual(actions, [], "working Esc is never rewind");
    m.unmount();
  });

  it("working + Esc still stops when focus is off the textarea", async () => {
    const stops: number[] = [];
    const m = await mountComposer({
      busy: true,
      onStopRun: () => {
        stops.push(1);
      },
    });
    await inAct(() => {
      textarea(m).blur();
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.deepEqual(stops, [1], "document Esc stops a live turn");
    m.unmount();
  });
});

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

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return baseDetail({
    thread: thread({
      title: "stop keys",
      branch: "coder/stop-abc",
      worktreePath: "/tmp/wt",
    }),
    messages: [
      msg({ id: "u1", role: "user", text: "do the thing", createdAt: 1 }),
      msg({ id: "a1", role: "assistant", text: "done", createdAt: 2 }),
    ],
    ...over,
  });
}

const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

describe("ThreadView stop keys (#478)", () => {
  it("working + Esc calls onStopRun", async () => {
    const stops: number[] = [];
    const m = await mount(
      <ThreadView
        detail={detail({
          thread: thread({
            title: "stop keys",
            branch: "coder/stop-abc",
            worktreePath: "/tmp/wt",
            status: "working",
          }),
        })}
        project={project()}
        providers={PROVIDERS}
        workflows={[]}
        hasProjects={true}
        onAddProject={() => {}}
        onStartRun={() => {}}
        onStartWorkflow={() => {}}
        onSaveWorkflow={noopSave}
        onRemoveWorkflow={async () => {}}
        onStopRun={() => {
          stops.push(1);
        }}
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
      />,
    );
    await m.press(textarea(m), "Escape");
    assert.deepEqual(stops, [1], "working Esc reaches ThreadView onStopRun");
    m.unmount();
  });

  it("idle + double Esc opens the rewind confirm", async () => {
    const m = await mount(
      <ThreadView
        detail={detail()}
        project={project()}
        providers={PROVIDERS}
        workflows={[]}
        hasProjects={true}
        onAddProject={() => {}}
        onStartRun={() => {}}
        onRewindAndResubmit={async () => {}}
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
      />,
    );
    const el = textarea(m);
    await m.press(el, "Escape");
    assert.equal(m.query("[data-rewind-confirm]"), null, "one Esc is not rewind");
    await m.press(el, "Escape");
    assert.ok(
      m.query("[data-rewind-confirm]"),
      "double Esc opens last-turn rewind",
    );
    m.unmount();
  });
});
