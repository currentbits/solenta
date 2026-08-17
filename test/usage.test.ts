/**
 * summarizeUsage: range windows, empty days, shares, token-only data.
 * Run: node --experimental-strip-types --test test/usage.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UsageByDay, UsageEntry } from "../src/shared/ipc.ts";
import { summarizeUsage } from "../src/usage.ts";

const TODAY = new Date(2026, 7, 17); // 2026-08-17 local

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
    ...over,
  };
}

describe("summarizeUsage", () => {
  it("fills every day in the range, including empty ones", () => {
    const data: UsageByDay = {
      "2026-08-17": {
        claude: { sonnet: entry({ costUsd: 1, inputTokens: 10, turns: 1 }) },
      },
    };
    const summary = summarizeUsage(data, 7, TODAY);
    assert.equal(summary.days.length, 7);
    assert.deepEqual(
      summary.days.map((d) => d.day),
      [
        "2026-08-11",
        "2026-08-12",
        "2026-08-13",
        "2026-08-14",
        "2026-08-15",
        "2026-08-16",
        "2026-08-17",
      ],
    );
    assert.equal(summary.days[0].costUsd, 0);
    assert.equal(summary.days[0].inputTokens, 0);
    assert.equal(summary.days[6].costUsd, 1);
    assert.equal(summary.days[6].inputTokens, 10);
  });

  it("excludes a day just outside the window", () => {
    const data: UsageByDay = {
      "2026-08-10": {
        claude: { opus: entry({ costUsd: 9, inputTokens: 90, outputTokens: 9, turns: 3 }) },
      },
      "2026-08-11": {
        claude: { opus: entry({ costUsd: 1, inputTokens: 10, outputTokens: 1, turns: 1 }) },
      },
    };
    const seven = summarizeUsage(data, 7, TODAY);
    assert.equal(seven.totals.costUsd, 1);
    assert.equal(seven.totals.inputTokens, 10);
    assert.equal(seven.totals.turns, 1);
    assert.ok(!seven.days.some((d) => d.day === "2026-08-10"));

    const thirty = summarizeUsage(data, 30, TODAY);
    assert.equal(thirty.totals.costUsd, 10);
    assert.equal(thirty.totals.turns, 4);
  });

  it("rolls up provider and model totals with share fractions", () => {
    const data: UsageByDay = {
      "2026-08-16": {
        claude: {
          sonnet: entry({ costUsd: 2, inputTokens: 20, outputTokens: 4, turns: 2 }),
        },
        grok: {
          "grok-4": entry({ costUsd: 1, inputTokens: 10, outputTokens: 2, turns: 1 }),
        },
      },
      "2026-08-17": {
        claude: {
          opus: entry({ costUsd: 1, inputTokens: 10, outputTokens: 2, turns: 1 }),
        },
      },
    };
    const summary = summarizeUsage(data, 7, TODAY);
    assert.equal(summary.totals.costUsd, 4);
    assert.equal(summary.totals.inputTokens, 40);
    assert.equal(summary.totals.outputTokens, 8);
    assert.equal(summary.totals.turns, 4);

    assert.equal(summary.providers.length, 2);
    assert.equal(summary.providers[0].provider, "claude");
    assert.equal(summary.providers[0].costUsd, 3);
    assert.equal(summary.providers[0].costShare, 0.75);
    assert.equal(summary.providers[0].tokenShare, 36 / 48);
    assert.equal(summary.providers[1].provider, "grok");
    assert.equal(summary.providers[1].costShare, 0.25);

    assert.equal(summary.models.length, 3);
    assert.equal(summary.models[0].model, "sonnet");
    assert.equal(summary.models[0].provider, "claude");
    assert.equal(summary.models[0].costUsd, 2);
    assert.ok(summary.models.some((m) => m.model === "opus" && m.provider === "claude"));
    assert.ok(summary.models.some((m) => m.model === "grok-4" && m.provider === "grok"));
  });

  it("keeps token-only (zero-cost) data useful", () => {
    const data: UsageByDay = {
      "2026-08-17": {
        claude: {
          sonnet: entry({ costUsd: 0, inputTokens: 800, outputTokens: 200, turns: 4 }),
        },
        grok: {
          "grok-4": entry({ costUsd: 0, inputTokens: 200, outputTokens: 0, turns: 1 }),
        },
      },
    };
    const summary = summarizeUsage(data, 7, TODAY);
    assert.equal(summary.totals.costUsd, 0);
    assert.equal(summary.totals.inputTokens, 1000);
    assert.equal(summary.totals.outputTokens, 200);
    assert.equal(summary.providers[0].provider, "claude");
    assert.equal(summary.providers[0].costShare, 0);
    assert.equal(summary.providers[0].tokenShare, 1000 / 1200);
    assert.equal(summary.providers[1].provider, "grok");
    assert.equal(summary.providers[1].tokenShare, 200 / 1200);
    assert.equal(summary.days[6].inputTokens, 1000);
  });

  it("skips malformed rows and still counts unknown model keys", () => {
    const data = {
      "2026-08-17": {
        claude: {
          "mystery-model": entry({ costUsd: 1.5, inputTokens: 30, outputTokens: 6, turns: 2 }),
          "": entry({ costUsd: 99, inputTokens: 99, turns: 9 }),
          broken: "nope",
        },
        "": {
          ghost: entry({ costUsd: 5, inputTokens: 5, turns: 1 }),
        },
        grok: null,
        kimi: {
          k2: { costUsd: "0.25", inputTokens: "10", outputTokens: undefined, turns: 1 },
        },
      },
      "not-a-day": {
        claude: { sonnet: entry({ costUsd: 50, inputTokens: 50, turns: 5 }) },
      },
      "2026-08-99": {
        claude: { sonnet: entry({ costUsd: 50, inputTokens: 50, turns: 5 }) },
      },
    } as unknown as UsageByDay;

    const summary = summarizeUsage(data, 7, TODAY);
    assert.equal(summary.totals.costUsd, 1.75);
    assert.equal(summary.totals.inputTokens, 40);
    assert.equal(summary.totals.outputTokens, 6);
    assert.equal(summary.totals.turns, 3);
    assert.deepEqual(
      summary.providers.map((p) => p.provider),
      ["claude", "kimi"],
    );
    assert.equal(summary.models.length, 2);
    assert.ok(summary.models.some((m) => m.model === "mystery-model"));
    assert.ok(summary.models.some((m) => m.model === "k2" && m.provider === "kimi"));
    assert.ok(!summary.models.some((m) => m.model === "" || m.model === "broken"));
  });

  it("treats missing or non-object data as empty", () => {
    const empty = summarizeUsage({} as UsageByDay, 7, TODAY);
    assert.equal(empty.days.length, 7);
    assert.equal(empty.totals.costUsd, 0);
    assert.equal(empty.providers.length, 0);
    assert.equal(empty.models.length, 0);

    const bogus = summarizeUsage(null as unknown as UsageByDay, 30, TODAY);
    assert.equal(bogus.days.length, 30);
    assert.equal(bogus.totals.turns, 0);
  });
});
