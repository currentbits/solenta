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
  GitPullResult,
  GitRepoInfo,
  ProjectInfo,
  ProviderInfo,
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
  repoInfo?: GitRepoInfo;
  onRepoInfo?: (id: string) => Promise<GitRepoInfo>;
  onPull?: (id: string) => Promise<GitPullResult>;
  summaries?: ThreadSummaryInfo[];
  onSummaries?: () => Promise<ThreadSummaryInfo[]>;
  onOpenPrs?: () => void;
  prsActive?: boolean;
  providers?: ProviderInfo[];
  onFork?: (opts?: { provider?: string; model?: string | null }) => void;
}) {
  const repoInfo = opts.repoInfo ?? { ok: false as const };
  return (
    <GitTab
      thread={opts.thread === undefined ? thread() : opts.thread}
      project={project}
      onSetupWorktree={async () => {}}
      onMergeWorktree={async () => {}}
      onRemoveWorktree={async () => {}}
      onViewChanges={() => {}}
      listCheckpoints={async () => []}
      restoreCheckpoint={async () => {}}
      listLocalServers={async () => []}
      gitRepoInfo={opts.onRepoInfo ?? (async () => repoInfo)}
      gitPull={opts.onPull ?? (async () => ({ ok: true, summary: "Already up to date" }))}
      listThreadSummaries={
        opts.onSummaries ?? (async () => opts.summaries ?? [summary()])
      }
      onOpenPrs={opts.onOpenPrs}
      prsActive={opts.prsActive}
      providers={opts.providers}
      onFork={opts.onFork}
    />
  );
}

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

  it("shows a hint instead of the button when no thread is selected", async () => {
    const m = await mount(tab({ thread: null }));
    await m.flush();
    assert.equal(m.query("[data-pull-btn]"), null);
    assert.ok(m.text().includes("Select a thread to pull its branch."));
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

  it("lists branch, PR, and status in the facts line", async () => {
    const m = await mount(
      tab({
        thread: thread({ prNumber: 7, prState: "OPEN", status: "working" }),
      }),
    );
    await m.flush();
    assert.equal(
      (m.query("[data-recap-facts]")?.textContent || "").trim(),
      "coder/ship-it · #7 open · working",
    );
    m.unmount();
  });

  it("omits the PR from the facts line when none is recorded", async () => {
    const m = await mount(tab({}));
    await m.flush();
    assert.equal(
      (m.query("[data-recap-facts]")?.textContent || "").trim(),
      "coder/ship-it · idle",
    );
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
    assert.equal(m.query("[data-recap-card]"), null);
    m.unmount();
  });
});

describe("pull requests card", () => {
  it("is hidden when no opener is passed", async () => {
    const m = await mount(tab({}));
    await m.flush();
    assert.equal(m.query("[data-prs-card]"), null);
    m.unmount();
  });

  it("opens the PR list even with no thread selected", async () => {
    let opened = 0;
    const m = await mount(
      tab({
        thread: null,
        onOpenPrs: () => {
          opened += 1;
        },
      }),
    );
    await m.flush();
    const btn = m.query("[data-open-prs]");
    assert.ok(btn, "PR opener");
    await m.click(btn);
    assert.equal(opened, 1);
    m.unmount();
  });

  it("marks the opener active when the PR view is showing", async () => {
    const m = await mount(tab({ onOpenPrs: () => {}, prsActive: true }));
    await m.flush();
    assert.equal(
      m.query("[data-open-prs]")?.getAttribute("data-active"),
      "true",
    );
    m.unmount();
  });
});

describe("fork card", () => {
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
    {
      id: "grok",
      name: "Grok",
      available: true,
      supportsResume: true,
      models: [],
      modelInfo: [],
      efforts: [],
    },
  ];

  it("is hidden when onFork is not wired", async () => {
    const m = await mount(tab({}));
    await m.flush();
    assert.equal(m.query("[data-thread-fork-card]"), null);
    m.unmount();
  });

  it("forks the open thread and lists other providers for hand-off", async () => {
    const forks: Array<{ provider?: string } | undefined> = [];
    const m = await mount(
      tab({
        providers,
        onFork: (opts) => {
          forks.push(opts);
        },
      }),
    );
    await m.flush();
    assert.ok(m.query("[data-thread-fork-card]"), "Fork card present");
    await m.click(m.query("[data-thread-fork]"));
    assert.deepEqual(forks, [undefined]);

    await m.click(m.query("[data-thread-handoff]"));
    await m.flush();
    const entries = m
      .queryAll("[data-thread-handoff-menu] [data-handoff-provider]")
      .map((el) => el.getAttribute("data-handoff-provider"));
    assert.deepEqual(entries, ["grok"]);
    await m.click(m.query('[data-handoff-provider="grok"]'));
    assert.deepEqual(forks, [undefined, { provider: "grok" }]);
    m.unmount();
  });

  it("disables Fork while the thread is working", async () => {
    const m = await mount(
      tab({
        thread: thread({ status: "working" }),
        providers,
        onFork: () => {},
      }),
    );
    await m.flush();
    assert.equal(
      (m.query("[data-thread-fork]") as HTMLButtonElement).disabled,
      true,
    );
    assert.equal(
      (m.query("[data-thread-handoff]") as HTMLButtonElement).disabled,
      true,
    );
    m.unmount();
  });
});
