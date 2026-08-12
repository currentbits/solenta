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
    assert.ok(idle.textContent?.includes("idle card"));
    assert.ok(done.textContent?.includes("done card"));
    assert.ok(failed.textContent?.includes("failed card"));
    assert.ok(m.text().includes("acme/ledger"));
    m.unmount();
  });

  it("selects the thread and leaves the board when a card is clicked", async () => {
    let selected: string | null = null;
    const m = await mount(
      <KanbanView
        threads={[thread({ id: "t-click", title: "click me", status: "idle" })]}
        projects={[project]}
        providers={providers}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    const select = m.query('button[aria-label="Select thread: click me"]');
    assert.ok(select, "card select button");
    await m.click(select);
    assert.equal(selected, "t-click");
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
