/**
 * Sidebar unsent-draft marker (#1770).
 *
 * The composer's drafts (src/composerSession.ts) are reactive via
 * subscribeDrafts: ThreadCard shows a quiet "Unsent draft" marker in the
 * meta line without polling localStorage per row per render.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { act } from "react";
import { mount, unmountAll, type Mounted } from "./support/dom.ts";
import { ThreadCard } from "../src/components/Sidebar";
import { Composer } from "../src/components/Composer";
import { resetComposerSession, setDraftText } from "../src/composerSession.ts";
import { thread } from "./support/fakeCoder.ts";
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

afterEach(() => {
  unmountAll();
  resetComposerSession();
});

function cardFor(threadId: string) {
  return mount(
    <ThreadCard
      thread={thread({ id: threadId, title: "draft target" })}
      slug="acme/ledger"
      providers={PROVIDERS}
      active={false}
      now={Date.now()}
      onSelect={() => {}}
    />,
  );
}

function composerFor(threadId: string) {
  return mount(
    <Composer
      threadId={threadId}
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
      onSend={() => {}}
      onBuild={() => {}}
    />,
  );
}

function textarea(m: Mounted): HTMLTextAreaElement {
  const el = m.container.querySelector("textarea");
  assert.ok(el, "textarea present");
  return el as HTMLTextAreaElement;
}

describe("sidebar draft marker", () => {
  it("is absent with no draft", async () => {
    const card = await cardFor("t1");
    assert.equal(card.query("[data-card-draft]"), null);
    card.unmount();
  });

  it("appears once the composer gets real text, title Unsent draft", async () => {
    const card = await cardFor("t1");
    const composer = await composerFor("t1");
    assert.equal(card.query("[data-card-draft]"), null);

    await composer.type(textarea(composer), "half a thought");
    const marker = card.query("[data-card-draft]");
    assert.ok(marker, "marker shows once a draft has real text");
    assert.equal(marker!.getAttribute("title"), "Unsent draft");

    card.unmount();
    composer.unmount();
  });

  it("ignores whitespace-only drafts", async () => {
    const card = await cardFor("t1");
    await act(async () => setDraftText("t1", "   \n\t  "));
    assert.equal(card.query("[data-card-draft]"), null);
    card.unmount();
  });

  it("clears when the draft is emptied (e.g. sent)", async () => {
    const card = await cardFor("t1");
    const composer = await composerFor("t1");
    await composer.type(textarea(composer), "half a thought");
    assert.ok(card.query("[data-card-draft]"));

    await composer.type(textarea(composer), "");
    assert.equal(card.query("[data-card-draft]"), null, "clears once emptied");

    card.unmount();
    composer.unmount();
  });

  it("only marks the thread whose draft changed", async () => {
    const cardA = await cardFor("t1");
    const cardB = await cardFor("t2");
    await act(async () => setDraftText("t2", "only t2 has a draft"));
    assert.equal(cardA.query("[data-card-draft]"), null);
    assert.ok(cardB.query("[data-card-draft]"));
    cardA.unmount();
    cardB.unmount();
  });
});
