/**
 * Git tab: one-click "Let the agent resolve" after MERGE_CONFLICT (#163).
 * Run: npm run test:renderer -- test/worktreeConflict.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useState } from "react";
import { inAct, mount } from "./support/dom.ts";
import { GitTab } from "../src/components/AgentsPanel";
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

function gitTab(opts: {
  thread?: ThreadInfo | null;
  onMergeWorktree?: () => Promise<unknown>;
  onStartRun?: (prompt: string, threadId?: string) => Promise<void>;
  conflictContext?: (threadId: string) => Promise<ConflictResolveInput>;
}) {
  return (
    <GitTab
      thread={opts.thread === undefined ? thread() : opts.thread}
      project={project}
      onSetupWorktree={async () => {}}
      onMergeWorktree={opts.onMergeWorktree ?? (async () => {})}
      onRemoveWorktree={async () => {}}
      onViewChanges={() => {}}
      listCheckpoints={async () => []}
      restoreCheckpoint={async () => {}}
      listLocalServers={async () => []}
      listDevScripts={async () => []}
      startDevServer={async () => ({ running: false }) as never}
      stopDevServer={async () => ({ running: false }) as never}
      devServerStatus={async () => ({ running: false }) as never}
      gitRepoInfo={async () => ({ ok: false as const })}
      gitPull={async () => ({ ok: true, summary: "Already up to date" })}
      onStartRun={opts.onStartRun}
      conflictContext={opts.conflictContext}
    />
  );
}

describe("worktree conflict resolve (#163)", () => {
  it("hides Let the agent resolve when onStartRun is not wired", async () => {
    const m = await mount(
      gitTab({
        onMergeWorktree: async () => {
          throw new Error(`MERGE_CONFLICT:${CONFLICT_BODY}`);
        },
      }),
    );
    await m.click(m.byText("Merge to main"));
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
      return gitTab({
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
    await m.click(m.byText("Merge to main"));
    assert.equal(merges, 1);
    const resolveBtn = m.query("[data-conflict-resolve]");
    assert.ok(resolveBtn, "Let the agent resolve is on the conflict card");
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
      return gitTab({
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
    await m.click(m.byText("Merge to main"));
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
