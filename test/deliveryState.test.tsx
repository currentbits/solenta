/**
 * Issue #314 renderer: stalled badge / strip and queued-error retry.
 *
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { mount } from "./support/dom.ts";
import { ThreadCard } from "../src/components/Sidebar";
import { ThreadView } from "../src/components/ThreadView";
import { thread } from "./support/fakeCoder.ts";
import type {
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  WorkflowTemplateInfo,
} from "../src/shared/ipc";

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

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

const workflows: WorkflowTemplateInfo[] = [];
const noopAsync = async () => {};
const noopSave = async () =>
  ({ id: "wf", name: "standard", phases: [] }) as WorkflowTemplateInfo;

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    thread: thread(),
    messages: [],
    workLog: [],
    workflow: null,
    usage: null,
    ...over,
  };
}

function view(props: {
  threadOver?: Parameters<typeof thread>[0];
  queuedPrompt?: string | null;
  queuedError?: string | null;
  onRetryQueued?: () => void;
  onCancelQueued?: () => void;
}) {
  const t = thread({
    status: "working",
    runStartedAt: 1,
    ...props.threadOver,
  });
  return (
    <ThreadView
      detail={detail({ thread: t })}
      project={project}
      providers={providers}
      workflows={workflows}
      hasProjects
      onAddProject={() => {}}
      onStartRun={() => {}}
      onStartWorkflow={() => {}}
      onSaveWorkflow={noopSave}
      onRemoveWorkflow={noopAsync}
      onStopRun={() => {}}
      queuedPrompt={props.queuedPrompt ?? null}
      queuedError={props.queuedError ?? null}
      onCancelQueued={props.onCancelQueued}
      onRetryQueued={props.onRetryQueued}
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
    />
  );
}

describe("stalled badge (issue #314)", () => {
  it("renders Stalled with elapsed, no spinner, when working+stalledAt", async () => {
    const now = 1_000_000;
    const m = await mount(
      <ThreadCard
        thread={thread({
          status: "working",
          runStartedAt: now - 70 * 60 * 1000,
          stalledAt: now - 12 * 60 * 1000,
        })}
        slug="acme/ledger"
        providers={providers}
        active={false}
        now={now}
        onSelect={() => {}}
      />,
    );
    const badge =
      m.query("[data-stalled]") || m.query("[data-status-label]");
    assert.ok(badge, "Stalled label must render");
    assert.match(badge!.textContent || "", /^Stalled/);
    assert.match(badge!.getAttribute("title") || "", /Stalled/);
    assert.match(badge!.getAttribute("title") || "", /12m/);
    assert.equal(m.query("[data-status-dot]"), null);
    assert.equal(
      badge!.querySelector("[class*='spinner']"),
      null,
      "stalled is not a spinner",
    );
    m.unmount();
  });

  it("keeps Waiting when awaitingInput even if stalledAt is set", async () => {
    const now = 1_000_000;
    const m = await mount(
      <ThreadCard
        thread={thread({
          status: "working",
          awaitingInput: true,
          stalledAt: now - 12 * 60 * 1000,
        })}
        slug="acme/ledger"
        providers={providers}
        active={false}
        now={now}
        onSelect={() => {}}
      />,
    );
    assert.equal(m.query("[data-stalled]"), null);
    const waiting =
      m.query("[data-waiting]") || m.query("[data-status-label]");
    assert.ok(waiting, "Waiting label must render instead");
    assert.match(waiting!.textContent || "", /^Waiting/);
    assert.match(waiting!.getAttribute("title") || "", /Waiting for input/);
    const pulse = m.query("[data-status-dot]");
    assert.ok(pulse, "waiting keeps a title-adjacent pulse");
    assert.equal(pulse!.getAttribute("data-status-dot"), "waiting");
    m.unmount();
  });
});

describe("thread stalled strip + queued error (issue #314)", () => {
  it("replaces Agent working… with a hung warning when stalled", () => {
    const now = Date.now();
    const html = renderToStaticMarkup(
      view({
        threadOver: {
          status: "working",
          runStartedAt: now - 70 * 60 * 1000,
          stalledAt: now - 12 * 60 * 1000,
        },
      }),
    );
    assert.match(html, /No output for/);
    assert.match(html, /the agent may be hung/);
    assert.ok(html.includes("Stop"), "Stop stays on a stalled turn");
    assert.ok(!html.includes("Agent working…"));
  });

  it("shows the queued error and a Retry button next to Cancel", async () => {
    let retried = 0;
    const m = await mount(
      view({
        threadOver: { status: "idle", runStartedAt: null, stalledAt: null },
        queuedPrompt: "finish the changelog",
        queuedError: "CLI exited before ack",
        onCancelQueued: () => {},
        onRetryQueued: () => {
          retried += 1;
        },
      }),
    );
    const err = m.query("[data-queued-error]");
    assert.ok(err, "queued error text must render");
    assert.match(err!.textContent || "", /CLI exited before ack/);
    const retry = m.query("button[data-retry-queued]") as HTMLButtonElement;
    assert.ok(retry, "Retry must sit on the queued strip");
    assert.equal(retry.disabled, false);
    assert.ok(m.query("button[data-cancel-queued]"), "Cancel stays");
    await m.click(retry);
    assert.equal(retried, 1);
    m.unmount();
  });
});
