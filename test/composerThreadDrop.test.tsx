/**
 * Issue #1810: dragging a sidebar thread row onto the composer adds the same
 * thread context chip the @-mention menu's thread row would, instead of
 * treating the drop as a file (the custom THREAD_DRAG_MIME payload is what
 * tells it apart, same pattern as the Files-pane MENTION_PATH_MIME drop in
 * composerFilesPaneDrop.test.tsx).
 *
 * Run: node --import=./test/support/render.mjs --test test/composerThreadDrop.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount, type Mounted } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import { THREAD_DRAG_MIME } from "../src/dropFiles";
import type { ProviderInfo } from "../src/shared/ipc";

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
  mentionThreads?: { id: string; title: string }[],
  threadId = "t1",
) {
  return mount(
    <Composer
      threadId={threadId}
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
      onSend={() => {}}
      onBuild={() => {}}
      onListFiles={async () => []}
      mentionThreads={mentionThreads}
    />,
  );
}

function dropTarget(m: Mounted): Element {
  const el = m.container.querySelector("textarea")?.closest("div");
  assert.ok(el, "composer drop target must exist");
  return el as Element;
}

async function dropThread(el: Element, threadId: string) {
  const data: Record<string, string> = { [THREAD_DRAG_MIME]: threadId };
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: {
      types: [THREAD_DRAG_MIME],
      getData: (type: string) => data[type] ?? "",
      files: [],
      items: [],
      dropEffect: "none",
    },
  });
  await inAct(() => {
    el.dispatchEvent(ev);
  });
}

describe("Composer drop of a dragged sidebar thread (#1810)", () => {
  it("adds a thread context chip for a dropped thread", async () => {
    const m = await mountComposer([{ id: "other", title: "Other thread" }]);
    await dropThread(dropTarget(m), "other");
    const chip = m.query('[data-context-kind="thread"]');
    assert.ok(chip, "thread chip added");
    assert.ok(chip!.textContent?.includes("Other thread"));
    m.unmount();
  });

  it("ignores a drop of the composer's own thread", async () => {
    const m = await mountComposer([{ id: "t1", title: "This thread" }], "t1");
    await dropThread(dropTarget(m), "t1");
    assert.equal(m.query('[data-context-kind="thread"]'), null);
    m.unmount();
  });

  it("ignores a duplicate drop of an already-chipped thread", async () => {
    const m = await mountComposer([{ id: "other", title: "Other thread" }]);
    const target = dropTarget(m);
    await dropThread(target, "other");
    await dropThread(target, "other");
    const chips = m.queryAll('[data-context-kind="thread"]');
    assert.equal(chips.length, 1, "only one chip for the repeated thread");
    m.unmount();
  });

  it("shows the drop overlay while a dragged thread hovers the composer", async () => {
    const m = await mountComposer([{ id: "other", title: "Other thread" }]);
    const target = dropTarget(m);
    assert.equal(m.query("[data-drop-overlay]"), null, "hidden until a drag enters");
    const ev = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", {
      value: { types: [THREAD_DRAG_MIME], items: [], files: [] },
    });
    await inAct(() => target.dispatchEvent(ev));
    assert.ok(m.query("[data-drop-overlay]"), "overlay must paint");
    m.unmount();
  });
});
