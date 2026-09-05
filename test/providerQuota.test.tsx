/**
 * Provider quota panel: used percents, unavailable ≠ 0%, loading/error/refresh.
 *
 * Run: npm run test:renderer -- test/providerQuota.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { ProviderQuota } from "../src/components/ProviderQuota";
import type {
  ProviderUsage,
  ProviderUsageWindow,
} from "../src/providerUsage.ts";

const FIVE_HOURS = 5 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;
const NOW = 1_700_000_000_000;

function windowRow(
  over: Partial<ProviderUsageWindow> = {},
): ProviderUsageWindow {
  return {
    label: "5 hours",
    usedPercent: 41,
    resetsAt: NOW + 3 * 60 * 60 * 1000,
    windowSeconds: FIVE_HOURS,
    ...over,
  };
}

function quota(over: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    provider: "claude",
    status: "ok",
    windows: [windowRow()],
    fetchedAt: NOW,
    ...over,
  };
}

const SAMPLE: ProviderUsage[] = [
  quota({
    provider: "kimi",
    windows: [
      windowRow({ usedPercent: 10 }),
      windowRow({
        label: "Weekly",
        usedPercent: 55,
        windowSeconds: WEEK,
        resetsAt: NOW + 2 * 24 * 60 * 60 * 1000,
      }),
    ],
  }),
  quota({
    provider: "claude",
    windows: [
      windowRow({ usedPercent: 72 }),
      windowRow({
        label: "Weekly",
        usedPercent: 18,
        windowSeconds: WEEK,
        resetsAt: NOW + 4 * 24 * 60 * 60 * 1000,
      }),
    ],
  }),
];

describe("ProviderQuota", () => {
  it("renders used percents and window labels, active provider first", async () => {
    const m = await mount(
      <ProviderQuota
        loadLimits={async () => SAMPLE}
        activeProvider="claude"
        now={NOW}
      />,
    );
    await m.flush();
    const rows = m.queryAll("[data-provider-quota-row]");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.getAttribute("data-provider-quota-row"), "claude");
    assert.equal(rows[0]?.getAttribute("data-active"), "true");
    assert.equal(rows[1]?.getAttribute("data-provider-quota-row"), "kimi");
    const text = m.text();
    assert.match(text, /72% used/);
    assert.match(text, /18% used/);
    assert.match(text, /5 hours/);
    assert.match(text, /Weekly/);
    assert.match(text, /resets in/);
    assert.equal(
      /\b0% used\b/.test(text),
      false,
      "successful quotas are not 0%",
    );
    m.unmount();
  });

  it("says unavailable instead of 0% when a provider has no quota snapshot", async () => {
    const m = await mount(
      <ProviderQuota
        loadLimits={async () => [
          quota({
            provider: "codex",
            status: "unavailable",
            windows: [],
            fetchedAt: null,
            message: "This CLI does not report account limits",
          }),
        ]}
        now={NOW}
      />,
    );
    await m.flush();
    const row = m.query('[data-provider-quota-row="codex"]');
    assert.ok(row);
    assert.equal(row.getAttribute("data-status"), "unavailable");
    const text = (row.textContent || "").replace(/\s+/g, " ");
    assert.match(text, /unavailable/i);
    assert.equal(text.includes("0%"), false, "unavailable must not render as 0%");
    m.unmount();
  });

  it("shows an error with retry when the loader rejects", async () => {
    let calls = 0;
    const m = await mount(
      <ProviderQuota
        loadLimits={async () => {
          calls += 1;
          if (calls === 1) throw new Error("rate limited");
          return SAMPLE;
        }}
        now={NOW}
      />,
    );
    await m.flush();
    assert.match(m.text(), /rate limited/);
    assert.equal(m.query("[data-provider-quota-row]"), null);
    const retry = m.query("[data-provider-quota-refresh]");
    assert.ok(retry);
    await m.click(retry as HTMLElement);
    assert.match(m.text(), /72% used/);
    m.unmount();
  });

  it("shows unsupported when there is no loader, never a fabricated 0%", async () => {
    const m = await mount(<ProviderQuota now={NOW} />);
    await m.flush();
    const text = m.text();
    assert.match(text, /unavailable|not available/i);
    assert.equal(text.includes("0%"), false);
    assert.equal(m.query("[data-provider-quota-row]"), null);
    m.unmount();
  });

  it("keeps the previous snapshot while a refresh is in flight", async () => {
    let resolveSecond: ((rows: ProviderUsage[]) => void) | null = null;
    let calls = 0;
    const m = await mount(
      <ProviderQuota
        loadLimits={() => {
          calls += 1;
          if (calls === 1) return Promise.resolve(SAMPLE);
          return new Promise<ProviderUsage[]>((resolve) => {
            resolveSecond = resolve;
          });
        }}
        now={NOW}
      />,
    );
    await m.flush();
    assert.match(m.text(), /72% used/);
    const refresh = m.query("[data-provider-quota-refresh]");
    assert.ok(refresh);
    await m.click(refresh as HTMLElement);
    assert.match(m.text(), /72% used/, "stale snapshot stays visible");
    const busy = m.query("[data-provider-quota-refresh]");
    assert.ok(busy);
    assert.equal((busy as HTMLButtonElement).disabled, true);
    assert.equal(busy.getAttribute("aria-busy"), "true");
    resolveSecond?.(
      SAMPLE.map((row) =>
        row.provider === "claude"
          ? {
              ...row,
              windows: row.windows.map((w) =>
                w.label === "5 hours" ? { ...w, usedPercent: 80 } : w,
              ),
            }
          : row,
      ),
    );
    await m.flush();
    assert.match(m.text(), /80% used/);
    m.unmount();
  });

  it("renders a weekly-only provider without inventing a 5-hour window", async () => {
    const m = await mount(
      <ProviderQuota
        loadLimits={async () => [
          quota({
            provider: "grok",
            windows: [
              windowRow({
                label: "Weekly",
                usedPercent: 31,
                windowSeconds: WEEK,
                resetsAt: NOW + 4 * 24 * 60 * 60 * 1000,
              }),
            ],
          }),
        ]}
        now={NOW}
      />,
    );
    await m.flush();
    const row = m.query('[data-provider-quota-row="grok"]');
    assert.ok(row);
    const windows = row.querySelectorAll("[data-provider-quota-window]");
    assert.equal(windows.length, 1);
    assert.equal(windows[0]?.getAttribute("data-provider-quota-window"), "Weekly");
    const text = (row.textContent || "").replace(/\s+/g, " ");
    assert.match(text, /31% used/);
    assert.match(text, /Weekly/);
    assert.equal(/5 hours|5h/i.test(text), false, "weekly-only must not grow a 5-hour row");
    m.unmount();
  });

  it("keeps last-reported used percent after the reset time has passed", async () => {
    const m = await mount(
      <ProviderQuota
        loadLimits={async () => [
          quota({
            provider: "grok",
            windows: [
              windowRow({
                label: "Weekly",
                usedPercent: 64,
                windowSeconds: WEEK,
                resetsAt: NOW - 60_000,
              }),
            ],
            fetchedAt: NOW - 120_000,
          }),
        ]}
        now={NOW}
      />,
    );
    await m.flush();
    const row = m.query('[data-provider-quota-row="grok"]');
    assert.ok(row);
    const win = row.querySelector('[data-provider-quota-window="Weekly"]');
    assert.ok(win);
    assert.equal(win.getAttribute("data-reset-expired"), "");
    const text = (win.textContent || "").replace(/\s+/g, " ");
    assert.match(text, /64% used/);
    assert.equal(/\b0% used\b/.test(text), false, "expired reset must not become 0% used");
    assert.match(text, /reset time passed|last reported|refresh/i);
    assert.equal(/reset due|renewed|fresh allowance/i.test(text), false);
    m.unmount();
  });

  it("marks previous rows stale when a later refresh fails, not updated just now", async () => {
    let calls = 0;
    const m = await mount(
      <ProviderQuota
        loadLimits={async () => {
          calls += 1;
          if (calls === 1) return SAMPLE;
          throw new Error("cli timeout");
        }}
        now={NOW}
      />,
    );
    await m.flush();
    assert.match(m.text(), /72% used/);
    assert.equal(m.query("[data-stale]"), null);
    await m.click(m.query("[data-provider-quota-refresh]") as HTMLElement);
    assert.match(m.text(), /72% used/);
    assert.match(m.text(), /cli timeout/);
    assert.match(m.text(), /Last reported · stale/);
    assert.equal(/Updated just now/i.test(m.text()), false);
    assert.ok(m.query("[data-provider-quota-list][data-stale]"));
    m.unmount();
  });

  it("shows overage in the label while the bar stays full", async () => {
    const m = await mount(
      <ProviderQuota
        loadLimits={async () => [
          quota({
            windows: [windowRow({ usedPercent: 125, label: "Weekly" })],
          }),
        ]}
        now={NOW}
      />,
    );
    await m.flush();
    const win = m.query('[data-provider-quota-window="Weekly"]');
    assert.ok(win);
    assert.match((win.textContent || "").replace(/\s+/g, " "), /125% used/);
    const fill = win.querySelector("[data-high]") as HTMLElement | null;
    assert.ok(fill, "overage bar is marked full");
    assert.match(fill.getAttribute("style") || "", /width:\s*100%/);
    m.unmount();
  });

  it("does not tick the clock when a frozen now is passed", async () => {
    const m = await mount(
      <ProviderQuota
        loadLimits={async () => [
          quota({
            fetchedAt: NOW,
            windows: [windowRow({ resetsAt: NOW + 2 * 60 * 60 * 1000 })],
          }),
        ]}
        now={NOW}
      />,
    );
    await m.flush();
    const before = m.text();
    await new Promise((r) => setTimeout(r, 40));
    await m.flush();
    assert.equal(m.text(), before);
    assert.match(m.text(), /Updated just now|resets in 2h/);
    m.unmount();
  });
});
