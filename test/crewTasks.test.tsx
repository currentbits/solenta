/**
 * Agents tab crew task list (issue #277): who holds what, what is blocked,
 * and the attempt count when a task is looping.
 *
 * Run: node --import=./test/support/render.mjs --test test/crewTasks.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useState } from "react";
import { mount } from "./support/dom.ts";
import { AgentsContent } from "../src/components/AgentsPanel";
import type {
  CrewTaskView,
  ProviderInfo,
  ThreadInfo,
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

function task(over: Partial<CrewTaskView> = {}): CrewTaskView {
  return {
    id: "t1",
    title: "Write the contract",
    needs: [],
    status: "open",
    owner: null,
    note: "",
    attempts: [],
    createdAt: 1,
    updatedAt: 1,
    blocked: false,
    ...over,
  };
}

const WORKER = thread({
  id: "t-work",
  title: "Fork: Plan the fix",
  handoffFrom: "t-orch",
});

type ThreadsChangedApi = {
  on: (channel: "threads:changed", cb: () => void) => () => void;
};

function installThreadsChanged(): { emit: () => void; restore: () => void } {
  const listeners = new Set<() => void>();
  const prev = (window as unknown as { coder?: ThreadsChangedApi }).coder;
  (window as unknown as { coder: ThreadsChangedApi }).coder = {
    on(channel, cb) {
      if (channel !== "threads:changed") return () => {};
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
  return {
    emit() {
      for (const cb of listeners) cb();
    },
    restore() {
      if (prev) {
        (window as unknown as { coder: ThreadsChangedApi }).coder = prev;
      } else {
        delete (window as unknown as { coder?: ThreadsChangedApi }).coder;
      }
    },
  };
}

afterEach(() => {
  delete (window as unknown as { coder?: ThreadsChangedApi }).coder;
});

function content(
  selected: ThreadInfo,
  tasks: CrewTaskView[],
  listCrewTasks?: (threadId: string) => Promise<{
    rootThreadId: string;
    tasks: CrewTaskView[];
  }>,
) {
  return (
    <AgentsContent
      workflow={null}
      thread={selected}
      usage={null}
      providers={PROVIDERS}
      listCrewTasks={
        listCrewTasks ??
        (async () => ({ rootThreadId: "t-orch", tasks }))
      }
    />
  );
}

describe("Agents crew task list", () => {
  it("renders nothing when the crew has no tasks", async () => {
    const m = await mount(content(thread(), []));
    await m.flush();
    assert.equal(m.query("[data-crew-tasks]"), null);
    assert.doesNotMatch(m.text(), /Tasks/);
    m.unmount();
  });

  it("renders nothing when no fetcher is passed", async () => {
    const m = await mount(
      <AgentsContent
        workflow={null}
        thread={thread()}
        usage={null}
        providers={PROVIDERS}
      />,
    );
    await m.flush();
    assert.equal(m.query("[data-crew-tasks]"), null);
    m.unmount();
  });

  it("one row per task: id, title, status pill", async () => {
    const m = await mount(
      content(thread(), [
        task({ id: "t1", title: "Write the contract", status: "open" }),
        task({
          id: "t2",
          title: "Build the form",
          status: "claimed",
          owner: "t-work",
        }),
        task({
          id: "t3",
          title: "Ship it",
          status: "done",
          note: "main:docs/contract.md",
        }),
      ]),
    );
    await m.flush();

    const section = m.query("[data-crew-tasks]");
    assert.ok(section, "tasks section renders");
    assert.match(m.text(), /Tasks/);

    const rows = m.queryAll("[data-crew-task]");
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.getAttribute("data-crew-task"), "t1");
    assert.match(rows[0]!.textContent ?? "", /t1/);
    assert.match(rows[0]!.textContent ?? "", /Write the contract/);
    assert.match(rows[0]!.textContent ?? "", /open/);
    assert.match(rows[1]!.textContent ?? "", /Build the form/);
    assert.match(rows[1]!.textContent ?? "", /claimed/);
    assert.match(rows[2]!.textContent ?? "", /Ship it/);
    assert.match(rows[2]!.textContent ?? "", /done/);
    m.unmount();
  });

  it("blocked pill wins over open when blocked is true", async () => {
    const m = await mount(
      content(thread(), [
        task({ id: "t2", title: "Needs the contract", blocked: true }),
      ]),
    );
    await m.flush();
    const row = m.query("[data-crew-task=t2]");
    assert.ok(row);
    const pill = row!.querySelector("[data-status]");
    assert.equal(pill?.getAttribute("data-status"), "blocked");
    assert.match(pill?.textContent ?? "", /blocked/);
    m.unmount();
  });

  it("claimed row shows the owner thread title", async () => {
    const m = await mount(
      content(WORKER, [
        task({
          id: "t2",
          title: "Build the form",
          status: "claimed",
          owner: "t-work",
        }),
      ]),
    );
    await m.flush();
    const row = m.query("[data-crew-task=t2]");
    assert.match(row?.textContent ?? "", /Fork: Plan the fix/);
    m.unmount();
  });

  it("done row shows the note", async () => {
    const m = await mount(
      content(thread(), [
        task({
          id: "t1",
          status: "done",
          note: "main:docs/contract.md",
        }),
      ]),
    );
    await m.flush();
    assert.match(m.text(), /main:docs\/contract\.md/);
    m.unmount();
  });

  it("shows attempt count only when a task has been retried", async () => {
    const m = await mount(
      content(thread(), [
        task({
          id: "t1",
          title: "First try",
          attempts: [{ threadId: "t-work", at: 1 }],
        }),
        task({
          id: "t2",
          title: "Looping",
          status: "claimed",
          owner: "t-work",
          attempts: [
            { threadId: "t-work", at: 1, outcome: "types drifted" },
            { threadId: "t-work", at: 2 },
          ],
        }),
      ]),
    );
    await m.flush();
    const first = m.query("[data-crew-task=t1]");
    const looping = m.query("[data-crew-task=t2]");
    assert.doesNotMatch(first?.textContent ?? "", /attempts/);
    assert.match(looping?.textContent ?? "", /2 attempts/);
    m.unmount();
  });

  it("refetches when the selected thread changes", async () => {
    const seen: string[] = [];
    function Harness() {
      const [id, setId] = useState("t-orch");
      return (
        <>
          <button onClick={() => setId("t-work")}>switch</button>
          <AgentsContent
            workflow={null}
            thread={thread({ id, title: id })}
            usage={null}
            providers={PROVIDERS}
            listCrewTasks={async (threadId) => {
              seen.push(threadId);
              return { rootThreadId: "t-orch", tasks: [] };
            }}
          />
        </>
      );
    }
    const m = await mount(<Harness />);
    await m.flush();
    assert.deepEqual(seen, ["t-orch"]);

    await m.click(m.byText("switch"));
    await m.flush();
    assert.deepEqual(seen, ["t-orch", "t-work"]);
    m.unmount();
  });

  it("refetches on threads:changed", async () => {
    const push = installThreadsChanged();
    let calls = 0;
    const m = await mount(
      content(thread(), [], async () => {
        calls += 1;
        return { rootThreadId: "t-orch", tasks: [] };
      }),
    );
    await m.flush();
    assert.equal(calls, 1, "initial fetch");

    push.emit();
    await m.flush();
    assert.equal(calls, 2, "push event refetches");
    push.restore();
    m.unmount();
  });
});
