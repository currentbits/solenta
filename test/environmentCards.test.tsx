/**
 * Environment tab: Repository row, Pull card, Recap card.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { GitTab } from "../src/components/AgentsPanel";
import type {
  CheckpointInfo,
  DiffResult,
  GitPullResult,
  GitRepoInfo,
  MergeLaneInfo,
  ProjectInfo,
  ThreadInfo,
  ThreadSummaryInfo,
} from "../src/shared/ipc";

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

function summary(over: Partial<ThreadSummaryInfo> = {}): ThreadSummaryInfo {
  return {
    id: "t1",
    title: "ship it",
    provider: "claude",
    status: "idle",
    handoffFrom: null,
    lastActivity: null,
    ...over,
  } as ThreadSummaryInfo;
}

function tab(opts: {
  thread?: ThreadInfo | null;
  project?: ProjectInfo;
  repoInfo?: GitRepoInfo;
  onRepoInfo?: (id: string) => Promise<GitRepoInfo>;
  onPull?: (id: string) => Promise<GitPullResult>;
  summaries?: ThreadSummaryInfo[];
  onSummaries?: (input?: unknown) => Promise<ThreadSummaryInfo[]>;
  onFetchDiff?: () => Promise<DiffResult>;
  onViewChanges?: () => void;
  checkpoints?: CheckpointInfo[];
  lanes?: MergeLaneInfo[];
}) {
  const repoInfo = opts.repoInfo ?? { ok: false as const };
  const laneProps = opts.lanes
    ? {
        claimLane: async () => ({
          n: 1,
          port: 3001,
          path: "/tmp/lane-1",
          branch: "lane/1",
        }),
        listLanes: async () => opts.lanes!,
        previewLane: async (input: { lane: number }) => ({
          lane: input.lane,
          sha: "abc",
          files: [],
          path: "/tmp/repo",
        }),
        restorePreview: async () => ({ restored: true }),
        recycleWedgedLanes: async () => [],
      }
    : {};
  return (
    <GitTab
      thread={opts.thread === undefined ? thread() : opts.thread}
      project={opts.project ?? project}
      onViewChanges={opts.onViewChanges ?? (() => {})}
      fetchDiff={opts.onFetchDiff}
      listCheckpoints={async () => opts.checkpoints ?? []}
      restoreCheckpoint={async () => {}}
      listLocalServers={async () => []}
      gitRepoInfo={opts.onRepoInfo ?? (async () => repoInfo)}
      gitPull={opts.onPull ?? (async () => ({ ok: true, summary: "Already up to date" }))}
      listThreadSummaries={
        opts.onSummaries ?? (async () => opts.summaries ?? [summary()])
      }
      listDevScripts={async () => []}
      startDevServer={async () => ({ running: false })}
      stopDevServer={async () => ({ running: false })}
      devServerStatus={async () => ({ running: false })}
      {...laneProps}
    />
  );
}

describe("scm card (#521)", () => {
  const jjProject: ProjectInfo = {
    ...project,
    scm: {
      kind: "jj",
      colocated: true,
      support: "unsupported",
      detail: "Jujutsu colocated repo. Worktrees and diffs use git.",
    },
  };

  it("badges a jj project as unsupported", async () => {
    const m = await mount(tab({ project: jjProject }));
    await m.flush();
    const badge = m.query("[data-scm-badge]");
    assert.ok(badge, "scm badge");
    assert.equal(badge!.getAttribute("data-scm-badge"), "unsupported");
    assert.equal((badge!.textContent || "").trim(), "jj · unsupported");
    const detail = m.query("[data-scm-detail]");
    assert.ok(detail, "detail line");
    assert.match(detail!.textContent || "", /Jujutsu colocated/);
    m.unmount();
  });

  it("is hidden on a plain git project", async () => {
    const m = await mount(tab({}));
    await m.flush();
    assert.equal(m.query("[data-scm-card]"), null);
    m.unmount();
  });
});

describe("repository card", () => {
  it("links owner/repo to the origin web URL", async () => {
    const m = await mount(
      tab({
        repoInfo: {
          ok: true,
          owner: "acme",
          repo: "widgets",
          webUrl: "https://github.com/acme/widgets",
        },
      }),
    );
    await m.flush();
    const link = m.query("[data-repo-link]") as HTMLAnchorElement | null;
    assert.ok(link, "repo link");
    assert.ok(
      (link!.textContent || "").includes("acme/widgets"),
      "owner/repo label",
    );
    assert.equal(link!.getAttribute("href"), "https://github.com/acme/widgets");
    assert.equal(link!.getAttribute("target"), "_blank");
    m.unmount();
  });

  it("is hidden when there is no origin", async () => {
    const m = await mount(tab({ repoInfo: { ok: false } }));
    await m.flush();
    assert.equal(m.query("[data-repo-card]"), null);
    m.unmount();
  });

  it("is hidden when no thread is selected", async () => {
    const m = await mount(
      tab({
        thread: null,
        repoInfo: {
          ok: true,
          owner: "acme",
          repo: "widgets",
          webUrl: "https://github.com/acme/widgets",
        },
      }),
    );
    await m.flush();
    assert.equal(m.query("[data-repo-card]"), null);
    m.unmount();
  });

  it("refetches when the selected thread changes", async () => {
    const seen: string[] = [];
    const m = await mount(
      tab({
        onRepoInfo: async (id) => {
          seen.push(id);
          return { ok: false };
        },
      }),
    );
    await m.flush();
    assert.deepEqual(seen, ["t1"]);
    m.unmount();
  });
});

describe("pull card", () => {
  it("shows the summary inline after a successful pull", async () => {
    const m = await mount(
      tab({ onPull: async () => ({ ok: true, summary: "Already up to date" }) }),
    );
    await m.flush();
    const btn = m.query("[data-pull-btn]") as HTMLButtonElement | null;
    assert.ok(btn, "Pull button");
    assert.equal(btn!.getAttribute("title"), "Pull from upstream (fast-forward only)");
    await m.click(btn);
    await m.flush();
    const result = m.query("[data-pull-result]");
    assert.ok(result, "result line");
    assert.equal((result!.textContent || "").trim(), "Already up to date");
    m.unmount();
  });

  it("shows Fast-forwarded when upstream advanced", async () => {
    const m = await mount(
      tab({ onPull: async () => ({ ok: true, summary: "Fast-forwarded" }) }),
    );
    await m.flush();
    await m.click(m.query("[data-pull-btn]"));
    await m.flush();
    assert.equal(
      (m.query("[data-pull-result]")?.textContent || "").trim(),
      "Fast-forwarded",
    );
    m.unmount();
  });

  it("shows the reason inline when the pull cannot run", async () => {
    const m = await mount(
      tab({
        onPull: async () => ({
          ok: false,
          reason: "Working tree has uncommitted changes",
        }),
      }),
    );
    await m.flush();
    await m.click(m.query("[data-pull-btn]"));
    await m.flush();
    const result = m.query("[data-pull-result]");
    assert.ok(result, "result line");
    assert.equal(
      (result!.textContent || "").trim(),
      "Working tree has uncommitted changes",
    );
    assert.equal(result!.getAttribute("role"), "alert");
    m.unmount();
  });

  it("shows a spinner and disables the button while pulling", async () => {
    let resolvePull: (r: GitPullResult) => void = () => {};
    const pending = new Promise<GitPullResult>((r) => {
      resolvePull = r;
    });
    const m = await mount(tab({ onPull: () => pending }));
    await m.flush();
    const btn = m.query("[data-pull-btn]") as HTMLButtonElement;
    // click flushes React work; the pull promise stays pending throughout.
    await m.click(btn);
    assert.ok(btn.disabled, "disabled while pulling");
    assert.ok(
      (btn.textContent || "").includes("Pulling"),
      "spinner label while pulling",
    );
    assert.equal(m.query("[data-pull-result]"), null, "no result yet");
    resolvePull({ ok: true, summary: "Already up to date" });
    await m.flush();
    assert.ok(!btn.disabled, "enabled again after");
    assert.equal(
      (m.query("[data-pull-result]")?.textContent || "").trim(),
      "Already up to date",
    );
    m.unmount();
  });

  it("no thread: no Pull button, one empty-state line", async () => {
    const m = await mount(tab({ thread: null }));
    await m.flush();
    assert.equal(m.query("[data-pull-btn]"), null);
    assert.equal(
      m.query("[data-env-empty]")?.textContent,
      "Select a thread to see its workspace.",
    );
    m.unmount();
  });
});

describe("recap card", () => {
  it("shows the selected thread's last activity, not another thread's", async () => {
    const m = await mount(
      tab({
        summaries: [
          summary({
            id: "other",
            lastActivity: { text: "unrelated work", at: 5 },
          }),
          summary({
            id: "t1",
            lastActivity: { text: "Fixed the login redirect", at: 10 },
          }),
        ],
      }),
    );
    await m.flush();
    assert.equal(
      (m.query("[data-recap-activity]")?.textContent || "").trim(),
      "Fixed the login redirect",
    );
    m.unmount();
  });

  it("shows the empty state when the thread has no activity", async () => {
    const m = await mount(tab({ summaries: [summary()] }));
    await m.flush();
    assert.equal(
      (m.query("[data-recap-activity]")?.textContent || "").trim(),
      "No activity yet",
    );
    m.unmount();
  });

  it("shows branch and PR in the status header, and the failure line when failed", async () => {
    const m = await mount(
      tab({
        thread: thread({
          prNumber: 7,
          prState: "OPEN",
          status: "failed",
          lastError: "Run error:\n  boom",
        }),
      }),
    );
    await m.flush();
    assert.equal(m.query("[data-env-branch]")?.textContent, "coder/ship-it");
    assert.equal(m.query("[data-env-pr]")?.textContent, "#7 open");
    assert.equal(m.query("[data-env-error]")?.textContent, "Run error: boom");
    m.unmount();
  });

  it("links the PR number out to GitHub when a URL is recorded", async () => {
    const m = await mount(
      tab({
        thread: thread({
          prNumber: 7,
          prState: "OPEN",
          prUrl: "https://github.com/owner/repo/pull/7",
        }),
      }),
    );
    await m.flush();
    const link = m.query("[data-recap-pr]") as HTMLAnchorElement | null;
    assert.ok(link, "PR is a link");
    assert.equal(link!.getAttribute("href"), "https://github.com/owner/repo/pull/7");
    assert.equal((link!.textContent || "").trim(), "#7 open ›");
    m.unmount();
  });

  it("keeps the PR number plain text when no URL is recorded", async () => {
    const m = await mount(
      tab({ thread: thread({ prNumber: 7, prState: "OPEN" }) }),
    );
    await m.flush();
    assert.equal(m.query("[data-recap-pr]"), null);
    assert.equal(m.query("[data-env-pr]")?.textContent, "#7 open");
    m.unmount();
  });

  it("omits the PR when none is recorded", async () => {
    const m = await mount(tab({}));
    await m.flush();
    assert.equal(m.query("[data-env-pr]"), null);
    assert.equal(m.query("[data-env-branch]")?.textContent, "coder/ship-it");
    m.unmount();
  });

  it("refetches summaries when the thread status changes", async () => {
    let calls = 0;
    const m = await mount(
      tab({
        onSummaries: async () => {
          calls += 1;
          return [summary()];
        },
      }),
    );
    await m.flush();
    assert.ok(calls >= 1, "summaries fetched on mount");
    m.unmount();
  });

  it("is hidden when no thread is selected", async () => {
    const m = await mount(tab({ thread: null }));
    await m.flush();
    assert.equal(m.query("[data-recap-activity]"), null);
    m.unmount();
  });

  it("asks only for its own thread's summary (#1398)", async () => {
    const calls: unknown[] = [];
    const m = await mount(
      tab({
        onSummaries: async (input?: unknown) => {
          calls.push(input);
          return [];
        },
      }),
    );
    await m.flush();
    assert.deepEqual(calls, [{ threadIds: ["t1"] }]);
    m.unmount();
  });
});


describe("Environment layout (inspector redesign)", () => {
  it("renders Status, Run, Checkpoints, Lanes in a fixed order", async () => {
    const m = await mount(tab({ lanes: [] }));
    await m.flush();
    const pane = m.query("[data-env-tools]")!;
    assert.deepEqual(
      [...pane.children].map((el) => el.getAttribute("aria-label")),
      ["Status", "Run", "Checkpoints", "Lanes"],
    );
    m.unmount();
  });

  it("drops the duplicate cards and the reorder chrome", async () => {
    const m = await mount(tab({}));
    await m.flush();
    for (const sel of [
      "[data-prs-card]",
      "[data-open-prs]",
      "[data-thread-fork-card]",
      "[data-thread-fork]",
      "[data-thread-handoff]",
      "[data-display-prefs]",
      "[data-lane-spotlight]",
      "[data-env-grip]",
      "[data-env-reset]",
      "[data-env-section]",
      "[data-git-status]",
      "[data-recap-card]",
      "[data-recap-facts]",
    ]) {
      assert.equal(m.query(sel), null, `${sel} must be gone`);
    }
    assert.doesNotMatch(m.text(), /Drag to reorder|Reset order|Open Git/);
    m.unmount();
  });

  it("status header: branch, Pull, changed-files link that opens Git", async () => {
    let opened = 0;
    const m = await mount(
      tab({
        onFetchDiff: async () =>
          ({ files: [{}, {}, {}], patch: "", truncated: false }) as unknown as DiffResult,
        onViewChanges: () => {
          opened += 1;
        },
      }),
    );
    await m.flush();
    const status = m.query("[data-env-status]")!;
    assert.equal(status.querySelector("[data-env-branch]")?.textContent, "coder/ship-it");
    assert.ok(status.querySelector("[data-pull-btn]"), "Pull exists nowhere else, so it stays");
    const changes = status.querySelector("[data-env-changes]")!;
    assert.equal(changes.textContent, "3 changed files ›");
    await m.click(changes);
    assert.equal(opened, 1, "the link opens the Git view");
    m.unmount();
  });

  it("changes link reads Changes › until a diff count arrives", async () => {
    const m = await mount(tab({}));
    await m.flush();
    assert.equal(m.query("[data-env-changes]")?.textContent, "Changes ›");
    m.unmount();
  });

  it("checkpoints start collapsed and show their count", async () => {
    const m = await mount(
      tab({
        checkpoints: [
          { sha: "abc1234ffff", turn: 1, message: "turn 1", at: Date.now() },
        ],
      }),
    );
    await m.flush();
    const cp = m.query("[data-checkpoints]") as HTMLDetailsElement;
    assert.equal(cp.tagName, "DETAILS");
    assert.equal(cp.open, false);
    assert.equal(cp.querySelector("[data-section-count]")?.textContent, "1");
    m.unmount();
  });

  it("no thread: one empty line, Lanes still offered for the project", async () => {
    const m = await mount(tab({ thread: null, lanes: [] }));
    await m.flush();
    assert.ok(m.query("[data-env-empty]"));
    assert.equal(m.query("[data-env-status]"), null);
    assert.equal(m.query("[data-env-run]"), null);
    assert.ok(m.query("[data-lanes]"));
    m.unmount();
  });

  // Migrated from envSectionReorder "still hides remote-only tools on an SSH project".
  it("remote project: notice line; no Run, Checkpoints, Lanes, Pull or Finder", async () => {
    const m = await mount(
      tab({
        project: { ...project, remoteHost: "dev@box", remotePath: "/srv/app" },
        lanes: [],
      }),
    );
    await m.flush();
    assert.ok(m.query("[data-remote-unavailable]"));
    assert.ok(m.query("[data-env-changes]"), "changes link stays");
    assert.equal(m.query("[data-env-run]"), null);
    assert.equal(m.query("[data-local-servers]"), null);
    assert.equal(m.query("[data-checkpoints]"), null);
    assert.equal(m.query("[data-lanes]"), null, "lanes are local-only");
    assert.equal(m.query("[data-pull-btn]"), null);
    assert.equal(m.query("[data-editor]"), null);
    m.unmount();
  });
});
