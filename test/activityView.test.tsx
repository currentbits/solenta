/**
 * ActivityView: groups, rows, click-through.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { ActivityView } from "../src/components/ActivityView";
import type { ActivityItem, ProjectInfo } from "../src/shared/ipc";

const DAY_MS = 24 * 60 * 60 * 1000;

const p1: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
};
const p2: ProjectInfo = {
  id: "p2",
  slug: "acme/billing",
  name: "billing",
  path: "/tmp/billing",
};

function item(over: Partial<ActivityItem> & Pick<ActivityItem, "id" | "kind">): ActivityItem {
  return {
    threadId: over.threadId ?? over.id,
    projectId: "p1",
    threadTitle: over.threadTitle ?? over.id,
    at: over.at ?? Date.now(),
    ...over,
  };
}

describe("ActivityView", () => {
  it("groups rows by day and shows slug, title, kind, relative time", async () => {
    const now = Date.now();
    const listActivity = async (): Promise<ActivityItem[]> => [
      item({
        id: "t1:done:1",
        threadId: "t1",
        kind: "done",
        threadTitle: "Ship ledger",
        at: now,
      }),
      item({
        id: "t2:created:1",
        threadId: "t2",
        projectId: "p2",
        kind: "created",
        threadTitle: "New billing thread",
        at: now - DAY_MS,
      }),
      item({
        id: "t3:failed:1",
        threadId: "t3",
        kind: "failed",
        threadTitle: "Old fail",
        at: now - 10 * DAY_MS,
      }),
    ];
    const m = await mount(
      <ActivityView
        projects={[p1, p2]}
        listActivity={listActivity}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.query('[data-activity-group="Today"]'), "today group");
    assert.ok(m.query('[data-activity-group="Yesterday"]'), "yesterday group");
    assert.ok(m.text().includes("acme/ledger"));
    assert.ok(m.text().includes("acme/billing"));
    assert.ok(m.text().includes("Ship ledger"));
    assert.ok(m.text().includes("New billing thread"));
    assert.ok(m.text().includes("finished"));
    assert.ok(m.text().includes("created"));
    assert.ok(m.text().includes("failed"));
    assert.ok(m.text().includes("Old fail"));
    m.unmount();
  });

  it("selects the thread when a row is clicked", async () => {
    let selected: string | null = null;
    const listActivity = async (): Promise<ActivityItem[]> => [
      item({
        id: "t-hit:started:1",
        threadId: "t-hit",
        kind: "started",
        threadTitle: "click me",
      }),
    ];
    const m = await mount(
      <ActivityView
        projects={[p1]}
        listActivity={listActivity}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const select = m.query('button[aria-label="Select thread: click me"]');
    assert.ok(select, "row select button");
    await m.click(select);
    assert.equal(selected, "t-hit");
    m.unmount();
  });

  it("projectScope filters rows to that project's activity (#598)", async () => {
    const now = Date.now();
    const listActivity = async (): Promise<ActivityItem[]> => [
      item({
        id: "t1:done:1",
        threadId: "t1",
        kind: "done",
        threadTitle: "Ship ledger",
        at: now,
      }),
      item({
        id: "t2:created:1",
        threadId: "t2",
        projectId: "p2",
        kind: "created",
        threadTitle: "New billing thread",
        at: now,
      }),
    ];
    const m = await mount(
      <ActivityView
        projects={[p1, p2]}
        projectScope="p2"
        listActivity={listActivity}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.text().includes("New billing thread"));
    assert.ok(!m.text().includes("Ship ledger"));
    m.unmount();
  });

  it("shows the empty state when the scope filters everything out (#598)", async () => {
    const listActivity = async (): Promise<ActivityItem[]> => [
      item({
        id: "t1:done:1",
        threadId: "t1",
        kind: "done",
        threadTitle: "Ship ledger",
      }),
    ];
    const m = await mount(
      <ActivityView
        projects={[p1, p2]}
        projectScope="p2"
        listActivity={listActivity}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.text().includes("No activity yet"));
    assert.equal(m.query("[data-activity-row]"), null);
    m.unmount();
  });

  it("renders the empty state when there is no activity", async () => {
    const m = await mount(
      <ActivityView
        projects={[p1]}
        listActivity={async () => []}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.text().includes("No activity yet"));
    assert.equal(m.query("[data-activity-row]"), null);
    m.unmount();
  });
});
