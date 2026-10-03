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
  TerminalState,
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

/** No shell under jsdom; the pane only needs the four calls to resolve. */
const fakeTerminalApi = {
  open: async () => idleTerminal(),
  write: async () => idleTerminal(),
  read: async () => idleTerminal(),
  close: async () => idleTerminal(),
};

function idleTerminal(): TerminalState {
  return {
    running: false,
    cwd: "/tmp/repo",
    shell: "/bin/zsh",
    cursor: 0,
    text: "",
    pending: "",
    reset: true,
    startedAt: 0,
  };
}

function view(props: {
  detail?: ThreadDetail | null;
  project?: ProjectInfo;
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
  onPanesNeedRoom?: () => void;
  onRunCommand?: (
    threadId: string,
    actionId?: string,
  ) => Promise<unknown>;
  onSetupWorktree?: () => Promise<unknown>;
  onMergeWorktree?: () => Promise<unknown>;
  onOpenCrewLead?: (leadId: string) => void;
  onRemoveWorktree?: (force?: boolean) => Promise<unknown>;
  workerCount?: number;
  onOpenWorkers?: () => void;
  handoffSource?: ThreadInfo | null;
  onSelectThread?: (id: string) => void;
  onSetPendingWorktree?: (
    threadId: string,
    worktree: boolean,
    fromOrigin?: boolean,
  ) => Promise<void>;
  listBaseBranches?: (
    projectId: string,
  ) => Promise<{ defaultBranch: string; branches: string[] }>;
  onSetBaseBranch?: (threadId: string, baseBranch: string | null) => Promise<void>;
  previousWorktree?: { branch: string; title: string } | null;
  heroProjects?: ProjectInfo[];
  onMoveDraftToProject?: (threadId: string, projectId: string) => void;
  onStartWithoutProject?: (threadId: string) => void;
}) {
  return (
    <ThreadView
      detail={props.detail === undefined ? detail() : props.detail}
      project={props.project ?? project}
      onRunCommand={props.onRunCommand}
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
      terminalApi={fakeTerminalApi}
      onPanesNeedRoom={props.onPanesNeedRoom}
      onFetchDiff={async () => ({ files: [], patch: "", truncated: false })}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={props.onPush ?? (async () => ({ remote: "origin", branch: "main" }))}
      gitSyncInfo={props.gitSyncInfo}
      gitFetch={props.gitFetch}
      onSetupWorktree={props.onSetupWorktree}
      onMergeWorktree={props.onMergeWorktree}
      onOpenCrewLead={props.onOpenCrewLead}
      onRemoveWorktree={props.onRemoveWorktree}
      workerCount={props.workerCount}
      onOpenWorkers={props.onOpenWorkers}
      handoffSource={props.handoffSource}
      onSelectThread={props.onSelectThread}
      onSetPendingWorktree={props.onSetPendingWorktree}
      listBaseBranches={props.listBaseBranches}
      onSetBaseBranch={props.onSetBaseBranch}
      previousWorktree={props.previousWorktree}
      heroProjects={props.heroProjects}
      onMoveDraftToProject={props.onMoveDraftToProject}
      onStartWithoutProject={props.onStartWithoutProject}
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
    await m.click(m.query("[data-thread-details-btn]"));
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
      await m.click(m.query("[data-thread-details-btn]"));
      const pill = m.query("[data-sync-pill]");
      assert.ok(pill, `pill visible for ${label}`);
      assert.equal((pill!.textContent || "").trim(), label);
      m.unmount();
    }
  });

  it("fetches when Thread details opens, then refetches and re-reads on click", async () => {
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
    await m.click(m.query("[data-thread-details-btn]"));
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

describe("worktree in Thread details (#680)", () => {
  it("is hidden until the worktree handlers are wired", async () => {
    const m = await mount(view({}));
    await m.flush();
    assert.equal(m.query("[data-thread-details-btn]"), null, "nothing to show, no details button");
    assert.equal(m.query("[data-worktree-control]"), null);
    m.unmount();
  });

  it("shows Merge onto destination in Thread details when the thread has a worktree", async () => {
    const merges: number[] = [];
    const m = await mount(
      view({
        onSetupWorktree: async () => {},
        onMergeWorktree: async () => {
          merges.push(1);
        },
        onRemoveWorktree: async () => {},
      }),
    );
    await m.flush();
    await m.click(m.query("[data-thread-details-btn]"));
    const header = m.query("[data-thread-header]");
    assert.ok(header, "thread header present");
    const merge = header!.querySelector("[data-worktree-merge]");
    assert.ok(merge, "Merge lives in Thread details");
    assert.equal((merge!.textContent || "").trim(), "Merge onto repo default");
    await m.click(merge);
    assert.equal(merges.length, 1);
    m.unmount();
  });

  it("shows Set up worktree in Thread details when the thread has none", async () => {
    const m = await mount(
      view({
        detail: detail({ thread: thread({ worktreePath: null }) }),
        onSetupWorktree: async () => {},
        onMergeWorktree: async () => {},
        onRemoveWorktree: async () => {},
      }),
    );
    await m.flush();
    await m.click(m.query("[data-thread-details-btn]"));
    const setup = m.query("[data-worktree-setup]");
    assert.ok(setup);
    assert.ok(m.query("[data-thread-header]")!.contains(setup));
    m.unmount();
  });

  it("shows the recorded stacked base on the worktree control (#187)", async () => {
    const m = await mount(
      view({
        detail: detail({ thread: thread({ baseBranch: "stacked-base" }) }),
        onSetupWorktree: async () => {},
        onMergeWorktree: async () => {},
        onRemoveWorktree: async () => {},
      }),
    );
    await m.flush();
    await m.click(m.query("[data-thread-details-btn]"));
    const header = m.query("[data-thread-header]");
    assert.ok(header, "thread header present");
    const stacked = header!.querySelector("[data-stacked-base]");
    assert.ok(stacked, "stacked-base label is shown");
    assert.equal((stacked!.textContent || "").trim(), "stacked-base");
    m.unmount();
  });

  it("names the merge destination on the Merge button (#954)", async () => {
    const m = await mount(
      view({
        detail: detail({ thread: thread({ baseBranch: "release" }) }),
        onSetupWorktree: async () => {},
        onMergeWorktree: async () => {},
        onRemoveWorktree: async () => {},
      }),
    );
    await m.flush();
    await m.click(m.query("[data-thread-details-btn]"));
    const merge = m.query("[data-thread-header] [data-worktree-merge]");
    assert.ok(merge);
    assert.equal((merge!.textContent || "").trim(), "Merge onto release");
    m.unmount();
  });

  it("points orchWorker threads at the lead Integration view (#954)", async () => {
    const opened: string[] = [];
    const merges: number[] = [];
    const m = await mount(
      view({
        detail: detail({
          thread: thread({
            orchWorker: true,
            handoffFrom: "lead-1",
            baseBranch: "main",
          }),
        }),
        onSetupWorktree: async () => {},
        onMergeWorktree: async () => {
          merges.push(1);
        },
        onRemoveWorktree: async () => {},
        onOpenCrewLead: (id: string) => {
          opened.push(id);
        },
      }),
    );
    await m.flush();
    await m.click(m.query("[data-thread-details-btn]"));
    const leadBtn = m.query("[data-thread-header] [data-crew-lead]");
    assert.ok(leadBtn, "crew workers get an Integrate from lead control");
    await m.click(leadBtn);
    assert.deepEqual(opened, ["lead-1"]);
    const merge = m.query("[data-thread-header] [data-worktree-merge]");
    assert.ok(merge);
    assert.equal((merge!.textContent || "").trim(), "Merge onto main");
    assert.equal(merges.length, 0, "Integrate from lead does not merge");
    m.unmount();
  });

  it("shows repo default when the stacked base is unset (#187)", async () => {
    const m = await mount(
      view({
        onSetupWorktree: async () => {},
        onMergeWorktree: async () => {},
        onRemoveWorktree: async () => {},
      }),
    );
    await m.flush();
    await m.click(m.query("[data-thread-details-btn]"));
    const stacked = m.query("[data-thread-header] [data-stacked-base]");
    assert.ok(stacked, "unset threads still name the merge base");
    assert.equal((stacked!.textContent || "").trim(), "repo default");
    m.unmount();
  });
});

describe("draft workspace strip under the composer", () => {
  const draft = () =>
    detail({ thread: thread({ worktreePath: null, branch: null }), messages: [] });

  it("lets a draft pick New worktree and a base branch, then names them", async () => {
    const calls: unknown[] = [];
    let current = draft();
    const m = await mount(
      view({
        detail: current,
        onSetPendingWorktree: async (id, worktree) => {
          calls.push(["worktree", id, worktree]);
        },
        listBaseBranches: async () => ({ defaultBranch: "main", branches: ["main", "release"] }),
        onSetBaseBranch: async (id, base) => {
          calls.push(["base", id, base]);
        },
      }),
    );
    await m.flush();
    const trigger = m.query("[data-workspace-trigger]");
    assert.ok(trigger, "strip renders on a draft");
    assert.equal(trigger!.getAttribute("data-workspace-trigger"), "local");
    assert.equal(m.query("[data-workspace-base]"), null, "no base picker for Local checkout");
    await m.click(trigger);
    await m.click(m.query('[data-workspace-option="worktree"]'));
    assert.deepEqual(calls, [["worktree", "t1", true]]);

    current = detail({ ...current, thread: { ...current.thread, pendingWorktree: true } });
    await m.rerender(
      view({
        detail: current,
        onSetPendingWorktree: async () => {},
        listBaseBranches: async () => ({ defaultBranch: "main", branches: ["main", "release"] }),
        onSetBaseBranch: async (id, base) => {
          calls.push(["base", id, base]);
        },
      }),
    );
    await m.flush();
    const base = m.query("[data-workspace-base]");
    assert.ok(base, "base picker for New worktree");
    assert.match(base!.textContent ?? "", /From main/);
    await m.click(base);
    await m.flush();
    await m.click(m.query('[data-workspace-base-option="release"]'));
    assert.deepEqual(calls.at(-1), ["base", "t1", "release"]);
    m.unmount();
  });

  it("offers Previous worktree: a fresh worktree stacked on the last worktree branch", async () => {
    const calls: unknown[] = [];
    const prev = { branch: "coder/api-contract-1a2b3c", title: "API contract" };
    const props = {
      onSetPendingWorktree: async (id: string, worktree: boolean) => {
        calls.push(["worktree", id, worktree]);
      },
      onSetBaseBranch: async (id: string, base: string | null) => {
        calls.push(["base", id, base]);
      },
      previousWorktree: prev,
    };
    const m = await mount(view({ detail: draft(), ...props }));
    await m.flush();
    await m.click(m.query("[data-workspace-trigger]"));
    const option = m.query('[data-workspace-option="previous"]');
    assert.ok(option, "Previous worktree is offered");
    assert.match(option!.textContent ?? "", /coder\/api-contract-1a2b3c/);
    await m.click(option);
    assert.deepEqual(calls, [
      ["worktree", "t1", true],
      ["base", "t1", "coder/api-contract-1a2b3c"],
    ]);

    // Armed + stacked on that branch reads as Previous worktree…
    const stacked = draft();
    stacked.thread = { ...stacked.thread, pendingWorktree: true, baseBranch: prev.branch };
    await m.rerender(view({ detail: stacked, ...props }));
    await m.flush();
    assert.equal(m.query("[data-workspace-trigger]")!.getAttribute("data-workspace-trigger"), "previous");
    assert.match(m.query("[data-workspace-trigger]")!.textContent ?? "", /Previous worktree/);

    // …and switching to plain New worktree drops the stacked base.
    calls.length = 0;
    await m.click(m.query("[data-workspace-trigger]"));
    await m.click(m.query('[data-workspace-option="worktree"]'));
    assert.deepEqual(calls, [
      ["worktree", "t1", true],
      ["base", "t1", null],
    ]);
    m.unmount();
  });

  it("toggles Start from origin in the base picker", async () => {
    const calls: unknown[] = [];
    const armed = draft();
    armed.thread = { ...armed.thread, pendingWorktree: true };
    const m = await mount(
      view({
        detail: armed,
        onSetPendingWorktree: async (id, worktree, fromOrigin) => {
          calls.push([id, worktree, fromOrigin]);
        },
        listBaseBranches: async () => ({ defaultBranch: "main", branches: ["main"] }),
        onSetBaseBranch: async () => {},
      }),
    );
    await m.flush();
    await m.click(m.query("[data-workspace-base]"));
    await m.flush();
    const toggle = m.query("[data-workspace-from-origin]") as HTMLInputElement;
    assert.ok(toggle, "Start from origin switch");
    assert.equal(toggle.checked, false);
    await m.click(toggle);
    assert.deepEqual(calls, [["t1", true, true]]);
    m.unmount();
  });

  it("hides Previous worktree when the project has no other worktree thread", async () => {
    const m = await mount(
      view({ detail: draft(), onSetPendingWorktree: async () => {}, onSetBaseBranch: async () => {} }),
    );
    await m.flush();
    await m.click(m.query("[data-workspace-trigger]"));
    assert.equal(m.query('[data-workspace-option="previous"]'), null);
    m.unmount();
  });

  it("is gone once the thread has a user message", async () => {
    const m = await mount(
      view({
        detail: detail({
          thread: thread({ worktreePath: null }),
          messages: [msg({ id: "u1", role: "user", text: "go" })],
        }),
        onSetPendingWorktree: async () => {},
      }),
    );
    await m.flush();
    assert.equal(m.query("[data-workspace-strip]"), null);
    m.unmount();
  });

  it("is gone once a worktree exists", async () => {
    const m = await mount(
      view({ detail: detail({ messages: [] }), onSetPendingWorktree: async () => {} }),
    );
    await m.flush();
    assert.equal(m.query("[data-workspace-strip]"), null);
    m.unmount();
  });

  it("shows a pending worktree in Thread details instead of Set up worktree", async () => {
    const m = await mount(
      view({
        detail: detail({
          thread: thread({ worktreePath: null, pendingWorktree: true, baseBranch: "release" }),
        }),
        onSetupWorktree: async () => {},
        onMergeWorktree: async () => {},
        onRemoveWorktree: async () => {},
      }),
    );
    await m.flush();
    await m.click(m.query("[data-thread-details-btn]"));
    assert.equal(m.query("[data-worktree-setup]"), null);
    const pending = m.query('[data-worktree-control="pending"]');
    assert.ok(pending);
    assert.match(pending!.textContent ?? "", /Worktree on first send · from release/);
    m.unmount();
  });
});

describe("thread title menu (#1411)", () => {
  it("the title opens the thread menu; there is no separate … button", async () => {
    const m = await mount(view({}));
    await m.flush();
    const title = m.query("[data-thread-title-menu]");
    assert.ok(title, "title is the menu trigger");
    assert.equal(title!.getAttribute("aria-label"), "Thread actions");
    assert.match(title!.textContent ?? "", /header features/);
    assert.equal(m.queryAll("[aria-label='Thread actions']").length, 1, "only one trigger");
    await m.click(title);
    assert.ok(m.query("[data-copy-thread-id]"), "menu items are there");
    m.unmount();
  });

  it("picks Summary / Normal / Verbose from the title menu", async () => {
    const m = await mount(view({}));
    await m.flush();
    await m.click(m.query("[data-thread-title-menu]"));
    for (const mode of ["summary", "normal", "verbose"]) {
      assert.ok(m.query(`[data-transcript-view-option='${mode}']`), mode);
    }
    await m.click(m.query("[data-transcript-view-option='summary']"));
    assert.equal(
      m.query("[data-transcript-view-mode]")?.getAttribute("data-transcript-view-mode"),
      "summary",
    );
    await m.click(m.query("[data-thread-title-menu]"));
    await m.click(m.query("[data-transcript-view-option='normal']"));
    m.unmount();
  });
});

describe("Thread details card rows (#1411)", () => {
  it("lists worktree, branch → base and the delete action as rows", async () => {
    const m = await mount(
      view({
        detail: detail({ thread: thread({ baseBranch: "release" }) }),
        onSetupWorktree: async () => {},
        onMergeWorktree: async () => {},
        onRemoveWorktree: async () => {},
      }),
    );
    await m.flush();
    await m.click(m.query("[data-thread-details-btn]"));
    const card = m.query("[data-thread-details]")!;
    assert.match(card.textContent ?? "", /Worktree\/tmp\/wt/);
    assert.match(card.textContent ?? "", /Branchcoder\/header-features-abc123→ release/);
    assert.ok(card.querySelector("[data-worktree-copy-path]"));
    assert.ok(card.querySelector("[data-worktree-merge]"));
    assert.ok(card.querySelector("[data-worktree-delete]"));
    assert.equal(card.querySelector("[data-worktree-menu]"), null, "no header pill inside the card");
    m.unmount();
  });

  it("offers Commit / Push / Create PR from what the branch needs", async () => {
    const opened: string[] = [];
    const m = await mount(
      view({
        onViewChanges: () => opened.push("changes"),
        gitFetch: async () => {},
        gitSyncInfo: async () => ({ hasUpstream: true, ahead: 2, behind: 0 }),
      }),
    );
    await m.flush();
    await m.click(m.query("[data-thread-details-btn]"));
    await m.flush();
    assert.ok(m.query("[data-details-push]"), "ahead → Push");
    assert.ok(m.query("[data-details-create-pr]"), "no PR yet → Create PR");
    assert.equal(m.query("[data-details-commit]"), null, "clean tree → no Commit");
    assert.match(m.query("[data-details-status]")?.textContent ?? "", /0 changed/);
    m.unmount();
  });

  it("puts the notes dot on the details toggle when the thread has notes", async () => {
    const m = await mount(
      view({
        detail: detail({ thread: thread({ notes: "ship after #42" }) }),
        gitFetch: async () => {},
        gitSyncInfo: async () => ({ hasUpstream: true, ahead: 0, behind: 0 }),
      }),
    );
    await m.flush();
    assert.ok(m.query("[data-thread-details-btn] [data-notes-dot]"));
    m.unmount();
  });
});

describe("new-thread hero (#1411)", () => {
  it("centres the draft and moves it to another project from the chooser", async () => {
    const moved: string[][] = [];
    const other = { ...project, id: "p2", slug: "acme/billing", name: "billing" };
    const m = await mount(
      view({
        detail: detail({ thread: thread({ worktreePath: null }), messages: [] }),
        heroProjects: [project, other],
        onMoveDraftToProject: (tid, pid) => moved.push([tid, pid]),
      }),
    );
    await m.flush();
    assert.ok(m.query("[data-pane-chat][data-draft-hero]"), "draft layout");
    assert.match(m.query("[data-draft-hero-title]")?.textContent ?? "", /What should we build in/);
    await m.click(m.query("[data-hero-project]"));
    await m.click(m.query('[data-hero-project-option="p2"]'));
    assert.deepEqual(moved, [["t1", "p2"]]);
    m.unmount();
  });

  it("offers 'or start without a project' and renders the Scratch variant", async () => {
    const started: string[] = [];
    const m = await mount(
      view({
        detail: detail({ thread: thread({ worktreePath: null }), messages: [] }),
        onStartWithoutProject: (id) => started.push(id),
        onSetPendingWorktree: async () => {},
      }),
    );
    await m.flush();
    await m.click(m.query("[data-start-without-project]"));
    assert.deepEqual(started, ["t1"]);
    m.unmount();

    const scratch = { ...project, id: "p-scratch", slug: "Scratch", name: "Scratch", scratch: true };
    const s2 = await mount(
      view({
        project: scratch,
        detail: detail({ thread: thread({ projectId: "p-scratch", worktreePath: null }), messages: [] }),
        heroProjects: [project, scratch],
        onMoveDraftToProject: () => {},
        onSetPendingWorktree: async () => {},
        onSetupWorktree: async () => {},
        onMergeWorktree: async () => {},
        onRemoveWorktree: async () => {},
      }),
    );
    await s2.flush();
    assert.match(s2.query("[data-draft-hero-title]")?.textContent ?? "", /What should we build\?/);
    assert.ok(s2.query("[data-hero-scratch]"));
    assert.equal(s2.query("[data-workspace-strip]"), null, "no worktree strip in Scratch");
    assert.equal(s2.query("[data-start-without-project]"), null);
    await s2.click(s2.query("[data-hero-project]"));
    assert.equal(s2.query('[data-hero-project-option="p-scratch"]'), null, "Scratch is not a move target");
    assert.ok(s2.query('[data-hero-project-option="p1"]'));
    s2.unmount();
  });

  it("drops the hero once the thread has messages", async () => {
    const m = await mount(
      view({ detail: detail({ messages: [msg({ id: "u1", role: "user", text: "go" })] }) }),
    );
    await m.flush();
    assert.equal(m.query("[data-draft-hero]"), null);
    assert.equal(m.query("[data-draft-hero-title]"), null);
    m.unmount();
  });
});

describe("worktree line at the top of the transcript (#1411)", () => {
  const sent = [msg({ id: "u1", role: "user", text: "go" })];

  it("says Worktree ready with branch and base once the worktree exists", async () => {
    const m = await mount(
      view({ detail: detail({ thread: thread({ baseBranch: "release" }), messages: sent }) }),
    );
    await m.flush();
    const line = m.query('[data-worktree-line="ready"]');
    assert.ok(line);
    assert.match(line!.textContent ?? "", /Worktree ready·coder\/header-features-abc123from release/);
    m.unmount();
  });

  it("says Setting up worktree while the first send materializes it", async () => {
    const m = await mount(
      view({
        detail: detail({
          thread: thread({ worktreePath: null, pendingWorktree: true, status: "working" }),
          messages: sent,
        }),
      }),
    );
    await m.flush();
    assert.ok(m.query('[data-worktree-line="setup"]'));
    m.unmount();
  });

  it("shows nothing for a draft, a plain thread, or a failed setup", async () => {
    for (const t of [
      { worktreePath: null, pendingWorktree: true },
      { worktreePath: null },
      { worktreePath: null, pendingWorktree: true, status: "failed" as const },
    ]) {
      const m = await mount(
        view({
          detail: detail({
            thread: thread(t),
            messages: t.pendingWorktree && !t.status ? [] : sent,
          }),
        }),
      );
      await m.flush();
      assert.equal(m.query("[data-worktree-line]"), null, JSON.stringify(t));
      m.unmount();
    }
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

  it("opens the Browser pane as a real preview, not a placeholder", async () => {
    const m = await mount(view({}));
    await m.flush();
    await m.click(m.query("[data-views-btn]"));
    await m.click(m.query("[data-views-item='browser']"));
    assert.ok(m.query("[data-browser-pane]"), "Browser pane mounts");
    assert.equal(m.query("[data-pane-placeholder='browser']"), null);
    assert.ok(m.query("[data-pane-chat]"), "chat stays");
    m.unmount();
  });

  it("keeps unbuilt pane types out of the Views menu", async () => {
    const m = await mount(view({}));
    await m.flush();
    await m.click(m.query("[data-views-btn]"));
    for (const type of ["files", "tasks", "subagent"]) {
      assert.equal(m.query(`[data-views-item='${type}']`), null, `${type} is not offered`);
    }
    assert.ok(m.query("[data-views-item='diff']"), "Git is offered");
    m.unmount();
  });

  it("toggles the terminal pane from the header", async () => {
    const m = await mount(view({}));
    await m.flush();
    const toggle = m.query("[data-terminal-toggle]");
    assert.ok(toggle);
    assert.equal(toggle!.getAttribute("aria-pressed"), "false");
    await m.click(toggle);
    assert.ok(m.query("[data-terminal-pane]"), "terminal pane opens");
    assert.equal(m.query("[data-terminal-toggle]")!.getAttribute("aria-pressed"), "true");
    await m.click(m.query("[data-terminal-toggle]"));
    assert.equal(m.query("[data-terminal-pane]"), null, "second click closes it");
    assert.equal(m.query("[data-terminal-toggle]")!.getAttribute("aria-pressed"), "false");
    assert.ok(m.query("[data-pane-chat]"), "chat stays");
    m.unmount();
  });

  it("opens Terminal as a pane beside chat, not a drawer", async () => {
    const m = await mount(view({}));
    await m.flush();
    await m.click(m.query("[data-views-btn]"));
    await m.click(m.query("[data-views-item='terminal']"));
    assert.ok(m.query("[data-terminal-pane]"), "terminal pane renders");
    assert.ok(m.query("[data-pane-chat]"), "chat stays");
    assert.equal(
      m.query("[data-pane-split]")?.getAttribute("data-pane-split"),
      "horizontal",
      "side by side, same split as Git",
    );
    m.unmount();
  });

  it("asks for room as soon as a second pane exists", async () => {
    let asked = 0;
    const m = await mount(view({ onPanesNeedRoom: () => (asked += 1) }));
    await m.flush();
    assert.equal(asked, 0, "chat alone does not collapse the agents rail");

    for (const type of ["terminal", "diff"]) {
      await m.click(m.query("[data-views-btn]"));
      await m.click(m.query(`[data-views-item='${type}']`));
    }
    await m.flush();
    assert.ok(asked >= 1, "opening a pane collapses the agents rail");
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

describe("project quick actions in Thread details (#153)", () => {
  it("hides the command row when the project has none", async () => {
    const m = await mount(view({ onRunCommand: async () => {} }));
    await m.flush();
    assert.equal(m.query("[data-thread-details-btn]"), null, "nothing to show, no details button");
    assert.equal(m.query("[data-thread-commands]"), null);
    m.unmount();
  });

  it("renders Setup and named actions and records the click", async () => {
    const calls: Array<{ threadId: string; actionId?: string }> = [];
    const m = await mount(
      view({
        project: {
          ...project,
          setupCommand: "npm install",
          quickActions: [
            { id: "lint", name: "Lint", command: "npm run lint" },
            { id: "db", name: "Reset db", command: "npm run db:reset" },
          ],
        },
        onRunCommand: async (threadId, actionId) => {
          calls.push({ threadId, actionId });
        },
      }),
    );
    await m.flush();
    await m.click(m.query("[data-thread-details-btn]"));
    assert.ok(m.query("[data-thread-commands]"));
    assert.ok(m.query('[data-thread-command="setup"]'));
    assert.equal(
      m.query('[data-thread-command="setup"]')?.textContent,
      "Setup",
    );
    assert.equal(m.query('[data-thread-command="lint"]')?.textContent, "Lint");
    assert.equal(
      m.query('[data-thread-command="db"]')?.textContent,
      "Reset db",
    );
    await m.click(m.query('[data-thread-command="lint"]'));
    await m.flush();
    assert.deepEqual(calls, [{ threadId: "t1", actionId: "lint" }]);
    m.unmount();
  });

  it("shows a thrown error next to the buttons", async () => {
    const m = await mount(
      view({
        project: {
          ...project,
          setupCommand: "npm install",
        },
        onRunCommand: async () => {
          throw new Error("A run is already active on this thread");
        },
      }),
    );
    await m.flush();
    await m.click(m.query("[data-thread-details-btn]"));
    await m.click(m.query('[data-thread-command="setup"]'));
    await m.flush();
    const err = m.query("[data-thread-command-error]");
    assert.ok(err);
    assert.match(err!.textContent || "", /already active/);
    m.unmount();
  });
});

describe("Workers header control and parent navigation", () => {
  it("shows Workers (n) and opens the inspector callback", async () => {
    const opened: number[] = [];
    const m = await mount(
      view({
        workerCount: 3,
        onOpenWorkers: () => {
          opened.push(1);
        },
      }),
    );
    await m.flush();
    const btn = m.query("[data-thread-header] [data-open-workers]");
    assert.ok(btn, "orchestrators with workers get a header control");
    assert.equal((btn!.textContent || "").trim(), "Workers (3)");
    assert.equal(btn!.getAttribute("aria-label"), "Workers (3)");
    await m.click(btn);
    assert.deepEqual(opened, [1]);
    m.unmount();
  });

  it("hides Workers on a single thread and when the opener is missing", async () => {
    const lone = await mount(view({ onOpenWorkers: () => {} }));
    await lone.flush();
    assert.equal(lone.query("[data-open-workers]"), null);
    lone.unmount();

    const counted = await mount(view({ workerCount: 2 }));
    await counted.flush();
    assert.equal(
      counted.query("[data-open-workers]"),
      null,
      "count without an opener does not render a dead control",
    );
    counted.unmount();
  });

  it("keeps worker task navigation persistent and distinct from a fork banner", async () => {
    const selected: string[] = [];
    const lead = thread({ id: "lead-1", title: "Lead task" });
    const m = await mount(
      view({
        detail: detail({
          thread: thread({
            orchWorker: true,
            handoffFrom: "lead-1",
            title: "Review permissions",
          }),
        }),
        handoffSource: lead,
        onSelectThread: (id) => {
          selected.push(id);
        },
      }),
    );
    await m.flush();
    assert.equal(m.query("[data-handoff-banner]"), null);
    assert.equal(
      m.query("[aria-label='Dismiss handoff banner']"),
      null,
    );
    const nav = m.query("[data-worker-nav]");
    assert.ok(nav, "crew workers get persistent task navigation");
    assert.ok((nav!.textContent || "").includes("Task"));
    assert.ok((nav!.textContent || "").includes("Lead task"));
    const link = m.query('[data-task-source="lead-1"]');
    assert.ok(link);
    await m.click(link as HTMLElement);
    assert.deepEqual(selected, ["lead-1"]);
    m.unmount();

    const nested = await mount(
      view({
        detail: detail({
          thread: thread({
            orchWorker: true,
            handoffFrom: "w1",
            title: "Nested helper",
          }),
        }),
        handoffSource: thread({
          id: "w1",
          title: "Review permissions",
          orchWorker: true,
        }),
      }),
    );
    await nested.flush();
    const nestedNav = nested.query("[data-worker-nav]");
    assert.ok(nestedNav);
    assert.match(nestedNav!.textContent || "", /^Parent worker/);
    assert.doesNotMatch(nestedNav!.textContent || "", /^Task /);
    nested.unmount();
  });

  it("keeps ordinary forks dismissible and labels a missing parent", async () => {
    const fork = await mount(
      view({
        detail: detail({
          thread: thread({
            handoffFrom: "lead-1",
            title: "Fork: Lead task",
          }),
        }),
        handoffSource: thread({ id: "lead-1", title: "Lead task" }),
      }),
    );
    await fork.flush();
    assert.equal(fork.query("[data-worker-nav]"), null);
    assert.ok(fork.query("[data-handoff-banner]"));
    assert.ok(fork.query("[aria-label='Dismiss handoff banner']"));
    await fork.click(fork.query("[aria-label='Dismiss handoff banner']"));
    await fork.flush();
    assert.equal(fork.query("[data-handoff-banner]"), null);
    fork.unmount();

    const missingFork = await mount(
      view({
        detail: detail({
          thread: thread({ handoffFrom: "gone" }),
        }),
      }),
    );
    await missingFork.flush();
    assert.ok(
      (missingFork.query("[data-handoff-missing]")?.textContent || "").includes(
        "Forked from a deleted thread",
      ),
    );
    missingFork.unmount();

    const missingTask = await mount(
      view({
        detail: detail({
          thread: thread({ orchWorker: true, handoffFrom: "gone" }),
        }),
      }),
    );
    await missingTask.flush();
    assert.equal(missingTask.query("[data-handoff-banner]"), null);
    assert.ok(missingTask.query("[data-worker-nav]"));
    assert.equal(
      missingTask.query("[aria-label='Dismiss handoff banner']"),
      null,
      "missing task parent stays on screen",
    );
    assert.equal(
      (missingTask.query("[data-worker-nav-missing]")?.textContent || "").trim(),
      "Task is no longer available",
    );
    missingTask.unmount();
  });
});
