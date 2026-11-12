import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { inAct, mount } from "./support/dom.ts";
import { thread, providers } from "./support/sidebarFixtures.tsx";
import { ThreadCard } from "../src/components/sidebar/ThreadCard";
import {
  getDraftPreview,
  hydrateComposerSession,
  DRAFTS_STORAGE_KEY,
  keptAttachments,
  keptDrafts,
  keptPasteCards,
  pruneComposerDrafts,
  scheduleDraftSave,
  sentHistory,
  setContextChips,
  setReviewComments,
  syncListRecord,
} from "../src/composerSession";
import { makePasteCard } from "../src/pasteCards";

it("static card consumers render without drafts (server snapshot, #1770)", () => {
  keptDrafts.a = "saved thought";
  const html = renderToStaticMarkup(<ThreadCard thread={thread({ id: "a" })}
    slug="solenta" providers={providers} active={false} now={Date.now()} onSelect={() => {}} />);
  assert.doesNotMatch(html, /data-draft-badge|saved thought/);
  delete keptDrafts.a;
});

it("normalizes and bounds excerpts without changing saved text or splitting emoji", () => {
  keptDrafts.a = "  Fix\n\t the \uFFFC sidebar   ";
  assert.equal(getDraftPreview("a"), "Fix the sidebar");
  assert.equal(keptDrafts.a, "  Fix\n\t the \uFFFC sidebar   ");
  keptDrafts.a = "😀".repeat(181);
  assert.equal(getDraftPreview("a"), "😀".repeat(180) + "…");
  assert.equal(getDraftPreview("missing"), "");
});

it("summarizes attachment/context-only drafts without exposing context bodies or history", () => {
  sentHistory.a = ["private sent prompt"];
  assert.equal(getDraftPreview("a"), "");
  keptAttachments.a = [{ kind: "file", name: "secret.txt", path: "/private/secret.txt" }];
  keptPasteCards.a = [makePasteCard("private pasted body")];
  setContextChips("a", () => [{ kind: "terminal", id: "c", text: "private terminal output" }]);
  setReviewComments("a", () => [{ id: "r", path: "secret.ts", startLine: 1, endLine: 1,
    removed: false, code: "secret code", text: "private review" }]);
  assert.equal(getDraftPreview("a"), "1 attachment · 3 context items");
  keptDrafts.a = "my request";
  assert.equal(getDraftPreview("a"), "my request");
});

it("updates memoized cards from the shared store, selects the owner, and clears on prune", async () => {
  const selected: string[] = [];
  const card = (id: string, compact = false) => <ThreadCard
    thread={thread({ id })} slug="solenta" providers={providers} active={false}
    now={Date.now()} compact={compact} onSelect={(id) => selected.push(id)} />;
  const m = await mount(<>{card("a")}{card("b", true)}</>);
  assert.equal(m.query("[data-draft-badge]"), null);
  await inAct(() => { keptDrafts.a = "first\nthought"; scheduleDraftSave(); });
  const badge = m.query('[data-draft-badge="a"]')!;
  assert.ok(badge);
  assert.equal(m.query('[data-draft-badge="b"]'), null);
  const tip = m.query("[data-draft-preview]")!;
  assert.equal(tip.textContent?.trim(), "Unsent draft: first thought");
  assert.equal(badge.getAttribute("aria-describedby"), tip.id);
  await inAct(() => (badge as HTMLElement).focus());
  await m.pressFocused("Escape");
  assert.equal((tip as HTMLElement).style.display, "none");
  await m.click(badge);
  assert.deepEqual(selected, ["a"]);
  await inAct(() => { keptDrafts.a = "edited"; scheduleDraftSave(); });
  assert.match(tip.textContent!, /edited/);
  await inAct(() => syncListRecord(keptAttachments, { b: [{ kind: "file", name: "a", path: "/a" }] }));
  assert.equal(m.query('[data-draft-badge="b"]'), null, "compact cards have no meta line for the marker");
  await inAct(() => syncListRecord(keptAttachments, { a: [{ kind: "file", name: "a", path: "/a" }] }));
  await inAct(() => { keptDrafts.a = ""; scheduleDraftSave(); });
  assert.match(m.query("[data-draft-preview]")!.textContent!, /1 attachment/, "attachment-only drafts still mark the card");
  await inAct(() => pruneComposerDrafts([]));
  assert.equal(m.query("[data-draft-badge]"), null);
});

it("hydrates and clears markers without a thread-prop update", async () => {
  const m = await mount(<ThreadCard thread={thread({ id: "a" })} slug="solenta"
    providers={providers} active={false} now={Date.now()} onSelect={() => {}} />);
  await inAct(() => {
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ a: { text: "restored" } }));
    hydrateComposerSession();
  });
  assert.match(m.query("[data-draft-preview]")!.textContent!, /restored/);
  await inAct(() => { keptDrafts.a = "  "; scheduleDraftSave(); });
  assert.equal(m.query("[data-draft-badge]"), null);
});
