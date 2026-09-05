/**
 * Pure helpers for provider quota windows (local contract until shared IPC lands).
 *
 * Run: node --experimental-strip-types --test test/providerUsage.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  displayWindowLabel,
  formatResetAt,
  formatUsedPercent,
  usedBarWidth,
  isQuotaStale,
  QUOTA_STALE_MS,
  sortProviderUsage,
  type ProviderUsage,
  type ProviderUsageWindow,
} from "../src/providerUsage.ts";

const FIVE_HOURS = 5 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;

function windowRow(
  over: Partial<ProviderUsageWindow> = {},
): ProviderUsageWindow {
  return {
    label: "5 hours",
    usedPercent: 40,
    resetsAt: 1,
    windowSeconds: FIVE_HOURS,
    ...over,
  };
}

function row(over: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    provider: "claude",
    status: "ok",
    windows: [windowRow()],
    fetchedAt: 1,
    ...over,
  };
}

describe("sortProviderUsage", () => {
  it("puts the active thread provider first, then the rest alphabetically", () => {
    const rows = [
      row({ provider: "kimi" }),
      row({ provider: "claude" }),
      row({ provider: "grok" }),
    ];
    assert.deepEqual(
      sortProviderUsage(rows, "grok").map((r) => r.provider),
      ["grok", "claude", "kimi"],
    );
  });
});

describe("formatUsedPercent", () => {
  it("labels the percentage as used, never remaining", () => {
    assert.equal(formatUsedPercent(42.4), "42% used");
    assert.equal(formatUsedPercent(0), "0% used");
    assert.equal(formatUsedPercent(100), "100% used");
  });

  it("keeps overage in the text and treats invalid values as unavailable", () => {
    assert.equal(formatUsedPercent(125), "125% used");
    assert.equal(formatUsedPercent(125.4), "125% used");
    assert.equal(formatUsedPercent(-1), "unavailable");
    assert.equal(formatUsedPercent(Number.NaN), "unavailable");
    assert.equal(formatUsedPercent(Number.POSITIVE_INFINITY), "unavailable");
  });
});

describe("usedBarWidth", () => {
  it("caps the bar at 100 and hides invalid values", () => {
    assert.equal(usedBarWidth(125), 100);
    assert.equal(usedBarWidth(40), 40);
    assert.equal(usedBarWidth(-1), 0);
    assert.equal(usedBarWidth(Number.NaN), 0);
  });
});

describe("displayWindowLabel", () => {
  it("keeps a backend label and names unlabeled windows from their actual duration", () => {
    assert.equal(displayWindowLabel(windowRow({ label: "5 hours" })), "5 hours");
    assert.equal(
      displayWindowLabel(windowRow({ label: "", windowSeconds: FIVE_HOURS })),
      "5 hours",
    );
    assert.equal(
      displayWindowLabel(windowRow({ label: "  ", windowSeconds: WEEK })),
      "Weekly",
    );
    assert.equal(
      displayWindowLabel(windowRow({ label: "", windowSeconds: 3600 })),
      "1 hour",
    );
    assert.equal(
      displayWindowLabel(windowRow({ label: "", windowSeconds: null })),
      "Window",
    );
  });
});

describe("formatResetAt", () => {
  it("describes a future reset without implying a passed reset already renewed", () => {
    const now = 1_000_000;
    assert.equal(formatResetAt(now + 2 * 60 * 60 * 1000, now), "resets in 2h");
    assert.equal(formatResetAt(now - 1, now), "reset time passed");
    assert.match(formatResetAt(now - 1, now) ?? "", /last reported|refresh|passed/i);
    assert.equal(/reset due|renewed|fresh/i.test(formatResetAt(now - 1, now) ?? ""), false);
    assert.equal(formatResetAt(null, now), null);
  });
});

describe("isQuotaStale", () => {
  it("is stale only when a fetchedAt snapshot is older than the threshold", () => {
    const now = QUOTA_STALE_MS + 10;
    assert.equal(isQuotaStale(0, now), true);
    assert.equal(isQuotaStale(now, now), false);
    assert.equal(isQuotaStale(null, now), false);
  });
});
