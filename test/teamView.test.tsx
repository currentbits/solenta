/**
 * Agents tab team view: an orchestrator thread lists its worker forks; a
 * worker thread links back to its orchestrator; plain threads keep the plain
 * SessionCard.
 *
 * Run: node --import=./test/support/render.mjs --test test/teamView.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { AgentsContent } from "../src/components/AgentsPanel";
import type {
  ProviderInfo,
  ThreadInfo,
  ThreadSummaryInfo,
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
  {
    id: "grok",
    name: "Grok",
    available: true,
    supportsResume: false,
    models: [],
    modelInfo: [],
    efforts: [],
  },
];

function thread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "t-orch",
    projectId: "p1",
    title: "Plan the fix",
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

function summary(over: Partial<ThreadSummaryInfo> = {}): ThreadSummaryInfo {
  return {
    id: "t-orch",
    title: "Plan the fix",
    provider: "claude",
    status: "idle",
    handoffFrom: null,
    lastActivity: null,
    ...over,
  };
}

const ORCHESTRATOR = summary();
const WORKER = summary({
  id: "t-work",
  title: "Fork: Plan the fix",
  provider: "grok",
  status: "working",
  handoffFrom: "t-orch",
  lastActivity: { text: "Found the race in runner", at: 42 },
});

function content(
  selected: ThreadInfo,
  summaries: ThreadSummaryInfo[],
  onSelectThread?: (id: string) => void,
) {
  return (
    <AgentsContent
      workflow={null}
      thread={selected}
      usage={null}
      providers={PROVIDERS}
      threads={[selected]}
      listThreadSummaries={async () => summaries}
      onSelectThread={onSelectThread}
    />
  );
}

describe("Agents team view", () => {
  it("orchestrator: chips the session card and lists worker rows", async () => {
    const selected: string[] = [];
    const m = await mount(
      content(thread(), [ORCHESTRATOR, WORKER], (id) => selected.push(id)),
    );
    await m.flush();

    const text = m.text();
    assert.match(text, /Orchestrator/, "selected card carries the chip");
    assert.match(text, /Worker/);
    assert.match(text, /Grok/, "worker provider name");
    assert.match(text, /Fork: Plan the fix/, "worker title");
    assert.match(text, /working/i, "worker status badge");
    assert.match(text, /Found the race in runner/, "one-line lastActivity");

    await m.click(m.byText("Fork: Plan the fix"));
    assert.deepEqual(selected, ["t-work"], "clicking a worker selects it");
    m.unmount();
  });

  it("worker: links back to the orchestrator row", async () => {
    const selected: string[] = [];
    const m = await mount(
      content(
        thread({ id: "t-work", title: "Fork: Plan the fix", handoffFrom: "t-orch" }),
        [ORCHESTRATOR, WORKER],
        (id) => selected.push(id),
      ),
    );
    await m.flush();

    const text = m.text();
    assert.match(text, /Worker/, "selected card carries the Worker chip");
    assert.match(text, /Orchestrator/);
    assert.match(text, /Plan the fix/, "orchestrator row title");

    await m.click(m.byText("Plan the fix"));
    assert.deepEqual(selected, ["t-orch"], "clicking the row selects the orchestrator");
    m.unmount();
  });

  it("plain thread: no team section, SessionCard unchanged", async () => {
    const m = await mount(content(thread(), [ORCHESTRATOR]));
    await m.flush();

    const text = m.text();
    assert.doesNotMatch(text, /Orchestrator/);
    assert.doesNotMatch(text, /Worker/);
    assert.match(text, /Session/, "plain session card still renders");
    m.unmount();
  });

  it("orchestrator: omits done workers from the team list", async () => {
    const done = summary({
      id: "t-done",
      title: "Fork: already finished",
      provider: "grok",
      status: "done",
      handoffFrom: "t-orch",
    });
    const failed = summary({
      id: "t-fail",
      title: "Fork: blew up",
      provider: "grok",
      status: "failed",
      handoffFrom: "t-orch",
    });
    const idle = summary({
      id: "t-idle",
      title: "Fork: waiting to start",
      provider: "claude",
      status: "idle",
      handoffFrom: "t-orch",
    });
    const m = await mount(
      content(thread(), [ORCHESTRATOR, WORKER, done, failed, idle]),
    );
    await m.flush();

    const text = m.text();
    assert.match(text, /Fork: Plan the fix/, "working worker stays");
    assert.match(text, /Fork: blew up/, "failed worker stays");
    assert.match(text, /Fork: waiting to start/, "idle worker stays");
    assert.doesNotMatch(text, /already finished/, "done worker is gone");
    assert.ok(
      m.query('[aria-label="Team"]'),
      "team section still renders while live workers remain",
    );
    m.unmount();
  });

  it("orchestrator: no team section when every worker is done", async () => {
    const done = summary({
      id: "t-done",
      title: "Fork: already finished",
      provider: "grok",
      status: "done",
      handoffFrom: "t-orch",
    });
    const m = await mount(content(thread(), [ORCHESTRATOR, done]));
    await m.flush();

    const text = m.text();
    assert.doesNotMatch(text, /Orchestrator/);
    assert.doesNotMatch(text, /Worker/);
    assert.doesNotMatch(text, /already finished/);
    assert.equal(m.query('[aria-label="Team"]'), null);
    assert.match(text, /Session/, "falls back to a plain session card");
    m.unmount();
  });
});
