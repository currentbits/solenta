/**
 * UsageView: totals, range/metric toggles, empty state.
 * Run: npm run test:renderer -- test/usageView.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { UsageView } from "../src/components/UsageView";
import type { UsageByDay, UsageEntry, UsageReport, UsageThreadEntry } from "../src/shared/ipc";

function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysAgo(n: number, from = new Date()): string {
  return localDayKey(new Date(from.getFullYear(), from.getMonth(), from.getDate() - n));
}

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    costUsd: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    turns: 0,
    wastedUsd: 0,
    ...over,
  };
}

function thread(over: Partial<UsageThreadEntry> = {}): UsageThreadEntry {
  return {
    ...entry(),
    projectId: "proj-1",
    projectName: "nebula",
    title: "A thread",
    provider: "claude",
    model: "sonnet",
    ...over,
  };
}

function sampleData(): UsageByDay {
  return {
    [daysAgo(0)]: {
      claude: {
        sonnet: entry({
          costUsd: 2.5,
          inputTokens: 1200,
          outputTokens: 300,
          turns: 4,
        }),
      },
    },
    [daysAgo(20)]: {
      grok: {
        "grok-4": entry({
          costUsd: 10,
          inputTokens: 8000,
          outputTokens: 2000,
          turns: 8,
        }),
      },
    },
  };
}

function richReport(): UsageReport {
  const today = daysAgo(0);
  return {
    byDay: {
      [today]: {
        claude: {
          sonnet: entry({
            costUsd: 2.5,
            inputTokens: 200,
            cachedInputTokens: 1000,
            cacheWriteTokens: 100,
            outputTokens: 300,
            turns: 4,
            wastedUsd: 1.5,
          }),
        },
        kimi: {
          "kimi-k2": entry({ turns: 41 }),
        },
      },
    },
    threadsByDay: {
      [today]: {
        "th-a": thread({
          costUsd: 2.0,
          inputTokens: 150,
          cachedInputTokens: 800,
          cacheWriteTokens: 80,
          outputTokens: 200,
          turns: 3,
          wastedUsd: 1.5,
          projectId: "proj-1",
          projectName: "nebula",
          title: "Fix the cache",
          provider: "claude",
          model: "sonnet",
        }),
        "th-b": thread({
          costUsd: 0.5,
          inputTokens: 50,
          cachedInputTokens: 200,
          cacheWriteTokens: 20,
          outputTokens: 100,
          turns: 1,
          projectId: "proj-2",
          projectName: "ledger",
          title: "Tighten CSP",
          provider: "claude",
          model: "sonnet",
        }),
        "th-k": thread({
          turns: 41,
          projectId: "proj-2",
          projectName: "ledger",
          title: "Kimi research",
          provider: "kimi",
          model: "kimi-k2",
        }),
      },
    },
  };
}

describe("UsageView", () => {
  it("renders range totals after load", async () => {
    const m = await mount(<UsageView loadUsage={async () => ({ byDay: sampleData(), threadsByDay: {} })} />);
    await m.flush();
    const text = m.text();
    assert.ok(m.query("[data-usage]"), "root");
    assert.ok(m.query("[data-usage-totals]"), "totals");
    assert.ok(text.includes("$2.50"), "today cost");
    assert.ok(text.includes("Σ 1.5k"), "today tokens");
    assert.ok(text.includes("4 turns"), "today turns");
    assert.ok(text.includes("claude"), "provider");
    assert.ok(text.includes("sonnet"), "model");
    assert.ok(!text.includes("grok"), "20-day-old provider stays outside 7d");
    assert.ok(!text.includes("$10.00"), "20-day-old cost stays outside 7d");
    m.unmount();
  });

  it("switching range and metric changes what is rendered", async () => {
    const m = await mount(<UsageView loadUsage={async () => ({ byDay: sampleData(), threadsByDay: {} })} />);
    await m.flush();

    assert.equal(m.query("[data-usage]")?.getAttribute("data-range"), "7");
    assert.equal(m.query("[data-usage]")?.getAttribute("data-metric"), "cost");
    assert.ok(m.query("[data-usage-totals]")?.textContent?.includes("$2.50"));
    assert.ok(!m.text().includes("grok"));

    await m.click(m.query('[data-usage-range="30"]'));
    assert.equal(m.query("[data-usage]")?.getAttribute("data-range"), "30");
    const at30 = m.text();
    assert.ok(at30.includes("grok"), "30d includes older provider");
    assert.ok(at30.includes("grok-4"), "30d includes older model");
    assert.ok(at30.includes("$12.50"), "30d sums both days");

    await m.click(m.query('[data-usage-metric="tokens"]'));
    assert.equal(m.query("[data-usage]")?.getAttribute("data-metric"), "tokens");
    const totals = m.query("[data-usage-totals]")?.textContent ?? "";
    assert.match(totals, /Σ 11\.5k/);
    const grokRow = m.query('[data-usage-provider="grok"]');
    assert.ok(grokRow, "grok provider row");
    assert.ok((grokRow?.textContent ?? "").includes("Σ 10.0k"));
    m.unmount();
  });

  it("renders the empty state when there is no data", async () => {
    const m = await mount(<UsageView loadUsage={async () => ({ byDay: {}, threadsByDay: {} })} />);
    await m.flush();
    assert.ok(m.text().includes("No usage in this range"));
    assert.ok(m.query("[data-usage-empty]"), "empty marker");
    assert.equal(m.query("[data-usage-totals]"), null);
    assert.equal(m.query("[data-usage-bar]"), null);
    m.unmount();
  });

  it("renders a token-only cursor row as unmetered cost, never $0.00 (#703)", async () => {
    const today = daysAgo(0);
    const report: UsageReport = {
      byDay: {
        [today]: {
          cursor: {
            auto: entry({
              inputTokens: 11114,
              cachedInputTokens: 6496,
              outputTokens: 43,
              turns: 2,
            }),
          },
        },
      },
      threadsByDay: {
        [today]: {
          "th-c": thread({
            title: "Cursor ping",
            provider: "cursor",
            model: "auto",
            inputTokens: 11114,
            cachedInputTokens: 6496,
            outputTokens: 43,
            turns: 2,
          }),
        },
      },
    };
    const m = await mount(<UsageView loadUsage={async () => report} />);
    await m.flush();
    const row = m.query('[data-usage-provider="cursor"]');
    assert.ok(row, "cursor provider row");
    const text = row.textContent ?? "";
    assert.ok(text.includes("unmetered"), "explicit unmetered copy");
    assert.ok(!text.includes("$0.00"), "must not look free");
    assert.ok(row.getAttribute("data-usage-cost-unmetered") !== null);
    m.unmount();
  });

  it("renders an unreported provider as usage not reported, never $0.00", async () => {
    const m = await mount(<UsageView loadUsage={async () => richReport()} />);
    await m.flush();
    const kimi = m.query('[data-usage-provider="kimi"]');
    assert.ok(kimi, "kimi provider row");
    assert.ok(kimi.getAttribute("data-usage-unreported") !== null, "unreported marker");
    const text = kimi.textContent ?? "";
    assert.ok(text.includes("usage not reported"), "unreported copy");
    assert.ok(text.includes("41 turns"), "turn count");
    assert.ok(!text.includes("$0.00"), "must not look free");
    assert.equal(kimi.querySelector("[class*='shareTrack']"), null, "no share bar");
    m.unmount();
  });

  it("shows the headline caveat that the dollar figure is a counterfactual", async () => {
    const m = await mount(<UsageView loadUsage={async () => richReport()} />);
    await m.flush();
    const caveat = m.query("[data-usage-caveat]");
    assert.ok(caveat, "caveat marker");
    assert.ok((caveat.textContent ?? "").includes("if billed at full API rate"));
    m.unmount();
  });

  it("shows wasted spend on failed/stopped runs", async () => {
    const m = await mount(<UsageView loadUsage={async () => richReport()} />);
    await m.flush();
    const text = m.text();
    assert.ok(text.includes("Wasted"), "wasted column");
    assert.ok(text.includes("failed/stopped") || m.query("[data-usage-wasted]"), "wasted surface");
    assert.ok(text.includes("$1.50"), "wasted amount");
    const wasted = m.query("[data-usage-wasted]");
    assert.ok(wasted, "wasted cell");
    assert.ok((wasted.textContent ?? "").includes("$1.50"));
    m.unmount();
  });

  it("switches the breakdown between model, day, project and thread", async () => {
    const m = await mount(<UsageView loadUsage={async () => richReport()} />);
    await m.flush();

    assert.equal(m.query("[data-usage]")?.getAttribute("data-usage-group"), "model");
    assert.ok(m.query('[data-usage-model="claude/sonnet"]'), "model row");
    assert.ok(m.text().includes("sonnet"));

    await m.click(m.query('[data-usage-group-btn="day"]'));
    assert.equal(m.query("[data-usage]")?.getAttribute("data-usage-group"), "day");
    assert.ok(m.query(`[data-usage-row="${daysAgo(0)}"]`), "day row");

    await m.click(m.query('[data-usage-group-btn="project"]'));
    assert.equal(m.query("[data-usage]")?.getAttribute("data-usage-group"), "project");
    const projectText = m.text();
    assert.ok(projectText.includes("nebula"), "project nebula");
    assert.ok(projectText.includes("ledger"), "project ledger");

    await m.click(m.query('[data-usage-group-btn="thread"]'));
    assert.equal(m.query("[data-usage]")?.getAttribute("data-usage-group"), "thread");
    const threadText = m.text();
    assert.ok(threadText.includes("Fix the cache"), "thread title");
    assert.ok(threadText.includes("Tighten CSP"), "second thread");
    assert.ok(threadText.includes("Kimi research"), "unreported thread");
    m.unmount();
  });

  // Every store predating #556 has usageByDay but no threadsByDay, so these
  // two tabs are empty on real history and must not read as broken.
  it("explains an empty project/thread breakdown instead of showing a bare table", async () => {
    const report = richReport();
    const legacy: UsageReport = { byDay: report.byDay, threadsByDay: {} };
    const m = await mount(<UsageView loadUsage={async () => legacy} />);
    await m.flush();

    await m.click(m.query('[data-usage-group-btn="project"]'));
    assert.ok(m.query('[data-usage-breakdown-empty="project"]'), "project empty row");
    assert.ok(
      m.text().includes("Attribution starts from the first run after this update"),
      "explains why it is empty",
    );

    await m.click(m.query('[data-usage-group-btn="thread"]'));
    assert.ok(m.query('[data-usage-breakdown-empty="thread"]'), "thread empty row");

    // The model tab still has data, so it must not show the empty row.
    await m.click(m.query('[data-usage-group-btn="model"]'));
    assert.equal(m.query('[data-usage-breakdown-empty="model"]'), null);
    m.unmount();
  });

  it("can show provider quotas above local cost history without replacing it", async () => {
    const m = await mount(
      <UsageView
        loadUsage={async () => ({ byDay: sampleData(), threadsByDay: {} })}
        loadProviderLimits={async () => [
          {
            provider: "claude",
            status: "ok",
            windows: [
              {
                label: "5 hours",
                usedPercent: 22,
                resetsAt: Date.now() + 60 * 60 * 1000,
                windowSeconds: 5 * 60 * 60,
              },
            ],
            fetchedAt: Date.now(),
          },
        ]}
      />,
    );
    await m.flush();
    assert.match(m.text(), /22% used/);
    assert.ok(m.query("[data-usage-totals]"), "local history still present");
    assert.ok(m.text().includes("$2.50"), "local cost still present");
    m.unmount();
  });
});
