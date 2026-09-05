/**
 * `/` palette verbs that live on ThreadView (issue #472): /context opens the
 * context ring, /usage opens provider quotas, fork/new/clear call the parent,
 * rewind opens the last-turn confirm. Composer-only verbs are covered in
 * composerCommands.test.tsx.
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
import type { ProviderUsage } from "../src/providerUsage.ts";

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

const QUOTAS: ProviderUsage[] = [
  {
    provider: "claude",
    status: "ok",
    windows: [
      {
        label: "5 hours",
        usedPercent: 37,
        resetsAt: Date.now() + 60 * 60 * 1000,
        windowSeconds: 5 * 60 * 60,
      },
      {
        label: "Weekly",
        usedPercent: 12,
        resetsAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
        windowSeconds: 7 * 24 * 60 * 60,
      },
    ],
    fetchedAt: Date.now(),
  },
  {
    provider: "grok",
    status: "unavailable",
    windows: [],
    fetchedAt: null,
    message: "This CLI does not report account limits",
  },
];

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
    onViewChanges?: () => void;
    loadProviderLimits?: () => Promise<ProviderUsage[]>;
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
      onViewChanges={over.onViewChanges}
      onFetchDiff={async () => ({ files: [], patch: "", truncated: false })}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
      onFork={over.onFork}
      onNewThread={over.onNewThread}
      onSettleThread={over.onSettleThread}
      loadProviderLimits={over.loadProviderLimits ?? (async () => QUOTAS)}
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
  it("/context pins the context breakdown open", async () => {
    const m = await mountView();
    assert.equal(m.query("[data-context-popover]"), null);
    await acceptSlash(m, "/context");
    assert.ok(
      m.query("[data-context-popover]"),
      "context breakdown opened",
    );
    assert.equal(m.query("[data-provider-quota]"), null);
    assert.equal(textarea(m).value, "", "token cleared");
  });

  it("/usage opens provider quotas and does not open the context ring", async () => {
    const m = await mountView();
    await acceptSlash(m, "/usage");
    assert.equal(m.query("[data-context-popover]"), null);
    const dialog = m.query("[data-provider-quota]");
    assert.ok(dialog, "quota dialog opened");
    await m.flush();
    const text = m.text();
    assert.match(text, /37% used/);
    assert.match(text, /12% used/);
    assert.match(text, /5 hours/);
    assert.match(text, /Weekly/);
    assert.match(text, /unavailable/i);
    assert.equal(
      m.query('[data-provider-quota-row="grok"]')?.textContent?.includes("0%"),
      false,
      "unavailable grok is not 0%",
    );
    assert.equal(textarea(m).value, "", "token cleared");
  });

  it("/usage opens quotas even when the thread has no context ring", async () => {
    const m = await mountView({
      detail: detail({ usage: null, messages: [] }),
    });
    assert.equal(m.query("[data-context-ring]"), null);
    await acceptSlash(m, "/usage");
    assert.ok(m.query("[data-provider-quota]"), "quota dialog without a ring");
    assert.equal(m.query("[data-context-popover]"), null);
    await m.flush();
    assert.match(m.text(), /37% used/);
  });

  it("/usage Escape closes the quota dialog", async () => {
    const m = await mountView();
    await acceptSlash(m, "/usage");
    assert.ok(m.query("[data-provider-quota]"));
    await inAct(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    assert.equal(m.query("[data-provider-quota]"), null);
  });

  it("/usage moves focus out of the composer; Tab stays inside; Escape restores", async () => {
    const m = await mountView();
    const composer = textarea(m);
    await acceptSlash(m, "/usage");
    await m.flush();
    const dialog = m.query("[data-provider-quota-dialog]") as HTMLElement | null;
    assert.ok(dialog, "quota dialog");
    assert.ok(
      dialog.contains(document.activeElement),
      "focus left the composer for the dialog",
    );
    assert.notEqual(document.activeElement, composer);

    await m.pressFocused("Tab");
    const first = document.activeElement as HTMLElement;
    assert.ok(dialog.contains(first), "Tab stays inside");
    assert.equal(first.tagName, "BUTTON");

    await m.pressFocused("Tab");
    const second = document.activeElement as HTMLElement;
    assert.ok(dialog.contains(second), "second Tab stays inside");
    assert.notEqual(second, first);

    await m.pressFocused("Tab");
    assert.equal(document.activeElement, first, "Tab wraps inside the dialog");

    await m.pressFocused("Escape");
    assert.equal(m.query("[data-provider-quota]"), null);
    assert.equal(document.activeElement, composer, "Escape restores composer focus");
  });

  it("/compact forks to fresh context instead of opening usage", async () => {
    const forks: number[] = [];
    const m = await mountView({ onFork: () => forks.push(1) });
    await acceptSlash(m, "/compact");
    assert.deepEqual(forks, [1]);
    assert.equal(m.query("[data-context-popover]"), null);
    assert.equal(textarea(m).value, "");
  });

  it("warn context offers a one-click fresh-context fork", async () => {
    const forks: number[] = [];
    const warned = detail({
      usage: { ...USAGE, contextTokens: 180_000 },
    });
    const m = await mountView({
      detail: warned,
      onFork: () => forks.push(1),
    });
    await acceptSlash(m, "/context");
    const action = m.query("[data-context-fork]");
    assert.ok(action);
    await m.click(action as HTMLElement);
    assert.deepEqual(forks, [1]);
    assert.equal(m.query("[data-context-popover]"), null);
  });

  it("restores ring focus before a keyboard-focused warning action forks", async () => {
    let focusAtFork: Element | null = null;
    const warned = detail({
      usage: { ...USAGE, contextTokens: 180_000 },
    });
    const m = await mountView({
      detail: warned,
      onFork: () => {
        focusAtFork = document.activeElement;
      },
    });
    await acceptSlash(m, "/context");
    const ring = m.query("[data-context-ring]") as HTMLButtonElement | null;
    const action = m.query("[data-context-fork]") as HTMLButtonElement | null;
    assert.ok(ring);
    assert.ok(action);

    await inAct(() => action.focus());
    assert.equal(document.activeElement, action);
    // Browsers translate Enter/Space on a focused button into this click.
    await m.click(action);

    assert.equal(
      focusAtFork === ring,
      true,
      "fork callback observes restored trigger focus",
    );
    assert.equal(document.activeElement === ring, true);
    assert.equal(m.query("[data-context-popover]"), null);
  });

  it("does not offer context fork below warn or while working", async () => {
    const below = await mountView({
      detail: detail({ usage: USAGE }),
      onFork: () => {},
    });
    await acceptSlash(below, "/context");
    assert.equal(below.query("[data-context-fork]"), null);
    below.unmount();

    const noFork = await mountView({
      detail: detail({
        usage: { ...USAGE, contextTokens: 180_000 },
      }),
    });
    await acceptSlash(noFork, "/context");
    assert.equal(noFork.query("[data-context-fork]"), null);
    noFork.unmount();

    const working = await mountView({
      detail: detail({
        thread: thread({ status: "working" }),
        usage: { ...USAGE, contextTokens: 180_000 },
      }),
      onFork: () => {},
    });
    await acceptSlash(working, "/context");
    assert.equal(working.query("[data-context-fork]"), null);
  });

  it("/compact is inert while the thread is working", async () => {
    const forks: number[] = [];
    const m = await mountView({
      detail: detail({ thread: thread({ status: "working" }) }),
      onFork: () => forks.push(1),
    });
    await acceptSlash(m, "/compact");
    assert.deepEqual(forks, []);
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

  it("/review opens the Changes panel", async () => {
    let opened = 0;
    const m = await mountView({
      onViewChanges: () => {
        opened += 1;
      },
    });
    await acceptSlash(m, "/review");
    assert.equal(opened, 1);
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
