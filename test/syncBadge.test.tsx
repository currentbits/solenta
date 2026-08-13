/**
 * Sync badge in the Environment tab footer.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { GitTab } from "../src/components/AgentsPanel";
import type { GitSyncInfo, ProjectInfo, ThreadInfo } from "../src/shared/ipc";

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

function tab(opts: {
  thread?: ThreadInfo | null;
  sync?: GitSyncInfo;
  onSyncInfo?: (id: string) => Promise<GitSyncInfo>;
  onFetch?: (id: string) => Promise<void>;
}) {
  const info = opts.sync ?? { hasUpstream: false as const };
  return (
    <GitTab
      thread={opts.thread === undefined ? thread() : opts.thread}
      project={project}
      onSetupWorktree={async () => {}}
      onMergeWorktree={async () => {}}
      onRemoveWorktree={async () => {}}
      onViewChanges={() => {}}
      listCheckpoints={async () => []}
      restoreCheckpoint={async () => {}}
      listLocalServers={async () => []}
      gitSyncInfo={opts.onSyncInfo ?? (async () => info)}
      gitFetch={opts.onFetch ?? (async () => {})}
    />
  );
}

describe("sync badge", () => {
  it("hides the counts when there is no upstream", async () => {
    const m = await mount(tab({ sync: { hasUpstream: false } }));
    await m.flush();
    assert.equal(m.query("[data-sync-badge]"), null);
    assert.ok(m.query("[data-sync-btn]"), "Sync button still present");
    m.unmount();
  });

  it("shows Synced when ahead and behind are zero", async () => {
    const m = await mount(
      tab({ sync: { hasUpstream: true, ahead: 0, behind: 0 } }),
    );
    await m.flush();
    assert.equal(
      (m.query("[data-sync-badge]")?.textContent || "").trim(),
      "Synced",
    );
    m.unmount();
  });

  it("shows N ahead and N behind", async () => {
    const ahead = await mount(
      tab({ sync: { hasUpstream: true, ahead: 3, behind: 0 } }),
    );
    await ahead.flush();
    assert.equal(
      (ahead.query("[data-sync-badge]")?.textContent || "").trim(),
      "3 ahead",
    );
    ahead.unmount();

    const behind = await mount(
      tab({ sync: { hasUpstream: true, ahead: 0, behind: 2 } }),
    );
    await behind.flush();
    assert.equal(
      (behind.query("[data-sync-badge]")?.textContent || "").trim(),
      "2 behind",
    );
    behind.unmount();
  });

  it("gives the Sync button a tooltip and fetches then refreshes", async () => {
    const calls: string[] = [];
    const m = await mount(
      tab({
        sync: { hasUpstream: true, ahead: 1, behind: 0 },
        onSyncInfo: async () => {
          calls.push("syncInfo");
          return { hasUpstream: true, ahead: 0, behind: 0 };
        },
        onFetch: async () => {
          calls.push("fetch");
        },
      }),
    );
    await m.flush();
    const btn = m.query("[data-sync-btn]") as HTMLButtonElement | null;
    assert.ok(btn, "Sync button");
    assert.equal(btn!.getAttribute("title"), "Fetch from remote");
    assert.equal((btn!.textContent || "").trim(), "Sync");
    const before = calls.filter((c) => c === "syncInfo").length;
    await m.click(btn);
    await m.flush();
    assert.ok(calls.includes("fetch"), "git:fetch ran");
    assert.ok(
      calls.filter((c) => c === "syncInfo").length > before,
      "syncInfo refreshed after fetch",
    );
    assert.equal(
      (m.query("[data-sync-badge]")?.textContent || "").trim(),
      "Synced",
    );
    m.unmount();
  });

  it("hides the Sync button when no thread is selected", async () => {
    const m = await mount(tab({ thread: null, sync: { hasUpstream: false } }));
    await m.flush();
    assert.equal(m.query("[data-sync-btn]"), null);
    assert.equal(m.query("[data-sync-badge]"), null);
    m.unmount();
  });
});
