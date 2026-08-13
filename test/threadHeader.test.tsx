/**
 * ThreadView header additions: "Worked for" run headers, sync pill, dev
 * dropdown, and Copy thread ID in the overflow menu.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  ChatMessage,
  DevServerState,
  GitSyncInfo,
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
    title: "header features",
    branch: "coder/header-features-abc123",
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

function msg(
  over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">,
): ChatMessage {
  return {
    id: over.id ?? `m-${over.role}-${over.createdAt ?? 1}`,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? null,
    tool: over.tool,
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

function view(props: {
  detail?: ThreadDetail;
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  gitFetch?: (threadId: string) => Promise<void>;
  listDevScripts?: (threadId: string) => Promise<string[]>;
  startDevServer?: (
    threadId: string,
    script: string,
  ) => Promise<DevServerState>;
  stopDevServer?: (threadId: string) => Promise<DevServerState>;
  devServerStatus?: (threadId: string) => Promise<DevServerState>;
  onPush?: () => Promise<{ remote: string; branch: string }>;
}) {
  return (
    <ThreadView
      detail={props.detail ?? detail()}
      project={project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={() => {}}
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
      onFetchDiff={async () => ({ files: [], patch: "", truncated: false })}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={props.onPush ?? (async () => ({ remote: "origin", branch: "main" }))}
      gitSyncInfo={props.gitSyncInfo}
      gitFetch={props.gitFetch}
      listDevScripts={props.listDevScripts}
      startDevServer={props.startDevServer}
      stopDevServer={props.stopDevServer}
      devServerStatus={props.devServerStatus}
    />
  );
}

afterEach(unmountAll);

const twoRuns = detail({
  messages: [
    msg({ id: "u1", role: "user", text: "first prompt", runId: "r1", createdAt: 1_000 }),
    msg({ id: "a1", role: "assistant", text: "FIRST_RUN_REPLY", runId: "r1", createdAt: 126_000 }),
    msg({ id: "u2", role: "user", text: "second prompt", runId: "r2", createdAt: 200_000 }),
    msg({ id: "a2", role: "assistant", text: "SECOND_RUN_REPLY", runId: "r2", createdAt: 210_000 }),
  ],
});

describe("run headers", () => {
  it("renders a Worked for header above each completed run", async () => {
    const m = await mount(view({ detail: twoRuns }));
    await m.flush();
    const headers = m.queryAll("[data-run-header]");
    assert.equal(headers.length, 2, "one header per completed run");
    assert.ok(
      (m.query("[data-run-header='r1']")?.textContent || "").includes(
        "Worked for 2m 5s",
      ),
      "first run duration",
    );
    assert.ok(
      (m.query("[data-run-header='r2']")?.textContent || "").includes(
        "Worked for 10s",
      ),
      "second run duration",
    );
    const html = m.html();
    assert.ok(
      html.indexOf("Worked for 2m 5s") < html.indexOf("first prompt"),
      "header sits above the run's first message",
    );
    m.unmount();
  });

  it("collapsing a run hides its messages but keeps the header", async () => {
    const m = await mount(view({ detail: twoRuns }));
    await m.flush();
    assert.ok(m.text().includes("FIRST_RUN_REPLY"));
    await m.click(m.query("[data-run-header='r1']"));
    await m.flush();
    assert.ok(
      !m.text().includes("FIRST_RUN_REPLY"),
      "collapsed run messages are hidden",
    );
    assert.ok(
      !m.text().includes("first prompt"),
      "the run's user message is hidden too",
    );
    assert.ok(
      m.text().includes("SECOND_RUN_REPLY"),
      "other runs stay visible",
    );
    assert.ok(m.query("[data-run-header='r1']"), "header row stays");
    await m.click(m.query("[data-run-header='r1']"));
    await m.flush();
    assert.ok(m.text().includes("FIRST_RUN_REPLY"), "expanding restores messages");
    m.unmount();
  });

  it("gives the in-progress run no header while the thread is working", async () => {
    const m = await mount(
      view({
        detail: detail({
          thread: thread({ status: "working", runStartedAt: 1 }),
          messages: [
            msg({ id: "a1", role: "assistant", text: "OLD_RUN", runId: "r1", createdAt: 1_000 }),
            msg({ id: "a2", role: "assistant", text: "LIVE_RUN", runId: "r2", createdAt: 2_000 }),
          ],
        }),
      }),
    );
    await m.flush();
    const headers = m.queryAll("[data-run-header]");
    assert.equal(headers.length, 1, "only the completed run gets a header");
    assert.ok(m.query("[data-run-header='r1']"));
    m.unmount();
  });
});

describe("sync pill", () => {
  it("is hidden without an upstream", async () => {
    const m = await mount(
      view({
        gitFetch: async () => {},
        gitSyncInfo: async () => ({ hasUpstream: false }),
      }),
    );
    await m.flush();
    assert.equal(m.query("[data-sync-pill]"), null);
    m.unmount();
  });

  it("is hidden entirely when no sync props are wired", async () => {
    const m = await mount(view({}));
    await m.flush();
    assert.equal(m.query("[data-sync-pill]"), null);
    m.unmount();
  });

  it("shows Synced, ahead, behind, and both", async () => {
    const cases: Array<[GitSyncInfo, string]> = [
      [{ hasUpstream: true, ahead: 0, behind: 0 }, "Synced"],
      [{ hasUpstream: true, ahead: 3, behind: 0 }, "3 ahead"],
      [{ hasUpstream: true, ahead: 0, behind: 2 }, "2 behind"],
      [{ hasUpstream: true, ahead: 3, behind: 2 }, "3 ahead · 2 behind"],
    ];
    for (const [info, label] of cases) {
      const m = await mount(
        view({ gitFetch: async () => {}, gitSyncInfo: async () => info }),
      );
      await m.flush();
      const pill = m.query("[data-sync-pill]");
      assert.ok(pill, `pill visible for ${label}`);
      assert.equal((pill!.textContent || "").trim(), label);
      m.unmount();
    }
  });

  it("fetches on mount and refetches then re-reads on click", async () => {
    const calls: string[] = [];
    const m = await mount(
      view({
        gitFetch: async () => {
          calls.push("fetch");
        },
        gitSyncInfo: async () => {
          calls.push("syncInfo");
          return { hasUpstream: true, ahead: 1, behind: 0 };
        },
      }),
    );
    await m.flush();
    assert.deepEqual(calls, ["fetch", "syncInfo"], "fetch then read on mount");
    await m.click(m.query("[data-sync-pill]"));
    await m.flush();
    assert.deepEqual(
      calls,
      ["fetch", "syncInfo", "fetch", "syncInfo"],
      "click fetches then re-reads",
    );
    m.unmount();
  });

  it("refetches after a push completes", async () => {
    let syncReads = 0;
    const m = await mount(
      view({
        gitFetch: async () => {},
        gitSyncInfo: async () => {
          syncReads += 1;
          return { hasUpstream: true, ahead: 1, behind: 0 };
        },
        onPush: async () => ({ remote: "origin", branch: "main" }),
      }),
    );
    await m.flush();
    assert.equal(syncReads, 1);
    const push = m.byText("Push");
    assert.ok(push, "Push button present");
    await m.click(push);
    await m.flush();
    assert.equal(syncReads, 2, "sync re-read after push");
    m.unmount();
  });
});

describe("dev dropdown", () => {
  it("starts and stops a script and shows the captured url", async () => {
    const calls: string[] = [];
    let current: DevServerState = { running: false };
    const m = await mount(
      view({
        listDevScripts: async () => ["dev", "start"],
        startDevServer: async (id, script) => {
          calls.push(`start:${id}:${script}`);
          current = {
            running: true,
            script,
            url: "http://localhost:5173/",
            startedAt: Date.now(),
          };
          return current;
        },
        stopDevServer: async (id) => {
          calls.push(`stop:${id}`);
          current = { running: false };
          return current;
        },
        devServerStatus: async () => current,
      }),
    );
    await m.flush();
    const btn = m.query("[data-dev-menu]") as HTMLButtonElement | null;
    assert.ok(btn, "dev menu button present");
    assert.ok(!btn!.disabled, "enabled with scripts");
    assert.match(btn!.textContent || "", /dev/);

    await m.click(btn);
    await m.flush();
    const rows = m.queryAll("[data-dev-script]");
    assert.equal(rows.length, 2, "one row per script");
    await m.click(m.query("[data-dev-script='dev']"));
    await m.flush();
    assert.deepEqual(calls, ["start:t1:dev"]);

    const link = m.query("[data-dev-url]") as HTMLAnchorElement | null;
    assert.ok(link, "captured url shows once running");
    assert.equal(link!.getAttribute("href"), "http://localhost:5173/");
    assert.equal(link!.getAttribute("target"), "_blank");

    const stop = m.query("[data-dev-stop]");
    assert.ok(stop, "Stop row while running");
    await m.click(stop);
    await m.flush();
    assert.deepEqual(calls, ["start:t1:dev", "stop:t1"]);
    assert.equal(m.query("[data-dev-stop]"), null, "Stop row gone once stopped");
    m.unmount();
  });

  it("is disabled with a tooltip when there are no runnable scripts", async () => {
    const m = await mount(
      view({
        listDevScripts: async () => [],
        startDevServer: async () => ({ running: false }),
        stopDevServer: async () => ({ running: false }),
        devServerStatus: async () => ({ running: false }),
      }),
    );
    await m.flush();
    const btn = m.query("[data-dev-menu]") as HTMLButtonElement | null;
    assert.ok(btn, "button still renders");
    assert.equal(btn!.disabled, true);
    assert.equal(btn!.getAttribute("title"), "No runnable scripts in package.json");
    await m.click(btn);
    await m.flush();
    assert.equal(m.query("[data-dev-popover]"), null, "no popover when disabled");
    m.unmount();
  });
});

describe("copy thread id", () => {
  it("copies the thread id and flashes Copied inline", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
      configurable: true,
    });
    const m = await mount(view({}));
    await m.flush();
    const menuBtn = m.query("[aria-label='Thread actions']");
    assert.ok(menuBtn, "overflow menu button");
    await m.click(menuBtn);
    await m.flush();
    const item = m.query("[data-copy-thread-id]");
    assert.ok(item, "Copy thread ID menu item");
    assert.equal((item!.textContent || "").trim(), "Copy thread ID");
    await m.click(item);
    await m.flush();
    assert.deepEqual(copied, ["t1"]);
    assert.equal(
      (m.query("[data-copy-thread-id]")?.textContent || "").trim(),
      "Copied",
      "inline confirmation",
    );
    m.unmount();
  });
});
