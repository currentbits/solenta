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

  it("keeps a missing-thread row visible without selecting it", async () => {
    let selected: string | null = null;
    const m = await mount(
      <ActivityView
        projects={[p1]}
        listActivity={async () => [
          item({
            id: "gone:done:1",
            threadId: "gone",
            kind: "done",
            threadTitle: "Deleted claim",
          }),
        ]}
        existingThreadIds={["t-live"]}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const row = m.query('[data-activity-row="gone:done:1"]');
    assert.ok(row, "historical row stays");
    assert.ok(m.text().includes("Deleted claim"));
    assert.ok(m.text().includes("Transcript unavailable"));
    assert.equal(
      m.query('button[aria-label="Select thread: Deleted claim"]'),
      null,
      "no select overlay",
    );
    const kind = m.query("[data-kind]");
    assert.ok(kind, "kind stays a text cell");
    assert.equal(kind!.closest("button"), null, "kind is not a hit target");
    assert.equal(row!.querySelectorAll("button").length, 0, "no row hit target");
    await m.click(row);
    assert.equal(selected, null);
    m.unmount();
  });

  it("treats an empty existingThreadIds set as loaded and unavailable", async () => {
    let selected: string | null = null;
    const m = await mount(
      <ActivityView
        projects={[p1]}
        listActivity={async () => [
          item({
            id: "gone:done:1",
            threadId: "gone",
            kind: "done",
            threadTitle: "Deleted claim",
          }),
        ]}
        existingThreadIds={[]}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    assert.ok(m.text().includes("Transcript unavailable"));
    assert.equal(
      m.query('button[aria-label="Select thread: Deleted claim"]'),
      null,
    );
    await m.click(m.query('[data-activity-row="gone:done:1"]'));
    assert.equal(selected, null);
    m.unmount();
  });

  it("treats omitted live ids as openable so boot does not flash unavailable", async () => {
    let selected: string | null = null;
    const m = await mount(
      <ActivityView
        projects={[p1]}
        listActivity={async () => [
          item({
            id: "t-boot:started:1",
            threadId: "t-boot",
            kind: "started",
            threadTitle: "Still loading",
          }),
        ]}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const row = m.query('[data-activity-row="t-boot:started:1"]');
    assert.ok(row, "row renders during boot");
    assert.equal(
      /unavailable/i.test(row!.textContent ?? ""),
      false,
      "omitted live set must not mark rows unavailable",
    );
    const select = m.query('button[aria-label="Select thread: Still loading"]');
    assert.ok(select, "row stays openable before the list arrives");
    await m.click(select);
    assert.equal(selected, "t-boot");
    m.unmount();
  });

  it("opens a live row by thread id when another row shares the title", async () => {
    let selected: string | null = null;
    const m = await mount(
      <ActivityView
        projects={[p1]}
        listActivity={async () => [
          item({
            id: "t-hit:started:1",
            threadId: "t-hit",
            kind: "started",
            threadTitle: "click me",
          }),
          item({
            id: "gone:done:1",
            threadId: "gone",
            kind: "done",
            threadTitle: "click me",
          }),
        ]}
        existingThreadIds={["t-hit"]}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const live = m.query('button[aria-label="Select thread: click me"]');
    assert.ok(live, "live row select button");
    await m.click(live);
    assert.equal(selected, "t-hit");
    assert.ok(m.query('[data-activity-row="gone:done:1"]'), "missing row stays");
    assert.ok(m.text().includes("Transcript unavailable"));
    m.unmount();
  });
});
