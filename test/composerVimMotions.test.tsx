/**
 * Composer vim motions wired through the textarea (issue #779).
 * Pref off: letters type as usual. Pref on: Esc then 0 / w / dd.
 * Cmd+Enter and @-mention must keep working.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerVimMotions.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach, beforeEach } from "node:test";
import { inAct, mount, unmountAll, type Mounted } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import { setComposerVimEnabled } from "../src/uiPrefs";
import type { ProviderInfo } from "../src/shared/ipc";

const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    supportsResume: true,
    models: ["opus"],
    modelInfo: [],
    efforts: [],
  },
];

function mountComposer(
  over: {
    onSend?: (prompt: string) => void;
    onListFiles?: (query: string) => Promise<string[]>;
  } = {},
) {
  return mount(
    <Composer
      threadId="t1"
      branch="coder/vim-motions"
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
      onSend={over.onSend ?? (() => {})}
      onBuild={() => {}}
      onListFiles={over.onListFiles}
    />,
  );
}

function textarea(m: Mounted): HTMLTextAreaElement {
  const el = m.container.querySelector("textarea");
  assert.ok(el);
  return el as HTMLTextAreaElement;
}

async function caretTo(el: HTMLTextAreaElement, pos: number): Promise<void> {
  await inAct(() => {
    el.focus();
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
}

describe("Composer vim motions (#779)", () => {
  beforeEach(() => {
    setComposerVimEnabled(false);
  });
  afterEach(() => {
    unmountAll();
    setComposerVimEnabled(false);
  });

  it("does not intercept 0 when the pref is off", async () => {
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "hello world");
    await caretTo(el, 11);
    await m.press(el, "Escape");
    await m.press(el, "0");
    assert.equal(el.selectionStart, 11, "0 is not a motion when vim is off");
    assert.equal(el.getAttribute("data-vim-mode"), null);
  });

  it("0 / w / dd apply in the textarea when the pref is on", async () => {
    setComposerVimEnabled(true);
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "hello world");
    await caretTo(el, 11);
    assert.equal(el.getAttribute("data-vim-mode"), "insert");

    await m.press(el, "Escape");
    assert.equal(el.getAttribute("data-vim-mode"), "normal");
    await m.press(el, "0");
    assert.equal(el.selectionStart, 0, "0 → start of line");

    await m.press(el, "w");
    assert.equal(el.selectionStart, 6, "w → next word");
  });

  it("dd deletes the current line when the pref is on", async () => {
    setComposerVimEnabled(true);
    const m = await mountComposer();
    const el = textarea(m);
    await m.type(el, "hello\nworld");
    await caretTo(el, 0);
    await m.press(el, "Escape");
    await m.press(el, "d");
    await m.press(el, "d");
    assert.equal(el.value, "world");
  });

  it("Cmd+Enter still sends when vim is on", async () => {
    setComposerVimEnabled(true);
    const sent: string[] = [];
    const m = await mountComposer({
      onSend: (prompt) => {
        sent.push(prompt);
      },
    });
    const el = textarea(m);
    await m.type(el, "ship it");
    await m.press(el, "Enter", { metaKey: true });
    assert.deepEqual(sent, ["ship it"]);
  });

  it("@-mention still opens when vim is on", async () => {
    setComposerVimEnabled(true);
    const m = await mountComposer({
      onListFiles: async () => ["src/App.tsx"],
    });
    const el = textarea(m);
    await m.type(el, "@");
    await caretTo(el, 1);
    await inAct(() => new Promise((r) => setTimeout(r, 250)));
    const list = m.container.querySelector(
      '[role="listbox"][aria-label="Mention a file or folder"]',
    );
    assert.ok(list, "mention popup opens in insert mode");
  });
});
