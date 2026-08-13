/**
 * Sidebar "New worktree thread" creation menu (T3-style worktree threads).
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom";
import { Sidebar } from "../src/components/Sidebar";
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
};

const remoteProject: ProjectInfo = {
  id: "p2",
  slug: "acme/remote",
  name: "remote",
  path: "/srv/remote",
  remoteHost: "example.com",
  remotePath: "/srv/remote",
};

const providers: ProviderInfo[] = [
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

const FRESH = Date.now();

const thread: ThreadInfo = {
  id: "t1",
  projectId: "p1",
  title: "existing",
  branch: null,
  prNumber: null,
  prUrl: null,
  status: "idle",
  createdAt: FRESH,
  updatedAt: FRESH,
  runStartedAt: null,
  archived: false,
  settledOverride: null,
  settledAt: null,
  pinnedAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  lastVisitedAt: FRESH,
  prState: null,
  provider: "claude",
  model: null,
  sessionId: null,
  permissionMode: "default",
  reasoningEffort: null,
  worktreePath: null,
  handoffFrom: null,
};

function mountSidebar(
  projects: ProjectInfo[],
  onCreateThread: (projectId?: string, opts?: { worktree?: boolean }) => void,
) {
  return mount(
    <Sidebar
      appName="Solenta"
      searchPlaceholder="Search threads..."
      projectsHeader="All projects"
      projects={projects}
      threads={[thread]}
      providers={providers}
      activeThreadId={null}
      onSelectThread={() => {}}
      onCreateThread={onCreateThread}
      onAddProject={() => {}}
      searchThreads={async () => []}
    />,
  );
}

describe("Sidebar worktree thread creation", () => {
  it("plain button creates a local thread without options", async () => {
    const calls: Array<[string | undefined, { worktree?: boolean } | undefined]> =
      [];
    const m = await mountSidebar([project], (pid, opts) => {
      calls.push([pid, opts]);
    });

    const btn = m.query(".groupNewThread");
    assert.ok(btn, "New thread button renders");
    await m.click(btn);
    assert.deepEqual(calls, [["p1", undefined]]);
  });

  it("caret opens the menu and creates a worktree thread", async () => {
    const calls: Array<[string | undefined, { worktree?: boolean } | undefined]> =
      [];
    const m = await mountSidebar([project], (pid, opts) => {
      calls.push([pid, opts]);
    });

    const caret = m.query('[data-create-menu-btn="p1"]');
    assert.ok(caret, "caret renders for a local project");
    assert.equal(m.query('[data-create-menu="p1"]'), null);

    await m.click(caret);
    const item = m.query('[data-create-worktree-thread="p1"]');
    assert.ok(item, "menu offers the worktree variant");

    await m.click(item);
    assert.deepEqual(calls, [["p1", { worktree: true }]]);
    assert.equal(
      m.query('[data-create-menu="p1"]'),
      null,
      "menu closes after selection",
    );
  });

  it("hides the caret for remote projects (worktrees are local-only)", async () => {
    const m = await mountSidebar([remoteProject], () => {});
    assert.equal(m.query('[data-create-menu-btn="p2"]'), null);
    assert.ok(m.query(".groupNewThread"), "plain button still renders");
  });
});
