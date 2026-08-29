/**
 * Header worktree control: one-click "Let the agent resolve" after
 * MERGE_CONFLICT (#163 / #680).
 * Run: npm run test:renderer -- test/worktreeConflict.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useState } from "react";
import { inAct, mount } from "./support/dom.ts";
import {
  classifyGitError,
  WorktreeControl,
} from "../src/components/WorktreeControl";
import type { AgentStatus, ProjectInfo, ThreadInfo } from "../src/shared/ipc";
import type { ConflictResolveInput } from "../src/conflictResolve.ts";

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

const CONFLICT_BODY = `coder/ship-it conflicts with main:
  README.md
main was merged into the worktree. Resolve these files there, then merge again.`;

const CONTEXT: ConflictResolveInput = {
  files: [
    {
      path: "README.md",
      content: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n",
      truncated: false,
      binary: false,
    },
  ],
  omitted: 0,
  branch: "coder/ship-it",
  baseBranch: "main",
};

function chrome(opts: {
  thread?: ThreadInfo | null;
  project?: ProjectInfo;
  onMergeWorktree?: () => Promise<unknown>;
  onStartRun?: (prompt: string, threadId?: string) => Promise<void>;
  conflictContext?: (threadId: string) => Promise<ConflictResolveInput>;
  listBaseBranches?: () => Promise<{ defaultBranch: string; branches: string[] }>;
  onSetBaseBranch?: (baseBranch: string | null) => Promise<unknown>;
}) {
  return (
    <WorktreeControl
      thread={opts.thread === undefined ? thread() : opts.thread}
      project={opts.project ?? project}
      isWorking={(opts.thread ?? thread()).status === "working"}
      onSetupWorktree={async () => {}}
      onMergeWorktree={opts.onMergeWorktree ?? (async () => {})}
      onRemoveWorktree={async () => {}}
      onStartRun={opts.onStartRun}
      conflictContext={opts.conflictContext}
      listBaseBranches={opts.listBaseBranches}
      onSetBaseBranch={opts.onSetBaseBranch}
    />
  );
}

describe("worktree conflict resolve (#163)", () => {
  it("hides Let the agent resolve when onStartRun is not wired", async () => {
    const m = await mount(
      chrome({
        onMergeWorktree: async () => {
          throw new Error(`MERGE_CONFLICT:${CONFLICT_BODY}`);
        },
      }),
    );
    await m.click(m.byText("Merge worktree"));
    assert.ok(m.text().includes("README.md"));
    assert.equal(m.query("[data-conflict-resolve]"), null);
    assert.ok(m.byText("Merge again"));
  });

  it("starts a turn with conflicted files and markers, then retries merge on idle", async () => {
    const prompts: string[] = [];
    let merges = 0;
    let setStatus: ((status: AgentStatus) => void) | null = null;

    function Harness() {
      const [status, set] = useState<AgentStatus>("idle");
      setStatus = set;
      return chrome({
        thread: thread({ status }),
        onMergeWorktree: async () => {
          merges += 1;
          if (merges === 1) {
            throw new Error(`MERGE_CONFLICT:${CONFLICT_BODY}`);
          }
        },
        conflictContext: async () => CONTEXT,
        onStartRun: async (prompt) => {
          prompts.push(prompt);
        },
      });
    }

    const m = await mount(<Harness />);
    await m.click(m.byText("Merge worktree"));
    assert.equal(merges, 1);
    const resolveBtn = m.query("[data-conflict-resolve]");
    assert.ok(resolveBtn, "Let the agent resolve is on the conflict banner");
    await m.click(resolveBtn);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /README\.md/);
    assert.match(prompts[0]!, /<<<<<<< HEAD/);
    assert.match(prompts[0]!, /Do not merge into the project checkout/);

    await inAct(async () => {
      setStatus?.("working");
    });
    await m.flush();
    assert.equal(merges, 1, "must not merge while the resolve turn is running");

    await inAct(async () => {
      setStatus?.("idle");
    });
    await m.flush();
    assert.equal(merges, 2, "retry merge after the resolve turn idles");
  });

  it("does not retry merge after dismiss", async () => {
    const prompts: string[] = [];
    let merges = 0;
    let setStatus: ((status: AgentStatus) => void) | null = null;

    function Harness() {
      const [status, set] = useState<AgentStatus>("idle");
      setStatus = set;
      return chrome({
        thread: thread({ status }),
        onMergeWorktree: async () => {
          merges += 1;
          throw new Error(`MERGE_CONFLICT:${CONFLICT_BODY}`);
        },
        conflictContext: async () => CONTEXT,
        onStartRun: async (prompt) => {
          prompts.push(prompt);
        },
      });
    }

    const m = await mount(<Harness />);
    await m.click(m.byText("Merge worktree"));
    await m.click(m.query("[data-conflict-resolve]"));
    assert.equal(prompts.length, 1);
    await m.click(m.byText("Dismiss"));
    await inAct(async () => {
      setStatus?.("working");
    });
    await m.flush();
    await inAct(async () => {
      setStatus?.("idle");
    });
    await m.flush();
    assert.equal(merges, 1);
  });
});

describe("worktree header control (#680)", () => {
  it("offers Set up worktree when the thread has none", async () => {
    const setups: number[] = [];
    const m = await mount(
      <WorktreeControl
        thread={thread({ worktreePath: null, branch: null })}
        project={project}
        isWorking={false}
        onSetupWorktree={async () => {
          setups.push(1);
        }}
        onMergeWorktree={async () => {}}
        onRemoveWorktree={async () => {}}
      />,
    );
    const btn = m.query("[data-worktree-setup]");
    assert.ok(btn);
    assert.equal((btn!.textContent || "").trim(), "Set up worktree");
    assert.equal(m.query("[data-worktree-merge]"), null);
    await m.click(btn);
    assert.equal(setups.length, 1);
  });

  it("hides on remote projects", async () => {
    const m = await mount(
      <WorktreeControl
        thread={thread()}
        project={{
          ...project,
          remoteHost: "dev@box",
          remotePath: "/srv/app",
        }}
        isWorking={false}
        onSetupWorktree={async () => {}}
        onMergeWorktree={async () => {}}
        onRemoveWorktree={async () => {}}
      />,
    );
    assert.equal(m.query("[data-worktree-control]"), null);
  });
});

describe("stacked base after create (#187)", () => {
  it("shows the recorded base on the worktree control", async () => {
    const m = await mount(chrome({ thread: thread({ baseBranch: "stacked-base" }) }));
    const label = m.query("[data-stacked-base]");
    assert.ok(label, "stacked-base label");
    assert.equal((label!.textContent || "").trim(), "stacked-base");
    m.unmount();
  });

  it("shows repo default when the base is unset", async () => {
    const m = await mount(chrome({}));
    const label = m.query("[data-stacked-base]");
    assert.ok(label);
    assert.equal((label!.textContent || "").trim(), "repo default");
    m.unmount();
  });

  it("changes the recorded base from the worktree menu", async () => {
    const picked: Array<string | null> = [];
    const m = await mount(
      chrome({
        listBaseBranches: async () => ({
          defaultBranch: "main",
          branches: ["main", "stacked-base"],
        }),
        onSetBaseBranch: async (baseBranch) => {
          picked.push(baseBranch);
        },
      }),
    );
    await m.click(m.query("[data-worktree-menu]"));
    await m.click(m.query("[data-change-base]"));
    await m.flush();
    const option = m.query("[data-base-branch='stacked-base']");
    assert.ok(option, "local branch listed");
    await m.click(option);
    await m.flush();
    assert.deepEqual(picked, ["stacked-base"]);
    m.unmount();
  });

  it("clears the recorded base back to the repo default", async () => {
    const picked: Array<string | null> = [];
    const m = await mount(
      chrome({
        thread: thread({ baseBranch: "stacked-base" }),
        listBaseBranches: async () => ({
          defaultBranch: "main",
          branches: ["main", "stacked-base"],
        }),
        onSetBaseBranch: async (baseBranch) => {
          picked.push(baseBranch);
        },
      }),
    );
    await m.click(m.query("[data-worktree-menu]"));
    await m.click(m.query("[data-change-base]"));
    await m.flush();
    await m.click(m.query("[data-base-branch='']"));
    await m.flush();
    assert.deepEqual(picked, [null]);
    m.unmount();
  });

  it("hides Change base after the first pull request", async () => {
    const m = await mount(
      chrome({
        thread: thread({ prNumber: 42, prUrl: "https://example/p/42" }),
        listBaseBranches: async () => ({
          defaultBranch: "main",
          branches: ["main", "stacked-base"],
        }),
        onSetBaseBranch: async () => {},
      }),
    );
    await m.click(m.query("[data-worktree-menu]"));
    assert.equal(m.query("[data-change-base]"), null);
    m.unmount();
  });
});

const REBASE_CONFLICT_MSG =
  "WORKTREE_REBASE_CONFLICT: cannot rebase onto stacked-base\n  README.md";

describe("rebase conflict card (#777)", () => {
  it("classifies WORKTREE_REBASE_CONFLICT as rebase-conflict and keeps MERGE_CONFLICT / WORKTREE_DIRTY", () => {
    const rebase = classifyGitError(REBASE_CONFLICT_MSG);
    assert.equal(rebase.kind, "rebase-conflict");
    assert.match(rebase.text, /README\.md/);
    assert.ok(!rebase.text.includes("WORKTREE_REBASE_CONFLICT"));

    assert.deepEqual(classifyGitError(`MERGE_CONFLICT:${CONFLICT_BODY}`), {
      kind: "conflict",
      text: CONFLICT_BODY,
    });
    assert.deepEqual(
      classifyGitError(
        "WORKTREE_DIRTY: cannot change the merge base while the worktree has uncommitted changes",
      ),
      {
        kind: "dirty",
        text: "cannot change the merge base while the worktree has uncommitted changes",
      },
    );
  });

  it("surfaces rebase-conflict paths from pickBase in the conflict card, not cardError", async () => {
    const m = await mount(
      chrome({
        onStartRun: async () => {},
        listBaseBranches: async () => ({
          defaultBranch: "main",
          branches: ["main", "stacked-base"],
        }),
        onSetBaseBranch: async () => {
          throw new Error(REBASE_CONFLICT_MSG);
        },
      }),
    );
    await m.click(m.query("[data-worktree-menu]"));
    await m.click(m.query("[data-change-base]"));
    await m.flush();
    await m.click(m.query("[data-base-branch='stacked-base']"));
    await m.flush();

    const banner = m.query("[data-worktree-banner='conflict']");
    assert.ok(banner, "conflict card");
    assert.match(banner!.textContent || "", /README\.md/);
    assert.ok(
      !(banner!.textContent || "").includes("WORKTREE_REBASE_CONFLICT"),
      "marker prefix stripped",
    );
    assert.equal(m.query("[data-worktree-banner='error']"), null);
    assert.equal(
      m.query("[data-conflict-resolve]"),
      null,
      "rebase already aborted; no let-the-agent-resolve",
    );
    assert.ok(
      !m.text().includes("Merge again"),
      "rebase already aborted; no merge retry",
    );
    m.unmount();
  });

  it("keeps WORKTREE_DIRTY on the dirty banner, not the conflict card", async () => {
    const m = await mount(
      <WorktreeControl
        thread={thread()}
        project={project}
        isWorking={false}
        onSetupWorktree={async () => {}}
        onMergeWorktree={async () => {}}
        onRemoveWorktree={async () => {
          throw new Error("WORKTREE_DIRTY: uncommitted changes\n  README.md");
        }}
      />,
    );
    await m.click(m.query("[data-worktree-menu]"));
    await m.click(m.query("[data-worktree-delete]"));
    await m.flush();
    const dirty = m.query("[data-worktree-banner='dirty']");
    assert.ok(dirty, "dirty banner");
    assert.match(dirty!.textContent || "", /README\.md/);
    assert.equal(m.query("[data-worktree-banner='conflict']"), null);
    assert.equal(m.query("[data-worktree-banner='error']"), null);
    m.unmount();
  });
});
