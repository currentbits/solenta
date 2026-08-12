/**
 * The Git tab must actually hand the selected thread to the PR card.
 *
 * A reviewer showed that `<PrCard thread={null}>` removes the only path to
 * opening a PR while the whole suite, tsc and vite build stay green. The
 * mutation is at the CALL SITE, so testing PrCard directly cannot catch it:
 * GitTab is the smallest unit that contains the wiring.
 *
 * renderToStaticMarkup runs no effects, so nothing here can reach gh.
 *
 * Run: node --import=./test/support/render.mjs --test test/prCard.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GitTab } from "../src/components/AgentsPanel";
import type { ThreadInfo, ProjectInfo, PrInfo } from "../src/shared/ipc";

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
    branch: "coder/ship-it-abc123",
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

function render(t: ThreadInfo | null): string {
  return renderToStaticMarkup(
    <GitTab
      thread={t}
      project={project}
      onSetupWorktree={async () => {}}
      onMergeWorktree={async () => {}}
      onRemoveWorktree={async () => {}}
      onViewChanges={() => {}}
      onPush={async () => ({ remote: "origin", branch: "b" })}
      createPr={async () =>
        ({
          number: 1,
          url: "https://github.com/owner/repo/pull/1",
          state: "OPEN",
          branch: "b",
          created: true,
        }) as PrInfo
      }
      prStatus={async () => null}
      listCheckpoints={async () => []}
      restoreCheckpoint={async () => {}}
      listLocalServers={async () => []}
    />,
  );
}

describe("Git tab wires the PR card to the selected thread", () => {
  it("renders the create form for a thread with a branch and no PR", () => {
    const html = render(thread());
    assert.ok(html.includes("Create PR"), "the create control must be present");
    assert.ok(
      html.includes('aria-label="PR title"'),
      "the title field must render",
    );
    assert.ok(
      !html.includes("Select a thread to open a PR"),
      "the card must receive the real thread, not null",
    );
  });

  it("shows the empty state only when no thread is selected", () => {
    const html = render(null);
    assert.ok(html.includes("Select a thread to open a PR"));
    assert.ok(!html.includes('aria-label="PR title"'));
  });

  it("cannot create without a title", () => {
    // canCreate requires a non-empty title; the button must start disabled.
    const html = render(thread());
    const idx = html.indexOf("Create PR");
    const button = html.lastIndexOf("<button", idx);
    const tag = html.slice(button, idx);
    assert.ok(
      tag.includes("disabled"),
      `Create PR must be disabled with an empty title, got: ${tag}`,
    );
  });

  it("cannot create without a branch", () => {
    // No `if (html.includes(...))` guard: a conditional assertion passes
    // silently when the button disappears, which is the exact failure this
    // test exists to catch.
    const html = render(thread({ branch: null, worktreePath: null }));
    assert.ok(html.includes("Create PR"), "the create control must still render");
    const idx = html.indexOf("Create PR");
    const button = html.lastIndexOf("<button", idx);
    assert.ok(
      html.slice(button, idx).includes("disabled"),
      "Create PR must be disabled without a branch",
    );
  });
});
