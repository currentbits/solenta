/**
 * PlanboardView: columns from issues, project selector, error + empty states.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount, inAct } from "./support/dom.ts";
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
});
