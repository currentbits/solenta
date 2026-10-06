/**
 * Issue #1493 B: composer drafts survive a restart.
 *
 * Run: node --import=./test/support/render.mjs --test test/composerDurability.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll, type Mounted } from "./support/dom.ts";
import { Composer } from "../src/components/Composer";
import {
  DRAFTS_SAVE_MS,
  DRAFTS_STORAGE_KEY,
  flushDraftSave,
  hydrateComposerSession,
  keptAttachments,
  keptDrafts,
  keptPasteCards,
  pruneComposerDrafts,
  resetComposerSession,
  sentHistory,
  serializeDrafts,
} from "../src/composerSession";
import { makePasteCard } from "../src/pasteCards";
import type { ProviderInfo } from "../src/shared/ipc";
import { setEnterSendsEnabled } from "../src/uiPrefs";

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
  over: { threadId?: string; sends?: string[] } = {},
) {
  return mount(
    <Composer
      threadId={over.threadId ?? "t1"}
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
      onSend={(p) => {
        over.sends?.push(p);
      }}
      onBuild={() => {}}
    />,
  );
}

function textarea(m: Mounted): HTMLTextAreaElement {
  const el = m.container.querySelector("textarea");
  assert.ok(el, "textarea present");
  return el as HTMLTextAreaElement;
}

/** What a relaunch sees: empty maps, storage left as the last session wrote it. */
function restart() {
  flushDraftSave();
  const raw = window.localStorage.getItem(DRAFTS_STORAGE_KEY);
  resetComposerSession();
  if (raw != null) window.localStorage.setItem(DRAFTS_STORAGE_KEY, raw);
  hydrateComposerSession();
}

afterEach(unmountAll);

describe("composer drafts survive restart", () => {
  it("restores typed text, attachments and paste cards after a relaunch", async () => {
    const m = await mountComposer();
    await m.type(textarea(m), "half a thought");
    keptAttachments.t1 = [{ kind: "file", path: "/repo/a.ts", name: "a.ts" }];
    keptPasteCards.t1 = [makePasteCard("x\n".repeat(20))];
    m.unmount();
    restart();
    const again = await mountComposer();
    assert.equal(textarea(again).value, "half a thought");
    assert.ok(again.container.querySelector('[data-attachment-kind="file"]'));
    assert.equal(keptPasteCards.t1?.length, 1);
  });

  it("writes on its own after the debounce, without an explicit flush", async () => {
    const m = await mountComposer();
    await m.type(textarea(m), "typed");
    assert.equal(window.localStorage.getItem(DRAFTS_STORAGE_KEY), null);
    await new Promise((r) => setTimeout(r, DRAFTS_SAVE_MS + 60));
    const saved = JSON.parse(window.localStorage.getItem(DRAFTS_STORAGE_KEY)!);
    assert.equal(saved.t1.text, "typed");
  });

  it("drops the saved draft on send", async () => {
    const sends: string[] = [];
    const m = await mountComposer({ sends });
    await m.type(textarea(m), "ship it");
    flushDraftSave();
    assert.ok(window.localStorage.getItem(DRAFTS_STORAGE_KEY));
    await m.press(textarea(m), "Enter", { metaKey: true });
    assert.deepEqual(sends, ["ship it"]);
    flushDraftSave();
    const saved = JSON.parse(window.localStorage.getItem(DRAFTS_STORAGE_KEY)!);
    assert.equal(saved.t1.text, undefined, "the sent draft is gone");
  });

  it("prunes drafts of threads that no longer exist", () => {
    keptDrafts.gone = "orphan";
    keptDrafts.live = "keep";
    keptPasteCards.gone = [makePasteCard("y".repeat(500))];
    assert.equal(pruneComposerDrafts(["live"]), 1);
    assert.deepEqual(Object.keys(keptDrafts), ["live"]);
    assert.equal(keptPasteCards.gone, undefined);
    const saved = JSON.parse(window.localStorage.getItem(DRAFTS_STORAGE_KEY)!);
    assert.deepEqual(Object.keys(saved), ["live"]);
  });

  it("over the cap drops the largest paste cards first and keeps text", () => {
    keptDrafts.t1 = "words";
    keptPasteCards.t1 = [
      makePasteCard("a".repeat(5_000)),
      makePasteCard("b".repeat(800)),
    ];
    const saved = JSON.parse(serializeDrafts(3_000));
    assert.equal(saved.t1.text, "words");
    assert.equal(saved.t1.pasteCards.length, 1);
    assert.equal(saved.t1.pasteCards[0].text[0], "b");
  });

  it("ignores a corrupt stored value", () => {
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, "{not json");
    hydrateComposerSession();
    assert.deepEqual(keptDrafts, {});
  });
});

describe("↑ recalls sent prompts", () => {
  async function sendAll(m: Mounted, prompts: string[]) {
    for (const p of prompts) {
      await m.type(textarea(m), p);
      await m.press(textarea(m), "Enter", { metaKey: true });
    }
  }

  it("↑ in an empty composer walks back, ↓ walks forward to empty", async () => {
    const sends: string[] = [];
    const m = await mountComposer({ sends });
    await sendAll(m, ["first", "second"]);
    assert.equal(textarea(m).value, "");
    await m.press(textarea(m), "ArrowUp");
    assert.equal(textarea(m).value, "second");
    await m.press(textarea(m), "ArrowUp");
    assert.equal(textarea(m).value, "first");
    await m.press(textarea(m), "ArrowUp");
    assert.equal(textarea(m).value, "first", "stops at the oldest");
    await m.press(textarea(m), "ArrowDown");
    assert.equal(textarea(m).value, "second");
    await m.press(textarea(m), "ArrowDown");
    assert.equal(textarea(m).value, "");
  });

  it("leaves ↑ alone in a non-empty draft", async () => {
    const m = await mountComposer({ sends: [] });
    await sendAll(m, ["old"]);
    await m.type(textarea(m), "line one\nline two");
    await m.press(textarea(m), "ArrowUp");
    assert.equal(textarea(m).value, "line one\nline two");
  });

  it("stops walking once the recalled text is edited", async () => {
    const m = await mountComposer({ sends: [] });
    await sendAll(m, ["a", "b"]);
    await m.press(textarea(m), "ArrowUp");
    await m.type(textarea(m), "b edited");
    await m.press(textarea(m), "ArrowUp");
    assert.equal(textarea(m).value, "b edited");
  });

  it("keeps history per thread and across a restart", async () => {
    const m = await mountComposer({ sends: [] });
    await sendAll(m, ["for t1"]);
    m.unmount();
    restart();
    assert.deepEqual(sentHistory.t1, ["for t1"]);
    const other = await mountComposer({ threadId: "t2" });
    await other.press(textarea(other), "ArrowUp");
    assert.equal(textarea(other).value, "", "t2 has no history");
    other.unmount();
    const back = await mountComposer();
    await back.press(textarea(back), "ArrowUp");
    assert.equal(textarea(back).value, "for t1");
  });

  it("leaves ↑ to the slash popup while it is open", async () => {
    const m = await mountComposer({ sends: [] });
    await sendAll(m, ["old"]);
    await m.type(textarea(m), "/");
    assert.ok(m.container.querySelector('[role="listbox"][aria-label="Commands"]'));
    await m.press(textarea(m), "ArrowUp");
    assert.equal(textarea(m).value, "/");
  });
});

describe("send-key preference", () => {
  afterEach(() => setEnterSendsEnabled(false));

  it("default: bare Enter is a newline, ⌘Enter sends", async () => {
    const sends: string[] = [];
    const m = await mountComposer({ sends });
    await m.type(textarea(m), "hello");
    await m.press(textarea(m), "Enter");
    assert.deepEqual(sends, []);
    await m.press(textarea(m), "Enter", { metaKey: true });
    assert.deepEqual(sends, ["hello"]);
  });

  it("Enter sends: bare Enter sends, ⇧Enter does not, ⌘Enter still does", async () => {
    setEnterSendsEnabled(true);
    const sends: string[] = [];
    const m = await mountComposer({ sends });
    await m.type(textarea(m), "one");
    await m.press(textarea(m), "Enter", { shiftKey: true });
    assert.deepEqual(sends, [], "⇧Enter is the newline");
    await m.press(textarea(m), "Enter");
    assert.deepEqual(sends, ["one"]);
    await m.type(textarea(m), "two");
    await m.press(textarea(m), "Enter", { ctrlKey: true });
    assert.deepEqual(sends, ["one", "two"]);
    m.unmount();
  });
});
