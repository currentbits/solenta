/**
 * UsageView: totals, range/metric toggles, empty state.
 * Run: npm run test:renderer -- test/usageView.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { mount } from "./support/dom.ts";
import { UsageView, type UsageReportControls } from "../src/components/UsageView";
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

  it("opens the thread by stable id from the Thread breakdown title", async () => {
    const picked: string[] = [];
    const report = richReport();
    const m = await mount(
      <UsageView
        loadUsage={async () => report}
        onSelectThread={(id) => {
          picked.push(id);
        }}
        existingThreadIds={["th-a", "th-b", "th-k"]}
      />,
    );
    await m.flush();
    await m.click(m.query('[data-usage-group-btn="thread"]'));

    const openA = m.query('[aria-label="Open thread: Fix the cache"]');
    assert.ok(openA, "title is an accessible control");
    await m.click(openA);
    assert.deepEqual(picked, ["th-a"], "opens by thread id, not title");

    const row = m.query('[data-usage-row="th-a"]');
    assert.ok(row, "thread row");
    assert.equal(row.querySelectorAll("button").length, 1, "only the title is a control");
    assert.equal(
      row.querySelector("button")?.closest("td"),
      row.querySelector("td"),
      "the control lives in the title cell, not the whole row",
    );
    m.unmount();
  });

  it("opens the matching id when two threads share a title", async () => {
    const today = daysAgo(0);
    const report: UsageReport = {
      byDay: {
        [today]: {
          claude: {
            sonnet: entry({
              costUsd: 3,
              inputTokens: 200,
              outputTokens: 40,
              turns: 2,
            }),
          },
        },
      },
      threadsByDay: {
        [today]: {
          "th-left": thread({ title: "Same title", costUsd: 2, turns: 1 }),
          "th-right": thread({
            title: "Same title",
            projectId: "proj-2",
            projectName: "ledger",
            costUsd: 1,
            turns: 1,
          }),
        },
      },
    };
    const picked: string[] = [];
    const m = await mount(
      <UsageView
        loadUsage={async () => report}
        onSelectThread={(id) => {
          picked.push(id);
        }}
        existingThreadIds={["th-left", "th-right"]}
      />,
    );
    await m.flush();
    await m.click(m.query('[data-usage-group-btn="thread"]'));
    const buttons = m.queryAll('[aria-label="Open thread: Same title"]');
    assert.equal(buttons.length, 2, "one control per row");
    await m.click(buttons[0]);
    await m.click(buttons[1]);
    assert.deepEqual(picked, ["th-left", "th-right"]);
    m.unmount();
  });

  it("keeps a deleted thread visible and does not navigate", async () => {
    const picked: string[] = [];
    const m = await mount(
      <UsageView
        loadUsage={async () => richReport()}
        onSelectThread={(id) => {
          picked.push(id);
        }}
        existingThreadIds={["th-a"]}
      />,
    );
    await m.flush();
    await m.click(m.query('[data-usage-group-btn="thread"]'));

    assert.ok(m.query('[aria-label="Open thread: Fix the cache"]'), "live thread stays openable");
    assert.equal(
      m.query('[aria-label="Open thread: Tighten CSP"]'),
      null,
      "deleted title is not an action",
    );
    const missing = m.query('[data-usage-row="th-b"]');
    assert.ok(missing, "deleted thread remains for accounting");
    assert.ok(
      (missing.textContent ?? "").includes("unavailable"),
      "explains why it cannot be opened",
    );
    assert.equal(missing.querySelector("button"), null, "no broken action");
    await m.click(missing);
    assert.deepEqual(picked, []);
    m.unmount();
  });

  it("exposes the thread title as a focusable button", async () => {
    const m = await mount(
      <UsageView
        loadUsage={async () => richReport()}
        onSelectThread={() => {}}
        existingThreadIds={["th-a", "th-b", "th-k"]}
      />,
    );
    await m.flush();
    await m.click(m.query('[data-usage-group-btn="thread"]'));
    const openA = m.query('[aria-label="Open thread: Fix the cache"]');
    assert.ok(openA, "title control");
    assert.equal(openA.tagName, "BUTTON", "native button is keyboard-activable");
    (openA as HTMLElement).focus();
    await m.pressFocused("Enter");
    assert.equal(openA.ownerDocument.activeElement, openA, "title keeps focus");
    m.unmount();
  });

  it("restores range, metric and Thread breakdown after a remount", async () => {
    let controls: UsageReportControls = {
      range: 7,
      metric: "cost",
      group: "model",
    };
    const render = () =>
      mount(
        <UsageView
          loadUsage={async () => richReport()}
          reportControls={controls}
          onReportControlsChange={(next) => {
            controls = next;
          }}
        />,
      );

    const first = await render();
    await first.flush();
    await first.click(first.query('[data-usage-range="30"]'));
    await first.click(first.query('[data-usage-metric="tokens"]'));
    await first.click(first.query('[data-usage-group-btn="thread"]'));
    assert.equal(first.query("[data-usage]")?.getAttribute("data-range"), "30");
    assert.equal(first.query("[data-usage]")?.getAttribute("data-metric"), "tokens");
    assert.equal(first.query("[data-usage]")?.getAttribute("data-usage-group"), "thread");
    first.unmount();

    const again = await render();
    await again.flush();
    assert.equal(again.query("[data-usage]")?.getAttribute("data-range"), "30");
    assert.equal(again.query("[data-usage]")?.getAttribute("data-metric"), "tokens");
    assert.equal(again.query("[data-usage]")?.getAttribute("data-usage-group"), "thread");
    assert.ok(again.text().includes("Fix the cache"), "thread rows still listed");
    again.unmount();
  });

  it("shows an initial load error with retry, not a successful empty report (#1133)", async () => {
    let calls = 0;
    const m = await mount(
      <UsageView
        loadUsage={async () => {
          calls += 1;
          throw new Error("store locked");
        }}
      />,
    );
    await m.flush();
    assert.equal(calls, 1);
    assert.ok(m.query("[data-usage-error]"), "error marker");
    assert.ok(m.query('[role="alert"]'), "error uses role=alert");
    assert.ok(m.text().includes("store locked"));
    assert.ok(m.byText("Retry"), "initial failure offers retry");
    assert.equal(m.query("[data-usage-empty]"), null, "must not look like a loaded empty report");
    assert.equal(m.query("[data-usage-totals]"), null, "must not invent a $0 report");
    assert.ok(!m.text().includes("No usage in this range"));
    const refresh = m.byText("Refresh");
    assert.ok(refresh, "refresh control");
    assert.equal((refresh as HTMLButtonElement).disabled, false, "loading control recovers");
    m.unmount();
  });

  it("keeps the last report after a failed refresh and recovers on retry (#1133)", async () => {
    let calls = 0;
    const first: UsageReport = { byDay: sampleData(), threadsByDay: {} };
    const laterDay = daysAgo(0);
    const second: UsageReport = {
      byDay: {
        [laterDay]: {
          claude: {
            sonnet: entry({
              costUsd: 9,
              inputTokens: 400,
              outputTokens: 80,
              turns: 2,
            }),
          },
        },
      },
      threadsByDay: {},
    };
    const m = await mount(
      <UsageView
        loadUsage={async () => {
          calls += 1;
          if (calls === 1) return first;
          if (calls === 2) throw new Error("store locked");
          return second;
        }}
      />,
    );
    await m.flush();
    assert.ok(m.text().includes("$2.50"), "first load");
    assert.equal(m.query("[data-usage-error]"), null);
    assert.equal(m.query("[data-usage-stale]"), null);

    await m.click(m.byText("Refresh"));
    assert.ok(m.text().includes("$2.50"), "failed refresh must keep last spend");
    assert.ok(!m.text().includes("No usage in this range"), "must not erase into empty");
    assert.ok(m.query("[data-usage-error]"), "refresh failure is visible");
    assert.ok(m.query('[role="alert"]')?.textContent?.includes("store locked"));
    assert.ok(m.query("[data-usage-stale]"), "stale/last-success marker");
    assert.match(m.text(), /stale/i);
    assert.equal(m.query("[data-usage]")?.getAttribute("data-range"), "7");
    assert.equal(m.query("[data-usage]")?.getAttribute("data-metric"), "cost");
    const refresh = m.byText("Refresh") as HTMLButtonElement;
    assert.equal(refresh.disabled, false, "refresh re-enables after failure");

    await m.click(m.query('[data-usage-range="30"]'));
    assert.equal(m.query("[data-usage]")?.getAttribute("data-range"), "30");
    assert.ok(m.text().includes("$12.50"), "range change still filters last success");
    assert.ok(m.query("[data-usage-stale]"), "other range must not look freshly current");
    assert.ok(m.query("[data-usage-error]"), "error stays while last success is shown");

    await m.click(m.query('[data-usage-range="7"]'));
    await m.click(refresh);
    assert.ok(m.text().includes("$9.00"), "successful retry updates the report");
    assert.ok(!m.text().includes("$2.50"), "previous spend is replaced");
    assert.equal(m.query("[data-usage-error]"), null, "success clears the error");
    assert.equal(m.query("[data-usage-stale]"), null, "success clears stale");
    assert.equal(m.query("[data-usage]")?.getAttribute("data-range"), "7");
    assert.equal(m.query("[data-usage]")?.getAttribute("data-metric"), "cost");
    m.unmount();
  });
});
