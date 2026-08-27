/**
 * Pure usage rollup for the analytics view. Days are local calendar keys.
 */
import type {
  UsageByDay,
  UsageEntry,
  UsageReport,
  UsageThreadEntry,
  UsageThreadsByDay,
} from "./shared/ipc";

export type UsageRange = 7 | 30 | 90;

export const USAGE_RANGES: UsageRange[] = [7, 30, 90];

export type UsageBreakdownKind = "model" | "day" | "project" | "thread";

export interface UsageTotals {
  costUsd: number;
  /** Uncached input, billable at the full rate. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  turns: number;
  wastedUsd: number;
}

export interface UsageDayBucket extends UsageTotals {
  day: string;
  /** Per-provider totals for this day; missing provider = zero that day. */
  byProvider: Record<string, UsageTotals>;
}

export interface UsageProviderTotal extends UsageTotals {
  provider: string;
  /** Fraction of range cost. 0 when every cost is 0. */
  costShare: number;
  /** Fraction of range processed tokens. 0 when every token is 0. */
  tokenShare: number;
  unreported: boolean;
  /** Tokens (or cache) present, but the provider never reported USD. */
  costUnmetered: boolean;
  /**
   * Cache-volume multiplier: (inputTokens + cachedInputTokens) / inputTokens.
   *
   * 6.8 means the model read 6.8× as many input tokens as were billed at the
   * full uncached rate. This is a token-volume ratio, not a dollar saving —
   * we do not know each provider's cache-read discount, so claiming "6.8×
   * cheaper" would be invented. Cache writes are excluded (they are a
   * premium cost, not a saving) and output is unrelated. Null when the
   * provider reported no cache reads (`cachedInputTokens === 0`) or there
   * is no uncached remainder to divide by.
   */
  cacheMultiplier: number | null;
}

export interface UsageModelTotal extends UsageTotals {
  provider: string;
  model: string;
  costShare: number;
  tokenShare: number;
  unreported: boolean;
  costUnmetered: boolean;
}

export interface UsageBreakdownRow extends UsageTotals {
  key: string;
  label: string;
  detail: string;
  costShare: number;
  tokenShare: number;
  unreported: boolean;
  costUnmetered: boolean;
}

export interface UsageSummary {
  days: UsageDayBucket[];
  totals: UsageTotals;
  providers: UsageProviderTotal[];
  models: UsageModelTotal[];
  byDay: UsageBreakdownRow[];
  projects: UsageBreakdownRow[];
  threads: UsageBreakdownRow[];
}

/** Tokens the model actually saw, including cache reads/writes. */
export function processedTokens(row: UsageTotals): number {
  return (
    row.inputTokens +
    row.cachedInputTokens +
    row.cacheWriteTokens +
    row.outputTokens
  );
}

export function isUnreported(row: UsageTotals): boolean {
  return (
    row.turns > 0 &&
    row.costUsd === 0 &&
    row.inputTokens === 0 &&
    row.cachedInputTokens === 0 &&
    row.cacheWriteTokens === 0 &&
    row.outputTokens === 0
  );
}

/** Token counts exist, but the provider never emitted a USD cost (Cursor). */
export function isCostUnmetered(row: UsageTotals): boolean {
  return !isUnreported(row) && row.costUsd === 0 && processedTokens(row) > 0;
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
  return {
    costUsd: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    turns: 0,
    wastedUsd: 0,
  };
}

function cloneTotals(row: UsageTotals): UsageTotals {
  return { ...row };
}

function addTo(target: UsageTotals, entry: UsageEntry): void {
  target.costUsd += entry.costUsd;
  target.inputTokens += entry.inputTokens;
  target.cachedInputTokens += entry.cachedInputTokens;
  target.cacheWriteTokens += entry.cacheWriteTokens;
  target.outputTokens += entry.outputTokens;
  target.turns += entry.turns;
  target.wastedUsd += entry.wastedUsd;
}

function readEntry(raw: unknown): UsageEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  return {
    costUsd: finiteNumber(rec.costUsd),
    inputTokens: finiteNumber(rec.inputTokens),
    cachedInputTokens: finiteNumber(rec.cachedInputTokens),
    cacheWriteTokens: finiteNumber(rec.cacheWriteTokens),
    outputTokens: finiteNumber(rec.outputTokens),
    turns: finiteNumber(rec.turns),
    wastedUsd: finiteNumber(rec.wastedUsd),
  };
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function readThreadEntry(raw: unknown): UsageThreadEntry | null {
  const entry = readEntry(raw);
  if (!entry) return null;
  const rec = raw as Record<string, unknown>;
  return {
    ...entry,
    projectId: typeof rec.projectId === "string" ? rec.projectId : "",
    projectName: typeof rec.projectName === "string" ? rec.projectName : "",
    title: typeof rec.title === "string" ? rec.title : "",
    provider: typeof rec.provider === "string" ? rec.provider : "",
    model: typeof rec.model === "string" ? rec.model : "",
  };
}

function share(part: number, whole: number): number {
  if (!(whole > 0) || !Number.isFinite(part) || part <= 0) return 0;
  return part / whole;
}

function cacheMultiplierOf(row: UsageTotals): number | null {
  if (!(row.cachedInputTokens > 0) || !(row.inputTokens > 0)) return null;
  return (row.inputTokens + row.cachedInputTokens) / row.inputTokens;
}

function compareTotals(a: UsageTotals, b: UsageTotals): number {
  if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
  const tokenDiff = processedTokens(b) - processedTokens(a);
  if (tokenDiff !== 0) return tokenDiff;
  return b.turns - a.turns;
}

function withShares(row: UsageTotals, totals: UsageTotals) {
  return {
    ...row,
    costShare: share(row.costUsd, totals.costUsd),
    tokenShare: share(processedTokens(row), processedTokens(totals)),
    unreported: isUnreported(row),
    costUnmetered: isCostUnmetered(row),
  };
}

/**
 * Accept a UsageReport, a bare UsageByDay (legacy callers / tests), or junk
 * from disk. Missing maps become {}.
 */
function unwrapReport(raw: unknown): {
  byDay: UsageByDay;
  threadsByDay: UsageThreadsByDay;
} {
  const rec = asRecord(raw);
  if (!rec) return { byDay: {}, threadsByDay: {} };
  if ("byDay" in rec || "threadsByDay" in rec) {
    return {
      byDay: (asRecord(rec.byDay) as UsageByDay | null) ?? {},
      threadsByDay:
        (asRecord(rec.threadsByDay) as UsageThreadsByDay | null) ?? {},
    };
  }
  return { byDay: rec as UsageByDay, threadsByDay: {} };
}

/**
 * One bucket per local day in `range` (including empty days), plus provider,
 * model, project and thread totals. `today` is the inclusive end of the window.
 */
export function summarizeUsage(
  report: UsageReport | UsageByDay | null | undefined,
  range: UsageRange,
  today: Date,
): UsageSummary {
  const { byDay: source, threadsByDay: threadSource } = unwrapReport(report);
  const days: UsageDayBucket[] = [];
  const providerMap = new Map<string, UsageTotals>();
  const modelMap = new Map<string, UsageModelTotal>();
  const totals = emptyTotals();

  for (let i = range - 1; i >= 0; i--) {
    const day = localDayKey(addLocalDays(today, -i));
    const bucket: UsageDayBucket = {
      day,
      ...emptyTotals(),
      byProvider: {},
    };
    const providers = asRecord(source[day]);
    if (providers) {
      for (const [provider, models] of Object.entries(providers)) {
        if (!provider) continue;
        const modelRec = asRecord(models);
        if (!modelRec) continue;
        for (const [model, raw] of Object.entries(modelRec)) {
          if (!model) continue;
          const entry = readEntry(raw);
          if (!entry) continue;
          addTo(bucket, entry);
          addTo(totals, entry);

          let providerTotal = providerMap.get(provider);
          if (!providerTotal) {
            providerTotal = emptyTotals();
            providerMap.set(provider, providerTotal);
          }
          addTo(providerTotal, entry);

          let dayProvider = bucket.byProvider[provider];
          if (!dayProvider) {
            dayProvider = emptyTotals();
            bucket.byProvider[provider] = dayProvider;
          }
          addTo(dayProvider, entry);

          const modelKey = `${provider}\0${model}`;
          let modelTotal = modelMap.get(modelKey);
          if (!modelTotal) {
            modelTotal = {
              provider,
              model,
              ...emptyTotals(),
              costShare: 0,
              tokenShare: 0,
              unreported: false,
              costUnmetered: false,
            };
            modelMap.set(modelKey, modelTotal);
          }
          addTo(modelTotal, entry);
        }
      }
    }
    days.push(bucket);
  }

  const providers: UsageProviderTotal[] = [...providerMap.entries()]
    .map(([provider, row]) => ({
      provider,
      ...withShares(row, totals),
      cacheMultiplier: cacheMultiplierOf(row),
    }))
    .sort((a, b) => compareTotals(a, b) || a.provider.localeCompare(b.provider));

  const models: UsageModelTotal[] = [...modelMap.values()]
    .map((row) => ({
      ...row,
      ...withShares(row, totals),
      provider: row.provider,
      model: row.model,
    }))
    .sort(
      (a, b) =>
        compareTotals(a, b) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

  const byDay: UsageBreakdownRow[] = days
    .filter((d) => d.turns > 0)
    .map((d) => ({
      key: d.day,
      label: d.day,
      detail: "",
      ...withShares(cloneTotals(d), totals),
    }))
    .sort((a, b) => compareTotals(a, b) || b.key.localeCompare(a.key));

  const projectMap = new Map<
    string,
    UsageTotals & { label: string }
  >();
  const threadMap = new Map<
    string,
    UsageTotals & { label: string; detail: string }
  >();

  for (let i = range - 1; i >= 0; i--) {
    const day = localDayKey(addLocalDays(today, -i));
    const threads = asRecord(threadSource[day]);
    if (!threads) continue;
    for (const [threadId, raw] of Object.entries(threads)) {
      if (!threadId) continue;
      const entry = readThreadEntry(raw);
      if (!entry) continue;

      const projectKey = entry.projectId || entry.projectName || "(unknown)";
      const projectLabel = entry.projectName || entry.projectId || "Unknown project";
      let project = projectMap.get(projectKey);
      if (!project) {
        project = { ...emptyTotals(), label: projectLabel };
        projectMap.set(projectKey, project);
      }
      addTo(project, entry);
      if (entry.projectName) project.label = entry.projectName;

      let thread = threadMap.get(threadId);
      if (!thread) {
        thread = {
          ...emptyTotals(),
          label: entry.title || threadId,
          detail: [entry.projectName, entry.provider].filter(Boolean).join(" · "),
        };
        threadMap.set(threadId, thread);
      }
      addTo(thread, entry);
      if (entry.title) thread.label = entry.title;
      thread.detail = [entry.projectName, entry.provider].filter(Boolean).join(" · ");
    }
  }

  const projects: UsageBreakdownRow[] = [...projectMap.entries()]
    .map(([key, row]) => ({
      key,
      label: row.label,
      detail: "",
      ...withShares(row, totals),
    }))
    .sort((a, b) => compareTotals(a, b) || a.label.localeCompare(b.label));

  const threads: UsageBreakdownRow[] = [...threadMap.entries()]
    .map(([key, row]) => ({
      key,
      label: row.label,
      detail: row.detail,
      ...withShares(row, totals),
    }))
    .sort((a, b) => compareTotals(a, b) || a.label.localeCompare(b.label));

  return { days, totals, providers, models, byDay, projects, threads };
}
