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
import { shortSessionId } from "../src/format";
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

function summary(
  over: Partial<ThreadSummaryInfo> & { orchWorker?: boolean } = {},
): ThreadSummaryInfo {
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
  orchWorker: true,
  projectId: "p1",
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
  it("run queue (#166): selected thread shows its place; queued workers badge", async () => {
    let left = 0;
    const m = await mount(
      <AgentsContent
        workflow={null}
        thread={thread({ runQueue: { at: 5 } })}
        usage={null}
        providers={PROVIDERS}
        rosterKey="t-orch:idle"
        runQueueIds={["t-other", "t-work", "t-orch"]}
        onLeaveRunQueue={() => {
          left++;
        }}
        listThreadSummaries={async () => [ORCHESTRATOR, WORKER]}
      />,
    );
    await m.flush();
    assert.match(m.text(), /Queued for a run slot · #3 of 3/);
    assert.match(m.text(), /queued #2/, "worker row shows its queue place");
    await m.click(m.byText("Leave queue"));
    assert.equal(left, 1);
    m.unmount();
  });

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

  it("working worker rows carry a Stop button; idle and done rows do not (#1531)", async () => {
    const stopped: string[] = [];
    const selected: string[] = [];
    const idle = summary({
      id: "t-idle",
      title: "Idle worker",
      status: "idle",
      handoffFrom: "t-orch",
      orchWorker: true,
      projectId: "p1",
    });
    const m = await mount(
      <AgentsContent
        workflow={null}
        thread={thread()}
        usage={null}
        providers={PROVIDERS}
        rosterKey="t-orch:idle"
        listThreadSummaries={async () => [ORCHESTRATOR, WORKER, idle]}
        onSelectThread={(id) => selected.push(id)}
        onStopThread={(id) => stopped.push(id)}
      />,
    );
    await m.flush();
    const stop = m.query('[aria-label="Stop Fork: Plan the fix"]');
    assert.ok(stop, "working worker has a Stop button");
    assert.equal(m.query('[aria-label="Stop Idle worker"]'), null, "idle row has none");
    await m.click(stop);
    assert.deepEqual(stopped, ["t-work"]);
    assert.deepEqual(selected, [], "Stop does not also select the row");
    m.unmount();
  });

  it("no Stop button without an onStopThread handler", async () => {
    const m = await mount(content(thread(), [ORCHESTRATOR, WORKER]));
    await m.flush();
    assert.equal(m.query('[aria-label^="Stop "]'), null);
    m.unmount();
  });

  it("worker: Worker chip and a Lead line back to the orchestrator; no Team section", async () => {
    const selected: string[] = [];
    const m = await mount(
      content(
        thread({
          id: "t-work",
          title: "Fork: Plan the fix",
          handoffFrom: "t-orch",
          orchWorker: true,
        }),
        [ORCHESTRATOR, WORKER],
        (id) => selected.push(id),
      ),
    );
    await m.flush();
    assert.match(
      m.query("[data-session-line]")?.textContent ?? "",
      /Worker/,
      "selected card carries the Worker chip",
    );
    assert.equal(m.query('[aria-label="Team"]'), null, "Team is for crew leads only");
    const lead = m.query("[data-crew-lead]");
    assert.ok(lead, "a worker links back to its lead");
    assert.equal(lead.textContent, "Lead: Plan the fix ›", "orchestrator row title");
    await m.click(lead);
    assert.deepEqual(selected, ["t-orch"], "clicking the Lead line selects the orchestrator");
    m.unmount();
  });

  it("worker whose lead is not in the project shows no Lead line", async () => {
    const m = await mount(
      content(
        thread({
          id: "t-work",
          title: "Fork: Plan the fix",
          handoffFrom: "t-orch",
          orchWorker: true,
        }),
        [WORKER],
      ),
    );
    await m.flush();
    assert.equal(m.query("[data-crew-lead]"), null);
    assert.equal(m.query('[aria-label="Team"]'), null);
    m.unmount();
  });

  it("plain thread: no team section, SessionCard unchanged", async () => {
    const m = await mount(content(thread(), [ORCHESTRATOR]));
    await m.flush();

    const text = m.text();
    assert.doesNotMatch(text, /Orchestrator/);
    assert.doesNotMatch(text, /Worker/);
    assert.ok(m.query("[data-session-line]"), "plain session line still renders");
    m.unmount();
  });

  it("manual forks and legacy summaries without orchWorker stay out of Team", async () => {
    const fork = summary({
      id: "t-fork",
      title: "Fork: independent conversation",
      provider: "grok",
      status: "working",
      handoffFrom: "t-orch",
    });
    const denied = summary({
      id: "t-not-worker",
      title: "Fork: flagged false",
      provider: "claude",
      status: "idle",
      handoffFrom: "t-orch",
      orchWorker: false,
    });
    const cross = summary({
      id: "t-cross",
      title: "Wrong project worker",
      provider: "grok",
      status: "working",
      handoffFrom: "t-orch",
      orchWorker: true,
      projectId: "p-other",
    });
    const archived = summary({
      id: "t-archived",
      title: "Archived crew worker",
      provider: "claude",
      status: "idle",
      handoffFrom: "t-orch",
      orchWorker: true,
      projectId: "p1",
    });
    const mixed = await mount(
      content(thread(), [ORCHESTRATOR, WORKER, fork, denied, cross, archived]),
    );
    await mixed.flush();
    const team = mixed.query('[aria-label="Team"]');
    assert.ok(team);
    assert.match(team!.textContent || "", /Fork: Plan the fix/);
    assert.match(
      team!.textContent || "",
      /Archived crew worker/,
      "archived same-project workers stay on Team",
    );
    assert.doesNotMatch(
      team!.textContent || "",
      /independent conversation/,
      "handoffFrom without orchWorker is not a crew worker",
    );
    assert.doesNotMatch(team!.textContent || "", /flagged false/);
    assert.doesNotMatch(
      team!.textContent || "",
      /Wrong project worker/,
      "cross-project orchWorker is not a crew child",
    );
    mixed.unmount();

    const forkOnly = await mount(content(thread(), [ORCHESTRATOR, fork]));
    await forkOnly.flush();
    assert.equal(forkOnly.query('[aria-label="Team"]'), null);
    assert.doesNotMatch(forkOnly.text(), /Orchestrator/);
    forkOnly.unmount();

    const viewingFork = await mount(
      content(
        thread({
          id: "t-fork",
          title: "Fork: independent conversation",
          handoffFrom: "t-orch",
        }),
        [ORCHESTRATOR, fork],
      ),
    );
    await viewingFork.flush();
    assert.doesNotMatch(viewingFork.text(), /Worker/);
    assert.doesNotMatch(viewingFork.text(), /Orchestrator/);
    viewingFork.unmount();

    const viewingCross = await mount(
      content(
        thread({
          id: "t-work",
          title: "Fork: Plan the fix",
          handoffFrom: "t-orch",
          orchWorker: true,
          projectId: "p1",
        }),
        [
          summary({
            id: "t-orch",
            title: "Plan the fix",
            projectId: "p-other",
          }),
          WORKER,
        ],
      ),
    );
    await viewingCross.flush();
    assert.doesNotMatch(
      viewingCross.text(),
      /Orchestrator/,
      "cross-project parent is not a Team back-link",
    );
    viewingCross.unmount();
  });

  it("SessionCard shows unmetered cost when tokens exist but USD does not (#703)", async () => {
    const m = await mount(
      <AgentsContent
        workflow={null}
        thread={thread({ provider: "cursor", model: "auto" })}
        usage={{
          model: "auto",
          inputTokens: 11114,
          outputTokens: 43,
          costUsd: 0,
          turns: 1,
          contextTokens: 17653,
        }}
        providers={PROVIDERS}
        rosterKey={rosterKey([thread({ provider: "cursor" })])}
        listThreadSummaries={async () => [ORCHESTRATOR]}
      />,
    );
    await m.flush();
    const text = m.text();
    assert.match(text, /11,114/);
    assert.match(text, /43/);
    assert.match(text, /unmetered/i);
    assert.doesNotMatch(text, /\$0\.00/);
    m.unmount();
  });

  it("SessionCard shows usage not reported for an all-zero turn (#703)", async () => {
    const m = await mount(
      <AgentsContent
        workflow={null}
        thread={thread({ provider: "cursor" })}
        usage={{
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          turns: 1,
        }}
        providers={PROVIDERS}
        rosterKey={rosterKey([thread({ provider: "cursor" })])}
        listThreadSummaries={async () => [ORCHESTRATOR]}
      />,
    );
    await m.flush();
    const text = m.text();
    assert.match(text, /usage not reported/i);
    assert.doesNotMatch(text, /\$0\.00/);
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
      orchWorker: true,
    });
    const failed = summary({
      id: "t-fail",
      title: "Fork: blew up",
      provider: "grok",
      status: "failed",
      handoffFrom: "t-orch",
      orchWorker: true,
    });
    const idle = summary({
      id: "t-idle",
      title: "Fork: waiting to start",
      provider: "claude",
      status: "idle",
      handoffFrom: "t-orch",
      orchWorker: true,
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
      orchWorker: true,
      runStartedAt: Date.now() - 3 * 60 * 1000,
    });
    const blocked = summary({
      id: "t-block",
      title: "Fork: needs a yes",
      provider: "grok",
      status: "working",
      handoffFrom: "t-orch",
      orchWorker: true,
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

  it("orchestrator wait includes a nested blocked grandchild", async () => {
    const mid = summary({
      id: "t-mid",
      title: "Review permissions",
      provider: "grok",
      status: "idle",
      handoffFrom: "t-orch",
      orchWorker: true,
      projectId: "p1",
    });
    const nested = summary({
      id: "t-nested",
      title: "Nested helper",
      provider: "grok",
      status: "working",
      handoffFrom: "t-mid",
      orchWorker: true,
      projectId: "p1",
      awaitingInput: true,
      runStartedAt: Date.now() - 60 * 1000,
    });
    const m = await mount(
      content(thread({ projectId: "p1" }), [ORCHESTRATOR, mid, nested]),
    );
    await m.flush();
    const line = m.query("[data-wait-line]");
    assert.ok(line, "lead wait summary keeps the nested blocked worker");
    assert.match(line!.textContent || "", /Waiting on 1 worker/);
    assert.match(line!.textContent || "", /1 blocked/);
    assert.equal(line!.getAttribute("data-attention"), "true");
    m.unmount();
  });

  it("a watchdog-stalled worker reads stalled, not working (issue #314)", async () => {
    const hung = summary({
      id: "t-hung",
      title: "Fork: hung grok",
      provider: "grok",
      status: "working",
      handoffFrom: "t-orch",
      orchWorker: true,
      stalledAt: Date.now() - 12 * 60 * 1000,
      runStartedAt: Date.now() - 70 * 60 * 1000,
    });
    const m = await mount(content(thread(), [ORCHESTRATOR, hung]));
    await m.flush();
    const chip = m.query('[data-status="stalled"]');
    assert.ok(chip, "team row must mark stalled");
    assert.match(chip!.textContent || "", /stalled/i);
    m.unmount();
  });

  it("no wait line once every worker has landed", async () => {
    const done = summary({
      id: "t-done",
      title: "Fork: finished",
      status: "done",
      handoffFrom: "t-orch",
      orchWorker: true,
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
      orchWorker: true,
    });
    const m = await mount(content(thread(), [ORCHESTRATOR, done]));
    await m.flush();

    const text = m.text();
    assert.match(text, /Orchestrator/, "card keeps the orchestrator chip");
    assert.ok(m.query('[aria-label="Team"]'), "team section still renders");
    assert.match(
      text,
      /already finished/,
      "the only workers are done: list them, do not fold behind a toggle",
    );
    assert.equal(
      m.query("[data-wait-line]"),
      null,
      "finished workers must not keep a wait line",
    );
    assert.equal(
      m.byText("1 done"),
      null,
      "no collapsed toggle when none are live",
    );
    m.unmount();
  });

  it("orchestrator: done+settled workers are findable without the Settled shelf", async () => {
    const settledA = summary({
      id: "t-settled-a",
      title: "Fork: Import existing CLI agent sessions",
      provider: "grok",
      status: "done",
      handoffFrom: "t-orch",
      orchWorker: true,
    });
    const settledB = summary({
      id: "t-settled-b",
      title: "Fork: Map the wait line",
      provider: "grok",
      status: "done",
      handoffFrom: "t-orch",
      orchWorker: true,
    });
    const selected: string[] = [];
    const m = await mount(
      content(
        thread({ status: "idle" }),
        [ORCHESTRATOR, settledA, settledB],
        (id) => selected.push(id),
      ),
    );
    await m.flush();

    const text = m.text();
    assert.ok(m.query('[aria-label="Team"]'), "team roster still mounts");
    assert.match(
      text,
      /Import existing CLI agent sessions/,
      "settled worker title is visible without opening Settled",
    );
    assert.match(text, /Map the wait line/);
    assert.doesNotMatch(
      text,
      /\d+ done/,
      "no collapsed 'N done' toggle when every worker has landed",
    );
    assert.equal(
      m.byText("2 done"),
      null,
      "no collapsed done toggle when the live roster is empty",
    );
    assert.equal(m.byText("Hide done"), null);
    assert.doesNotMatch(
      text,
      /Settled/,
      "Team is not the sidebar Settled shelf",
    );
    assert.equal(m.query("[data-wait-line]"), null);

    await m.click(m.byText("Fork: Import existing CLI agent sessions"));
    assert.deepEqual(
      selected,
      ["t-settled-a"],
      "clicking the settled worker selects it from Team",
    );
    m.unmount();
  });

  it("plain thread: hides the hypothesis ledger when none were recorded", async () => {
    const m = await mount(content(thread(), [ORCHESTRATOR]));
    await m.flush();
    assert.equal(m.query("[data-hypothesis-ledger]"), null);
    assert.doesNotMatch(m.text(), /Hypotheses/);
    m.unmount();
  });

  it("plain thread: lists recorded hypotheses newest-first by status", async () => {
    const now = Date.now();
    const m = await mount(
      content(
        thread({
          hypotheses: [
            {
              id: "h-old",
              claim: "Race is in the store flush",
              status: "invalidated",
              reason: "Flush is sync.",
              at: now - 10 * 60_000,
            },
            {
              id: "h-ok",
              claim: "execFile never fires under load",
              status: "validated",
              reason: "",
              at: now - 5 * 60_000,
            },
            {
              id: "h-new",
              claim: "A second watcher is doubling the work",
              status: "invalidated",
              reason: "",
              at: now - 60_000,
            },
          ],
        }),
        [ORCHESTRATOR],
      ),
    );
    await m.flush();

    const card = m.query("[data-hypothesis-ledger]");
    assert.ok(card, "ledger section renders");
    assert.match(m.text(), /Hypotheses/);
    assert.match(m.text(), /2 ruled out · 1 worked/);
    assert.doesNotMatch(m.text(), /inconclusive/);
    assert.equal(card.tagName, "DETAILS");
    assert.equal(
      (card as HTMLDetailsElement).open,
      false,
      "hypotheses start collapsed",
    );
    assert.equal(card.querySelector("[data-section-count]")?.textContent, "3");

    const rows = m.queryAll("[data-hypothesis-status]");
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.getAttribute("data-hypothesis-status"), "invalidated");
    assert.match(rows[0]!.textContent ?? "", /second watcher/);
    assert.doesNotMatch(
      rows[0]!.textContent ?? "",
      /Flush is sync/,
      "empty reason renders nothing",
    );
    assert.equal(rows[1]!.getAttribute("data-hypothesis-status"), "invalidated");
    assert.match(rows[1]!.textContent ?? "", /store flush/);
    assert.match(rows[1]!.textContent ?? "", /Flush is sync/);
    assert.equal(rows[2]!.getAttribute("data-hypothesis-status"), "validated");
    assert.match(rows[2]!.textContent ?? "", /execFile/);
    m.unmount();
  });

  it("session line: provider · status · turns · cost; tokens muted; no Model, Permission or Context", async () => {
    const m = await mount(
      <AgentsContent
        workflow={null}
        thread={thread({ model: "opus-x", permissionMode: "acceptEdits" })}
        usage={{
          model: "opus-x",
          inputTokens: 1200,
          outputTokens: 34,
          costUsd: 0.5,
          turns: 2,
          contextTokens: 50_000,
          contextWindow: 200_000,
        }}
        providers={PROVIDERS}
        rosterKey=""
        listThreadSummaries={async () => []}
      />,
    );
    await m.flush();
    assert.equal(
      m.query("[data-session-line]")?.textContent,
      "Claude Code · idle · 2 turns · $0.50",
    );
    assert.equal(
      m.query("[data-session-tokens]")?.textContent,
      "1,200 in · 34 out tokens",
    );
    const text = m.text();
    assert.doesNotMatch(text, /opus-x/, "model lives in the composer");
    assert.doesNotMatch(text, /Permission|Accept edits/, "permission lives in the composer");
    assert.doesNotMatch(text, /Context|of 200/, "context lives in the header ring");
    m.unmount();
  });

  it("session line: shows the short session id with the full id as a tooltip, even with no usage", async () => {
    const sessionId = "abc12345-full-session-id";
    const m = await mount(
      <AgentsContent
        workflow={null}
        thread={thread({ sessionId })}
        usage={null}
        providers={PROVIDERS}
        rosterKey=""
        listThreadSummaries={async () => []}
      />,
    );
    await m.flush();
    const tokens = m.query("[data-session-tokens]");
    assert.ok(tokens, "muted session line renders even with no usage");
    assert.equal(tokens.textContent, shortSessionId(sessionId));
    assert.equal(tokens.getAttribute("title"), sessionId);
    m.unmount();
  });

  it("crew lead: Session, Team, Tasks, Subagents, Hypotheses in that order", async () => {
    const m = await mount(
      <AgentsContent
        workflow={null}
        thread={thread({
          subagents: [
            {
              id: "s1",
              description: "Scan the repo",
              agentType: null,
              status: "running",
            },
          ],
          hypotheses: [
            {
              id: "h1",
              claim: "Flush races the stream",
              status: "validated",
              reason: "",
              at: Date.now(),
            },
          ],
        })}
        usage={null}
        providers={PROVIDERS}
        rosterKey="t-orch:idle,t-work:working"
        listThreadSummaries={async () => [ORCHESTRATOR, WORKER]}
        listCrewTasks={async () => ({
          rootThreadId: "t-orch",
          tasks: [
            {
              id: "T1",
              title: "Split the parser",
              needs: [],
              status: "open",
              owner: null,
              note: "",
              attempts: [],
              createdAt: 1,
              updatedAt: 1,
              blocked: false,
            },
          ],
        })}
      />,
    );
    await m.flush();
    // [data-session-line] is the <p>; its section is a direct child of the pane.
    const pane = m.query("[data-session-line]")!.parentElement!.parentElement!;
    assert.deepEqual(
      [...pane.children].map((el) => el.getAttribute("aria-label")),
      ["Session", "Team", "Tasks", "Subagents", "Hypotheses"],
    );
    const team = m.query('[aria-label="Team"]')!;
    assert.equal(team.querySelector("[data-section-count]")?.textContent, "1");
    m.unmount();
  });
});

describe("team view scope (#1398)", () => {
  it("team view fetches only its project's summaries (#1398)", async () => {
    const calls: unknown[] = [];
    const m = await mount(
      <AgentsContent
        workflow={null}
        thread={thread({ id: "t-orch", projectId: "p1" })}
        usage={null}
        providers={PROVIDERS}
        rosterKey="t-orch:idle"
        listThreadSummaries={async (input?: unknown) => {
          calls.push(input);
          return [];
        }}
      />,
    );
    await m.flush();
    assert.deepEqual(calls, [{ projectId: "p1" }]);
    m.unmount();
  });
});
