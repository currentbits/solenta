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
  defaultWorktree = false,
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
      defaultWorktree={defaultWorktree}
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

    const btn = m.query("[data-new-thread]");
    assert.ok(btn, "New thread button renders in the header");
    await m.click(btn);
    assert.deepEqual(calls, [["p1", undefined]]);
  });

  it("caret opens the menu and creates a worktree thread", async () => {
    const calls: Array<[string | undefined, { worktree?: boolean } | undefined]> =
      [];
    const m = await mountSidebar([project], (pid, opts) => {
      calls.push([pid, opts]);
    });

    const caret = m.query("[data-new-thread-caret]");
    assert.ok(caret, "caret renders in the header");
    assert.equal(m.query("[data-new-thread-menu]"), null);

    await m.click(caret);
    const item = m.query("[data-create-worktree-thread]");
    assert.ok(item, "menu offers the worktree variant");

    await m.click(item);
    assert.deepEqual(calls, [["p1", { worktree: true }]]);
    assert.equal(
      m.query("[data-new-thread-menu]"),
      null,
      "menu closes after selection",
    );
  });

  it("hides worktree-only items for remote projects", async () => {
    const m = await mountSidebar([remoteProject], () => {});
    assert.ok(m.query("[data-new-thread]"), "plain button still renders");
    const caret = m.query("[data-new-thread-caret]");
    assert.ok(caret, "caret still renders; only worktree items hide");
    await m.click(caret);
    assert.equal(m.query("[data-create-worktree-thread]"), null);
    assert.ok(m.query("[data-create-plain-thread]"));
  });

  it("offers a no-worktree opt-out when defaultWorktree is on (issue #72)", async () => {
    const calls: Array<[string | undefined, { worktree?: boolean } | undefined]> =
      [];
    const m = await mountSidebar(
      [project],
      (pid, opts) => {
        calls.push([pid, opts]);
      },
      true,
    );

    const caret = m.query("[data-new-thread-caret]");
    assert.ok(caret, "caret renders in the header");
    await m.click(caret);

    const item = m.query("[data-create-plain-thread]");
    assert.ok(item, "menu offers the no-worktree variant");

    await m.click(item);
    assert.deepEqual(calls, [["p1", { worktree: false }]]);
    assert.equal(
      m.query("[data-new-thread-menu]"),
      null,
      "menu closes after selection",
    );
  });

  it("offers the no-worktree item even when defaultWorktree is off", async () => {
    const m = await mountSidebar([project], () => {});
    const caret = m.query("[data-new-thread-caret]");
    assert.ok(caret);
    await m.click(caret);
    assert.ok(m.query("[data-create-worktree-thread]"));
    assert.ok(
      m.query("[data-create-plain-thread]"),
      "plain-thread item is always listed",
    );
  });
});
