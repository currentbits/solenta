/**
 * Issue #1794: dragging a Files-pane row onto the composer inserts an
 * `@path` mention (the same text acceptMention would) instead of attaching
 * the file. The custom MENTION_PATH_MIME payload is what tells it apart
 * from an OS file drop, which composerAttachments.test.tsx already covers.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerFilesPaneDrop.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount, type Mounted } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import { MENTION_PATH_MIME } from "../src/dropFiles";
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

function mountComposer() {
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
      onSend={() => {}}
      onBuild={() => {}}
      onListFiles={async () => []}
    />,
  );
}

function textarea(m: Mounted): HTMLTextAreaElement {
  const el = m.container.querySelector("textarea");
  assert.ok(el, "textarea present");
  return el as HTMLTextAreaElement;
}

async function caretToEnd(m: Mounted): Promise<void> {
  const el = textarea(m);
  await inAct(() => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
}

async function dropMentionPath(el: Element | null, path: string) {
  assert.ok(el, "drop target must exist");
  const data: Record<string, string> = {
    [MENTION_PATH_MIME]: path,
    "text/plain": path,
  };
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: {
      types: [MENTION_PATH_MIME, "text/plain"],
      getData: (type: string) => data[type] ?? "",
      files: [],
      items: [],
      dropEffect: "none",
    },
  });
  await inAct(() => {
    el!.dispatchEvent(ev);
  });
}

describe("Composer drop from the Files pane (#1794)", () => {
  it("inserts an @mention at the caret for a dropped file", async () => {
    const m = await mountComposer();
    await caretToEnd(m);
    const el = textarea(m);
    el.value = "look at ";
    await caretToEnd(m);
    await dropMentionPath(m.query("textarea"), "src/App.tsx");
    assert.equal(el.value, "look at @src/App.tsx ");
  });

  it("inserts a folder mention with its trailing slash kept", async () => {
    const m = await mountComposer();
    await caretToEnd(m);
    await dropMentionPath(m.query("textarea"), "src/components/");
    assert.equal(textarea(m).value, "@src/components/ ");
  });

  it("does not add an attachment chip for a mention-path drop", async () => {
    const m = await mountComposer();
    await caretToEnd(m);
    await dropMentionPath(m.query("textarea"), "src/App.tsx");
    assert.equal(m.query("[data-attachment-kind]"), null);
  });
});
