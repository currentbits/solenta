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

interface CommitCall {
  message: string;
  paths?: string[];
}

interface RevertCall {
  path: string;
  status: string;
}

interface Spies {
  commits: CommitCall[];
  reverts: RevertCall[];
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
      onCommitChanges={async (message, paths) => {
        spies.commits.push({ message, paths });
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
  return view.container.querySelector(
    "[data-commit-changes]",
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
    assert.equal(spies.commits.length, 1);
    assert.equal(spies.commits[0]?.message, "feat: generated");
    assert.deepEqual(spies.commits[0]?.paths, ["src/a.ts", "notes.txt"]);
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

  it("renders as a Git pane with the branch, no Close control", async () => {
    const { m } = mountPanel();
    const view = await m;
    const pane = view.query("[data-git-pane]");
    assert.ok(pane, "Git pane");
    assert.equal(pane!.getAttribute("aria-label"), "Git");
    assert.match(pane!.textContent || "", /coder\/commit-flow/);
    assert.equal(
      [...pane!.querySelectorAll("button")].find(
        (b) => (b.textContent || "").trim() === "Close",
      ),
      undefined,
    );
  });

  it("unchecking a file commits only the rest", async () => {
    const { m, spies } = mountPanel();
    const view = await m;
    await view.flush();
    const notes = view.container.querySelector(
      '[data-stage-file="notes.txt"]',
    );
    assert.ok(notes);
    assert.equal(notes.getAttribute("aria-checked"), "true");
    await view.click(notes);
    assert.equal(notes.getAttribute("aria-checked"), "false");

    await view.click(view.byText("Generate"));
    const commitBtn = panelCommit(view);
    assert.ok(commitBtn);
    assert.match((commitBtn.textContent || "").trim(), /Commit 1 file/);
    await view.click(commitBtn);
    assert.equal(spies.commits.length, 1);
    assert.deepEqual(spies.commits[0]?.paths, ["src/a.ts"]);
  });

  it("unchecking every file disables Commit", async () => {
    const { m } = mountPanel();
    const view = await m;
    await view.flush();
    await view.click(view.byText("Generate"));
    for (const box of view.container.querySelectorAll("[data-stage-file]")) {
      if (box.getAttribute("aria-checked") === "true") await view.click(box);
    }
    const commitBtn = panelCommit(view);
    assert.ok(commitBtn);
    assert.ok(commitBtn.hasAttribute("disabled"), "disabled with nothing staged");
  });

  it("selects a file row", async () => {
    const { m } = mountPanel();
    const view = await m;
    await view.flush();
    const rows = [...view.container.querySelectorAll("[data-file-row]")];
    assert.ok(rows.length >= 2, "both files listed");
    const selected = () =>
      rows.find((r) => r.getAttribute("data-selected") === "true") ?? null;
    assert.ok(selected(), "one file selected after load");
    const other = rows.find((r) => r !== selected());
    assert.ok(other);
    await view.click(other);
    assert.equal(other.getAttribute("data-selected"), "true");
    assert.equal(
      rows.filter((r) => r.getAttribute("data-selected") === "true").length,
      1,
    );
  });
});
