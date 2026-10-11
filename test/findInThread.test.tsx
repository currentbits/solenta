/**
 * Find in thread / diffs (#1524).
 * Run: npm run test:renderer -- --test-name-pattern="Find in"
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import { TurnDiffPanel } from "../src/components/TurnDiffPanel";
import { setMacPlatformForTests } from "../src/keybindings";
import { KEYBINDINGS } from "../src/keybindings";
import type {
  ChatMessage,
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

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "find me",
    branch: "coder/find-me",
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

function view(d: ThreadDetail, extra: { changesOpen?: boolean; diff?: DiffResult } = {}) {
  return (
    <ThreadView
      detail={d}
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
      changesOpen={extra.changesOpen ?? false}
      changesNonce={extra.changesOpen ? 1 : 0}
      onCloseChanges={() => {}}
      onFetchDiff={async () => extra.diff ?? { files: [], patch: "", truncated: false }}
      onCommitChanges={async () => ({ subject: "x" })}
      onRevertFile={async (path) => ({ path })}
      onSuggestCommitMessage={async () => ({ message: "feat: x" })}
      onPush={async () => ({ remote: "origin", branch: "main" })}
    />
  );
}

async function pressFind(target?: Element | null) {
  await inAct(() => {
    const el = target ?? window;
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

afterEach(() => {
  setMacPlatformForTests(null);
});

describe("Find in thread", () => {
  it("registers both find chords in the keybinding table", () => {
    assert.ok(KEYBINDINGS.some((d) => d.id === "transcript.find" && d.chord === "mod+f"));
    assert.ok(KEYBINDINGS.some((d) => d.id === "diff.find" && d.chord === "mod+f"));
  });

  it("opens a find bar, highlights the match, steps, and closes on Escape", async () => {
    setMacPlatformForTests(true);
    const m = await mount(
      view(
        detail({
          messages: [
            msg({ id: "u1", role: "user", text: "please fix the login timeout", createdAt: 1 }),
            msg({ id: "t1", role: "tool", text: "Bash: npm test", createdAt: 2, tool: {
              id: "tc1",
              name: "Bash",
              input: "npm test",
              output: "ok",
              done: true,
              isError: false,
            } }),
            msg({ id: "a1", role: "assistant", text: "I bumped the login timeout.", createdAt: 3 }),
          ],
        }),
      ),
    );
    await pressFind();
    const bar = m.query("[data-find-bar='transcript']");
    assert.ok(bar, "find bar opens");
    await m.type(m.query("[data-find-input]"), "timeout");
    await m.flush();
    assert.equal(m.query("[data-find-count]")?.textContent, "1/2");
    assert.ok(m.query('[data-message-id="u1"][data-find-current]'));
    await m.press(m.query("[data-find-input]"), "Enter");
    await m.flush();
    assert.equal(m.query("[data-find-count]")?.textContent, "2/2");
    assert.ok(m.query('[data-message-id="a1"][data-find-current]'));
    await inAct(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    assert.equal(m.query("[data-find-bar]"), null);
    m.unmount();
  });

  it("finds text on the plan card", async () => {
    setMacPlatformForTests(true);
    const m = await mount(
      view(
        detail({
          thread: thread({
            plan: "Harden the auth session",
            planSteps: [{ step: "Raise the login timeout", status: "todo" }],
          }),
          messages: [msg({ id: "u1", role: "user", text: "go", createdAt: 1 })],
        }),
      ),
    );
    await pressFind();
    await m.type(m.query("[data-find-input]"), "Harden");
    await m.flush();
    assert.equal(m.query("[data-find-count]")?.textContent, "1/1");
    assert.ok(m.query("[data-plan-card][data-find-current]"));
    m.unmount();
  });
});

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
    "diff --git a/notes.txt b/notes.txt",
    "--- /dev/null",
    "+++ b/notes.txt",
    "@@ -0,0 +1 @@",
    "+hello unique-note",
  ].join("\n"),
  truncated: false,
};

describe("Find in diffs", () => {
  it("searches loaded patches and selects the matching file", async () => {
    setMacPlatformForTests(true);
    const m = await mount(view(detail(), { changesOpen: true, diff: DIFF }));
    await m.flush();
    const pane = m.query("[data-git-pane]");
    assert.ok(pane, "git pane");
    await pressFind(pane);
    assert.ok(m.query("[data-find-bar='diff']"), "diff find bar");
    await m.type(m.query("[data-find-input]"), "unique-note");
    await m.flush();
    assert.equal(m.query("[data-find-count]")?.textContent, "1/1");
    assert.ok(m.query('[data-file-path="notes.txt"][data-find-current]'));
    m.unmount();
  });

  it("finds a turn-diff file and selects it", async () => {
    setMacPlatformForTests(true);
    const m = await mount(
      <TurnDiffPanel
        threadId="t1"
        sha="sha-turn-2"
        turn={2}
        mode="unified"
        onModeChange={() => {}}
        onFetch={async () => DIFF}
      />,
    );
    await m.flush();
    const panel = m.query("[data-turn-diff]");
    assert.ok(panel);
    await pressFind(panel);
    await m.type(m.query("[data-find-input]"), "hello");
    await m.flush();
    assert.equal(m.query("[data-find-count]")?.textContent, "1/1");
    assert.ok(m.query('[data-turn-diff-file="notes.txt"][data-find-current]'));
    m.unmount();
  });
});
