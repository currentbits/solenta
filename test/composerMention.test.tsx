/**
 * Composer @-mention popup: typing "@" opens the file list, arrows + Enter
 * accept, Escape closes. The lookup is debounced 150ms, so tests wait it out.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerMention.test.tsx
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

const FILES = ["src/App.tsx", "src/main.tsx"];

function mountComposer(onListFiles: (query: string) => Promise<string[]>) {
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
      onListFiles={onListFiles}
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

/** Wait out the 150ms mention debounce plus the lookup microtasks. */
async function waitForPopup(): Promise<void> {
  await inAct(() => new Promise((r) => setTimeout(r, 250)));
}

describe("Composer @-mention popup", () => {
  it("opens on @, accepts the highlighted file with Enter", async () => {
    const queries: string[] = [];
    const m = await mountComposer(async (q) => {
      queries.push(q);
      return FILES;
    });
    const el = textarea(m);
    await m.type(el, "check @");
    await caretToEnd(m);
    await waitForPopup();

    const list = m.container.querySelector('[role="listbox"][aria-label="Mention a file or folder"]');
    assert.ok(list, "popup open after @");
    assert.deepEqual(queries, [""]);

    // ArrowDown moves the highlight to the second row; Enter accepts it.
    await m.press(el, "ArrowDown");
    await m.press(el, "Enter");
    assert.equal(textarea(m).value, "check @src/main.tsx ");
    assert.equal(
      m.container.querySelector('[aria-label="Mention a file or folder"]'),
      null,
      "popup closed after accept",
    );
  });

  it("filters as the token grows", async () => {
    const queries: string[] = [];
    const m = await mountComposer(async (q) => {
      queries.push(q);
      return FILES.filter((f) => f.includes(q));
    });
    const el = textarea(m);
    await m.type(el, "@src/ma");
    await caretToEnd(m);
    await waitForPopup();
    assert.deepEqual(queries, ["src/ma"]);
    assert.ok(m.byText("src/main.tsx"), "matching row shown");
    assert.equal(m.byText("src/App.tsx"), null, "non-matching row filtered");
  });

  it("Escape closes the popup and keeps the text", async () => {
    const m = await mountComposer(async () => FILES);
    const el = textarea(m);
    await m.type(el, "@");
    await caretToEnd(m);
    await waitForPopup();
    assert.ok(m.container.querySelector('[aria-label="Mention a file or folder"]'));
    await m.press(el, "Escape");
    assert.equal(m.container.querySelector('[aria-label="Mention a file or folder"]'), null);
    assert.equal(textarea(m).value, "@");
  });

  it("email-shaped tokens never open the popup", async () => {
    let calls = 0;
    const m = await mountComposer(async () => {
      calls += 1;
      return FILES;
    });
    const el = textarea(m);
    await m.type(el, "mail a@b");
    await caretToEnd(m);
    await waitForPopup();
    assert.equal(calls, 0);
    assert.equal(m.container.querySelector('[aria-label="Mention a file or folder"]'), null);
  });

  it("scrolls the mention list without moving ancestor scrollports (#762)", async () => {
    // Same 240px overflow box as the slash palette. scrollIntoView would
    // walk up to .chatSlot and lift the composer.
    const files = Array.from({ length: 16 }, (_, i) => `src/file-${i}.ts`);
    const m = await mountComposer(async () => files);
    const el = textarea(m);
    await m.type(el, "@");
    await caretToEnd(m);
    await waitForPopup();
    const list = m.container.querySelector(
      '[role="listbox"][aria-label="Mention a file or folder"]',
    ) as HTMLElement | null;
    assert.ok(list, "popup open after @");

    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      value: 240,
    });
    list.querySelectorAll<HTMLElement>("button").forEach((row, i) => {
      Object.defineProperty(row, "offsetTop", {
        configurable: true,
        value: i * 40,
      });
      Object.defineProperty(row, "offsetHeight", {
        configurable: true,
        value: 40,
      });
    });

    let intoView = 0;
    const proto = (m.query('[data-highlighted="true"]') as HTMLElement)
      .constructor.prototype as { scrollIntoView: () => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function patched() {
      intoView += 1;
    };
    try {
      for (let i = 0; i < 8; i++) await m.press(el, "ArrowDown");
    } finally {
      proto.scrollIntoView = original;
    }
    assert.equal(intoView, 0, "scrollIntoView scrolls chatSlot");
    assert.ok(list.scrollTop > 0, "the mention list itself must scroll");
  });
});
