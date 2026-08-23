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
  patch: [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " keep",
    "-old",
    "+new",
    " context",
  ].join("\n"),
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
  comments: string[];
}

function mountPanel(opts?: {
  archived?: boolean;
  working?: boolean;
}): { m: Promise<Mounted>; spies: Spies } {
  const spies: Spies = {
    commits: [],
    reverts: [],
    suggests: 0,
    diffLoads: 0,
    comments: [],
  };
  const t = thread();
  if (opts?.archived) t.archived = true;
  if (opts?.working) t.status = "working";
  const m = mount(
    <ThreadView
      detail={{ ...detail(), thread: t }}
      project={project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={(prompt) => {
        spies.comments.push(prompt);
      }}
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

describe("ChangesPanel inline comments (issue #162)", () => {
  it("puts a comment control on code lines, not on the hunk header", async () => {
    const { m } = mountPanel();
    const view = await m;
    const add = view.query('button[aria-label="Comment on line 2"]');
    const removed = view.query('button[aria-label="Comment on removed line 2"]');
    const ctx = view.query('button[aria-label="Comment on line 1"]');
    assert.ok(add, "added line is commentable");
    assert.ok(removed, "deleted line is commentable");
    assert.ok(ctx, "context line is commentable");
    assert.equal(
      view.queryAll("[data-diff-comment-gutter]").length,
      4,
      "keep, old, new, context — not the @@ header",
    );
  });

  it("opens a comment box on the clicked line", async () => {
    const { m } = mountPanel();
    const view = await m;
    assert.equal(view.query("[data-diff-comment-box]"), null);
    await view.click(view.query('button[aria-label="Comment on line 2"]'));
    const box = view.query("[data-diff-comment-box]");
    assert.ok(box, "comment box appears");
    const input = view.query(
      'textarea[aria-label="Diff comment"]',
    ) as HTMLTextAreaElement | null;
    assert.ok(input);
    const send = [...box!.querySelectorAll("button")].find(
      (b) => (b.textContent || "").trim() === "Send",
    );
    assert.ok(send);
    assert.ok(send!.hasAttribute("disabled"), "empty comment cannot send");
  });

  it("sends the comment as a follow-up prompt with file and line", async () => {
    const { m, spies } = mountPanel();
    const view = await m;
    await view.click(view.query('button[aria-label="Comment on line 2"]'));
    const input = view.query('textarea[aria-label="Diff comment"]');
    await view.type(input, "use Y instead");
    const send = [...view.queryAll("[data-diff-comment-box] button")].find(
      (b) => (b.textContent || "").trim() === "Send",
    );
    await view.click(send ?? null);
    assert.equal(spies.comments.length, 1);
    assert.match(spies.comments[0]!, /^Comment on src\/a\.ts:2:\n/);
    assert.match(spies.comments[0]!, /\n    \+new\n/);
    assert.match(spies.comments[0]!, /\nuse Y instead$/);
    assert.equal(
      view.query("[data-diff-comment-box]"),
      null,
      "box closes after send",
    );
  });

  it("queues the comment while the thread is working", async () => {
    const { m, spies } = mountPanel({ working: true });
    const view = await m;
    await view.click(view.query('button[aria-label="Comment on line 2"]'));
    const queue = [...view.queryAll("[data-diff-comment-box] button")].find(
      (b) => (b.textContent || "").trim() === "Queue",
    );
    assert.ok(queue, "Send relabels to Queue mid-run");
    const input = view.query('textarea[aria-label="Diff comment"]');
    await view.type(input, "fix the new line");
    await view.click(queue);
    assert.equal(spies.comments.length, 1);
    assert.match(spies.comments[0]!, /fix the new line$/);
  });

  it("sends with Cmd+Enter and closes on Escape", async () => {
    const { m, spies } = mountPanel();
    const view = await m;
    await view.click(view.query('button[aria-label="Comment on line 2"]'));
    const input = view.query('textarea[aria-label="Diff comment"]');
    await view.type(input, "first");
    await view.pressFocused("Enter", { metaKey: true });
    assert.equal(spies.comments.length, 1);
    assert.match(spies.comments[0]!, /\nfirst$/);

    await view.click(view.query('button[aria-label="Comment on line 1"]'));
    assert.ok(view.query("[data-diff-comment-box]"));
    await view.pressFocused("Escape");
    assert.equal(view.query("[data-diff-comment-box]"), null);
    assert.equal(spies.comments.length, 1, "Escape must not send");
  });

  it("hides comment controls on an archived thread", async () => {
    const { m } = mountPanel({ archived: true });
    const view = await m;
    assert.equal(view.queryAll("[data-diff-comment-gutter]").length, 0);
  });
});
