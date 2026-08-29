/**
 * Composer power-ups from issue #381: paste-cards, prompt stash, reply chip,
 * folder-mention browse.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerPowerUps.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach, beforeEach } from "node:test";
import { inAct, mount, unmountAll, type Mounted } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import { setPasteCardsEnabled } from "../src/uiPrefs";
import type { ProviderInfo } from "../src/shared/ipc";
import type { ReplyTarget } from "../src/replyContext";

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
    onPickMentionFolder?: () => Promise<string | null>;
    onListFiles?: (query: string) => Promise<string[]>;
    replyTo?: ReplyTarget | null;
    onClearReply?: () => void;
    provider?: string;
    model?: string | null;
  } = {},
) {
  return mount(
    <Composer
      threadId="t1"
      branch="coder/power-ups"
      permissionMode="default"
      onPermissionModeChange={() => {}}
      provider={over.provider ?? "claude"}
      model={over.model ?? null}
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
      onPickMentionFolder={over.onPickMentionFolder}
      replyTo={over.replyTo}
      onClearReply={over.onClearReply}
    />,
  );
}

function textarea(m: Mounted): HTMLTextAreaElement {
  const el = m.container.querySelector("textarea");
  assert.ok(el);
  return el as HTMLTextAreaElement;
}

async function pasteText(m: Mounted, text: string): Promise<void> {
  const el = textarea(m);
  await inAct(() => {
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: {
        items: [],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    });
    el.dispatchEvent(ev);
  });
}

describe("Composer paste-cards and stash (#381)", () => {
  beforeEach(() => {
    setPasteCardsEnabled(true);
    try {
      window.localStorage.clear();
    } catch {
      // jsdom always has localStorage
    }
  });
  afterEach(() => {
    unmountAll();
    setPasteCardsEnabled(true);
  });

  it("collapses a large paste into a labeled card and sends it as bounded context", async () => {
    const sent: string[] = [];
    const m = await mountComposer({
      onSend: (prompt) => {
        sent.push(prompt);
      },
    });
    await pasteText(m, "x".repeat(400));
    const card = m.query("[data-paste-card]");
    assert.ok(card, "paste became a card");
    assert.match(card.textContent ?? "", /Pasted/);
    assert.equal(textarea(m).value, "", "textarea stays empty");
    assert.ok(m.query("[data-paste-overflow]"), "overflow counter is up");

    await m.click(m.query('button[aria-label="Send"]'));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /<pasted-context/);
    assert.match(sent[0], /x{400}/);
  });

  it("leaves a short paste in the textarea when cards are disabled", async () => {
    setPasteCardsEnabled(false);
    const m = await mountComposer();
    await pasteText(m, "x".repeat(400));
    assert.equal(m.container.querySelector("[data-paste-card]"), null);
  });

  it("Cmd+S stashes the draft and Undo puts it back", async () => {
    const m = await mountComposer();
    await m.type(textarea(m), "keep this prompt");
    await m.press(textarea(m), "s", { metaKey: true });
    assert.equal(textarea(m).value, "", "stash clears the composer");
    const toast = m.query('[data-toast="archive"]');
    assert.match(toast.textContent ?? "", /Stashed/);
    await m.click(m.byText("Undo"));
    assert.equal(textarea(m).value, "keep this prompt");
  });

  it("wraps a reply target around the typed prompt on send", async () => {
    const sent: string[] = [];
    const replyTo: ReplyTarget = {
      messageId: "a1",
      text: "agent said folders first",
    };
    const m = await mountComposer({
      replyTo,
      onSend: (prompt) => {
        sent.push(prompt);
      },
    });
    assert.ok(m.query("[data-reply-chip]"));
    await m.type(textarea(m), "why folders?");
    await m.click(m.query('button[aria-label="Send"]'));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /<reply-context message="a1">/);
    assert.match(sent[0], /agent said folders first/);
    assert.match(sent[0], /why folders\?/);
  });

  it("Browse folder inserts a directory mention", async () => {
    let picked = 0;
    const m = await mountComposer({
      onListFiles: async () => ["src/App.tsx"],
      onPickMentionFolder: async () => {
        picked += 1;
        return "electron/";
      },
    });
    const el = textarea(m);
    await m.type(el, "@");
    await inAct(() => {
      el.setSelectionRange(1, 1);
      el.dispatchEvent(new Event("select", { bubbles: true }));
    });
    await inAct(() => new Promise((r) => setTimeout(r, 250)));
    await m.click(m.query("[data-mention-browse]"));
    assert.equal(picked, 1);
    assert.equal(textarea(m).value, "@electron/ ");
  });
});
