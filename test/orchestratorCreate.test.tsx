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
  it("offers all five modes and passes the chosen one through", async () => {
    const calls: Array<[string, unknown]> = [];
    const m = await mount(
      <Sidebar
        {...baseProps}
        onCreateThread={(projectId, opts) => calls.push([projectId!, opts])}
      />,
    );

    await m.click(m.query("[data-new-thread-caret]"));

    for (const attr of [
      "data-create-worktree-thread",
      "data-create-orchestrator-thread",
      "data-create-plain-thread",
      "data-create-teach-thread",
      "data-create-ask-thread",
    ]) {
      assert.ok(m.query(`[${attr}]`), `menu is missing ${attr}`);
    }

    await m.click(m.query("[data-create-orchestrator-thread]"));
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
    await m.click(m.query("[data-new-thread-caret]"));
    await m.click(m.query("[data-create-teach-thread]"));
    assert.deepEqual(calls, [["p1", { worktree: true, teach: true }]]);
  });

  it("New ask thread passes ask and no worktree", async () => {
    const calls: Array<[string, unknown]> = [];
    const m = await mount(
      <Sidebar
        {...baseProps}
        onCreateThread={(projectId, opts) => calls.push([projectId!, opts])}
      />,
    );
    await m.click(m.query("[data-new-thread-caret]"));
    await m.click(m.query("[data-create-ask-thread]"));
    assert.deepEqual(calls, [["p1", { ask: true }]]);
  });

  it("hides worktree-only items for remote projects", async () => {
    const m = await mount(
      <Sidebar
        {...baseProps}
        projects={[remoteProject]}
        threads={[]}
        onCreateThread={() => {}}
      />,
    );
    assert.ok(m.query("[data-new-thread-caret]"), "caret still renders");
    await m.click(m.query("[data-new-thread-caret]"));
    assert.equal(m.query("[data-create-worktree-thread]"), null);
    assert.ok(m.query("[data-create-plain-thread]"));
  });
});
