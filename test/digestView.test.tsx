/**
 * DigestView: groups, ranking, receipt, click-through.
 * Run: npm run test:renderer -- test/digestView.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { DigestView } from "../src/components/DigestView";
import type { DigestResult, DigestRun, ProjectInfo } from "../src/shared/ipc";

const NOW = 1_700_000_000_000;

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

function run(over: Partial<DigestRun> & Pick<DigestRun, "threadId">): DigestRun {
  return {
    projectId: "p1",
    projectSlug: "coder",
    title: over.threadId,
    provider: "claude",
    status: "done",
    awaitingInput: false,
    lastError: null,
    endedAt: NOW,
    costUsd: 0,
    turns: 1,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    commits: 0,
    prNumber: null,
    prState: null,
    checks: { ran: false, failed: false, label: null },
    ...over,
  };
}

function result(runs: DigestRun[], sinceMs = NOW - 8 * 60 * 60 * 1000): DigestResult {
  return { sinceMs, generatedAt: NOW, runs };
}

describe("DigestView", () => {
  it("lands rows in the ranked groups and keeps merge-ready / needs-you / discard order", async () => {
    const loadDigest = async (): Promise<DigestResult> =>
      result([
        run({
          threadId: "ready",
          title: "Ship ledger",
          filesChanged: 3,
          additions: 40,
          deletions: 5,
          commits: 1,
          costUsd: 2.14,
          turns: 4,
          checks: { ran: true, failed: false, label: "npm test" },
        }),
        run({
          threadId: "stuck",
          projectId: "p2",
          projectSlug: "billing-fallback",
          title: "Migrate store",
          status: "failed",
          lastError: "Run error: boom",
          filesChanged: 2,
          additions: 10,
          deletions: 1,
          costUsd: 1.02,
          checks: { ran: true, failed: true, label: "npm test" },
        }),
        run({
          threadId: "waste",
          title: "Investigate flake",
          costUsd: 1.8,
          turns: 6,
        }),
      ]);
    const m = await mount(
      <DigestView
        projects={[p1, p2]}
        loadDigest={loadDigest}
        markSeen={async () => ({ seenAt: NOW })}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();

    const groups = m.queryAll("[data-digest-group]");
    assert.deepEqual(
      groups.map((el) => el.getAttribute("data-digest-group")),
      ["merge-ready", "needs-you", "discard"],
    );

    const ready = m.query('[data-digest-row="ready"]');
    const stuck = m.query('[data-digest-row="stuck"]');
    const waste = m.query('[data-digest-row="waste"]');
    assert.ok(ready, "merge-ready row");
    assert.ok(stuck, "needs-you row");
    assert.ok(waste, "discard row");
    assert.equal(ready!.closest("[data-digest-group]")?.getAttribute("data-digest-group"), "merge-ready");
    assert.equal(stuck!.closest("[data-digest-group]")?.getAttribute("data-digest-group"), "needs-you");
    assert.equal(waste!.closest("[data-digest-group]")?.getAttribute("data-digest-group"), "discard");

    const text = m.text();
    assert.ok(text.includes("acme/ledger"));
    assert.ok(text.includes("acme/billing"));
    assert.ok(text.includes("Ship ledger"));
    assert.ok(text.includes("Migrate store"));
    assert.ok(text.includes("Investigate flake"));
    assert.ok(text.includes("3 runs · $4.96 · $1.80 wasted"), text);
    assert.ok(text.includes("passed"));
    assert.ok(text.includes("failed"));
    assert.ok(text.includes("no test evidence"));
    m.unmount();
  });

  it("shows the wasted total in the headline when a discard row cost money", async () => {
    const loadDigest = async (): Promise<DigestResult> =>
      result([run({ threadId: "nothing", costUsd: 2 })]);
    const m = await mount(
      <DigestView
        projects={[p1]}
        loadDigest={loadDigest}
        markSeen={async () => ({ seenAt: NOW })}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.text().includes("1 run · $2.00 · $2.00 wasted"));
    assert.equal(
      m.query("[data-digest-headline]")?.getAttribute("data-wasted"),
      "true",
    );
    const ready = m.query('[data-digest-group="merge-ready"]');
    const needsYou = m.query('[data-digest-group="needs-you"]');
    assert.ok(ready?.textContent?.includes("nothing here"));
    assert.ok(needsYou?.textContent?.includes("nothing here"));
    m.unmount();
  });

  it("Mark reviewed calls markSeen and reloads", async () => {
    let seen = 0;
    let loads = 0;
    const loadDigest = async (): Promise<DigestResult> => {
      loads += 1;
      return result(
        loads === 1
          ? [run({ threadId: "waste", costUsd: 1.8 })]
          : [],
      );
    };
    const markSeen = async () => {
      seen += 1;
      return { seenAt: NOW };
    };
    const m = await mount(
      <DigestView
        projects={[p1]}
        loadDigest={loadDigest}
        markSeen={markSeen}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.equal(loads, 1);
    assert.ok(m.query('[data-digest-row="waste"]'));

    const btn = m.query("[data-digest-mark-seen]");
    assert.ok(btn, "mark reviewed");
    await m.click(btn);
    await m.flush();

    assert.equal(seen, 1);
    assert.equal(loads, 2);
    assert.ok(m.text().includes("Nothing ran while you were away."));
    assert.equal(m.query("[data-digest-row]"), null);
    m.unmount();
  });

  it("selects the thread when a row is clicked", async () => {
    let selected: string | null = null;
    const loadDigest = async (): Promise<DigestResult> =>
      result([
        run({
          threadId: "t-hit",
          title: "click me",
          commits: 1,
          checks: { ran: true, failed: false, label: "npm test" },
        }),
      ]);
    const m = await mount(
      <DigestView
        projects={[p1]}
        loadDigest={loadDigest}
        markSeen={async () => ({ seenAt: NOW })}
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

  it("opens a live thread by id when the live set is known", async () => {
    let selected: string | null = null;
    const m = await mount(
      <DigestView
        projects={[p1]}
        loadDigest={async () =>
          result([
            run({
              threadId: "t-live",
              title: "Same title",
              costUsd: 1.25,
              commits: 1,
              checks: { ran: true, failed: false, label: "npm test" },
            }),
            run({
              threadId: "t-gone",
              title: "Same title",
              costUsd: 4.5,
            }),
          ])
        }
        markSeen={async () => ({ seenAt: NOW })}
        existingThreadIds={["t-live"]}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const live = m.query('[data-digest-row="t-live"]');
    const gone = m.query('[data-digest-row="t-gone"]');
    assert.ok(live, "live row stays");
    assert.ok(gone, "deleted row stays for historical accounting");
    const select = live!.querySelector(
      'button[aria-label="Select thread: Same title"]',
    );
    assert.ok(select, "live row keeps an accessible select control");
    await m.click(select as HTMLElement);
    assert.equal(selected, "t-live");
    m.unmount();
  });

  it("keeps a missing thread visible and does not navigate", async () => {
    let selected: string | null = null;
    const m = await mount(
      <DigestView
        projects={[p1]}
        loadDigest={async () =>
          result([
            run({
              threadId: "t-gone",
              title: "Deleted run",
              costUsd: 3.2,
              turns: 5,
            }),
          ])
        }
        markSeen={async () => ({ seenAt: NOW })}
        existingThreadIds={["t-other"]}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const row = m.query('[data-digest-row="t-gone"]');
    assert.ok(row, "historical row stays");
    assert.match(row!.textContent ?? "", /unavailable/i);
    assert.equal(
      row!.querySelector('button[aria-label="Select thread: Deleted run"]'),
      null,
      "missing thread has no open action",
    );
    const cost = [...row!.querySelectorAll("span")].find((el) =>
      (el.textContent ?? "").includes("$3.20"),
    );
    assert.ok(cost, "cost stays visible");
    assert.equal(
      cost!.closest("button"),
      null,
      "numeric cells stay outside the hit target",
    );
    await m.click(row);
    assert.equal(selected, null, "deleted row must not navigate");
    m.unmount();
  });

  it("treats omitted live ids as openable so boot does not flash unavailable", async () => {
    let selected: string | null = null;
    const m = await mount(
      <DigestView
        projects={[p1]}
        loadDigest={async () =>
          result([run({ threadId: "t-boot", title: "Still loading" })])
        }
        markSeen={async () => ({ seenAt: NOW })}
        onSelectThread={(id) => {
          selected = id;
        }}
      />,
    );
    await m.flush();
    const row = m.query('[data-digest-row="t-boot"]');
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

  it("renders the empty-window state when nothing ran", async () => {
    const m = await mount(
      <DigestView
        projects={[p1]}
        loadDigest={async () => result([])}
        markSeen={async () => ({ seenAt: NOW })}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.text().includes("Nothing ran while you were away."));
    assert.equal(m.query("[data-digest-row]"), null);
    assert.equal(m.query("[data-digest-group]"), null);
    const mark = m.query("[data-digest-mark-seen]") as HTMLButtonElement | null;
    assert.ok(mark, "mark reviewed");
    assert.equal(mark.disabled, false, "successful empty digest can be acknowledged");
    m.unmount();
  });

  it("shows an initial load error with retry and keeps Mark reviewed disabled (#943)", async () => {
    let calls = 0;
    const m = await mount(
      <DigestView
        projects={[p1]}
        loadDigest={async () => {
          calls += 1;
          throw new Error("store locked");
        }}
        markSeen={async () => ({ seenAt: NOW })}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.equal(calls, 1);
    assert.ok(m.query("[data-digest-error]"), "error marker");
    assert.ok(m.query('[role="alert"]'), "error uses role=alert");
    assert.ok(m.text().includes("store locked"));
    assert.ok(m.byText("Retry"), "initial failure offers retry");
    assert.ok(
      !m.text().includes("Nothing ran while you were away."),
      "must not claim nothing ran",
    );
    assert.equal(m.query("[data-digest-row]"), null);
    const mark = m.query("[data-digest-mark-seen]") as HTMLButtonElement | null;
    assert.ok(mark, "mark reviewed");
    assert.equal(mark.disabled, true, "no successful digest, cannot acknowledge");
    const refresh = m.byText("Refresh") as HTMLButtonElement | null;
    assert.ok(refresh, "refresh control");
    assert.equal(refresh.disabled, false, "loading control recovers");
    m.unmount();
  });

  it("keeps the last digest after a failed refresh and recovers on retry (#943)", async () => {
    let calls = 0;
    const first = result([run({ threadId: "waste", title: "Investigate flake", costUsd: 1.8 })]);
    const second = result([
      run({
        threadId: "ready",
        title: "Ship ledger",
        filesChanged: 1,
        additions: 4,
        deletions: 0,
        commits: 1,
        checks: { ran: true, failed: false, label: "npm test" },
      }),
    ]);
    const m = await mount(
      <DigestView
        projects={[p1]}
        loadDigest={async () => {
          calls += 1;
          if (calls === 1) return first;
          if (calls === 2) throw new Error("store locked");
          return second;
        }}
        markSeen={async () => ({ seenAt: NOW })}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(m.query('[data-digest-row="waste"]'), "first load");
    assert.ok(m.text().includes("Investigate flake"));
    assert.equal(m.query("[data-digest-error]"), null);
    assert.equal(m.query("[data-digest-stale]"), null);

    await m.click(m.byText("Refresh"));
    assert.ok(m.query('[data-digest-row="waste"]'), "failed refresh keeps last rows");
    assert.ok(m.text().includes("Investigate flake"));
    assert.ok(
      !m.text().includes("Nothing ran while you were away."),
      "must not erase into empty",
    );
    assert.ok(m.query("[data-digest-window]"), "failed refresh keeps the digest window");
    assert.ok(m.query("[data-digest-error]"), "refresh failure is visible");
    assert.ok(m.query('[role="alert"]')?.textContent?.includes("store locked"));
    assert.ok(m.query("[data-digest-stale]"), "stale/last-success marker");
    assert.match(m.text(), /stale|out of date/i);
    const refresh = m.byText("Refresh") as HTMLButtonElement;
    assert.equal(refresh.disabled, false, "refresh re-enables after failure");
    assert.ok(m.byText("Retry"), "refresh failure exposes retry");
    const mark = m.query("[data-digest-mark-seen]") as HTMLButtonElement;
    assert.equal(mark.disabled, false, "last successful digest can still be acknowledged");

    await m.click(m.byText("Retry"));
    assert.ok(m.query('[data-digest-row="ready"]'), "successful retry updates rows");
    assert.ok(m.text().includes("Ship ledger"));
    assert.equal(m.query('[data-digest-row="waste"]'), null, "previous rows are replaced");
    assert.equal(m.query("[data-digest-error]"), null, "success clears the error");
    assert.equal(m.query("[data-digest-stale]"), null, "success clears stale");
    m.unmount();
  });

  it("shows the successful-empty copy only after a successful empty response (#943)", async () => {
    let calls = 0;
    const m = await mount(
      <DigestView
        projects={[p1]}
        loadDigest={async () => {
          calls += 1;
          if (calls === 1) throw new Error("store locked");
          return result([]);
        }}
        markSeen={async () => ({ seenAt: NOW })}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.ok(!m.text().includes("Nothing ran while you were away."));
    await m.click(m.byText("Retry"));
    assert.ok(m.text().includes("Nothing ran while you were away."));
    assert.equal(m.query("[data-digest-error]"), null);
    assert.equal(m.query("[data-digest-row]"), null);
    const mark = m.query("[data-digest-mark-seen]") as HTMLButtonElement;
    assert.equal(mark.disabled, false);
    m.unmount();
  });

  it("surfaces markSeen rejection and keeps the digest window (#943)", async () => {
    let loads = 0;
    let marks = 0;
    const m = await mount(
      <DigestView
        projects={[p1]}
        loadDigest={async () => {
          loads += 1;
          return result([run({ threadId: "waste", title: "Investigate flake", costUsd: 1.8 })]);
        }}
        markSeen={async () => {
          marks += 1;
          throw new Error("ack failed");
        }}
        onSelectThread={() => {}}
      />,
    );
    await m.flush();
    assert.equal(loads, 1);
    assert.ok(m.query('[data-digest-row="waste"]'));
    const windowBefore = m.query("[data-digest-window]")?.textContent;

    const btn = m.query("[data-digest-mark-seen]") as HTMLButtonElement;
    await m.click(btn);
    await m.flush();

    assert.equal(marks, 1);
    assert.equal(loads, 1, "failed acknowledgement must not reload");
    assert.ok(m.query('[data-digest-row="waste"]'), "rows stay");
    assert.equal(
      m.query("[data-digest-window]")?.textContent,
      windowBefore,
      "failed acknowledgement must not clear the window",
    );
    assert.ok(!m.text().includes("Nothing ran while you were away."));
    assert.ok(m.query("[data-digest-ack-error]"), "ack failure marker");
    assert.ok(m.query('[role="alert"]')?.textContent?.includes("ack failed"));
    assert.equal(btn.disabled, false, "ack control recovers so the user can retry");
    m.unmount();
  });
});
