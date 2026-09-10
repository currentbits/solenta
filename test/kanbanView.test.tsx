/**
 * KanbanView: columns, counts, click-through.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { KanbanView } from "../src/components/KanbanView";
import type { ProjectInfo, ProviderInfo, ThreadInfo } from "../src/shared/ipc";

const project: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
};

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

const NOW = Date.now();

function thread(
  over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">,
): ThreadInfo {
  return {
    projectId: "p1",
    title: over.title ?? over.id,
    branch: over.branch ?? "coder/branch",
    prNumber: over.prNumber ?? null,
    prUrl: over.prUrl ?? null,
    status: over.status ?? "idle",
    createdAt: NOW,
    updatedAt: NOW,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: NOW,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  };
}

describe("KanbanView", () => {
  it("renders four columns with counts and card titles", async () => {
    const m = await mount(
      <KanbanView
        threads={[
          thread({ id: "tw", title: "working card", status: "working" }),
          thread({ id: "ti", title: "idle card", status: "idle" }),
          thread({ id: "td", title: "done card", status: "done" }),
          thread({ id: "tf", title: "failed card", status: "failed" }),
        ]}
        projects={[project]}
        providers={providers}
        onSelectThread={() => {}}
      />,
    );
    const working = m.query('[data-kanban-column="working"]');
    const idle = m.query('[data-kanban-column="idle"]');
    const done = m.query('[data-kanban-column="done"]');
    const failed = m.query('[data-kanban-column="failed"]');
    assert.ok(working && idle && done && failed, "four columns");
    assert.ok(working.textContent?.includes("Working"));
    assert.ok(working.textContent?.includes("1"));
    assert.ok(working.textContent?.includes("working card"));
    assert.equal(
      working.querySelector("[data-return-scroll]")?.getAttribute("data-return-scroll"),
      "working",
    );
    assert.equal(
      idle.querySelector("[data-return-scroll]")?.getAttribute("data-return-scroll"),
      "idle",
    );
    assert.ok(idle.textContent?.includes("idle card"));
    assert.ok(done.textContent?.includes("done card"));
    assert.ok(failed.textContent?.includes("failed card"));
    assert.ok(m.text().includes("acme/ledger"));
    m.unmount();
  });

  it("selects the thread and leaves the board when a card is clicked", async () => {
    let selected: string | null = null;
    let scrollKey: string | undefined;
    let rowIndex: number | undefined;
    const m = await mount(
      <KanbanView
        threads={[thread({ id: "t-click", title: "click me", status: "idle" })]}
        projects={[project]}
        providers={providers}
        onSelectThread={(id, origin) => {
          selected = id;
          scrollKey = origin?.scrollKey;
          rowIndex = origin?.rowIndex;
        }}
      />,
    );
    const select = m.query('button[aria-label="Select thread: click me"]');
    assert.ok(select, "card select button");
    await m.click(select);
    assert.equal(selected, "t-click");
    assert.equal(scrollKey, "idle");
    assert.equal(rowIndex, 0);
    m.unmount();
  });

  it("projectScope filters the board to that project's threads (#598)", async () => {
    const p2: ProjectInfo = {
      id: "p2",
      slug: "acme/billing",
      name: "billing",
      path: "/tmp/billing",
    };
    const m = await mount(
      <KanbanView
        threads={[
          thread({ id: "in", title: "in scope", status: "idle" }),
          thread({
            id: "out",
            title: "out of scope",
            status: "idle",
            projectId: "p2",
          }),
        ]}
        projects={[project, p2]}
        projectScope="p1"
        providers={providers}
        onSelectThread={() => {}}
      />,
    );
    assert.ok(m.text().includes("in scope"));
    assert.ok(!m.text().includes("out of scope"));
    m.unmount();
  });

  it("header Project select is seeded from projectScope and lists All projects (#944)", async () => {
    const p2: ProjectInfo = {
      id: "p2",
      slug: "acme/billing",
      name: "billing",
      path: "/tmp/billing",
    };
    const m = await mount(
      <KanbanView
        threads={[thread({ id: "in", title: "in scope", status: "idle" })]}
        projects={[project, p2]}
        projectScope="p1"
        providers={providers}
        onSelectThread={() => {}}
      />,
    );
    const select = m.query('select[aria-label="Project"]') as HTMLSelectElement | null;
    assert.ok(select, "labelled Project select");
    assert.equal(select.value, "p1");
    const labels = [...select.options].map((o) => o.textContent);
    assert.ok(labels.includes("All projects"));
    assert.ok(labels.includes("acme/ledger"));
    assert.ok(labels.includes("acme/billing"));
    assert.ok(m.text().includes("Project"), "visible Project label");
    m.unmount();
  });

  it("changing the header Project select reports the new scope (#944)", async () => {
    const p2: ProjectInfo = {
      id: "p2",
      slug: "acme/billing",
      name: "billing",
      path: "/tmp/billing",
    };
    const seen: Array<string | null> = [];
    const m = await mount(
      <KanbanView
        threads={[thread({ id: "in", title: "in scope", status: "idle" })]}
        projects={[project, p2]}
        projectScope="p1"
        providers={providers}
        onSelectThread={() => {}}
        onProjectScopeChange={(id) => {
          seen.push(id);
        }}
      />,
    );
    const select = m.query('select[aria-label="Project"]') as HTMLSelectElement;
    await m.change(select, "");
    assert.deepEqual(seen, [null]);
    m.unmount();
  });

  it("scoped empty board names the project and offers Show all projects (#944)", async () => {
    const p2: ProjectInfo = {
      id: "p2",
      slug: "acme/billing",
      name: "billing",
      path: "/tmp/billing",
    };
    const seen: Array<string | null> = [];
    const m = await mount(
      <KanbanView
        threads={[thread({ id: "in", title: "in scope", status: "idle" })]}
        projects={[project, p2]}
        projectScope="p2"
        providers={providers}
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onProjectScopeChange={(id) => {
          seen.push(id);
        }}
      />,
    );
    assert.equal(
      m.query("[data-scope-empty]")?.textContent,
      "No threads in acme/billing",
    );
    assert.equal(m.query("[data-kanban-column]"), null);
    const escape = m.byText("Show all projects");
    assert.ok(escape, "Show all projects escape");
    await m.click(escape);
    assert.deepEqual(seen, [null]);
    m.unmount();
  });

  it("names a removed project in the header and empty board (#944)", async () => {
    const m = await mount(
      <KanbanView
        threads={[thread({ id: "in", title: "in scope", status: "idle" })]}
        projects={[project]}
        projectScope="p-gone"
        providers={providers}
        onSelectThread={() => {}}
      />,
    );
    const select = m.query('select[aria-label="Project"]') as HTMLSelectElement | null;
    assert.ok(select);
    assert.equal(select.value, "p-gone");
    assert.ok(
      [...select.options].some((o) => o.textContent === "Removed project"),
      "explicit removed-project option",
    );
    assert.equal(m.query("[data-scope-empty]")?.textContent, "Removed project");
    assert.ok(m.byText("Show all projects"));
    assert.equal(m.query("[data-kanban-column]"), null);
    m.unmount();
  });

  it("points an empty board at New thread", async () => {
    const m = await mount(
      <KanbanView
        threads={[
          thread({ id: "archived", status: "idle", archived: true }),
          thread({
            id: "settled",
            status: "done",
            settledOverride: "settled",
          }),
        ]}
        projects={[project]}
        providers={providers}
        onSelectThread={() => {}}
        onCreateThread={() => {}}
      />,
    );
    assert.ok(m.text().includes("No threads on the board"));
    assert.ok(m.text().includes("New thread"));
    assert.equal(m.query("[data-kanban-column]"), null);
    m.unmount();
  });
});
