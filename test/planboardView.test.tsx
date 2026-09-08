/**
 * PlanboardView: columns from issues, project selector, error + empty states.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount, inAct } from "./support/dom.ts";
import { thread } from "./support/fakeCoder.ts";
import { PlanboardView } from "../src/components/PlanboardView";
import type {
  AgentProfile,
  ListIssuesResult,
  ListPrsResult,
  ProjectInfo,
  ProviderInfo,
} from "../src/shared/ipc";

const projects: ProjectInfo[] = [
  { id: "p1", slug: "acme/ledger", name: "ledger", path: "/tmp/ledger" },
  { id: "p2", slug: "acme/site", name: "site", path: "/tmp/site" },
];

const CLAUDE: ProviderInfo = {
  id: "claude",
  name: "Claude Code",
  available: true,
  supportsResume: true,
  models: ["claude-sonnet-4"],
  modelInfo: [],
  efforts: ["low", "medium", "high"],
};

const GROK_UNAVAILABLE: ProviderInfo = {
  id: "grok",
  name: "Grok",
  available: false,
  supportsResume: false,
  models: ["grok-4"],
  modelInfo: [],
  efforts: [],
};

const SCOUT: AgentProfile = {
  id: "p-scout",
  name: "Cheap scout",
  provider: "claude",
  model: "claude-sonnet-4",
  reasoningEffort: "low",
  permissionMode: "plan",
};

const GROK_WORKER: AgentProfile = {
  id: "p-grok",
  name: "Grok worker",
  provider: "grok",
  model: "grok-4",
  reasoningEffort: "high",
  permissionMode: "acceptEdits",
};

const AUDIT_A: ProjectInfo = {
  id: "a",
  slug: "acme/audit-a",
  name: "audit-a",
  path: "/tmp/audit-a",
};
const AUDIT_B: ProjectInfo = {
  id: "b",
  slug: "acme/audit-b",
  name: "audit-b",
  path: "/tmp/audit-b",
};
const AUDIT_PROJECTS = [AUDIT_A, AUDIT_B];

function auditIssues(path: string): ListIssuesResult {
  return path === AUDIT_A.path
    ? {
        ok: true,
        issues: [
          {
            number: 11,
            title: "A eleven",
            url: "https://github.com/acme/audit-a/issues/11",
            state: "OPEN",
            labels: ["plan:todo"],
          },
        ],
      }
    : {
        ok: true,
        issues: [
          {
            number: 22,
            title: "B twenty-two",
            url: "https://github.com/acme/audit-b/issues/22",
            state: "OPEN",
            labels: ["plan:todo"],
          },
        ],
      };
}

const okResult: ListIssuesResult = {
  ok: true,
  issues: [
    {
      number: 1,
      title: "todo item",
      url: "https://github.com/acme/ledger/issues/1",
      state: "OPEN",
      labels: ["plan:todo", "roadmap"],
    },
    {
      number: 2,
      title: "doing item",
      url: "https://github.com/acme/ledger/issues/2",
      state: "OPEN",
      labels: ["plan:doing"],
    },
    {
      number: 3,
      title: "done item",
      url: "https://github.com/acme/ledger/issues/3",
      state: "CLOSED",
      labels: [],
    },
  ],
};

describe("PlanboardView", () => {
  it("renders three columns with issues and label badges", async () => {
    const m = await mount(
      <PlanboardView projects={projects} listIssues={async () => okResult} />,
    );
    const todo = m.query('[data-plan-column="todo"]');
    const doing = m.query('[data-plan-column="doing"]');
    const done = m.query('[data-plan-column="done"]');
    assert.ok(todo && doing && done, "three columns");
    assert.ok(todo.textContent?.includes("todo item"));
    assert.ok(todo.textContent?.includes("roadmap"));
    assert.ok(doing.textContent?.includes("doing item"));
    assert.ok(done.textContent?.includes("done item"));
    const card = m.query('a[data-plan-issue="1"]') as HTMLAnchorElement | null;
    assert.ok(card, "issue card links out");
    assert.ok(card.href.includes("/issues/1"));
    m.unmount();
  });

  it("switching project refetches that project's issues", async () => {
    const asked: string[] = [];
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async (path) => {
          asked.push(path);
          return okResult;
        }}
      />,
    );
    assert.deepEqual(asked, ["/tmp/ledger"]);
    const select = m.query("select") as HTMLSelectElement | null;
    assert.ok(select, "project selector");
    await inAct(() => {
      select.value = "p2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.deepEqual(asked, ["/tmp/ledger", "/tmp/site"]);
    m.unmount();
  });

  it("opens on initialProjectId instead of projects[0] (#597)", async () => {
    const asked: string[] = [];
    const m = await mount(
      <PlanboardView
        projects={projects}
        initialProjectId="p2"
        listIssues={async (path) => {
          asked.push(path);
          return okResult;
        }}
      />,
    );
    assert.deepEqual(asked, ["/tmp/site"]);
    const select = m.query("select") as HTMLSelectElement | null;
    assert.ok(select, "project selector");
    assert.equal(select.value, "p2");
    m.unmount();
  });

  it("in-view project select still wins after initialProjectId (#597)", async () => {
    const asked: string[] = [];
    const m = await mount(
      <PlanboardView
        projects={projects}
        initialProjectId="p2"
        listIssues={async (path) => {
          asked.push(path);
          return okResult;
        }}
      />,
    );
    assert.deepEqual(asked, ["/tmp/site"]);
    const select = m.query("select") as HTMLSelectElement | null;
    assert.ok(select, "project selector");
    await inAct(() => {
      select.value = "p1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.deepEqual(asked, ["/tmp/site", "/tmp/ledger"]);
    assert.equal(select.value, "p1");
    m.unmount();
  });

  it("shows the failure reason with a retry", async () => {
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => ({ ok: false, reason: "auth" })}
      />,
    );
    assert.ok(m.query("[data-planboard-error]"), "error state");
    assert.ok(m.text().includes("auth"));
    assert.ok(m.text().includes("Retry"));
    m.unmount();
  });

  it("reorders a column from the sort selector", async () => {
    const sortable: ListIssuesResult = {
      ok: true,
      issues: [
        {
          number: 10,
          title: "older",
          url: "https://github.com/acme/ledger/issues/10",
          state: "OPEN",
          labels: [],
          updatedAt: "2026-02-01T00:00:00Z",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          number: 30,
          title: "newer",
          url: "https://github.com/acme/ledger/issues/30",
          state: "OPEN",
          labels: [],
          updatedAt: "2026-01-01T00:00:00Z",
          createdAt: "2026-03-01T00:00:00Z",
        },
      ],
    };
    const m = await mount(
      <PlanboardView projects={projects} listIssues={async () => sortable} />,
    );
    const numbers = () =>
      Array.from(
        m.queryAll('[data-plan-column="todo"] [data-plan-issue]'),
      ).map((el) => el.getAttribute("data-plan-issue"));
    assert.deepEqual(numbers(), ["10", "30"], "default: recently updated");

    const select = m.query("select[data-plan-sort]") as HTMLSelectElement | null;
    assert.ok(select, "sort selector");
    await inAct(() => {
      select.value = "number-asc";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.deepEqual(numbers(), ["10", "30"], "low to high");

    await inAct(() => {
      select.value = "created-desc";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.deepEqual(numbers(), ["30", "10"], "newest added");
    m.unmount();
  });

  it("starts a task from a Todo card only, and reloads the board", async () => {
    const started: { projectPath: string; ref: string }[] = [];
    let loads = 0;
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => {
          loads++;
          return okResult;
        }}
        onStartTask={async (input) => {
          started.push({ projectPath: input.projectPath, ref: input.ref });
          return { ok: true };
        }}
      />,
    );
    assert.ok(!m.query('[data-plan-start="2"]'), "no button on In progress");
    assert.ok(!m.query('[data-plan-start="3"]'), "no button on Done");
    const button = m.query('[data-plan-start="1"]') as HTMLButtonElement | null;
    assert.ok(button, "Start task on the Todo card");
    await inAct(() => button.click());
    assert.deepEqual(started, [{ projectPath: "/tmp/ledger", ref: "1" }]);
    assert.equal(loads, 2, "board reloads so the card moves");
    m.unmount();
  });

  it("keeps the thread but reports a failed or partial start", async () => {
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        onStartTask={async () => ({
          ok: true,
          warning: "plan:doing not set (auth)",
        })}
      />,
    );
    const button = m.query('[data-plan-start="1"]') as HTMLButtonElement | null;
    assert.ok(button);
    await inAct(() => button.click());
    assert.ok(m.text().includes("plan:doing not set (auth)"));
    m.unmount();
  });

  it("explains the plan:* convention when the board is empty", async () => {
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => ({ ok: true, issues: [] })}
      />,
    );
    assert.ok(m.text().includes("Nothing on the plan yet"));
    assert.ok(m.text().includes("plan:todo"));
    m.unmount();
  });

  it("shows the selected project's thread plans and opens the thread", async () => {
    const threads = [
      thread({
        id: "t1",
        projectId: "p1",
        title: "ledger thread",
        planSteps: [
          { step: "read the store", status: "done" },
          { step: "wire the runner", status: "doing" },
        ],
      }),
      thread({ id: "t2", projectId: "p2", title: "site thread",
        planSteps: [{ step: "other project", status: "todo" }] }),
      thread({ id: "t3", projectId: "p1", title: "no plan yet" }),
    ];
    const opened: string[] = [];
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => ({ ok: true, issues: [] })}
        threads={threads}
        onSelectThread={(id) => opened.push(id)}
      />,
    );
    const section = m.query("[data-thread-plans]");
    assert.ok(section, "thread plans section");
    assert.ok(section.textContent?.includes("wire the runner"));
    assert.ok(!section.textContent?.includes("other project"), "other project");
    assert.ok(!section.textContent?.includes("no plan yet"), "plan-less thread");
    assert.equal(
      m.query('[data-thread-plan="t1"] [data-plan-step="doing"]')?.textContent,
      "wire the runner",
    );
    // Plans alone keep the board out of the empty state.
    assert.ok(!m.text().includes("Nothing on the plan yet"));
    const open = m.query('[data-thread-plan="t1"] button') as HTMLButtonElement;
    await inAct(() => open.click());
    assert.deepEqual(opened, ["t1"]);
    m.unmount();
  });

  it("Start task passes the header's mode", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        onStartTask={async (input) => {
          calls.push(input);
          return { ok: true as const };
        }}
      />,
    );

    const select = m.query("[data-plan-start-mode]") as HTMLSelectElement | null;
    assert.ok(select, "the board has a start-mode selector");
    // Defaults to the app setting, i.e. no explicit override.
    assert.equal(select.value, "default");

    await inAct(() => {
      select.value = "orchestrator";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await inAct(() => {
      (m.query("[data-plan-start='1']") as HTMLElement).click();
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].ref, "1");
    assert.equal(calls[0].mode, "orchestrator");
    m.unmount();
  });

  it("hides the orchestrator-agent field until Start as is Orchestrator (#714)", async () => {
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        onStartTask={async () => ({ ok: true as const })}
        agentProfiles={[SCOUT]}
        providers={[CLAUDE]}
      />,
    );
    assert.equal(m.query("[data-plan-orch-agent]"), null);
    const mode = m.query("[data-plan-start-mode]") as HTMLSelectElement;
    await inAct(() => {
      mode.value = "orchestrator";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const agent = m.query("[data-plan-orch-agent]") as HTMLSelectElement | null;
    assert.ok(agent, "orchestrator agent field appears with the mode");
    assert.equal(agent.value, "");
    assert.ok(agent.textContent?.includes("Cheap scout"));
    m.unmount();
  });

  it("Start task passes the chosen orchestrator agent profile (#714)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        onStartTask={async (input) => {
          calls.push(input);
          return { ok: true as const };
        }}
        agentProfiles={[SCOUT, GROK_WORKER]}
        providers={[CLAUDE, GROK_UNAVAILABLE]}
      />,
    );
    const mode = m.query("[data-plan-start-mode]") as HTMLSelectElement;
    await inAct(() => {
      mode.value = "orchestrator";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const agent = m.query("[data-plan-orch-agent]") as HTMLSelectElement;
    const grok = agent.querySelector('option[value="p-grok"]') as HTMLOptionElement | null;
    assert.ok(grok, "unavailable profile is listed");
    assert.equal(grok.disabled, true, "unavailable profile is not selectable");

    await inAct(() => {
      agent.value = "p-scout";
      agent.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await inAct(() => {
      (m.query("[data-plan-start='1']") as HTMLElement).click();
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, "orchestrator");
    assert.equal(calls[0].agentProfileId, "p-scout");
    m.unmount();
  });

  it("Start task omits agentProfileId when the orchestrator agent is Default (#714)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        onStartTask={async (input) => {
          calls.push(input);
          return { ok: true as const };
        }}
        agentProfiles={[SCOUT]}
        providers={[CLAUDE]}
      />,
    );
    const mode = m.query("[data-plan-start-mode]") as HTMLSelectElement;
    await inAct(() => {
      mode.value = "orchestrator";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await inAct(() => {
      (m.query("[data-plan-start='1']") as HTMLElement).click();
    });
    assert.equal(calls[0].mode, "orchestrator");
    assert.equal(calls[0].agentProfileId, undefined);
    m.unmount();
  });

  it("Start task applies the settings default when Orchestrator: Default is selected (#725)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        onStartTask={async (input) => {
          calls.push(input);
          return { ok: true as const };
        }}
        agentProfiles={[SCOUT, GROK_WORKER]}
        defaultOrchestratorProfileId="p-scout"
        providers={[CLAUDE, GROK_UNAVAILABLE]}
      />,
    );
    const mode = m.query("[data-plan-start-mode]") as HTMLSelectElement;
    await inAct(() => {
      mode.value = "orchestrator";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const agent = m.query("[data-plan-orch-agent]") as HTMLSelectElement;
    assert.equal(agent.value, "");
    assert.ok(
      agent.textContent?.includes("Default (Cheap scout)"),
      `default option names the settings profile, got: ${agent.textContent}`,
    );
    await inAct(() => {
      (m.query("[data-plan-start='1']") as HTMLElement).click();
    });
    assert.equal(calls[0].mode, "orchestrator");
    assert.equal(calls[0].agentProfileId, "p-scout");
    m.unmount();
  });

  it("deferred A start after A→B leaves B's board and starts B's issue (#1131)", async () => {
    const started: Array<{
      projectId: string;
      projectPath: string;
      ref: string;
    }> = [];
    let resolveStart!: (value: { ok: true }) => void;
    const held = new Promise<{ ok: true }>((resolve) => {
      resolveStart = resolve;
    });
    const m = await mount(
      <PlanboardView
        projects={AUDIT_PROJECTS}
        listIssues={async (path) => auditIssues(path)}
        onStartTask={async (input) => {
          started.push({
            projectId: input.projectId,
            projectPath: input.projectPath,
            ref: input.ref,
          });
          if (started.length === 1) await held;
          return { ok: true as const };
        }}
      />,
    );

    assert.ok(m.query('[data-plan-issue="11"]'), "A/#11 on the board");
    await m.click(m.query('[data-plan-start="11"]'));
    assert.deepEqual(started, [
      { projectId: "a", projectPath: "/tmp/audit-a", ref: "11" },
    ]);

    await m.change(m.query('select[aria-label="Project"]'), "b");
    assert.ok(m.query('[data-plan-issue="22"]'), "B/#22 after the switch");
    assert.equal(m.query('[data-plan-issue="11"]'), null);
    assert.equal(
      (m.query('select[aria-label="Project"]') as HTMLSelectElement).value,
      "b",
    );

    await inAct(() => {
      resolveStart({ ok: true });
    });
    await m.flush();

    assert.equal(
      (m.query('select[aria-label="Project"]') as HTMLSelectElement).value,
      "b",
      "selector stays on B",
    );
    assert.ok(m.query('[data-plan-issue="22"]'), "B's card remains");
    assert.equal(
      m.query('[data-plan-issue="11"]'),
      null,
      "A's card must not replace B",
    );
    assert.equal(m.query("[data-plan-start-note]"), null, "A's note stays off B");
    const bStart = m.query('[data-plan-start="22"]') as HTMLButtonElement | null;
    assert.ok(bStart, "B can still start its own issue");
    assert.equal(bStart.disabled, false);
    assert.equal(bStart.textContent, "Start task");

    await m.click(bStart);
    assert.deepEqual(started, [
      { projectId: "a", projectPath: "/tmp/audit-a", ref: "11" },
      { projectId: "b", projectPath: "/tmp/audit-b", ref: "22" },
    ]);
    m.unmount();
  });

  it("deferred A failure after A→B leaves B's board intact (#1131)", async () => {
    let resolveStart!: (value: { ok: false; reason: string }) => void;
    const held = new Promise<{ ok: false; reason: string }>((resolve) => {
      resolveStart = resolve;
    });
    const m = await mount(
      <PlanboardView
        projects={AUDIT_PROJECTS}
        listIssues={async (path) => auditIssues(path)}
        onStartTask={async () => held}
      />,
    );

    await m.click(m.query('[data-plan-start="11"]'));
    await m.change(m.query('select[aria-label="Project"]'), "b");
    await inAct(() => {
      resolveStart({ ok: false, reason: "auth" });
    });
    await m.flush();

    assert.ok(m.query('[data-plan-issue="22"]'));
    assert.equal(m.query('[data-plan-issue="11"]'), null);
    assert.equal(m.query("[data-plan-start-note]"), null);
    assert.ok(!m.text().includes("auth"));
    m.unmount();
  });

  it("deferred A start after A→B→A still refreshes A (#1131)", async () => {
    let resolveStart!: (value: { ok: true }) => void;
    const held = new Promise<{ ok: true }>((resolve) => {
      resolveStart = resolve;
    });
    let aLoads = 0;
    const m = await mount(
      <PlanboardView
        projects={AUDIT_PROJECTS}
        listIssues={async (path) => {
          if (path === AUDIT_A.path) aLoads++;
          return auditIssues(path);
        }}
        onStartTask={async () => held}
      />,
    );

    await m.click(m.query('[data-plan-start="11"]'));
    await m.change(m.query('select[aria-label="Project"]'), "b");
    await m.change(m.query('select[aria-label="Project"]'), "a");
    assert.ok(m.query('[data-plan-issue="11"]'));
    const loadsBeforeSettle = aLoads;

    await inAct(() => {
      resolveStart({ ok: true });
    });
    await m.flush();

    assert.ok(m.query('[data-plan-issue="11"]'), "back on A");
    assert.equal(m.query('[data-plan-issue="22"]'), null);
    assert.ok(
      m.text().includes("#11: thread started"),
      "A's own completion note is kept",
    );
    assert.ok(aLoads > loadsBeforeSettle, "A still reloads after its own start");
    m.unmount();
  });

  it("deferred A start after A is removed leaves the remaining board intact (#1131)", async () => {
    let resolveStart!: (value: { ok: true }) => void;
    const held = new Promise<{ ok: true }>((resolve) => {
      resolveStart = resolve;
    });
    function Harness() {
      const [list, setList] = React.useState(AUDIT_PROJECTS);
      return (
        <>
          <button
            type="button"
            data-drop-a=""
            onClick={() => setList([AUDIT_B])}
          >
            drop A
          </button>
          <PlanboardView
            projects={list}
            listIssues={async (path) => auditIssues(path)}
            onStartTask={async () => held}
          />
        </>
      );
    }
    const m = await mount(<Harness />);
    await m.click(m.query('[data-plan-start="11"]'));
    await m.click(m.query("[data-drop-a]"));
    assert.ok(m.query('[data-plan-issue="22"]'), "fallback project is B");

    await inAct(() => {
      resolveStart({ ok: true });
    });
    await m.flush();

    assert.ok(m.query('[data-plan-issue="22"]'));
    assert.equal(m.query('[data-plan-issue="11"]'), null);
    assert.equal(m.query("[data-plan-start-note]"), null);
    m.unmount();
  });

  it("surfaces a rejected listIssues load and re-enables Refresh (#1132)", async () => {
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => {
          throw new Error("request timed out");
        }}
      />,
    );
    await m.flush();
    assert.ok(m.query("[data-planboard-error]"), "scoped load error");
    assert.ok(m.text().includes("request timed out"));
    assert.ok(!m.text().includes("Loading plan"));
    const refresh = m.byText("Refresh") as HTMLButtonElement | null;
    assert.ok(refresh);
    assert.equal(refresh.disabled, false);
    m.unmount();
  });

  it("drops a stale rejected load when the project changes (#1132)", async () => {
    let rejectLedger: (err: Error) => void = () => {};
    let resolveSite: (result: ListIssuesResult) => void = () => {};
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={(path) => {
          if (path === "/tmp/ledger") {
            return new Promise<ListIssuesResult>((_, reject) => {
              rejectLedger = reject;
            });
          }
          return new Promise<ListIssuesResult>((resolve) => {
            resolveSite = resolve;
          });
        }}
      />,
    );
    const select = m.query("select") as HTMLSelectElement | null;
    assert.ok(select, "project selector");
    await inAct(() => {
      select.value = "p2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await inAct(async () => {
      rejectLedger(new Error("stale timeout"));
      resolveSite(okResult);
      await Promise.resolve();
    });
    await m.flush();
    assert.ok(m.query('[data-plan-issue="1"]'), "new project's cards");
    assert.ok(!m.text().includes("stale timeout"), "stale reject must not land");
    const refresh = m.byText("Refresh") as HTMLButtonElement | null;
    assert.equal(refresh?.disabled, false);
    m.unmount();
  });

  it("restores Start task after onStartTask rejects and does not retry (#1132)", async () => {
    let starts = 0;
    let loads = 0;
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => {
          loads += 1;
          return okResult;
        }}
        onStartTask={async () => {
          starts += 1;
          throw new Error("disconnected");
        }}
      />,
    );
    await m.flush();
    const button = m.query('[data-plan-start="1"]') as HTMLButtonElement | null;
    assert.ok(button, "Start task on the Todo card");
    await inAct(() => button.click());
    await m.flush();
    assert.equal(starts, 1, "must not auto-retry a rejected start");
    assert.equal(loads, 1, "must not refresh after an ambiguous start rejection");
    const note = m.query("[data-plan-start-note]");
    assert.ok(note, "failure note");
    assert.ok(note.textContent?.includes("disconnected"));
    const start = m.query('[data-plan-start="1"]') as HTMLButtonElement | null;
    assert.ok(start);
    assert.equal(start.disabled, false, "Start task usable after rejection");
    assert.ok(!start.textContent?.includes("Starting"));
    m.unmount();
  });

  it("Start task does not apply an unavailable settings default (#725)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        onStartTask={async (input) => {
          calls.push(input);
          return { ok: true as const };
        }}
        agentProfiles={[GROK_WORKER]}
        defaultOrchestratorProfileId="p-grok"
        providers={[GROK_UNAVAILABLE]}
      />,
    );
    const mode = m.query("[data-plan-start-mode]") as HTMLSelectElement;
    await inAct(() => {
      mode.value = "orchestrator";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await inAct(() => {
      (m.query("[data-plan-start='1']") as HTMLElement).click();
    });
    assert.equal(calls[0].agentProfileId, undefined);
    m.unmount();
  });
});

describe("PlanboardView review-load meter (#402)", () => {
  const prsResult: ListPrsResult = {
    ok: true,
    prs: [
      {
        number: 11,
        title: "a",
        url: "https://github.com/acme/ledger/pull/11",
        state: "OPEN",
        headRefName: "coder/a",
        additions: 300,
        deletions: 50,
      },
      {
        number: 12,
        title: "b",
        url: "https://github.com/acme/ledger/pull/12",
        state: "OPEN",
        headRefName: "coder/b",
        additions: 200,
        deletions: 100,
      },
      {
        number: 13,
        title: "merged",
        url: "https://github.com/acme/ledger/pull/13",
        state: "MERGED",
        headRefName: "coder/c",
        additions: 9000,
      },
      {
        number: 14,
        title: "draft",
        url: "https://github.com/acme/ledger/pull/14",
        state: "OPEN",
        headRefName: "coder/d",
        isDraft: true,
        additions: 9000,
      },
    ],
  };

  it("shows open non-draft PR pressure in the header", async () => {
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        listPrs={async () => prsResult}
      />,
    );
    const meter = m.query("[data-review-load]");
    assert.ok(meter, "meter renders");
    assert.equal(meter.getAttribute("data-review-load"), "ok");
    assert.ok(meter.textContent?.includes("Review load: 2 PRs"));
    assert.ok(meter.textContent?.includes("650 lines"));
    m.unmount();
  });

  it("marks the queue busy at four open PRs", async () => {
    const busy: ListPrsResult = {
      ok: true,
      prs: [1, 2, 3, 4].map((n) => ({
        number: n,
        title: `pr ${n}`,
        url: `https://github.com/acme/ledger/pull/${n}`,
        state: "OPEN" as const,
        headRefName: `coder/${n}`,
      })),
    };
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        listPrs={async () => busy}
      />,
    );
    const meter = m.query("[data-review-load]");
    assert.equal(meter?.getAttribute("data-review-load"), "busy");
    m.unmount();
  });

  it("shows issue cards and re-enables Refresh when listPrs rejects (#1132)", async () => {
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        listPrs={async () => {
          throw new Error("request timed out");
        }}
      />,
    );
    await m.flush();
    assert.ok(m.query('[data-plan-column="todo"]'), "board still renders");
    assert.ok(m.query('[data-plan-issue="1"]'), "successful issue cards stay visible");
    assert.equal(m.query("[data-review-load]"), null, "meter stays off on reject");
    assert.ok(!m.text().includes("Loading plan"));
    const refresh = m.byText("Refresh") as HTMLButtonElement | null;
    assert.ok(refresh, "Refresh present");
    assert.equal(refresh.disabled, false, "Refresh usable after optional PR reject");
    m.unmount();
  });

  it("clears Refresh after a rejected refresh without hiding cards (#1132)", async () => {
    let prCalls = 0;
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        listPrs={async () => {
          prCalls += 1;
          if (prCalls === 1) {
            return {
              ok: true,
              prs: [
                {
                  number: 11,
                  title: "a",
                  url: "https://github.com/acme/ledger/pull/11",
                  state: "OPEN",
                  headRefName: "coder/a",
                  additions: 10,
                  deletions: 1,
                },
              ],
            };
          }
          throw new Error("disconnected");
        }}
      />,
    );
    await m.flush();
    assert.ok(m.query("[data-review-load]"), "meter on first success");
    await m.click(m.byText("Refresh"));
    await m.flush();
    assert.ok(m.query('[data-plan-issue="1"]'), "cards survive rejected PR refresh");
    assert.equal(m.query("[data-review-load]"), null);
    const refresh = m.byText("Refresh") as HTMLButtonElement | null;
    assert.equal(refresh?.disabled, false);
    m.unmount();
  });

  it("hides the meter when the PR list fails, board unaffected", async () => {
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        listPrs={async () => ({ ok: false as const, reason: "auth" })}
      />,
    );
    assert.equal(m.query("[data-review-load]"), null);
    assert.ok(m.query('[data-plan-column="todo"]'), "board still renders");
    m.unmount();
  });

  it("hides the meter when listPrs is not wired", async () => {
    const m = await mount(
      <PlanboardView projects={projects} listIssues={async () => okResult} />,
    );
    assert.equal(m.query("[data-review-load]"), null);
    m.unmount();
  });
});

describe("PlanboardView issue search (#945)", () => {
  function manyIssues(): ListIssuesResult {
    const issues = Array.from({ length: 60 }, (_, i) => {
      const number = i + 1;
      const column =
        number % 3 === 1 ? "todo" : number % 3 === 2 ? "doing" : "done";
      return {
        number,
        title:
          number === 42
            ? "Restore AUTH session"
            : number === 7
              ? "Quiet backlog card"
              : `Issue ${number}`,
        url: `https://github.com/acme/ledger/issues/${number}`,
        state: column === "done" ? ("CLOSED" as const) : ("OPEN" as const),
        labels:
          column === "todo"
            ? ["plan:todo"]
            : column === "doing"
              ? ["plan:doing"]
              : [],
        updatedAt: `2026-03-${String((number % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      };
    });
    return { ok: true, issues };
  }

  it("filters loaded cards by case-insensitive title or #number across statuses", async () => {
    let loads = 0;
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => {
          loads += 1;
          return manyIssues();
        }}
      />,
    );
    const search = m.query("[data-plan-search]") as HTMLInputElement | null;
    assert.ok(search, "labelled native search");
    assert.equal(search.type, "search");
    assert.equal(search.getAttribute("aria-label"), "Find issues by title or number");
    assert.equal(loads, 1);

    await m.type(search, "auth session");
    assert.ok(m.query('[data-plan-issue="42"]'));
    assert.equal(m.queryAll("[data-plan-issue]").length, 1);
    assert.ok(
      m.query('[data-plan-column="done"] [data-plan-issue="42"]'),
      "title match across statuses",
    );
    assert.ok(m.text().includes("1 of 60"), "visible/total while searching");
    assert.equal(loads, 1, "search stays local");

    await m.type(search, "#7");
    assert.ok(m.query('[data-plan-issue="7"]'));
    assert.equal(m.queryAll("[data-plan-issue]").length, 1);
    assert.ok(m.query('[data-plan-column="todo"] [data-plan-issue="7"]'));

    await m.type(search, "42");
    assert.ok(m.query('[data-plan-issue="42"]'));
    assert.equal(m.queryAll("[data-plan-issue]").length, 1);
    m.unmount();
  });

  it("clears back to every row and the original column order", async () => {
    const result = manyIssues();
    const m = await mount(
      <PlanboardView projects={projects} listIssues={async () => result} />,
    );
    const before = Array.from(m.queryAll("[data-plan-issue]")).map((el) =>
      el.getAttribute("data-plan-issue"),
    );
    await m.type(m.query("[data-plan-search]"), "auth");
    assert.equal(m.queryAll("[data-plan-issue]").length, 1);
    await m.click(m.byText("Clear search"));
    const after = Array.from(m.queryAll("[data-plan-issue]")).map((el) =>
      el.getAttribute("data-plan-issue"),
    );
    assert.deepEqual(after, before);
    assert.equal(
      (m.query("[data-plan-search]") as HTMLInputElement).value,
      "",
    );
    m.unmount();
  });

  it("no-match copy is not the empty-plan state and can be cleared", async () => {
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => manyIssues()}
        threads={[
          thread({
            id: "t-plan",
            projectId: "p1",
            title: "live agent plan",
            planSteps: [{ step: "keep going", status: "doing" }],
          }),
        ]}
      />,
    );
    await m.type(m.query("[data-plan-search]"), "zzz-missing");
    assert.ok(m.query("[data-plan-no-match]"), "distinct no-match");
    assert.ok(m.text().includes("No matching issues"));
    assert.ok(!m.text().includes("Nothing on the plan yet"));
    const plans = m.query("[data-thread-plans]");
    assert.ok(plans, "live agent plans stay visible");
    assert.ok(plans.textContent?.includes("Thread plans"));
    assert.ok(plans.textContent?.includes("live agent plan"));
    await m.click(m.query("[data-plan-no-match] button"));
    assert.equal(m.query("[data-plan-no-match]"), null);
    assert.ok(m.query('[data-plan-issue="42"]'));
    m.unmount();
  });

  it("Start task still works on a filtered Todo card", async () => {
    const started: string[] = [];
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => manyIssues()}
        onStartTask={async (input) => {
          started.push(input.ref);
          return { ok: true as const };
        }}
      />,
    );
    await m.type(m.query("[data-plan-search]"), "Quiet backlog");
    const start = m.query('[data-plan-start="7"]') as HTMLButtonElement | null;
    assert.ok(start, "Start task remains on the filtered card");
    await m.click(start);
    assert.deepEqual(started, ["7"]);
    m.unmount();
  });

  it("keeps project, search, and Refresh on the primary row", async () => {
    const m = await mount(
      <PlanboardView
        projects={projects}
        listIssues={async () => okResult}
        onStartTask={async () => ({ ok: true as const })}
      />,
    );
    const primary = m.query("[data-plan-primary]");
    const secondary = m.query("[data-plan-secondary]");
    assert.ok(primary, "primary controls");
    assert.ok(secondary, "wrapping secondary launch row");
    assert.ok(primary.querySelector("[data-plan-search]"));
    assert.ok(primary.querySelector('select[aria-label="Project"]'));
    assert.ok(primary.querySelector("button")?.textContent?.includes("Refresh"));
    assert.ok(secondary.querySelector("[data-plan-start-mode]"));
    assert.ok(secondary.querySelector("[data-plan-sort]"));
    const search = m.query("[data-plan-search]") as HTMLInputElement;
    search.focus();
    assert.equal(m.container.ownerDocument.activeElement, search);
    await m.pressFocused("Escape");
    m.unmount();
  });
});
