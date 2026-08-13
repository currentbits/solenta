/**
 * Delegation command: "@provider task" in the composer forks the open thread
 * onto that provider, runs the task on the fork, then selects the fork.
 * Non-provider first tokens (@file.ts) keep the normal send path.
 *
 * Run: node --import=./test/support/render.mjs --test test/delegateSubmit.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type {
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

const CLAUDE: ProviderInfo = {
  id: "claude",
  name: "Claude Code",
  available: true,
  supportsResume: true,
  models: [],
  modelInfo: [],
  efforts: [],
};

const GROK: ProviderInfo = {
  id: "grok",
  name: "Grok",
  available: true,
  supportsResume: false,
  models: [],
  modelInfo: [],
  efforts: [],
};

const PROVIDERS: ProviderInfo[] = [CLAUDE, GROK];
const WORKFLOWS: WorkflowTemplateInfo[] = [];

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t-source",
    projectId: "p1",
    title: "source thread",
    branch: null,
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
    worktreePath: null,
    handoffFrom: null,
    ...over,
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

function view(calls: string[]) {
  return (
    <ThreadView
      detail={detail()}
      project={project}
      providers={PROVIDERS}
      workflows={WORKFLOWS}
      hasProjects={true}
      onAddProject={() => {}}
      onStartRun={async (prompt, threadId) => {
        calls.push(`run:${threadId ?? "selected"}:${prompt}`);
      }}
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
      onPush={async () => ({ remote: "origin", branch: "main" })}
      onFork={async (opts) => {
        calls.push(`fork:${opts?.provider ?? ""}`);
        return { id: `fork-${opts?.provider}` } as ThreadInfo;
      }}
      onSelectThread={(id) => {
        calls.push(`select:${id}`);
      }}
    />
  );
}

async function submit(m: Awaited<ReturnType<typeof mount>>, prompt: string) {
  await m.type(m.query("textarea"), prompt);
  await m.click(m.query('button[aria-label="Send"]'));
}

describe("delegation command", () => {
  it("@provider forks, runs the task on the fork, then selects it", async () => {
    const calls: string[] = [];
    const m = await mount(view(calls));
    await submit(m, "@grok fix the flaky test");

    assert.deepEqual(calls, [
      "fork:grok",
      "run:fork-grok:fix the flaky test",
      "select:fork-grok",
    ]);
    assert.equal(
      (m.query("textarea") as HTMLTextAreaElement).value,
      "",
      "success clears the composer",
    );
    m.unmount();
  });

  it("@file.ts mention stays a normal send on the current thread", async () => {
    const calls: string[] = [];
    const m = await mount(view(calls));
    await submit(m, "@src/App.ts summarize this");

    assert.deepEqual(calls, ["run:selected:@src/App.ts summarize this"]);
    m.unmount();
  });

  it("an uninstalled provider id stays a normal send", async () => {
    const calls: string[] = [];
    const m = await mount(view(calls));
    await submit(m, "@kimi fix the flaky test");

    assert.deepEqual(calls, ["run:selected:@kimi fix the flaky test"]);
    m.unmount();
  });

  it("the placeholder hints at delegation", async () => {
    const m = await mount(view([]));
    const ta = m.query("textarea") as HTMLTextAreaElement;
    assert.match(ta.placeholder, /@provider delegates/);
    m.unmount();
  });
});
