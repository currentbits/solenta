/**
 * UsageView: totals, range/metric toggles, empty state.
 * Run: npm run test:renderer -- test/usageView.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { UsageView } from "../src/components/UsageView";
import type { UsageByDay, UsageEntry } from "../src/shared/ipc";

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
    outputTokens: 0,
    turns: 0,
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
});
