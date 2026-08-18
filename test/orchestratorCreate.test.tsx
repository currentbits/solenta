/**
 * Sidebar three-mode thread creation menu (orchestrator threads).
 *
 * Run: npm run test:renderer -- --test-name-pattern="thread-mode menu"
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

const baseProps = {
  appName: "Solenta",
  searchPlaceholder: "Search threads...",
  projectsHeader: "All projects",
  projects: [project],
  threads: [thread],
  providers,
  activeThreadId: null,
  onSelectThread: () => {},
  onAddProject: () => {},
  searchThreads: async () => [],
};

describe("Sidebar thread-mode menu", () => {
  it("offers all four modes and passes the chosen one through", async () => {
    const calls: Array<[string, unknown]> = [];
    const m = await mount(
      <Sidebar
        {...baseProps}
        onCreateThread={(projectId, opts) => calls.push([projectId!, opts])}
      />,
    );

    await m.click(m.query('[data-create-menu-btn="p1"]'));

    for (const attr of [
      "data-create-worktree-thread",
      "data-create-orchestrator-thread",
      "data-create-plain-thread",
      "data-create-teach-thread",
    ]) {
      assert.ok(m.query(`[${attr}="p1"]`), `menu is missing ${attr}`);
    }

    await m.click(m.query('[data-create-orchestrator-thread="p1"]'));
    assert.deepEqual(calls, [["p1", { orchestrate: true }]]);
  });

  it("New teach thread passes worktree + teach", async () => {
    const calls: Array<[string, unknown]> = [];
    const m = await mount(
      <Sidebar
        {...baseProps}
        onCreateThread={(projectId, opts) => calls.push([projectId!, opts])}
      />,
    );
    await m.click(m.query('[data-create-menu-btn="p1"]'));
    await m.click(m.query('[data-create-teach-thread="p1"]'));
    assert.deepEqual(calls, [["p1", { worktree: true, teach: true }]]);
  });

  it("hides the menu for remote projects", async () => {
    const m = await mount(
      <Sidebar
        {...baseProps}
        projects={[remoteProject]}
        threads={[]}
        onCreateThread={() => {}}
      />,
    );
    assert.equal(m.query('[data-create-menu-btn="p2"]'), null);
  });
});
