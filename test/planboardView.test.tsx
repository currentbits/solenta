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
import type { ListIssuesResult, ProjectInfo } from "../src/shared/ipc";

const projects: ProjectInfo[] = [
  { id: "p1", slug: "acme/ledger", name: "ledger", path: "/tmp/ledger" },
  { id: "p2", slug: "acme/site", name: "site", path: "/tmp/site" },
];

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
});

