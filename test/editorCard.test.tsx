/**
 * Editor card on the Environment tab: Finder / editor buttons.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { EditorCard, GitTab } from "../src/components/AgentsPanel";
import type { ProjectInfo, ThreadInfo } from "../src/shared/ipc";

const project = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
} as ProjectInfo;

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "ship it",
    branch: "coder/ship-it",
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: 1,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: "/tmp/wt",
    ...over,
  } as ThreadInfo;
}

describe("EditorCard", () => {
  it("disables both buttons and shows a hint when no thread is selected", async () => {
    const m = await mount(
      <EditorCard hasThread={false} onReveal={() => {}} onOpen={() => {}} />,
    );
    await m.flush();
    assert.ok(m.query("[data-editor]"), "card is present");
    assert.ok(m.query("[data-editor-hint]"), "hint is present");
    assert.match(
      (m.query("[data-editor-hint]")?.textContent || "").trim(),
      /Select a thread/,
    );
    const reveal = m.query("[data-editor-reveal]") as HTMLButtonElement | null;
    const open = m.query("[data-editor-open]") as HTMLButtonElement | null;
    assert.ok(reveal, "Finder button");
    assert.ok(open, "Editor button");
    assert.equal(reveal!.disabled, true);
    assert.equal(open!.disabled, true);
    m.unmount();
  });

  it("enables both buttons for a selected thread and fires the handlers", async () => {
    let revealed = 0;
    let opened = 0;
    const m = await mount(
      <EditorCard
        hasThread
        onReveal={() => {
          revealed += 1;
        }}
        onOpen={() => {
          opened += 1;
        }}
      />,
    );
    await m.flush();
    assert.equal(m.query("[data-editor-hint]"), null);
    const reveal = m.query("[data-editor-reveal]") as HTMLButtonElement;
    const open = m.query("[data-editor-open]") as HTMLButtonElement;
    assert.equal(reveal.disabled, false);
    assert.equal(open.disabled, false);
    assert.equal((reveal.textContent || "").trim(), "Open in Finder");
    assert.equal((open.textContent || "").trim(), "Open in Editor");
    await m.click(reveal);
    await m.click(open);
    assert.equal(revealed, 1);
    assert.equal(opened, 1);
    m.unmount();
  });
});

describe("Git tab places the Editor card after Local Servers", () => {
  it("renders the Editor card on the Environment tab", async () => {
    const m = await mount(
      <GitTab
        thread={thread()}
        project={project}
        onViewChanges={() => {}}
        listCheckpoints={async () => []}
        restoreCheckpoint={async () => {}}
        listLocalServers={async () => []}
      />,
    );
    await m.flush();
    const editor = m.query("[data-editor]");
    const servers = m.query("[data-local-servers]");
    assert.ok(editor, "Editor card present");
    assert.ok(servers, "Local Servers card present");
    assert.ok(
      Boolean(
        servers &&
          editor &&
          Boolean(
            servers.compareDocumentPosition(editor) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
      ),
      "Editor card follows Local Servers",
    );
    m.unmount();
  });
});
