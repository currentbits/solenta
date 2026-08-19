/**
 * summarizeUsage: range windows, empty days, shares, token-only data.
 * Run: node --experimental-strip-types --test test/usage.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  UsageByDay,
  UsageEntry,
  UsageReport,
  UsageThreadEntry,
} from "../src/shared/ipc.ts";
import {
  isUnreported,
  processedTokens,
  summarizeUsage,
} from "../src/usage.ts";

const TODAY = new Date(2026, 7, 17); // 2026-08-17 local

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

function thread(
  over: Partial<UsageThreadEntry> & { threadId?: string } = {},
): UsageThreadEntry {
  const { threadId: _id, ...rest } = over;
  return {
    ...entry(),
    projectId: "proj-1",
    projectName: "nebula",
    title: "A thread",
    provider: "claude",
    model: "sonnet",
    ...rest,
  };
}

function report(byDay: UsageByDay, threadsByDay: UsageReport["threadsByDay"] = {}): UsageReport {
  return { byDay, threadsByDay };
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

  it("keeps an all-zero provider with a real turn count and flags it unreported", () => {
    const data: UsageByDay = {
      "2026-08-17": {
        claude: {
          opus: entry({ costUsd: 2, inputTokens: 10, outputTokens: 2, turns: 1 }),
        },
        kimi: {
          "kimi-k2": entry({ turns: 41 }),
        },
      },
    };
    const summary = summarizeUsage(data, 7, TODAY);
    const kimi = summary.providers.find((p) => p.provider === "kimi");
    assert.ok(kimi, "kimi stays in providers");
    assert.equal(kimi.turns, 41);
    assert.equal(kimi.costUsd, 0);
    assert.equal(kimi.inputTokens, 0);
    assert.equal(kimi.cachedInputTokens, 0);
    assert.equal(kimi.cacheWriteTokens, 0);
    assert.equal(kimi.outputTokens, 0);
    assert.equal(kimi.unreported, true);
    assert.equal(kimi.costShare, 0);
    assert.equal(kimi.tokenShare, 0);
    assert.equal(kimi.cacheMultiplier, null);

    const kimiModel = summary.models.find((m) => m.provider === "kimi");
    assert.ok(kimiModel);
    assert.equal(kimiModel.unreported, true);
    assert.equal(kimiModel.turns, 41);

    const claude = summary.providers.find((p) => p.provider === "claude");
    assert.ok(claude);
    assert.equal(claude.unreported, false);
  });

  it("treats processed tokens as the sum of uncached, cache, and output", () => {
    const data: UsageByDay = {
      "2026-08-17": {
        claude: {
          opus: entry({
            costUsd: 5,
            inputTokens: 100,
            cachedInputTokens: 900,
            cacheWriteTokens: 50,
            outputTokens: 20,
            turns: 2,
          }),
        },
      },
    };
    const summary = summarizeUsage(data, 7, TODAY);
    assert.equal(summary.totals.inputTokens, 100);
    assert.equal(summary.totals.cachedInputTokens, 900);
    assert.equal(summary.totals.cacheWriteTokens, 50);
    assert.equal(summary.totals.outputTokens, 20);
    assert.equal(processedTokens(summary.totals), 1070);
    assert.notEqual(processedTokens(summary.totals), summary.totals.inputTokens);
    assert.notEqual(
      processedTokens(summary.totals),
      summary.totals.inputTokens + summary.totals.outputTokens,
    );
    assert.equal(summary.providers[0].tokenShare, 1);
    assert.equal(summary.days[6].cachedInputTokens, 900);
    assert.equal(summary.days[6].byProvider.claude.cachedInputTokens, 900);
  });

  it("loads old entries that lack the new fields as zeros", () => {
    const data = {
      "2026-08-17": {
        grok: {
          "grok-4": {
            costUsd: 1.25,
            inputTokens: 40,
            outputTokens: 8,
            turns: 2,
          },
        },
      },
    } as unknown as UsageByDay;
    const summary = summarizeUsage(data, 7, TODAY);
    const grok = summary.providers[0];
    assert.equal(grok.provider, "grok");
    assert.equal(grok.costUsd, 1.25);
    assert.equal(grok.inputTokens, 40);
    assert.equal(grok.outputTokens, 8);
    assert.equal(grok.cachedInputTokens, 0);
    assert.equal(grok.cacheWriteTokens, 0);
    assert.equal(grok.wastedUsd, 0);
    assert.equal(grok.unreported, false);
    assert.equal(grok.cacheMultiplier, null);
    assert.equal(summary.totals.cachedInputTokens, 0);
    assert.equal(summary.totals.wastedUsd, 0);
  });

  it("computes the cache multiplier only when a provider reported cache reads", () => {
    const data: UsageByDay = {
      "2026-08-17": {
        claude: {
          opus: entry({
            costUsd: 4,
            inputTokens: 200,
            cachedInputTokens: 1160,
            cacheWriteTokens: 40,
            outputTokens: 10,
            turns: 1,
          }),
        },
        grok: {
          "grok-4": entry({
            costUsd: 1,
            inputTokens: 500,
            outputTokens: 50,
            turns: 1,
          }),
        },
      },
    };
    const summary = summarizeUsage(data, 7, TODAY);
    const claude = summary.providers.find((p) => p.provider === "claude");
    const grok = summary.providers.find((p) => p.provider === "grok");
    assert.ok(claude && grok);
    assert.equal(claude.cacheMultiplier, (200 + 1160) / 200);
    assert.equal(grok.cacheMultiplier, null);
    assert.equal(grok.cachedInputTokens, 0);
  });

  it("carries wastedUsd through totals and groupings", () => {
    const data: UsageByDay = {
      "2026-08-17": {
        claude: {
          opus: entry({ costUsd: 5, inputTokens: 10, outputTokens: 2, turns: 3, wastedUsd: 1.5 }),
        },
      },
    };
    const summary = summarizeUsage(data, 7, TODAY);
    assert.equal(summary.totals.wastedUsd, 1.5);
    assert.equal(summary.providers[0].wastedUsd, 1.5);
    assert.equal(summary.models[0].wastedUsd, 1.5);
    assert.equal(summary.byDay[0].wastedUsd, 1.5);
  });

  it("builds day, project and thread groupings with share maths", () => {
    const byDay: UsageByDay = {
      "2026-08-16": {
        claude: {
          sonnet: entry({ costUsd: 6, inputTokens: 60, outputTokens: 6, turns: 2, wastedUsd: 1 }),
        },
      },
      "2026-08-17": {
        grok: {
          "grok-4": entry({ costUsd: 2, inputTokens: 20, outputTokens: 2, turns: 1 }),
        },
        kimi: {
          "kimi-k2": entry({ turns: 8 }),
        },
      },
    };
    const threadsByDay = {
      "2026-08-16": {
        "th-a": thread({
          costUsd: 6,
          inputTokens: 60,
          outputTokens: 6,
          turns: 2,
          wastedUsd: 1,
          projectId: "proj-1",
          projectName: "nebula",
          title: "Fix the cache",
          provider: "claude",
          model: "sonnet",
        }),
      },
      "2026-08-17": {
        "th-b": thread({
          costUsd: 2,
          inputTokens: 20,
          outputTokens: 2,
          turns: 1,
          projectId: "proj-2",
          projectName: "ledger",
          title: "Tighten CSP",
          provider: "grok",
          model: "grok-4",
        }),
        "th-k": thread({
          turns: 8,
          projectId: "proj-2",
          projectName: "ledger",
          title: "Kimi research",
          provider: "kimi",
          model: "kimi-k2",
        }),
      },
    };
    const summary = summarizeUsage(report(byDay, threadsByDay), 7, TODAY);

    assert.equal(summary.byDay.length, 2);
    assert.equal(summary.byDay[0].key, "2026-08-16");
    assert.equal(summary.byDay[0].costUsd, 6);
    assert.equal(summary.byDay[0].costShare, 6 / 8);
    assert.equal(summary.byDay[1].key, "2026-08-17");
    assert.equal(summary.byDay[1].costShare, 2 / 8);
    assert.equal(summary.byDay[1].turns, 9);

    assert.equal(summary.projects.length, 2);
    assert.equal(summary.projects[0].label, "nebula");
    assert.equal(summary.projects[0].costUsd, 6);
    assert.equal(summary.projects[0].costShare, 6 / 8);
    assert.equal(summary.projects[0].wastedUsd, 1);
    assert.equal(summary.projects[1].label, "ledger");
    assert.equal(summary.projects[1].costUsd, 2);
    assert.equal(summary.projects[1].costShare, 2 / 8);
    assert.equal(summary.projects[1].turns, 9);

    assert.equal(summary.threads.length, 3);
    assert.equal(summary.threads[0].label, "Fix the cache");
    assert.equal(summary.threads[0].key, "th-a");
    assert.equal(summary.threads[0].costShare, 6 / 8);
    assert.equal(summary.threads[0].detail, "nebula · claude");
    const kimiThread = summary.threads.find((t) => t.key === "th-k");
    assert.ok(kimiThread);
    assert.equal(kimiThread.unreported, true);
    assert.equal(kimiThread.turns, 8);
    assert.equal(kimiThread.label, "Kimi research");

    assert.equal(summary.days[5].byProvider.claude.costUsd, 6);
    assert.equal(summary.days[6].byProvider.grok.costUsd, 2);
    assert.equal(summary.days[6].byProvider.kimi.turns, 8);
  });

  it("does not treat a zero-turn empty cell as unreported", () => {
    assert.equal(isUnreported(entry()), false);
    assert.equal(isUnreported(entry({ turns: 1 })), true);
    assert.equal(isUnreported(entry({ turns: 1, inputTokens: 1 })), false);
  });
});
