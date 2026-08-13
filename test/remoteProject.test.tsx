/**
 * SSH remote projects: sidebar tag + Environment hint card.
 *
 * Run: node --import=./test/support/render.mjs --test test/remoteProject.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadCard } from "../src/components/Sidebar";
import { GitTab } from "../src/components/AgentsPanel";
import type {
  ProjectInfo,
  ProviderInfo,
  ThreadInfo,
} from "../src/shared/ipc";

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

const localProject: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
};

const remoteProject: ProjectInfo = {
  id: "p2",
  slug: "app",
  name: "app",
  path: "/srv/app",
  remoteHost: "dev@box",
  remotePath: "/srv/app",
};

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
  };
}

function renderCard(remote: boolean): string {
  return renderToStaticMarkup(
    <ThreadCard
      thread={thread()}
      slug="acme/ledger"
      providers={providers}
      active={false}
      now={Date.now()}
      onSelect={() => {}}
      remote={remote}
    />,
  );
}

function renderGit(project: ProjectInfo): string {
  return renderToStaticMarkup(
    <GitTab
      thread={thread({ projectId: project.id })}
      project={project}
      onSetupWorktree={async () => {}}
      onMergeWorktree={async () => {}}
      onRemoveWorktree={async () => {}}
      onViewChanges={() => {}}
      listCheckpoints={async () => []}
      restoreCheckpoint={async () => {}}
      listLocalServers={async () => []}
    />,
  );
}

describe("sidebar ssh tag", () => {
  it("renders an ssh tag next to the provider tag on remote projects", () => {
    const html = renderCard(true);
    assert.ok(html.includes("data-ssh-tag"), "ssh tag hook missing");
    assert.match(html, />ssh</);
    assert.ok(html.includes("SSH remote"), "tag title tooltip missing");
  });

  it("does not render an ssh tag on local projects", () => {
    const html = renderCard(false);
    assert.ok(!html.includes("data-ssh-tag"));
    assert.ok(!html.includes(">ssh<"));
  });
});

describe("Environment tab remote hint", () => {
  it("replaces worktree/PR/servers/checkpoints with a hint on remotes", () => {
    const html = renderGit(remoteProject);
    assert.ok(
      html.includes("data-remote-unavailable"),
      "hint card hook missing",
    );
    assert.ok(html.includes("Not available on remote projects"));
    assert.ok(!html.includes(">Worktree<"), "WorktreeCard must be hidden");
    assert.ok(!html.includes("Local Servers"), "LocalServersCard must be hidden");
    assert.ok(!html.includes("Checkpoints"), "CheckpointsCard must be hidden");
    assert.ok(html.includes("Changes"), "ChangesCard must stay");
    assert.ok(html.includes("View changes"), "diff action must stay");
  });

  it("keeps the full Environment cards on a local project", () => {
    const html = renderGit(localProject);
    assert.ok(!html.includes("data-remote-unavailable"));
    assert.ok(html.includes("Worktree"));
    assert.ok(html.includes("Local Servers"));
    assert.ok(html.includes("Changes"));
  });
});
