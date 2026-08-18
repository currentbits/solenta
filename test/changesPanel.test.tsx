/**
 * ChangesPanel commit flow: Generate drafts a message through the provider,
 * Commit sends it and reloads, per-file revert arms a confirm before deleting
 * untracked files.
 *
 * Run: node --import=./test/support/render.mjs --test test/changesPanel.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount, type Mounted } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  DiffResult,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
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

const DIFF: DiffResult = {
  files: [
    { path: "src/a.ts", status: "M", additions: 3, deletions: 1 },
    { path: "notes.txt", status: "??", additions: 5, deletions: 0 },
  ],
  patch: "diff --git a/src/a.ts b/src/a.ts\n+line\n",
  truncated: false,
};

function thread(): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "commit flow",
    branch: "coder/commit-flow",
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
  };
}

function detail(): ThreadDetail {
  return {
    thread: thread(),
    messages: [],
    workLog: [],
    workflow: null,
    usage: null,
  };
}

interface Spies {
  commits: string[];
  reverts: Array<{ path: string; status: string }>;
  suggests: number;
  diffLoads: number;
}

function mountPanel(): { m: Promise<Mounted>; spies: Spies } {
  const spies: Spies = { commits: [], reverts: [], suggests: 0, diffLoads: 0 };
  const m = mount(
    <ThreadView
      detail={detail()}
      project={project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={async () => ({ id: "w", name: "s", phases: [] })}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onDeleteThread={() => {}}
      changesOpen={true}
      changesNonce={1}
      onCloseChanges={() => {}}
      onFetchDiff={async () => {
        spies.diffLoads += 1;
        return DIFF;
      }}
      onCommitChanges={async (message) => {
        spies.commits.push(message);
        return { subject: message };
      }}
      onRevertFile={async (path, status) => {
        spies.reverts.push({ path, status });
        return { path };
      }}
      onSuggestCommitMessage={async () => {
        spies.suggests += 1;
        return { message: "feat: generated" };
      }}
      onPush={async () => ({ remote: "origin", branch: "main" })}
    />,
  );
  return { m, spies };
}

/** The Changes panel footer — not the header next-action "Commit N files". */
function panelCommit(view: { container: HTMLElement }): HTMLButtonElement | null {
  return (
    [...view.container.querySelectorAll("button")].find((b) => {
      const text = (b.textContent || "").trim();
      return text === "Commit" || text === "Committing…";
    }) ?? null
  ) as HTMLButtonElement | null;
}

describe("ChangesPanel commit flow", () => {
  it("Commit starts disabled; Generate fills the box and enables it", async () => {
    const { m, spies } = mountPanel();
    const view = await m;
    const commitBtn = panelCommit(view);
    assert.ok(commitBtn);
    assert.ok(commitBtn.hasAttribute("disabled"), "disabled while empty");

    await view.click(view.byText("Generate"));
    assert.equal(spies.suggests, 1);
    const input = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Commit message"]',
    );
    assert.ok(input);
    assert.equal(input.value, "feat: generated");
    assert.ok(!panelCommit(view)?.hasAttribute("disabled"));
  });

  it("Commit sends the message and reloads the diff", async () => {
    const { m, spies } = mountPanel();
    const view = await m;
    await view.click(view.byText("Generate"));
    const before = spies.diffLoads;
    await view.click(panelCommit(view));
    assert.deepEqual(spies.commits, ["feat: generated"]);
    assert.ok(spies.diffLoads > before, "diff reloaded after commit");
    const input = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Commit message"]',
    );
    assert.equal(input?.value, "", "message box cleared after commit");
  });

  it("tracked-file revert fires immediately", async () => {
    const { m, spies } = mountPanel();
    const view = await m;
    const btn = view.container.querySelector(
      'button[aria-label="Discard changes to src/a.ts"]',
    );
    assert.ok(btn);
    await view.click(btn);
    assert.deepEqual(spies.reverts, [{ path: "src/a.ts", status: "M" }]);
  });

  it("untracked-file revert arms a confirm before deleting", async () => {
    const { m, spies } = mountPanel();
    const view = await m;
    const find = () =>
      view.container.querySelector(
        'button[aria-label="Discard changes to notes.txt"]',
      );
    await view.click(find());
    assert.equal(spies.reverts.length, 0, "first click only arms");
    assert.equal(find()?.textContent, "Sure?");
    await view.click(find());
    assert.deepEqual(spies.reverts, [{ path: "notes.txt", status: "??" }]);
  });
});
