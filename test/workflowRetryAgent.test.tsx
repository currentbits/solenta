/**
 * Issue #825: Agents panel Retry on a failed workflow phase agent.
 *
 * Run: node --import=./test/support/render.mjs --test test/workflowRetryAgent.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { AgentsContent } from "../src/components/AgentsPanel";
import type {
  AgentView,
  ProviderInfo,
  ThreadInfo,
  WorkflowView,
} from "../src/shared/ipc";

const PROVIDERS: ProviderInfo[] = [
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
    title: "Plan the fix",
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "failed",
    lastError: "Run error",
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
    handoffFrom: null,
    ...over,
  };
}

function agent(over: Partial<AgentView> = {}): AgentView {
  return {
    id: "0:plan:0",
    model: "default",
    status: "failed",
    tokensUsed: 0,
    ...over,
  };
}

function workflow(over: Partial<WorkflowView> = {}): WorkflowView {
  return {
    id: "w1",
    name: "Retry plan",
    phases: [
      {
        name: "plan",
        pipelined: false,
        agents: [agent()],
      },
    ],
    settled: 1,
    total: 1,
    tokensTotal: 0,
    complete: false,
    ...over,
  };
}

function content(opts: {
  thread?: ThreadInfo;
  workflow?: WorkflowView;
  onRetryAgent?: (agentId: string) => void;
}) {
  return (
    <AgentsContent
      workflow={opts.workflow ?? workflow()}
      thread={opts.thread ?? thread()}
      usage={null}
      providers={PROVIDERS}
      onRetryAgent={opts.onRetryAgent}
    />
  );
}

describe("workflow Retry control (#825)", () => {
  it("shows Retry on a failed agent when the thread is idle", async () => {
    const m = await mount(
      content({ thread: thread({ status: "idle", lastError: null }) }),
    );
    const btn = m.query('[data-retry-agent="0:plan:0"]');
    assert.ok(btn, "failed phase must start open with a Retry control");
    assert.match(btn.textContent || "", /Retry/);
    m.unmount();
  });

  it("hides Retry while the thread is working", async () => {
    const m = await mount(
      content({
        thread: thread({ status: "working", lastError: null, runStartedAt: 1 }),
        workflow: workflow({
          phases: [
            {
              name: "plan",
              pipelined: false,
              agents: [agent({ status: "failed" })],
            },
          ],
        }),
      }),
    );
    assert.equal(m.query("[data-retry-agent]"), null);
    m.unmount();
  });

  it("does not offer Retry on a settled agent", async () => {
    const m = await mount(
      content({
        thread: thread({ status: "done", lastError: null }),
        workflow: workflow({
          complete: true,
          phases: [
            {
              name: "plan",
              pipelined: false,
              agents: [agent({ status: "settled", tokensUsed: 12 })],
            },
          ],
        }),
      }),
    );
    assert.equal(m.query("[data-retry-agent]"), null);
    m.unmount();
  });

  it("calls onRetryAgent with the failed slot id", async () => {
    const seen: string[] = [];
    const m = await mount(
      content({
        onRetryAgent: (id) => {
          seen.push(id);
        },
      }),
    );
    const btn = m.query('[data-retry-agent="0:plan:0"]');
    assert.ok(btn);
    await m.click(btn);
    assert.deepEqual(seen, ["0:plan:0"]);
    m.unmount();
  });
});
