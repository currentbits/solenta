/**
 * Issue #1781: PR pill and copy-branch action on the worktree toolbar
 * (WorktreeControl's standalone toolbar variant, used in isolation here the
 * same way test/worktreeConflict.test.tsx exercises it; the live app's
 * "Thread details" card uses the rows variant instead, covered by
 * test/threadHeader.test.tsx).
 *
 * Run: npm run test:renderer -- test/worktreeControl.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { WorktreeControl } from "../src/components/WorktreeControl";
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

function chrome(opts: { thread?: ThreadInfo | null; project?: ProjectInfo }) {
  return (
    <WorktreeControl
      thread={opts.thread === undefined ? thread() : opts.thread}
      project={opts.project ?? project}
      isWorking={false}
      onSetupWorktree={async () => {}}
      onMergeWorktree={async () => {}}
      onRemoveWorktree={async () => {}}
    />
  );
}

describe("WorktreeControl PR pill and copy-branch (#1781)", () => {
  it("shows the PR pill next to the branch when the thread has a linked PR", async () => {
    const m = await mount(
      chrome({
        thread: thread({
          prNumber: 9,
          prUrl: "https://github.com/acme/repo/pull/9",
          prState: "MERGED",
        }),
      }),
    );
    const pill = m.query("[data-pr-pill]");
    assert.ok(pill, "PR pill must be present");
    assert.equal(pill!.getAttribute("data-pr-state"), "merged");
    assert.equal(pill!.getAttribute("href"), "https://github.com/acme/repo/pull/9");
    assert.match(pill!.textContent ?? "", /#9/);
    m.unmount();
  });

  it("hides the PR pill without a linked PR", async () => {
    const m = await mount(chrome({}));
    assert.equal(m.query("[data-pr-pill]"), null);
    m.unmount();
  });

  it("copies the branch name from the always-visible button next to the branch", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => { copied.push(text); } },
      configurable: true,
    });
    const m = await mount(chrome({}));
    const btn = m.query("[data-copy-branch]") as HTMLButtonElement | null;
    assert.ok(btn, "copy-branch button must be present next to the branch");
    await m.click(btn as HTMLElement);
    await m.flush();
    assert.deepEqual(copied, ["coder/ship-it"]);
    assert.equal(btn!.textContent, "Copied");
    m.unmount();
  });

  it("offers Copy branch name in the branch's context menu, and flashes feedback there too", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => { copied.push(text); } },
      configurable: true,
    });
    const m = await mount(chrome({}));
    await m.click(m.query("[data-worktree-menu]"));
    const item = m.query("[data-copy-branch-menu]");
    assert.ok(item, "Copy branch name menu item must be present");
    assert.equal(item!.textContent, "Copy branch name");
    await m.click(item as HTMLElement);
    await m.flush();
    assert.deepEqual(copied, ["coder/ship-it"]);
    // Menu closes after the click, same as the existing Copy path item.
    assert.equal(m.query("[data-copy-branch-menu]"), null);
    m.unmount();
  });

  it("hides both branch affordances when the thread has no branch yet", async () => {
    const m = await mount(chrome({ thread: thread({ branch: null }) }));
    assert.equal(m.query("[data-copy-branch]"), null);
    await m.click(m.query("[data-worktree-menu]"));
    assert.equal(m.query("[data-copy-branch-menu]"), null);
    m.unmount();
  });
});
