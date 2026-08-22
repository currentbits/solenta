/**
 * ThreadView header additions: "Worked for" run headers, sync pill,
 * and Copy thread ID in the overflow menu.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { useState } from "react";
import { mount, unmountAll } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import {
  defaultPaneLayout,
  openPane,
  savePaneLayout,
} from "../src/paneLayout";
import type {
  ChatMessage,
  GitSyncInfo,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";
import { setRunDurationEnabled } from "../src/uiPrefs";

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
  detail?: ThreadDetail | null;
  gitSyncInfo?: (threadId: string) => Promise<GitSyncInfo>;
  gitFetch?: (threadId: string) => Promise<void>;
  onPush?: () => Promise<{ remote: string; branch: string }>;
  onStartRun?: (prompt: string, threadId?: string) => void | Promise<void>;
  onRepeatSchedule?: () => void;
  onDistillWorkflow?: () => void;
  onCreateThread?: (
    projectId?: string,
    opts?: { worktree?: boolean; orchestrate?: boolean },
  ) => void;
  onRenameThread?: (title: string) => void | Promise<void>;
  onSetCrossThreadInbound?: (
    policy: "accept" | "queue-only" | "refuse",
  ) => void | Promise<void>;
  changesOpen?: boolean;
  onViewChanges?: () => void;
  onCloseChanges?: () => void;
}) {
  return (
    <ThreadView
      detail={props.detail === undefined ? detail() : props.detail}
      project={project}
      providers={providers}
      workflows={[]}
      hasProjects={true}
      onAddProject={() => {}}
      onCreateThread={props.onCreateThread}
      onRenameThread={props.onRenameThread}
      onStartRun={props.onStartRun ?? (() => {})}
      onStartWorkflow={() => {}}
      onSaveWorkflow={noopSave}
      onRemoveWorkflow={async () => {}}
      onStopRun={() => {}}
      onSetPermissionMode={() => {}}
      onSetProvider={() => {}}
      onSetReasoningEffort={() => {}}
      onSetArchived={() => {}}
      onSetCrossThreadInbound={props.onSetCrossThreadInbound}
      onRepeatSchedule={props.onRepeatSchedule}
      onDistillWorkflow={props.onDistillWorkflow}
      onDeleteThread={() => {}}
      changesOpen={props.changesOpen ?? false}
      changesNonce={0}
      onCloseChanges={props.onCloseChanges ?? (() => {})}
      onViewChanges={props.onViewChanges}
      onFetchDiff={async () => ({ files: [], patch: "", truncated: false })}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={props.onPush ?? (async () => ({ remote: "origin", branch: "main" }))}
      gitSyncInfo={props.gitSyncInfo}
      gitFetch={props.gitFetch}
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

describe("time spent in the message footer", () => {
  const withWorkLog = detail({
    messages: twoRuns.messages,
    workLog: [
      { id: "w1", runId: "r1", label: "step", done: true, timestamp: 1_000 },
      { id: "w2", runId: "r1", label: "step", done: true, timestamp: 126_000 },
    ],
  });

  it("is off by default and appears once the pref is on", async () => {
    const off = await mount(view({ detail: withWorkLog }));
    await off.flush();
    assert.ok(
      !off.text().includes("2m 5s ·"),
      "no duration segment in the footer by default",
    );
    off.unmount();

    setRunDurationEnabled(true);
    try {
      const on = await mount(view({ detail: withWorkLog }));
      await on.flush();
      assert.ok(on.text().includes("2m 5s ·"), "duration segment once enabled");
      on.unmount();
    } finally {
      setRunDurationEnabled(false);
    }
  });
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
    assert.ok(calls.includes("fetch"), "fetch on mount");
    assert.ok(calls.includes("syncInfo"), "sync read on mount");
    const fetches = calls.filter((c) => c === "fetch").length;
    const reads = calls.filter((c) => c === "syncInfo").length;
    await m.click(m.query("[data-sync-pill]"));
    await m.flush();
    assert.equal(
      calls.filter((c) => c === "fetch").length,
      fetches + 1,
      "click fetches",
    );
    assert.equal(
      calls.filter((c) => c === "syncInfo").length,
      reads + 1,
      "click re-reads",
    );
    m.unmount();
  });

  it("refetches after a push completes", async () => {
    let syncReads = 0;
    const m = await mount(
      view({
        detail: detail({
          thread: thread({
            prNumber: 4,
            prUrl: "https://github.com/acme/repo/pull/4",
            prState: "OPEN",
          }),
        }),
        gitFetch: async () => {},
        gitSyncInfo: async () => {
          syncReads += 1;
          return { hasUpstream: true, ahead: 1, behind: 0 };
        },
        onPush: async () => ({ remote: "origin", branch: "main" }),
      }),
    );
    await m.flush();
    const before = syncReads;
    assert.ok(before >= 1, "sync read on mount");
    const push = m.byText("Push");
    assert.ok(push, "Push button present");
    await m.click(push);
    await m.flush();
    assert.ok(syncReads > before, "sync re-read after push");
    m.unmount();
  });
});

describe("header no longer hosts Environment actions", () => {
  it("does not render a dev menu, Fork, or Hand off in the thread header", async () => {
    const m = await mount(view({}));
    await m.flush();
    const header = m.query("header");
    assert.ok(header, "thread header present");
    assert.equal(header!.querySelector("[data-dev-menu]"), null);
    assert.equal(header!.querySelector("[data-thread-fork]"), null);
    assert.equal(header!.querySelector("[data-thread-handoff]"), null);
    m.unmount();
  });
});

describe("Views menu pane workspace (issue #552)", () => {
  it("defaults to chat only, with a Views menu in the session toolbar", async () => {
    const m = await mount(view({}));
    await m.flush();
    assert.ok(m.query("[data-views-btn]"), "Views control");
    assert.ok(m.query("[data-pane-chat]"), "chat leaf");
    assert.equal(m.query("[data-git-pane]"), null);
    m.unmount();
  });

  it("opens Git beside chat from Views and reports onViewChanges", async () => {
    const opened: string[] = [];
    const m = await mount(
      view({
        onViewChanges: () => {
          opened.push("git");
        },
      }),
    );
    await m.flush();
    await m.click(m.query("[data-views-btn]"));
    await m.click(m.query("[data-views-item='diff']"));
    assert.deepEqual(opened, ["git"]);
    assert.ok(m.query("[data-git-pane]"), "Git pane mounts");
    assert.ok(m.query("[data-pane-chat]"), "chat stays visible");
    m.unmount();
  });

  it("mounts Git when changesOpen is already true (Environment / next-git)", async () => {
    const open = await mount(view({ changesOpen: true }));
    await open.flush();
    assert.ok(open.query("[data-git-pane]"), "Git pane mounts when open");
    assert.ok(open.query("[data-pane-chat]"), "chat stays beside Git");
    open.unmount();
  });

  it("Reset layout restores a single chat pane", async () => {
    const closed: string[] = [];
    const m = await mount(
      view({
        changesOpen: true,
        onCloseChanges: () => {
          closed.push("thread");
        },
      }),
    );
    await m.flush();
    await m.click(m.query("[data-views-btn]"));
    await m.click(m.query("[data-views-reset]"));
    assert.equal(m.query("[data-git-pane]"), null);
    assert.ok(m.query("[data-pane-chat]"));
    assert.deepEqual(closed, ["thread"]);
    m.unmount();
  });

  it("reloads a persisted layout when an already-mounted ThreadView receives a thread", async () => {
    savePaneLayout(
      "t-restore",
      openPane(defaultPaneLayout(), "diff", "pane-1").layout,
    );

    function Harness() {
      const [d, setD] = useState<ThreadDetail | null>(null);
      return (
        <>
          <button
            type="button"
            data-open-thread=""
            onClick={() =>
              setD(detail({ thread: thread({ id: "t-restore" }) }))
            }
          >
            Open
          </button>
          {view({ detail: d })}
        </>
      );
    }

    const m = await mount(<Harness />);
    await m.flush();
    assert.equal(
      m.query("[data-git-pane]"),
      null,
      "empty state has no git pane",
    );
    await m.click(m.query("[data-open-thread]"));
    assert.ok(
      m.query("[data-git-pane]"),
      "selecting a thread must restore its saved split, not a fresh chat-only default",
    );
    m.unmount();
  });

  it("does not leak one thread's split onto the next thread", async () => {
    savePaneLayout(
      "t-a",
      openPane(defaultPaneLayout(), "diff", "pane-1").layout,
    );
    savePaneLayout("t-b", defaultPaneLayout());

    function Harness() {
      const [id, setId] = useState("t-a");
      return (
        <>
          <button type="button" data-go="t-b" onClick={() => setId("t-b")}>
            B
          </button>
          {view({ detail: detail({ thread: thread({ id }) }) })}
        </>
      );
    }

    const m = await mount(<Harness />);
    await m.flush();
    assert.ok(m.query("[data-git-pane]"), "thread A restores Git");
    await m.click(m.query("[data-go='t-b']"));
    assert.equal(
      m.query("[data-git-pane]"),
      null,
      "thread B stays chat-only; A's split must not write under B's key",
    );
    m.unmount();
  });

  it("opens an unshipped pane type as a placeholder slot", async () => {
    const m = await mount(view({}));
    await m.flush();
    await m.click(m.query("[data-views-btn]"));
    await m.click(m.query("[data-views-item='terminal']"));
    assert.ok(
      m.query("[data-pane-placeholder='terminal']"),
      "terminal registers as a pane even before the PTY lands",
    );
    assert.ok(m.query("[data-pane-chat]"), "chat stays");
    m.unmount();
  });

  it("keeps Spec / Teach / Ask off the header chrome", async () => {
    const m = await mount(view({}));
    await m.flush();
    const header = m.query("header");
    assert.equal(header!.querySelector("[data-spec-mode-btn]"), null);
    assert.equal(header!.querySelector("[data-teach-mode-btn]"), null);
    assert.equal(header!.querySelector("[data-ask-mode-btn]"), null);
    m.unmount();
  });
});

describe("repeat-thread overflow items", () => {
  it("shows Schedule and Distill when idle and the props are wired", async () => {
    const m = await mount(
      view({
        onRepeatSchedule: () => {},
        onDistillWorkflow: () => {},
      }),
    );
    await m.flush();
    const menuBtn = m.query("[aria-label='Thread actions']");
    assert.ok(menuBtn);
    await m.click(menuBtn);
    assert.ok(m.query("[data-repeat-schedule]"));
    assert.ok(m.query("[data-distill-workflow]"));
    m.unmount();
  });

  it("hides Schedule and Distill while the thread is working", async () => {
    const m = await mount(
      view({
        detail: detail({ thread: thread({ status: "working" }) }),
        onRepeatSchedule: () => {},
        onDistillWorkflow: () => {},
      }),
    );
    await m.flush();
    await m.click(m.query("[aria-label='Thread actions']"));
    assert.equal(m.query("[data-repeat-schedule]"), null);
    assert.equal(m.query("[data-distill-workflow]"), null);
    m.unmount();
  });
});

describe("inbound policy overflow (issue #551)", () => {
  it("lets the receiver pick accept / queue-only / refuse", async () => {
    const picked: string[] = [];
    const m = await mount(
      view({
        onSetCrossThreadInbound: (policy) => {
          picked.push(policy);
        },
      }),
    );
    await m.flush();
    await m.click(m.query("[aria-label='Thread actions']"));
    assert.ok(m.query("[data-inbound-policy-menu]"));
    const refuse = m.query("[data-inbound-policy='refuse']");
    assert.ok(refuse);
    await m.click(refuse);
    assert.deepEqual(picked, ["refuse"]);
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

describe("create PR button", () => {
  it("asks the agent to open a PR with the provider-name bullet", async () => {
    const prompts: string[] = [];
    const m = await mount(
      view({
        gitSyncInfo: async () => ({ hasUpstream: true, ahead: 0, behind: 0 }),
        onStartRun: (prompt) => {
          prompts.push(prompt);
        },
      }),
    );
    await m.flush();
    const btn = m.query("[data-create-pr]");
    assert.ok(btn, "Create PR button");
    await m.click(btn);
    await m.flush();
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]!.includes("pull request"));
    assert.ok(
      prompts[0]!.includes('"- PR created by the Claude Code agent"'),
      "prompt must carry the provider-name bullet",
    );
    m.unmount();
  });
});

describe("breadcrumb new thread (issue #445)", () => {
  it("turns the project slug into New thread in {slug}", async () => {
    const m = await mount(view({ onCreateThread: () => {} }));
    await m.flush();
    const slug = m.query("[data-new-thread-in]") as HTMLButtonElement | null;
    assert.ok(slug, "project slug is a create control");
    assert.equal(slug!.tagName, "BUTTON");
    assert.equal(slug!.textContent?.trim(), "owner/repo");
    assert.equal(slug!.getAttribute("aria-label"), "New thread in owner/repo");
    assert.equal(slug!.getAttribute("title"), "New thread in owner/repo");
    m.unmount();
  });

  it("click calls onCreateThread with the thread project and no extra opts", async () => {
    const calls: Array<{
      projectId?: string;
      opts?: { worktree?: boolean; orchestrate?: boolean };
    }> = [];
    const m = await mount(
      view({
        onCreateThread: (projectId, opts) => {
          calls.push({ projectId, opts });
        },
      }),
    );
    await m.flush();
    await m.click(m.query("[data-new-thread-in]"));
    await m.flush();
    assert.deepEqual(calls, [{ projectId: "p1", opts: undefined }]);
    m.unmount();
  });

  it("does not steal a title rename click", async () => {
    const creates: string[] = [];
    const m = await mount(
      view({
        onCreateThread: (projectId) => {
          creates.push(projectId ?? "");
        },
        onRenameThread: () => {},
      }),
    );
    await m.flush();
    const title = [...m.container.querySelectorAll("span")].find(
      (el) => el.textContent === "header features",
    );
    assert.ok(title, "thread title stays a separate control");
    await m.click(title);
    await m.flush();
    assert.deepEqual(creates, [], "title click must not create a thread");
    assert.equal(
      m.query("[data-thread-title-input]"),
      null,
      "slug is the only breadcrumb control; title is not a create button",
    );
    m.unmount();
  });
});
