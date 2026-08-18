/**
 * Thread header next-git-action button (issue #382).
 *
 * Run: node --import=./test/support/render.mjs --test test/nextGitActionButton.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  DiffResult,
  GitSyncInfo,
  PrChecksResult,
  PrInfo,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
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

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "next action",
    branch: "coder/next-action-abc123",
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
    lastVisitedAt: null,
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

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    thread: over.thread ?? thread(),
    messages: over.messages ?? [],
    workLog: over.workLog ?? [],
    workflow: over.workflow ?? null,
    usage: over.usage ?? null,
  };
}

const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

const emptyDiff: DiffResult = { files: [], patch: "", truncated: false };
const dirtyDiff: DiffResult = {
  files: [{ path: "src/a.ts", status: "M", additions: 2, deletions: 1 }],
  patch: "diff --git a/src/a.ts b/src/a.ts\n",
  truncated: false,
};

function view(props: {
  detail?: ThreadDetail;
  project?: ProjectInfo | null;
  onFetchDiff?: () => Promise<DiffResult>;
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  onViewChanges?: () => void;
  onPush?: () => Promise<{ remote: string; branch: string }>;
  onCreatePr?: (input: {
    title: string;
    body?: string;
    draft?: boolean;
  }) => Promise<PrInfo>;
  onPrChecks?: () => Promise<PrChecksResult>;
  onPrMerge?: () => Promise<PrInfo>;
  onStartRun?: (prompt: string) => void;
}) {
  return (
    <ThreadView
      detail={props.detail ?? detail()}
      project={props.project === undefined ? project : props.project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={props.onStartRun ?? (() => {})}
      onStartWorkflow={() => {}}
      onSaveWorkflow={noopSave}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      changesOpen={false}
      changesNonce={0}
      onCloseChanges={() => {}}
      onViewChanges={props.onViewChanges}
      onFetchDiff={props.onFetchDiff ?? (async () => emptyDiff)}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={props.onPush ?? (async () => ({ remote: "origin", branch: "main" }))}
      onCreatePr={props.onCreatePr}
      onPrChecks={props.onPrChecks}
      onPrMerge={props.onPrMerge}
      gitSyncInfo={props.gitSyncInfo}
    />
  );
}

afterEach(unmountAll);

describe("next-git-action button", () => {
  it("offers Create PR on a worktree when sync has not loaded", async () => {
    const m = await mount(view({}));
    await m.flush();
    const btn = m.query('[data-next-git-action="create-pr"]');
    assert.ok(btn, "create-pr action");
    assert.equal((btn!.textContent || "").trim(), "Create PR");
    m.unmount();
  });

  it("hides on a main checkout with no sync and no PR", async () => {
    const m = await mount(
      view({
        detail: detail({ thread: thread({ worktreePath: null }) }),
      }),
    );
    await m.flush();
    assert.equal(m.query("[data-next-git-action]"), null);
    m.unmount();
  });

  it("hides on remote projects even when dirty", async () => {
    const m = await mount(
      view({
        project: { ...project, remoteHost: "user@host" },
        onFetchDiff: async () => dirtyDiff,
        gitSyncInfo: async () => ({ hasUpstream: true, ahead: 2, behind: 0 }),
      }),
    );
    await m.flush();
    assert.equal(m.query("[data-next-git-action]"), null);
    m.unmount();
  });

  it("offers Commit and opens Changes", async () => {
    const opens: number[] = [];
    const m = await mount(
      view({
        onFetchDiff: async () => dirtyDiff,
        gitSyncInfo: async () => ({ hasUpstream: true, ahead: 0, behind: 0 }),
        onViewChanges: () => {
          opens.push(1);
        },
      }),
    );
    await m.flush();
    const btn = m.query('[data-next-git-action="commit"]');
    assert.ok(btn, "commit action");
    assert.equal((btn!.textContent || "").trim(), "Commit 1 file");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(opens, [1]);
    m.unmount();
  });

  it("pushes unpushed commits on an open PR", async () => {
    const pushes: string[] = [];
    const m = await mount(
      view({
        detail: detail({
          thread: thread({
            prNumber: 4,
            prUrl: "https://github.com/acme/repo/pull/4",
            prState: "OPEN",
          }),
        }),
        gitSyncInfo: async () => ({ hasUpstream: true, ahead: 2, behind: 0 }),
        onPush: async () => {
          pushes.push("origin");
          return { remote: "origin", branch: "coder/next-action-abc123" };
        },
      }),
    );
    await m.flush();
    const btn = m.query('[data-next-git-action="push"]');
    assert.ok(btn, "push action");
    assert.equal((btn!.textContent || "").trim(), "Push");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(pushes, ["origin"]);
    m.unmount();
  });

  it("creates a PR on an unpublished worktree without a prior Push", async () => {
    const created: Array<{ title: string }> = [];
    const pushes: string[] = [];
    const m = await mount(
      view({
        gitSyncInfo: async () => ({ hasUpstream: false }),
        onPush: async () => {
          pushes.push("origin");
          return { remote: "origin", branch: "coder/next-action-abc123" };
        },
        onCreatePr: async (input) => {
          created.push({ title: input.title });
          return {
            number: 42,
            url: "https://github.com/acme/repo/pull/42",
            state: "OPEN",
            branch: "coder/next-action-abc123",
            created: true,
          };
        },
      }),
    );
    await m.flush();
    const btn = m.query('[data-next-git-action="create-pr"]');
    assert.ok(btn, "create-pr action");
    assert.ok(btn!.hasAttribute("data-create-pr"));
    assert.equal((btn!.textContent || "").trim(), "Create PR");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(created, [{ title: "next action" }]);
    assert.deepEqual(pushes, [], "header does not push first; createPr does");
    m.unmount();
  });

  it("creates a PR with the thread title when createPr is wired", async () => {
    const created: Array<{ title: string }> = [];
    const m = await mount(
      view({
        gitSyncInfo: async () => ({ hasUpstream: true, ahead: 0, behind: 0 }),
        onCreatePr: async (input) => {
          created.push({ title: input.title });
          return {
            number: 42,
            url: "https://github.com/acme/repo/pull/42",
            state: "OPEN",
            branch: "coder/next-action-abc123",
            created: true,
          };
        },
      }),
    );
    await m.flush();
    const btn = m.query('[data-next-git-action="create-pr"]');
    assert.ok(btn, "create-pr action");
    assert.ok(btn!.hasAttribute("data-create-pr"));
    await m.click(btn);
    await m.flush();
    assert.deepEqual(created, [{ title: "next action" }]);
    m.unmount();
  });

  it("watches pending checks and links the PR", async () => {
    const m = await mount(
      view({
        detail: detail({
          thread: thread({
            prNumber: 7,
            prUrl: "https://github.com/acme/repo/pull/7",
            prState: "OPEN",
          }),
        }),
        gitSyncInfo: async () => ({ hasUpstream: true, ahead: 0, behind: 0 }),
        onPrChecks: async () => ({
          ok: true,
          checks: [
            { name: "lint", bucket: "pass" },
            { name: "test", bucket: "pending" },
          ],
        }),
      }),
    );
    await m.flush();
    const el = m.query('[data-next-git-action="watch-checks"]');
    assert.ok(el, "watch-checks action");
    assert.equal(el!.tagName, "A");
    assert.equal(el!.getAttribute("href"), "https://github.com/acme/repo/pull/7");
    assert.ok((el!.textContent || "").includes("Checks 1/2"));
    m.unmount();
  });

  it("merges when checks are green", async () => {
    const merges: number[] = [];
    const m = await mount(
      view({
        detail: detail({
          thread: thread({
            prNumber: 9,
            prUrl: "https://github.com/acme/repo/pull/9",
            prState: "OPEN",
          }),
        }),
        gitSyncInfo: async () => ({ hasUpstream: true, ahead: 0, behind: 0 }),
        onPrChecks: async () => ({
          ok: true,
          checks: [{ name: "ci", bucket: "pass" }],
        }),
        onPrMerge: async () => {
          merges.push(9);
          return {
            number: 9,
            url: "https://github.com/acme/repo/pull/9",
            state: "MERGED",
            branch: "coder/next-action-abc123",
            created: false,
          };
        },
      }),
    );
    await m.flush();
    const btn = m.query('[data-next-git-action="merge"]');
    assert.ok(btn, "merge action");
    assert.equal((btn!.textContent || "").trim(), "Merge PR #9");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(merges, [9]);
    m.unmount();
  });

  it("labels Update from main when the open PR is conflicting", async () => {
    const merges: number[] = [];
    const m = await mount(
      view({
        detail: detail({
          thread: thread({
            prNumber: 49,
            prUrl: "https://github.com/acme/repo/pull/49",
            prState: "OPEN",
            prMergeable: "CONFLICTING",
          }),
        }),
        gitSyncInfo: async () => ({ hasUpstream: true, ahead: 0, behind: 0 }),
        onPrChecks: async () => ({
          ok: true,
          checks: [{ name: "ci", bucket: "pass" }],
        }),
        onPrMerge: async () => {
          merges.push(49);
          return {
            number: 49,
            url: "https://github.com/acme/repo/pull/49",
            state: "MERGED",
            branch: "coder/next-action-abc123",
            created: false,
          };
        },
      }),
    );
    await m.flush();
    const btn = m.query('[data-next-git-action="merge"]');
    assert.ok(btn, "merge action");
    assert.equal((btn!.textContent || "").trim(), "Update from main");
    await m.click(btn);
    await m.flush();
    assert.deepEqual(merges, [49]);
    m.unmount();
  });

  it("does not offer merge when checks failed", async () => {
    const m = await mount(
      view({
        detail: detail({
          thread: thread({
            prNumber: 3,
            prUrl: "https://github.com/acme/repo/pull/3",
            prState: "OPEN",
          }),
        }),
        gitSyncInfo: async () => ({ hasUpstream: true, ahead: 0, behind: 0 }),
        onPrChecks: async () => ({
          ok: true,
          checks: [{ name: "ci", bucket: "fail" }],
        }),
        onPrMerge: async () => {
          throw new Error("should not merge");
        },
      }),
    );
    await m.flush();
    assert.equal(m.query('[data-next-git-action="merge"]'), null);
    const el = m.query('[data-next-git-action="checks-failed"]');
    assert.ok(el, "checks-failed action");
    assert.equal((el!.textContent || "").trim(), "Checks failed");
    m.unmount();
  });
});
