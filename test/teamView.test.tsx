/**
 * Agents tab team view: an orchestrator thread lists its worker forks; a
 * worker thread links back to its orchestrator; plain threads keep the plain
 * SessionCard.
 *
 * Run: node --import=./test/support/render.mjs --test test/teamView.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useState } from "react";
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
    runStartedAt: null,
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

/** Same derivation App does; the panel takes the key, not the list. */
function rosterKey(threads: ThreadInfo[]): string {
  return threads.map((t) => `${t.id}:${t.status}`).join(",");
}

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
      rosterKey={rosterKey([selected])}
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

  it("plain thread: lists Agent-tool subagents with status (issue #21)", async () => {
    const m = await mount(
      content(
        thread({
          subagents: [
            {
              id: "toolu_1",
              description: "Background research",
              agentType: "general-purpose",
              status: "running",
            },
            {
              id: "toolu_2",
              description: "Map the panel",
              agentType: "Explore",
              status: "done",
            },
          ],
        }),
        [ORCHESTRATOR],
      ),
    );
    await m.flush();

    const text = m.text();
    assert.ok(m.query('[aria-label="Subagents"]'), "subagents section renders");
    assert.match(text, /Subagent/, "role chip");
    assert.match(text, /Background research/);
    assert.match(text, /working/i, "running subagent shows a live badge");
    assert.match(text, /Map the panel/);
    assert.match(text, /done/i, "completed subagent stays listed with done");
    assert.match(text, /general-purpose/, "agent type shown in provider slot");
    m.unmount();
  });

  it("orchestrator: folds done workers behind a toggle", async () => {
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

    let text = m.text();
    assert.match(text, /Fork: Plan the fix/, "working worker stays");
    assert.match(text, /Fork: blew up/, "failed worker stays");
    assert.match(text, /Fork: waiting to start/, "idle worker stays");
    assert.doesNotMatch(
      text,
      /already finished/,
      "done worker folded by default",
    );
    assert.match(text, /1 done/, "toggle advertises the folded count");

    await m.click(m.byText("1 done"));
    text = m.text();
    assert.match(text, /already finished/, "expanded done worker appears");
    assert.match(text, /Hide done/, "toggle flips to hide");
    m.unmount();
  });

  it("stream pushes that change no id or status do not refetch (issue #29)", async () => {
    let calls = 0;
    const orch = thread();
    // Stable identity, like useCoder's useCallback fetcher.
    const fetcher = async () => {
      calls += 1;
      return [ORCHESTRATOR, WORKER];
    };
    function Harness() {
      const [threads, setThreads] = useState<ThreadInfo[]>([orch]);
      return (
        <>
          <button onClick={() => setThreads([{ ...orch }])}>push</button>
          <button onClick={() => setThreads([{ ...orch, status: "working" }])}>
            work
          </button>
          <AgentsContent
            workflow={null}
            thread={orch}
            usage={null}
            providers={PROVIDERS}
            rosterKey={rosterKey(threads)}
            listThreadSummaries={fetcher}
          />
        </>
      );
    }
    const m = await mount(<Harness />);
    await m.flush();
    assert.equal(calls, 1, "initial fetch");

    await m.click(m.byText("push"));
    await m.click(m.byText("push"));
    await m.flush();
    assert.equal(calls, 1, "new threads array, same roster: no refetch");

    await m.click(m.byText("work"));
    await m.flush();
    assert.equal(calls, 2, "a status change still refetches");
    m.unmount();
  });

  it("orchestrator: says it is waiting, for how long, on what (issue #42)", async () => {
    const running = summary({
      id: "t-work",
      title: "Fork: Plan the fix",
      provider: "grok",
      status: "working",
      handoffFrom: "t-orch",
      runStartedAt: Date.now() - 3 * 60 * 1000,
    });
    const blocked = summary({
      id: "t-block",
      title: "Fork: needs a yes",
      provider: "grok",
      status: "working",
      handoffFrom: "t-orch",
      awaitingInput: true,
      runStartedAt: Date.now() - 60 * 1000,
    });
    const m = await mount(content(thread(), [ORCHESTRATOR, running, blocked]));
    await m.flush();

    const line = m.query("[data-wait-line]");
    assert.ok(line, "wait line renders above the roster");
    assert.match(line!.textContent || "", /Waiting on 2 workers · 3m · 1 blocked/);
    assert.equal(line!.getAttribute("data-attention"), "true");
    assert.match(
      m.text(),
      /waiting/,
      "the stalled worker's row reads waiting, not working",
    );
    m.unmount();
  });

  it("no wait line once every worker has landed", async () => {
    const done = summary({
      id: "t-done",
      title: "Fork: finished",
      status: "done",
      handoffFrom: "t-orch",
    });
    const m = await mount(content(thread(), [ORCHESTRATOR, done]));
    await m.flush();
    assert.equal(m.query("[data-wait-line]"), null);
    m.unmount();
  });

  it("orchestrator: team section survives when every worker is done", async () => {
    const done = summary({
      id: "t-done",
      title: "Fork: already finished",
      provider: "grok",
      status: "done",
      handoffFrom: "t-orch",
    });
    const m = await mount(content(thread(), [ORCHESTRATOR, done]));
    await m.flush();

    let text = m.text();
    assert.match(text, /Orchestrator/, "card keeps the orchestrator chip");
    assert.ok(m.query('[aria-label="Team"]'), "team section still renders");
    assert.match(text, /1 done/, "roster folded, not gone");
    assert.doesNotMatch(text, /already finished/);

    await m.click(m.byText("1 done"));
    text = m.text();
    assert.match(text, /already finished/, "done worker recoverable");
    m.unmount();
  });
});
