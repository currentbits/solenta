/**
 * FleetView / FleetReport: provider table, null-is-not-zero, review tax,
 * outcome badges, notes, loading/empty. Drive FleetReport with hand-built
 * summaries so this suite does not wait on worker B's rollup.
 *
 * Run: npm run test:renderer -- test/fleetView.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import {
  FleetReport,
  FleetView,
  reviewTaxCopy,
} from "../src/components/FleetView";
import { emptyProviderRow, type FleetSummary, type FleetThreadRow } from "../src/fleet";
import type { FleetEvidence } from "../src/shared/ipc";

const HOUR = 3_600_000;

function threadRow(
  over: Partial<FleetThreadRow> & Pick<FleetThreadRow, "threadId">,
): FleetThreadRow {
  return {
    title: over.title ?? over.threadId,
    provider: "claude",
    costUsd: 1.25,
    activeMs: 12 * 60 * 1000,
    wallClockMs: 64 * 60 * 1000,
    linesAdded: 40,
    durableShare: 0.8,
    outcome: "merged",
    prNumber: 12,
    prUrl: "https://github.com/acme/nebula/pull/12",
    ...over,
  };
}

function summary(over: Partial<FleetSummary> = {}): FleetSummary {
  return {
    providers: [],
    totals: emptyProviderRow("all"),
    threads: [],
    humanReviewLatencyMs: null,
    reviewTax: null,
    durabilityWindowDays: 14,
    notes: [],
    ...over,
  };
}

const emptyEvidence: FleetEvidence = {
  collectedAt: 0,
  durabilityWindowDays: 14,
  threads: [],
  prs: [],
  notes: [],
};

describe("FleetReport", () => {
  it("renders provider rows with cost, merge rate, and active vs wall", async () => {
    const m = await mount(
      <FleetReport
        summary={summary({
          providers: [
            {
              ...emptyProviderRow("claude"),
              threads: 3,
              costUsd: 12.5,
              mergeRate: 0.8,
              closeWithoutMergeRate: 0.2,
              costPerMergedPrUsd: 6.25,
              durableShare: 0.7,
              reworkShare: 0.3,
              reviewLatencyMs: 4 * HOUR,
              activeMs: 2 * HOUR,
              wallClockMs: 5 * HOUR,
            },
            {
              ...emptyProviderRow("codex"),
              threads: 1,
              costUsd: 2,
              mergeRate: 1,
              closeWithoutMergeRate: 0,
              costPerMergedPrUsd: 2,
              durableShare: 0.5,
              reworkShare: 0.5,
              reviewLatencyMs: HOUR,
              activeMs: 20 * 60 * 1000,
              wallClockMs: HOUR,
            },
          ],
        })}
      />,
    );
    const text = m.text();
    assert.ok(m.query('[data-fleet-provider="claude"]'), "claude row");
    assert.ok(m.query('[data-fleet-provider="codex"]'), "codex row");
    assert.ok(text.includes("claude"));
    assert.ok(text.includes("codex"));
    assert.ok(text.includes("$12.50"), "claude cost");
    assert.ok(text.includes("80%"), "merge rate");
    assert.ok(text.includes("20%"), "close without merge");
    assert.ok(text.includes("$6.25"), "cost per merged PR");
    assert.ok(text.includes("70%"), "durable");
    assert.ok(text.includes("30%"), "rework");
    assert.ok(text.includes("2h / 5h"), "active vs wall");
    m.unmount();
  });

  it("renders null cost per merged PR as an em dash, not $0.00", async () => {
    const m = await mount(
      <FleetReport
        summary={summary({
          providers: [
            {
              ...emptyProviderRow("grok"),
              threads: 2,
              costUsd: 0.4,
              costPerMergedPrUsd: null,
            },
          ],
        })}
      />,
    );
    const cell = m.query('[data-fleet-provider="grok"] [data-cost-per-merged]');
    assert.equal(cell?.textContent, "—");
    assert.ok(!(cell?.textContent ?? "").includes("$0.00"));
    assert.ok(m.text().includes("$0.4000"), "row cost still renders");
    m.unmount();
  });

  it("renders null durable/rework share as not enough history, not 0%", async () => {
    const m = await mount(
      <FleetReport
        summary={summary({
          providers: [
            {
              ...emptyProviderRow("kimi"),
              threads: 1,
              durableShare: null,
              reworkShare: null,
            },
          ],
        })}
      />,
    );
    const row = m.query('[data-fleet-provider="kimi"]');
    assert.ok(row, "kimi row");
    assert.equal(row?.querySelector("[data-durable]")?.textContent, "not enough history");
    assert.equal(row?.querySelector("[data-rework]")?.textContent, "not enough history");
    assert.ok(!(row?.querySelector("[data-durable]")?.textContent ?? "").includes("0%"));
    m.unmount();
  });

  it("renders a measured 0% durable share as 0%, not the missing-history label", async () => {
    const m = await mount(
      <FleetReport
        summary={summary({
          providers: [
            {
              ...emptyProviderRow("claude"),
              durableShare: 0,
              reworkShare: 1,
            },
          ],
        })}
      />,
    );
    const row = m.query('[data-fleet-provider="claude"]');
    assert.equal(row?.querySelector("[data-durable]")?.textContent, "0%");
    assert.equal(row?.querySelector("[data-rework]")?.textContent, "100%");
    m.unmount();
  });

  it("renders null review tax as a plain no-comparison line", async () => {
    const m = await mount(<FleetReport summary={summary({ reviewTax: null })} />);
    const tax = m.query("[data-fleet-review-tax]");
    assert.ok(tax, "review tax block");
    assert.ok((tax?.textContent ?? "").includes("no reviewed PRs to compare"));
    assert.ok(!(tax?.textContent ?? "").includes("0×"));
    assert.ok(!(tax?.textContent ?? "").includes("0.0×"));
    m.unmount();
  });

  it("says which way review tax points", async () => {
    assert.equal(
      reviewTaxCopy(1.8),
      "agent PRs wait 1.8× longer than human PRs",
    );
    assert.equal(
      reviewTaxCopy(0.5),
      "agent PRs are reviewed 2.0× faster than human PRs",
    );
    const slower = await mount(
      <FleetReport
        summary={summary({
          reviewTax: 1.8,
          humanReviewLatencyMs: 2 * HOUR,
          totals: {
            ...emptyProviderRow("all"),
            reviewLatencyMs: 3.6 * HOUR,
          },
        })}
      />,
    );
    assert.ok(slower.text().includes("agent PRs wait 1.8× longer than human PRs"));
    assert.ok(slower.text().includes("3h 36m"));
    assert.ok(slower.text().includes("2h"));
    slower.unmount();

    const faster = await mount(
      <FleetReport summary={summary({ reviewTax: 0.5 })} />,
    );
    assert.ok(
      faster.text().includes("agent PRs are reviewed 2.0× faster than human PRs"),
    );
    faster.unmount();
  });

  it("renders outcome badges and links the PR when there is a url", async () => {
    const m = await mount(
      <FleetReport
        summary={summary({
          threads: [
            threadRow({ threadId: "t-merged", title: "Ship ledger", outcome: "merged" }),
            threadRow({
              threadId: "t-closed",
              title: "Dropped retry",
              outcome: "closed",
              prUrl: "https://github.com/acme/nebula/pull/13",
            }),
            threadRow({
              threadId: "t-open",
              title: "WIP auth",
              outcome: "open",
              prUrl: "https://github.com/acme/nebula/pull/14",
            }),
            threadRow({
              threadId: "t-none",
              title: "Local spike",
              outcome: "none",
              prNumber: null,
              prUrl: null,
            }),
          ],
        })}
      />,
    );
    assert.ok(m.query('[data-fleet-outcome="merged"]'), "merged badge");
    assert.ok(m.query('[data-fleet-outcome="closed"]'), "closed badge");
    assert.ok(m.query('[data-fleet-outcome="open"]'), "open badge");
    assert.ok(m.query('[data-fleet-outcome="none"]'), "none badge");
    const mergedLink = m.query('[data-fleet-thread="t-merged"] a');
    assert.equal(
      mergedLink?.getAttribute("href"),
      "https://github.com/acme/nebula/pull/12",
    );
    assert.equal(m.query('[data-fleet-thread="t-none"] a'), null);
    m.unmount();
  });

  it("shows notes as a visible caveat strip", async () => {
    const m = await mount(
      <FleetReport
        summary={summary({
          notes: ["acme: gh missing", "acme: blame budget reached"],
          providers: [emptyProviderRow("claude")],
        })}
      />,
    );
    const notes = m.query("[data-fleet-notes]");
    assert.ok(notes, "notes strip");
    assert.ok((notes?.textContent ?? "").includes("acme: gh missing"));
    assert.ok((notes?.textContent ?? "").includes("blame budget reached"));
    assert.ok((notes?.textContent ?? "").includes("Partial collection"));
    m.unmount();
  });
});

describe("FleetView", () => {
  it("shows a loading state until evidence arrives", async () => {
    let finish!: (value: FleetEvidence) => void;
    const pending = new Promise<FleetEvidence>((resolve) => {
      finish = resolve;
    });
    const m = await mount(<FleetView loadEvidence={() => pending} />);
    await m.flush();
    assert.ok(m.query("[data-fleet]"), "root");
    assert.ok(m.query("[data-fleet-loading]"), "loading marker");
    assert.ok(m.text().includes("Loading fleet"));
    finish(emptyEvidence);
    await m.flush();
    assert.equal(m.query("[data-fleet-loading]"), null);
    assert.ok(m.query("[data-fleet-empty]"), "empty after load");
    m.unmount();
  });

  it("renders the empty state when the rollup has no rows", async () => {
    const m = await mount(
      <FleetView loadEvidence={async () => emptyEvidence} />,
    );
    await m.flush();
    assert.ok(m.text().includes("No fleet data in this range"));
    assert.ok(m.query("[data-fleet-empty]"), "empty marker");
    assert.equal(m.query("[data-fleet-report]"), null);
    assert.equal(m.query("[data-fleet]")?.getAttribute("data-range"), "7");
    m.unmount();
  });

  it("keeps collection notes visible on the empty state", async () => {
    const m = await mount(
      <FleetView
        loadEvidence={async () => ({
          ...emptyEvidence,
          notes: ["acme: gh missing"],
        })}
      />,
    );
    await m.flush();
    assert.ok(m.query("[data-fleet-empty]"), "empty marker");
    assert.ok(m.query("[data-fleet-notes]"), "notes still shown");
    assert.ok(m.text().includes("acme: gh missing"));
    m.unmount();
  });

  it("renders an error when the load rejects", async () => {
    const m = await mount(
      <FleetView
        loadEvidence={async () => {
          throw new Error("store locked");
        }}
      />,
    );
    await m.flush();
    assert.ok(m.query("[data-fleet-error]"), "error marker");
    assert.ok(m.text().includes("store locked"));
    assert.ok(m.query('[role="alert"]'), "error uses role=alert");
    assert.equal(m.query("[data-fleet-report]"), null);
    m.unmount();
  });
});
