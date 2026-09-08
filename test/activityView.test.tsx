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

  it("header Project select is seeded from projectScope and lists All projects (#944)", async () => {
    const m = await mount(
      <ActivityView
        projects={[p1, p2]}
        projectScope="p2"
        listActivity={async () => []}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    const select = m.query('select[aria-label="Project"]') as HTMLSelectElement | null;
    assert.ok(select, "labelled Project select");
    assert.equal(select.value, "p2");
    const labels = [...select.options].map((o) => o.textContent);
    assert.ok(labels.includes("All projects"));
    assert.ok(labels.includes("acme/ledger"));
    assert.ok(labels.includes("acme/billing"));
    assert.ok(m.text().includes("Project"), "visible Project label");
    m.unmount();
  });

  it("changing the header Project select reports the new scope (#944)", async () => {
    const seen: Array<string | null> = [];
    const m = await mount(
      <ActivityView
        projects={[p1, p2]}
        projectScope="p2"
        listActivity={async () => [
          item({
            id: "t2:created:1",
            threadId: "t2",
            projectId: "p2",
            kind: "created",
            threadTitle: "New billing thread",
          }),
        ]}
        onSelectThread={() => {}}
        onProjectScopeChange={(id) => {
          seen.push(id);
        }}
      />,
    );
    await m.flush();
    const select = m.query('select[aria-label="Project"]') as HTMLSelectElement;
    await m.change(select, "");
    assert.deepEqual(seen, [null]);
    m.unmount();
  });

  it("scoped empty state names the project and offers Show all projects (#944)", async () => {
    const seen: Array<string | null> = [];
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
        onProjectScopeChange={(id) => {
          seen.push(id);
        }}
      />,
    );
    await m.flush();
    assert.equal(
      m.query("[data-scope-empty]")?.textContent,
      "No activity in acme/billing",
    );
    assert.equal(m.query("[data-activity-row]"), null);
    const escape = m.byText("Show all projects");
    assert.ok(escape, "Show all projects escape");
    await m.click(escape);
    assert.deepEqual(seen, [null]);
    m.unmount();
  });

  it("names a removed project in the header and empty state (#944)", async () => {
    const m = await mount(
      <ActivityView
        projects={[p1]}
        projectScope="p-gone"
        listActivity={async () => [
          item({
            id: "t1:done:1",
            threadId: "t1",
            kind: "done",
            threadTitle: "Ship ledger",
          }),
        ]}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    const select = m.query('select[aria-label="Project"]') as HTMLSelectElement | null;
    assert.ok(select);
    assert.equal(select.value, "p-gone");
    assert.ok(
      [...select.options].some((o) => o.textContent === "Removed project"),
      "explicit removed-project option",
    );
    assert.equal(m.query("[data-scope-empty]")?.textContent, "Removed project");
    assert.ok(m.byText("Show all projects"));
    assert.equal(m.query("[data-activity-row]"), null);
    m.unmount();
  });

  it("restores focus to the originating row, or the nearest remaining row (#942)", async () => {
    const m = await mount(
      <ActivityView
        projects={[p1, p2]}
        listActivity={async () => [
          item({
            id: "t1:done:1",
            threadId: "t1",
            kind: "done",
            threadTitle: "Ship ledger",
          }),
          item({
            id: "t2:created:1",
            threadId: "t2",
            projectId: "p2",
            kind: "created",
            threadTitle: "New billing thread",
          }),
        ]}
        onSelectThread={() => {}}
        restore={{
          view: "activity",
          projectId: null,
          rowKey: "t2:created:1",
          rowIndex: 1,
          scrollTop: 0,
        }}
      />,
    );
    await m.flush();
    assert.equal(
      m.container.ownerDocument.activeElement?.getAttribute("aria-label"),
      "Select thread: New billing thread",
    );
    m.unmount();

    const gone = await mount(
      <ActivityView
        projects={[p1, p2]}
        listActivity={async () => [
          item({
            id: "t1:done:1",
            threadId: "t1",
            kind: "done",
            threadTitle: "Ship ledger",
          }),
          item({
            id: "t3:failed:1",
            threadId: "t3",
            kind: "failed",
            threadTitle: "Old fail",
          }),
        ]}
        onSelectThread={() => {}}
        restore={{
          view: "activity",
          projectId: null,
          rowKey: "t2:created:1",
          rowIndex: 1,
          scrollTop: 0,
        }}
      />,
    );
    await gone.flush();
    assert.equal(
      gone.container.ownerDocument.activeElement?.getAttribute("aria-label"),
      "Select thread: Old fail",
    );
    gone.unmount();
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

  it("shows an initial load error with retry, not a successful empty list (#943)", async () => {
    let calls = 0;
    const m = await mount(
      <ActivityView
        projects={[p1]}
        listActivity={async () => {
          calls += 1;
          throw new Error("store locked");
        }}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.equal(calls, 1);
    assert.ok(m.query("[data-activity-error]"), "error marker");
    assert.ok(m.query('[role="alert"]'), "error uses role=alert");
    assert.ok(m.text().includes("store locked"));
    assert.ok(m.byText("Retry"), "initial failure offers retry");
    assert.ok(!m.text().includes("No activity yet"), "must not claim nothing happened");
    assert.equal(m.query("[data-activity-row]"), null);
    const refresh = m.byText("Refresh") as HTMLButtonElement | null;
    assert.ok(refresh, "refresh control");
    assert.equal(refresh.disabled, false, "loading control recovers");
    m.unmount();
  });

  it("keeps the last rows after a failed refresh and recovers on retry (#943)", async () => {
    let calls = 0;
    const first = item({
      id: "t1:done:1",
      threadId: "t1",
      kind: "done",
      threadTitle: "Ship ledger",
    });
    const second = item({
      id: "t2:started:1",
      threadId: "t2",
      kind: "started",
      threadTitle: "Retry billing",
    });
    const m = await mount(
      <ActivityView
        projects={[p1]}
        listActivity={async () => {
          calls += 1;
          if (calls === 1) return [first];
          if (calls === 2) throw new Error("store locked");
          return [second];
        }}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.query('[data-activity-row="t1:done:1"]'), "first load");
    assert.ok(m.text().includes("Ship ledger"));
    assert.equal(m.query("[data-activity-error]"), null);
    assert.equal(m.query("[data-activity-stale]"), null);

    await m.click(m.byText("Refresh"));
    assert.ok(m.query('[data-activity-row="t1:done:1"]'), "failed refresh keeps last rows");
    assert.ok(m.text().includes("Ship ledger"));
    assert.ok(!m.text().includes("No activity yet"), "must not erase into empty");
    assert.ok(m.query("[data-activity-error]"), "refresh failure is visible");
    assert.ok(m.query('[role="alert"]')?.textContent?.includes("store locked"));
    assert.ok(m.query("[data-activity-stale]"), "stale/last-success marker");
    assert.match(m.text(), /stale|out of date/i);
    const refresh = m.byText("Refresh") as HTMLButtonElement;
    assert.equal(refresh.disabled, false, "refresh re-enables after failure");
    assert.ok(m.byText("Retry"), "refresh failure exposes retry");

    await m.click(m.byText("Retry"));
    assert.ok(m.query('[data-activity-row="t2:started:1"]'), "successful retry updates rows");
    assert.ok(m.text().includes("Retry billing"));
    assert.equal(m.query('[data-activity-row="t1:done:1"]'), null, "previous rows are replaced");
    assert.equal(m.query("[data-activity-error]"), null, "success clears the error");
    assert.equal(m.query("[data-activity-stale]"), null, "success clears stale");
    m.unmount();
  });

  it("shows the successful-empty copy only after a successful empty response (#943)", async () => {
    let calls = 0;
    const m = await mount(
      <ActivityView
        projects={[p1]}
        listActivity={async () => {
          calls += 1;
          if (calls === 1) throw new Error("store locked");
          return [];
        }}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(!m.text().includes("No activity yet"));
    await m.click(m.byText("Retry"));
    assert.ok(m.text().includes("No activity yet"));
    assert.equal(m.query("[data-activity-error]"), null);
    assert.equal(m.query("[data-activity-row]"), null);
    m.unmount();
  });
});
