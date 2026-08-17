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
    m.unmount();
  });
});
