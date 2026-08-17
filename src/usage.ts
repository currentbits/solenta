/**
 * Pure usage rollup for the analytics view. Days are local calendar keys.
 */
import type { UsageByDay, UsageEntry } from "./shared/ipc";

export type UsageRange = 7 | 30 | 90;

export const USAGE_RANGES: UsageRange[] = [7, 30, 90];

export interface UsageDayBucket {
  day: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface UsageProviderTotal extends UsageTotals {
  provider: string;
  /** Fraction of range cost. 0 when every cost is 0. */
  costShare: number;
  /** Fraction of range tokens (input + output). 0 when every token is 0. */
  tokenShare: number;
}

export interface UsageModelTotal extends UsageTotals {
  provider: string;
  model: string;
}

export interface UsageSummary {
  days: UsageDayBucket[];
  totals: UsageTotals;
  providers: UsageProviderTotal[];
  models: UsageModelTotal[];
}

function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addLocalDays(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
}

function finiteNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function emptyTotals(): UsageTotals {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
}

function addTo(target: UsageTotals, entry: UsageEntry): void {
  target.costUsd += entry.costUsd;
  target.inputTokens += entry.inputTokens;
  target.outputTokens += entry.outputTokens;
  target.turns += entry.turns;
}

function readEntry(raw: unknown): UsageEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  return {
    costUsd: finiteNumber(rec.costUsd),
    inputTokens: finiteNumber(rec.inputTokens),
    outputTokens: finiteNumber(rec.outputTokens),
    turns: finiteNumber(rec.turns),
  };
}

function share(part: number, whole: number): number {
  if (!(whole > 0) || !Number.isFinite(part) || part <= 0) return 0;
  return part / whole;
}

function tokensOf(row: UsageTotals): number {
  return row.inputTokens + row.outputTokens;
}

function compareTotals(a: UsageTotals, b: UsageTotals): number {
  if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
  const tokenDiff = tokensOf(b) - tokensOf(a);
  if (tokenDiff !== 0) return tokenDiff;
  return b.turns - a.turns;
}

/**
 * One bucket per local day in `range` (including empty days), plus provider
 * and model totals. `today` is the inclusive end of the window.
 */
export function summarizeUsage(
  data: UsageByDay,
  range: UsageRange,
  today: Date,
): UsageSummary {
  const days: UsageDayBucket[] = [];
  const providerMap = new Map<string, UsageTotals>();
  const modelMap = new Map<string, UsageModelTotal>();
  const totals = emptyTotals();
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : {};

  for (let i = range - 1; i >= 0; i--) {
    const day = localDayKey(addLocalDays(today, -i));
    const bucket: UsageDayBucket = {
      day,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const providers = source[day];
    if (providers && typeof providers === "object" && !Array.isArray(providers)) {
      for (const [provider, models] of Object.entries(providers)) {
        if (!provider || !models || typeof models !== "object" || Array.isArray(models)) {
          continue;
        }
        for (const [model, raw] of Object.entries(models)) {
          if (!model) continue;
          const entry = readEntry(raw);
          if (!entry) continue;
          bucket.costUsd += entry.costUsd;
          bucket.inputTokens += entry.inputTokens;
          bucket.outputTokens += entry.outputTokens;
          addTo(totals, entry);

          let providerTotal = providerMap.get(provider);
          if (!providerTotal) {
            providerTotal = emptyTotals();
            providerMap.set(provider, providerTotal);
          }
          addTo(providerTotal, entry);

          const modelKey = `${provider}\0${model}`;
          let modelTotal = modelMap.get(modelKey);
          if (!modelTotal) {
            modelTotal = { provider, model, ...emptyTotals() };
            modelMap.set(modelKey, modelTotal);
          }
          addTo(modelTotal, entry);
        }
      }
    }
    days.push(bucket);
  }

  const totalTokens = tokensOf(totals);
  const providers: UsageProviderTotal[] = [...providerMap.entries()]
    .map(([provider, row]) => ({
      provider,
      ...row,
      costShare: share(row.costUsd, totals.costUsd),
      tokenShare: share(tokensOf(row), totalTokens),
    }))
    .sort((a, b) => compareTotals(a, b) || a.provider.localeCompare(b.provider));

  const models = [...modelMap.values()].sort(
    (a, b) =>
      compareTotals(a, b) ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model),
  );

  return { days, totals, providers, models };
}
