/**
 * External pairing approval card (#157).
 * Run: node --import=./test/support/render.mjs --test test/pairingApproval.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mount, unmountAll } from "./support/dom.ts";
import { ThreadView } from "../src/components/ThreadView";
import type { ProjectInfo, ProviderInfo, ThreadDetail, ThreadInfo } from "../src/shared/ipc";

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

function thread(extra: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t1",
    projectId: "p1",
    title: "fix 123",
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    lastError: null,
    lastErrorKind: null,
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
    pairingId: "pair-1",
    pairingLabel: "Claude Desktop",
    pendingExternalApproval: true,
    pendingExternalPrompt: "fix issue 123 in a worktree",
    ...extra,
  };
}

afterEach(() => {
  unmountAll();
  delete (window as unknown as { coder?: unknown }).coder;
});

describe("pairing approval card", () => {
  it("shows the pairing prompt and Approve calls pairing.approve", async () => {
    const calls: unknown[] = [];
    const shell = await mount(<div />);
    (window as unknown as { coder: { pairing: unknown } }).coder = {
      pairing: {
        approve: async (input: unknown) => {
          calls.push(["approve", input]);
          return { runId: "r1" };
        },
        reject: async (input: unknown) => {
          calls.push(["reject", input]);
          return {};
        },
      },
    };
    shell.unmount();
    const detail: ThreadDetail = {
      thread: thread(),
      messages: [],
      workLog: [],
      workflow: null,
      usage: null,
      pendingPermission: null,
    };
    const view = await mount(
      <ThreadView
        detail={detail}
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
        onRespondPermission={() => {}}
        onSetProvider={() => {}}
        onSetReasoningEffort={() => {}}
        onSetArchived={() => {}}
        onDeleteThread={() => {}}
      />,
    );
    await view.flush();
    assert.ok(view.query("[data-external-approval]"), "approval card");
    assert.ok(
      view.text().includes("Claude Desktop"),
      `expected pairing label, got: ${view.text()}`,
    );
    assert.ok(
      view.text().includes("fix issue 123 in a worktree"),
      `expected prompt, got: ${view.text()}`,
    );
    await view.click(view.query("[data-external-approve]") as HTMLElement);
    await view.flush();
    assert.deepEqual(calls, [["approve", { threadId: "t1" }]]);
    view.unmount();
  });
});
