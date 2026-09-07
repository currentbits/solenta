/**
 * Lead Integration section (#954): destination labels, blockers, missing vs
 * integrated, order, separate final land.
 *
 * Run: node --import=./test/support/render.mjs --test test/crewIntegration.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { AgentsContent } from "../src/components/AgentsPanel";
import { CrewIntegration } from "../src/components/CrewIntegration";
import { WorktreeControl } from "../src/components/WorktreeControl";
import type {
  CrewIntegration as CrewIntegrationView,
  CrewIntegrationWorkerRow,
  ProjectInfo,
  ProviderInfo,
  ThreadInfo,
  ThreadSummaryInfo,
} from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "owner/repo",
  name: "repo",
  path: "/tmp/repo",
};

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
    title: "Lead",
    branch: "coder/lead",
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
    worktreePath: "/tmp/lead-wt",
    handoffFrom: null,
    verifyCommand: "npm test",
    verify: null,
    ...over,
  };
}

function row(
  over: Partial<CrewIntegrationWorkerRow> & Pick<CrewIntegrationWorkerRow, "workerId" | "title" | "state">,
): CrewIntegrationWorkerRow {
  return {
    taskId: null,
    sourceSha: "abc1234def",
    sourceBranch: null,
    sourceDirty: false,
    changedFiles: ["file.ts"],
    verify: null,
    destination: "coder/lead",
    blocked: false,
    needs: [],
    archived: false,
    worktreePath: "/tmp/w",
    missingReason: null,
    ...over,
  };
}

function view(over: Partial<CrewIntegrationView> = {}): CrewIntegrationView {
  return {
    leadThreadId: "t-orch",
    leadBranch: "coder/lead",
    leadWorktreePath: "/tmp/lead-wt",
    missingLeadWorktree: false,
    finalTarget: "main",
    finalAction: "merge",
    combinedFiles: [],
    leadHeadSha: "leadsha",
    leadVerify: null,
    verifyStale: false,
    landed: false,
    receipts: [],
    workers: [
      row({ workerId: "a", title: "A", state: "ready" }),
      row({
        workerId: "b",
        title: "B",
        state: "conflicted",
      }),
      row({
        workerId: "c",
        title: "C",
        state: "ready",
        blocked: true,
        needs: ["t2"],
      }),
    ],
    ...over,
  };
}

describe("CrewIntegration section", () => {
  it("names Workers → lead branch → final target and Merge into target", async () => {
    const m = await mount(
      <CrewIntegration
        view={view()}
        thread={thread()}
        onIntegrate={async () => {}}
      />,
    );
    const header = m.query("[data-crew-integration-header]");
    assert.ok(header);
    assert.match(header!.textContent || "", /Workers → coder\/lead → main/);
    assert.match(header!.textContent || "", /Merge into main/);
    const land = m.query("[data-final-land]");
    assert.ok(land);
    assert.equal((land!.textContent || "").trim(), "Merge into main");
    m.unmount();
  });

  it("shows Open PR when that is the final route", async () => {
    const m = await mount(
      <CrewIntegration
        view={view({ finalAction: "pr" })}
        thread={thread()}
        onIntegrate={async () => {}}
      />,
    );
    assert.match(m.text(), /Open PR/);
    assert.equal((m.query("[data-final-land]")!.textContent || "").trim(), "Open PR");
    m.unmount();
  });

  it("blocks Integrate without a lead worktree", async () => {
    const calls: string[] = [];
    const m = await mount(
      <CrewIntegration
        view={view({ missingLeadWorktree: true, leadWorktreePath: null })}
        thread={thread({ worktreePath: null })}
        onIntegrate={async (id) => {
          calls.push(id);
        }}
      />,
    );
    assert.match(m.text(), /Set up a lead worktree first/);
    const btn = m.query("[data-crew-worker='a'] [data-integrate]");
    assert.ok(btn);
    assert.equal((btn as HTMLButtonElement).disabled, true);
    m.unmount();
    assert.deepEqual(calls, []);
  });

  it("disables Integrate on blocked and conflicted rows; Ready stays a review state", async () => {
    const calls: string[] = [];
    const m = await mount(
      <CrewIntegration
        view={view()}
        thread={thread()}
        onIntegrate={async (id) => {
          calls.push(id);
        }}
      />,
    );
    const a = m.query("[data-crew-worker='a']");
    const b = m.query("[data-crew-worker='b']");
    const c = m.query("[data-crew-worker='c']");
    assert.equal(a!.getAttribute("data-state"), "ready");
    assert.match(a!.textContent || "", /Ready for review/);
    assert.equal(b!.getAttribute("data-state"), "conflicted");
    assert.ok(b!.querySelector("[data-resolve]"));
    assert.equal(c!.getAttribute("data-blocked"), "true");
    assert.match(c!.textContent || "", /blocked on t2/);
    assert.equal(
      (c!.querySelector("[data-integrate]") as HTMLButtonElement).disabled,
      true,
    );
    assert.match(a!.textContent || "", /into coder\/lead/);
    await m.click(a!.querySelector("[data-integrate]"));
    assert.deepEqual(calls, ["a"]);
    m.unmount();
  });

  it("distinguishes Missing from Integrated", async () => {
    const m = await mount(
      <CrewIntegration
        view={view({
          workers: [
            row({
              workerId: "gone",
              title: "Gone",
              state: "missing",
              worktreePath: null,
              sourceSha: null,
              missingReason:
                "Worker worktree is missing and there is no integrate receipt",
            }),
            row({
              workerId: "in",
              title: "In",
              state: "integrated",
              worktreePath: null,
              sourceSha: "deadbeef",
            }),
          ],
        })}
        thread={thread()}
        onIntegrate={async () => {}}
      />,
    );
    const gone = m.query("[data-crew-worker='gone']");
    const inn = m.query("[data-crew-worker='in']");
    assert.equal(gone!.getAttribute("data-state"), "missing");
    assert.match(gone!.textContent || "", /Missing/);
    assert.match(gone!.textContent || "", /unknown/);
    assert.doesNotMatch(gone!.textContent || "", /Landed/);
    assert.equal(inn!.getAttribute("data-state"), "integrated");
    assert.match(inn!.textContent || "", /Integrated/);
    m.unmount();
  });

  it("shows the source branch and short SHA on each worker row (#948)", async () => {
    const m = await mount(
      <CrewIntegration
        view={view({
          workers: [
            row({
              workerId: "a",
              title: "API",
              state: "ready",
              sourceSha: "abcdef1234567890",
              sourceBranch: "coder/lead",
              sourceDirty: true,
            }),
          ],
        })}
        thread={thread()}
        onIntegrate={async () => {}}
      />,
    );
    const sha = m.query("[data-crew-worker='a'] [data-source-sha]");
    assert.ok(sha);
    assert.match(sha!.textContent || "", /coder\/lead/);
    assert.match(sha!.textContent || "", /abcdef1/);
    const dirty = m.query("[data-crew-worker='a'] [data-source-dirty]");
    assert.ok(dirty);
    assert.match(dirty!.textContent || "", /inherits committed work only/i);
    const dest = m.query("[data-crew-worker='a'] [data-destination]");
    assert.ok(dest);
    assert.match(dest!.textContent || "", /into coder\/lead/);
    m.unmount();
  });

  it("offers an explicit refresh on an idle worker and hides it on a running one", async () => {
    const refreshed: string[] = [];
    const m = await mount(
      <CrewIntegration
        view={view({
          workers: [
            row({
              workerId: "a",
              title: "API",
              state: "ready",
              sourceSha: "abcdef1234567890",
              sourceBranch: "coder/lead",
            }),
            row({
              workerId: "run",
              title: "Busy",
              state: "running",
              sourceSha: "abcdef1234567890",
              sourceBranch: "coder/lead",
            }),
          ],
        })}
        thread={thread()}
        onIntegrate={async () => {}}
        onRefreshWorker={async (id) => {
          refreshed.push(id);
        }}
      />,
    );
    const ready = m.query(
      "[data-crew-worker='a'] [data-refresh-snapshot]",
    ) as HTMLButtonElement;
    assert.ok(ready, "refresh on idle worker");
    assert.equal(ready.disabled, false);
    assert.equal(
      m.query("[data-crew-worker='run'] [data-refresh-snapshot]"),
      null,
    );
    await m.click(ready);
    assert.deepEqual(refreshed, ["a"]);
    m.unmount();
  });

  it("does not label Integrate as Integrating while a refresh is in flight", async () => {
    const m = await mount(
      <CrewIntegration
        view={view({
          workers: [
            row({
              workerId: "a",
              title: "API",
              state: "ready",
              sourceSha: "abcdef1234567890",
              sourceBranch: "coder/lead",
            }),
          ],
        })}
        thread={thread()}
        onIntegrate={async () => {}}
        onRefreshWorker={async () => {}}
        busyWorkerId="a"
        busyKind="refresh"
      />,
    );
    const refresh = m.query(
      "[data-crew-worker='a'] [data-refresh-snapshot]",
    ) as HTMLButtonElement;
    const integrate = m.query(
      "[data-crew-worker='a'] [data-integrate]",
    ) as HTMLButtonElement;
    assert.match(refresh.textContent || "", /Refreshing/);
    assert.match(integrate.textContent || "", /Integrate into/);
    assert.doesNotMatch(integrate.textContent || "", /Integrating/);
    m.unmount();
  });

  it("reorders rows with up/down", async () => {
    const m = await mount(
      <CrewIntegration
        view={view({
          workers: [
            row({ workerId: "a", title: "Alpha", state: "ready" }),
            row({ workerId: "b", title: "Beta", state: "ready" }),
          ],
        })}
        thread={thread()}
        onIntegrate={async () => {}}
      />,
    );
    const ids = () =>
      m.queryAll("[data-crew-worker]").map((el) =>
        el.getAttribute("data-crew-worker"),
      );
    assert.deepEqual(ids(), ["a", "b"]);
    await m.click(m.query("[data-crew-worker='b'] [data-move='up']"));
    assert.deepEqual(ids(), ["b", "a"]);
    m.unmount();
  });

  it("does not land on the final target from Integrate", async () => {
    const integrated: string[] = [];
    let landed = 0;
    const m = await mount(
      <CrewIntegration
        view={view({
          workers: [row({ workerId: "a", title: "A", state: "ready" })],
        })}
        thread={thread()}
        onIntegrate={async (id) => {
          integrated.push(id);
        }}
        onFinal={async () => {
          landed += 1;
        }}
      />,
    );
    await m.click(m.query("[data-crew-worker='a'] [data-integrate]"));
    assert.deepEqual(integrated, ["a"]);
    assert.equal(landed, 0);
    const land = m.query("[data-final-land]") as HTMLButtonElement;
    assert.equal(land.disabled, true, "no integrated workers yet");
    m.unmount();
  });
});

describe("AgentsContent Integration section", () => {
  it("renders Integration on an orchestrator lead and hides it on a plain thread", async () => {
    const summaries: ThreadSummaryInfo[] = [
      {
        id: "t-orch",
        title: "Lead",
        provider: "claude",
        status: "idle",
        handoffFrom: null,
        runStartedAt: null,
        lastActivity: null,
      },
      {
        id: "t-work",
        title: "Worker A",
        provider: "claude",
        status: "done",
        handoffFrom: "t-orch",
        runStartedAt: null,
        lastActivity: null,
      },
    ];
    const orch = await mount(
      <AgentsContent
        workflow={null}
        thread={thread()}
        usage={null}
        providers={PROVIDERS}
        rosterKey="t-orch:idle,t-work:done"
        listThreadSummaries={async () => summaries}
        crewIntegration={async () => view()}
        onIntegrateWorker={async () => {}}
      />,
    );
    await orch.flush();
    assert.ok(orch.query("[data-crew-integration]"));
    assert.match(orch.text(), /Workers → coder\/lead → main/);
    orch.unmount();

    const plain = await mount(
      <AgentsContent
        workflow={null}
        thread={thread({ id: "plain", title: "Solo" })}
        usage={null}
        providers={PROVIDERS}
        rosterKey="plain:idle"
        listThreadSummaries={async () => [
          {
            id: "plain",
            title: "Solo",
            provider: "claude",
            status: "idle",
            handoffFrom: null,
            runStartedAt: null,
            lastActivity: null,
          },
        ]}
        crewIntegration={async () => view()}
      />,
    );
    await plain.flush();
    assert.equal(plain.query("[data-crew-integration]"), null);
    plain.unmount();
  });
});

describe("worker-header Merge destination", () => {
  it("names the recorded base on a plain thread", async () => {
    const m = await mount(
      <WorktreeControl
        thread={thread({
          id: "t-plain",
          handoffFrom: null,
          worktreePath: "/tmp/wt",
          branch: "coder/plain",
          baseBranch: "main",
        })}
        project={project}
        isWorking={false}
        onSetupWorktree={async () => {}}
        onMergeWorktree={async () => {}}
        onRemoveWorktree={async () => {}}
      />,
    );
    const merge = m.query("[data-worktree-merge]");
    assert.ok(merge);
    assert.equal((merge!.textContent || "").trim(), "Merge onto main");
    m.unmount();
  });

  it("falls back to repo default when no base is recorded", async () => {
    const m = await mount(
      <WorktreeControl
        thread={thread({
          id: "t-plain",
          handoffFrom: null,
          worktreePath: "/tmp/wt",
          branch: "coder/plain",
          baseBranch: null,
        })}
        project={project}
        isWorking={false}
        onSetupWorktree={async () => {}}
        onMergeWorktree={async () => {}}
        onRemoveWorktree={async () => {}}
      />,
    );
    assert.equal(
      (m.query("[data-worktree-merge]")!.textContent || "").trim(),
      "Merge onto repo default",
    );
    m.unmount();
  });

  it("orchWorker Merge still names its own destination and points crew integration at the lead", async () => {
    const opened: string[] = [];
    const m = await mount(
      <WorktreeControl
        thread={thread({
          id: "t-work",
          title: "Fork: Plan the fix",
          handoffFrom: "t-orch",
          worktreePath: "/tmp/wt",
          branch: "coder/worker-a",
          baseBranch: "main",
        })}
        project={project}
        isWorking={false}
        onSetupWorktree={async () => {}}
        onMergeWorktree={async () => {}}
        onRemoveWorktree={async () => {}}
        onOpenCrewIntegration={(id) => opened.push(id)}
      />,
    );
    assert.equal(
      (m.query("[data-worktree-merge]")!.textContent || "").trim(),
      "Merge onto main",
      "worker-header Merge is not silently retargeted at the lead",
    );
    const pointer = m.query("[data-crew-integration-lead]");
    assert.ok(pointer, "orchWorker points crew integration back to the lead");
    assert.match(pointer!.textContent || "", /lead/i);
    await m.click(pointer);
    assert.deepEqual(opened, ["t-orch"]);
    m.unmount();
  });
});
