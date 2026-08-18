/**
 * Composer `/` command popup: typing `/` at the start of the prompt lists
 * /handoff, /advisor, /committee; Enter inserts the selected command.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerCommands.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAct, mount, type Mounted } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
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

function mountComposer(onSend: (prompt: string) => void = () => {}) {
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
      onSend={onSend}
      onBuild={() => {}}
    />,
  );
}

function textarea(m: Mounted): HTMLTextAreaElement {
  const el = m.container.querySelector("textarea");
  assert.ok(el, "textarea present");
  return el as HTMLTextAreaElement;
}

/** Put the caret at the end and tell React the selection changed. */
async function caretToEnd(m: Mounted): Promise<void> {
  const el = textarea(m);
  await inAct(() => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
}

function commandList(m: Mounted): Element | null {
  return m.container.querySelector('[role="listbox"][aria-label="Commands"]');
}

describe("Composer / command popup", () => {
  it("opens on / with all three commands", async () => {
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "/");
    await caretToEnd(m);

    assert.ok(commandList(m), "popup open after /");
    assert.ok(m.byText("/handoff"), "/handoff listed");
    assert.ok(m.byText("/advisor"), "/advisor listed");
    assert.ok(m.byText("/committee"), "/committee listed");
    assert.ok(
      m.byText("Plan here, implement on a fresh model"),
      "handoff hint shown",
    );
    assert.ok(
      m.byText("One second opinion on a contrasting model"),
      "advisor hint shown",
    );
    assert.ok(
      m.byText("Two contrasting models converge on a root cause"),
      "committee hint shown",
    );
  });

  it("filters to /committee when the prefix is /co", async () => {
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "/co");
    await caretToEnd(m);

    assert.ok(commandList(m), "popup open after /co");
    assert.ok(m.byText("/committee"), "committee matches /co");
    assert.equal(m.byText("/handoff"), null, "handoff filtered out");
    assert.equal(m.byText("/advisor"), null, "advisor filtered out");
  });

  it("Enter inserts the selected command and does not send", async () => {
    const sends: string[] = [];
    const m = await mountComposer((prompt) => {
      sends.push(prompt);
    });
    const el = textarea(m);
    await m.type(el, "/co");
    await caretToEnd(m);
    assert.ok(commandList(m), "popup open before Enter");

    await m.press(el, "Enter");
    assert.equal(textarea(m).value, "/committee ");
    assert.ok(!commandList(m), "popup closed after accept");
    assert.deepEqual(sends, [], "Enter did not send while the popup was open");
  });

  it("Escape closes the popup and keeps the text", async () => {
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "/co");
    await caretToEnd(m);
    assert.ok(commandList(m));
    await m.press(el, "Escape");
    assert.ok(!commandList(m), "popup closed after Escape");
    assert.equal(textarea(m).value, "/co");
  });

  it("does not open when / is not at the start of the text", async () => {
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "see src/foo");
    await caretToEnd(m);
    assert.equal(commandList(m), null);
    assert.equal(m.byText("/handoff"), null);
  });
});
