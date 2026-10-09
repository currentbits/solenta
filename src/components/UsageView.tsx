import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCostUsd, formatTokenCount, providerDisplayName } from "../format";
import type { ProviderInfo, UsageReport } from "../shared/ipc";
import {
  USAGE_RANGES,
  filterUsageReport,
  processedTokens,
  summarizeUsage,
  type UsageBreakdownKind,
  type UsageBreakdownRow,
  type UsageProviderTotal,
  type UsageRange,
  type UsageTotals,
} from "../usage";
import type { ProviderLimitsLoader } from "../providerUsage";
import { ProviderMark } from "./ProviderMark";
import { providerColor } from "../providerColors";
import { ProviderQuotaSection } from "./ProviderQuota";
import styles from "./UsageView.module.css";

export type UsageMetric = "cost" | "tokens";

export interface UsageReportControls {
  range: UsageRange;
  metric: UsageMetric;
  group: UsageBreakdownKind;
}

export interface UsageViewProps {
  loadUsage: () => Promise<UsageReport>;
  loadProviderLimits?: ProviderLimitsLoader;
  quotaDemo?: boolean;
  /** Registry rows for display names ("Claude Code"); ids show without it. */
  providers?: readonly ProviderInfo[];
  onSelectThread?: (id: string) => void;
  existingThreadIds?: Iterable<string>;
  reportControls?: UsageReportControls;
  onReportControlsChange?: (next: UsageReportControls) => void;
}

const EMPTY_REPORT: UsageReport = { byDay: {}, threadsByDay: {} };

const BREAKDOWN_KINDS: { id: UsageBreakdownKind; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "day", label: "Day" },
  { id: "project", label: "Project" },
  { id: "thread", label: "Thread" },
];

function metricValue(row: UsageTotals, metric: UsageMetric): number {
  return metric === "cost" ? row.costUsd : processedTokens(row);
}

function formatMetric(value: number, metric: UsageMetric): string {
  return metric === "cost" ? formatCostUsd(value) : formatTokenCount(value);
}

function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  return `${Math.round(share * 100)}%`;
}

function formatMultiplier(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const text = n >= 100 ? n.toFixed(0) : n.toFixed(1);
  return `${text}×`;
}

/** "Sep 27" from a local YYYY-MM-DD day key. */
function formatDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Axis top and step: three gridlines at 1/2/2.5/5 × 10^k. */
function niceAxis(max: number): { top: number; step: number } {
  if (!(max > 0)) return { top: 0, step: 0 };
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? raw;
  return { top: step * 3, step };
}

/**
 * Smooth series path (Catmull-Rom as cubic Béziers), control points clamped
 * to the plot so a dip to zero never draws below the axis.
 */
function smoothPath(values: number[], max: number, w: number, h: number): string {
  const n = values.length;
  if (n === 0) return "";
  const yOf = (v: number) => (!(max > 0) || !(v > 0) ? h : (1 - v / max) * h);
  const xOf = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const pts = values.map((v, i) => [xOf(i), yOf(v)] as const);
  const clamp = (y: number) => Math.min(h, Math.max(0, y));
  let d = `M ${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 1; i < n; i++) {
    const p0 = pts[i - 2] ?? pts[i - 1]!;
    const p1 = pts[i - 1]!;
    const p2 = pts[i]!;
    const p3 = pts[i + 1] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6);
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`;
  }
  return d;
}

export function UsageView({
  loadUsage,
  loadProviderLimits,
  quotaDemo = false,
  providers = [],
  onSelectThread,
  existingThreadIds,
  reportControls,
  onReportControlsChange,
}: UsageViewProps) {
  const [report, setReport] = useState<UsageReport>(EMPTY_REPORT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLastSuccess, setHasLastSuccess] = useState(false);
  const [range, setRangeState] = useState<UsageRange>(
    () => reportControls?.range ?? 7,
  );
  const [metric, setMetricState] = useState<UsageMetric>(
    () => reportControls?.metric ?? "cost",
  );
  const [group, setGroupState] = useState<UsageBreakdownKind>(
    () => reportControls?.group ?? "model",
  );
  // ponytail: Limits tab is session-only; persist it in reportControls if people ask.
  const [limitsOpen, setLimitsOpen] = useState(false);
  // ponytail: provider filter is session-only like the Limits tab.
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const loadGen = useRef(0);

  const setRange = useCallback(
    (next: UsageRange) => {
      setRangeState(next);
      onReportControlsChange?.({ range: next, metric, group });
    },
    [onReportControlsChange, metric, group],
  );
  const setMetric = useCallback(
    (next: UsageMetric) => {
      setLimitsOpen(false);
      setMetricState(next);
      onReportControlsChange?.({ range, metric: next, group });
    },
    [onReportControlsChange, range, group],
  );
  const setGroup = useCallback(
    (next: UsageBreakdownKind) => {
      setGroupState(next);
      onReportControlsChange?.({ range, metric, group: next });
    },
    [onReportControlsChange, range, metric],
  );

  const openableThreadIds = useMemo(() => {
    if (!existingThreadIds) return null;
    return new Set(existingThreadIds);
  }, [existingThreadIds]);

  const loadAll = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadUsage();
      if (gen !== loadGen.current) return;
      const byDay =
        next && typeof next === "object" && next.byDay && typeof next.byDay === "object" &&
        !Array.isArray(next.byDay)
          ? next.byDay
          : {};
      const threadsByDay =
        next && typeof next === "object" && next.threadsByDay &&
        typeof next.threadsByDay === "object" &&
        !Array.isArray(next.threadsByDay)
          ? next.threadsByDay
          : {};
      setReport({ byDay, threadsByDay });
      setHasLastSuccess(true);
      setNow(Date.now());
    } catch (err) {
      if (gen !== loadGen.current) return;
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to load usage";
      setError(msg);
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [loadUsage]);

  useEffect(() => {
    void loadAll();
    return () => {
      loadGen.current += 1;
    };
  }, [loadAll]);

  const fullSummary = useMemo(
    () => summarizeUsage(report, range, new Date(now)),
    [report, range, now],
  );
  const summary = useMemo(
    () =>
      providerFilter
        ? summarizeUsage(filterUsageReport(report, providerFilter), range, new Date(now))
        : fullSummary,
    [fullSummary, report, providerFilter, range, now],
  );
  const providerOptions = useMemo(() => {
    const ids = fullSummary.providers.map((p) => p.provider);
    if (providerFilter && !ids.includes(providerFilter)) ids.push(providerFilter);
    return ids.sort((a, b) => a.localeCompare(b));
  }, [fullSummary.providers, providerFilter]);
  const rangeEmpty = summary.providers.length === 0;
  const showLoading = loading && !hasLastSuccess && !error;
  const initialError = Boolean(error && !hasLastSuccess);

  const providerRows = useMemo(() => {
    return summary.providers.slice().sort((a, b) => {
      if (a.unreported !== b.unreported) return a.unreported ? 1 : -1;
      const diff = metricValue(b, metric) - metricValue(a, metric);
      return diff !== 0 ? diff : a.provider.localeCompare(b.provider);
    });
  }, [summary.providers, metric]);

  const plotted = useMemo(
    () => providerRows.filter((p) => !p.unreported),
    [providerRows],
  );

  const axis = useMemo(() => {
    let max = 0;
    for (const day of summary.days) {
      for (const row of plotted) {
        const cell = day.byProvider[row.provider];
        const value = cell ? metricValue(cell, metric) : 0;
        if (value > max) max = value;
      }
    }
    return niceAxis(max);
  }, [summary.days, plotted, metric]);

  const breakdownRows: UsageBreakdownRow[] = useMemo(() => {
    const rows: UsageBreakdownRow[] =
      group === "model"
        ? summary.models.map((m) => ({
            key: `${m.provider}/${m.model}`,
            label: m.model,
            detail: m.provider,
            ...m,
          }))
        : group === "day"
          ? summary.byDay
          : group === "project"
            ? summary.projects
            : summary.threads;
    return rows.slice().sort((a, b) => {
      const diff = metricValue(b, metric) - metricValue(a, metric);
      return diff !== 0 ? diff : a.label.localeCompare(b.label);
    });
  }, [group, summary, metric]);

  const allUnreported =
    summary.providers.length > 0 && summary.providers.every((p) => p.unreported);
  const costUnmeteredTotal =
    metric === "cost" &&
    summary.totals.costUsd === 0 &&
    processedTokens(summary.totals) > 0;
  const totalLabel = allUnreported
    ? "usage not reported"
    : costUnmeteredTotal
      ? "unmetered"
      : formatMetric(metricValue(summary.totals, metric), metric);

  const firstDay = summary.days[0]?.day;
  const lastDay = summary.days[summary.days.length - 1]?.day;
  const midDay = summary.days[Math.floor((summary.days.length - 1) / 2)]?.day;
  const rangeLabel =
    firstDay && lastDay ? `${formatDayKey(firstDay)} – ${formatDayKey(lastDay)}` : null;
  const ticks =
    axis.step > 0 ? [3, 2, 1, 0].map((i) => i * axis.step) : [];

  return (
    <main
      className={styles.main}
      data-usage=""
      data-range={range}
      data-metric={metric}
      data-usage-group={group}
      data-usage-tab={limitsOpen ? "limits" : "report"}
    >
      <header className={styles.header}>
        <div className={styles.crumb}>
          <span className={styles.crumbParent}>Insights</span>
          <span className={styles.crumbSep} aria-hidden>
            /
          </span>
          <h1 className={styles.title}>Usage</h1>
          {!limitsOpen && rangeLabel ? (
            <span className={styles.rangeLabel} data-usage-range-label="">
              {rangeLabel}
            </span>
          ) : null}
        </div>
        <div className={styles.controls}>
          <div className={styles.segment} role="group" aria-label="Metric">
            <button
              type="button"
              className={styles.segBtn}
              aria-pressed={!limitsOpen && metric === "cost"}
              data-usage-metric="cost"
              onClick={() => setMetric("cost")}
            >
              Cost
            </button>
            <button
              type="button"
              className={styles.segBtn}
              aria-pressed={!limitsOpen && metric === "tokens"}
              data-usage-metric="tokens"
              onClick={() => setMetric("tokens")}
            >
              Tokens
            </button>
            {loadProviderLimits ? (
              <button
                type="button"
                className={styles.segBtn}
                aria-pressed={limitsOpen}
                data-usage-tab-btn="limits"
                onClick={() => setLimitsOpen(true)}
              >
                Limits
              </button>
            ) : null}
          </div>
          {limitsOpen ? null : (
            <>
              {providerOptions.length > 1 || providerFilter ? (
                <select
                  className={styles.providerSelect}
                  aria-label="Provider"
                  data-usage-provider-filter=""
                  value={providerFilter ?? ""}
                  onChange={(e) => setProviderFilter(e.target.value || null)}
                >
                  <option value="">All providers</option>
                  {providerOptions.map((id) => (
                    <option key={id} value={id}>
                      {providerDisplayName(id, providers)}
                    </option>
                  ))}
                </select>
              ) : null}
              <div className={styles.segment} role="group" aria-label="Range">
                {USAGE_RANGES.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={styles.segBtn}
                    aria-pressed={range === item}
                    data-usage-range={item}
                    onClick={() => setRange(item)}
                  >
                    {item} days
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={styles.refresh}
                onClick={() => void loadAll()}
                disabled={loading}
                aria-label="Refresh"
                title="Refresh"
                data-usage-refresh=""
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5" />
                </svg>
              </button>
            </>
          )}
        </div>
      </header>

      {limitsOpen && loadProviderLimits ? (
        <div className={styles.body}>
          <div className={styles.column}>
            <ProviderQuotaSection
              loadLimits={loadProviderLimits}
              demo={quotaDemo}
              providers={providers}
            />
          </div>
        </div>
      ) : showLoading ? (
        <p className={styles.hint} aria-live="polite">
          Loading usage…
        </p>
      ) : initialError ? (
        <div className={styles.empty} data-usage-error="">
          <p className={styles.emptyTitle}>Could not load usage</p>
          <p className={styles.emptyHint} role="alert">
            {error}
          </p>
          <button
            type="button"
            className={styles.retry}
            onClick={() => void loadAll()}
            disabled={loading}
            title="Retry"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {error ? (
            <div className={styles.refreshStatus} data-usage-error="">
              <p className={styles.hint} role="alert">
                {error}
              </p>
              <p className={styles.hint} data-usage-stale="" data-stale="">
                Last successful report · stale
              </p>
            </div>
          ) : null}
          {rangeEmpty ? (
            <div className={styles.empty} data-usage-empty="">
              <p className={styles.emptyTitle}>No usage in this range</p>
              <p className={styles.emptyHint}>
                Token and cost totals from runs will show up here.
              </p>
            </div>
          ) : (
        <div className={styles.body}>
          <div className={styles.column}>
          <div className={styles.hero}>
            <div className={styles.heroLeft}>
              <section className={styles.totals} data-usage-totals="">
                <p className={styles.totalValue}>{totalLabel}</p>
                <p className={styles.totalMeta}>
                  {summary.totals.turns} turns
                  {allUnreported || costUnmeteredTotal ? null : (
                    <>
                      {" · "}
                      <span data-usage-caveat="">if billed at full API rate</span>
                    </>
                  )}
                </p>
              </section>

              <section className={styles.providers} aria-label="Providers">
                {providerRows.map((row) => (
                  <ProviderRow
                    key={row.provider}
                    row={row}
                    metric={metric}
                    name={providerDisplayName(row.provider, providers)}
                  />
                ))}
              </section>
            </div>

            <section className={styles.chartSection} aria-label="Daily usage">
              <h2 className={styles.sectionTitle}>
                {metric === "cost" ? "Daily cost" : "Daily tokens"}
              </h2>
              <div className={styles.chart}>
                <div className={styles.yAxis} aria-hidden="true">
                  {ticks.map((t) => (
                    <span
                      key={t}
                      className={styles.yTick}
                      style={{ top: `${axis.top > 0 ? (1 - t / axis.top) * 100 : 100}%` }}
                    >
                      {formatMetric(t, metric)}
                    </span>
                  ))}
                </div>
                <div className={styles.plot} role="img" aria-label="Daily usage chart">
                  {/* ponytail: hand-rolled overlay SVG, no zoom/stack; reach for a chart lib if we need either */}
                  <svg
                    className={styles.chartSvg}
                    viewBox="0 0 100 40"
                    preserveAspectRatio="none"
                    data-usage-chart=""
                    aria-hidden="true"
                  >
                    {ticks.map((t) => {
                      const y = axis.top > 0 ? (1 - t / axis.top) * 40 : 40;
                      return (
                        <line
                          key={t}
                          x1="0"
                          x2="100"
                          y1={y}
                          y2={y}
                          className={styles.gridLine}
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}
                    {plotted.map((row) => {
                      const values = summary.days.map((day) => {
                        const cell = day.byProvider[row.provider];
                        return cell ? metricValue(cell, metric) : 0;
                      });
                      const line = smoothPath(values, axis.top, 100, 40);
                      const color = providerColor(row.provider);
                      return (
                        <g key={row.provider} data-usage-series={row.provider}>
                          <path d={`${line} L 100 40 L 0 40 Z`} fill={color} opacity="0.1" />
                          <path
                            d={line}
                            fill="none"
                            stroke={color}
                            strokeWidth="1.6"
                            vectorEffect="non-scaling-stroke"
                          />
                        </g>
                      );
                    })}
                  </svg>
                  <div className={styles.chartHits}>
                    {summary.days.map((day) => {
                      const bits = plotted.map((row) => {
                        const cell = day.byProvider[row.provider];
                        const value = cell ? metricValue(cell, metric) : 0;
                        return `${providerDisplayName(row.provider, providers)} ${formatMetric(value, metric)}`;
                      });
                      const label =
                        bits.length > 0
                          ? `${formatDayKey(day.day)}: ${bits.join(", ")}`
                          : formatDayKey(day.day);
                      return (
                        <div
                          key={day.day}
                          className={styles.barCol}
                          data-usage-bar={day.day}
                          title={label}
                          aria-label={label}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
              {firstDay && lastDay ? (
                <div className={styles.xAxis} aria-hidden="true">
                  <span>{formatDayKey(firstDay)}</span>
                  {midDay && midDay !== firstDay && midDay !== lastDay ? (
                    <span>{formatDayKey(midDay)}</span>
                  ) : null}
                  <span>{formatDayKey(lastDay)}</span>
                </div>
              ) : null}
            </section>
          </div>

          <section aria-label="Totals">
            <h2 className={styles.sectionTitle}>Totals</h2>
            <div className={styles.stats} data-usage-stats="">
              <Stat label="Processed tokens" value={formatTokenCount(processedTokens(summary.totals))} kind="processed" />
              <Stat
                label="Cached input"
                value={formatTokenCount(summary.totals.cachedInputTokens)}
                kind="cached"
              />
              <Stat
                label="Uncached input"
                value={formatTokenCount(summary.totals.inputTokens)}
                kind="uncached"
              />
              <Stat
                label="Output"
                value={formatTokenCount(summary.totals.outputTokens)}
                kind="output"
              />
              <Stat
                label="Wasted"
                value={
                  summary.totals.wastedUsd > 0
                    ? formatCostUsd(summary.totals.wastedUsd)
                    : "—"
                }
                kind="wasted"
                title="Spend on runs that ended failed or stopped"
              />
            </div>
          </section>

          <section className={styles.models} aria-label="Breakdown" data-usage-breakdown="">
            <div className={styles.breakdownHead}>
              <h2 className={styles.sectionTitle}>Breakdown</h2>
              <div className={styles.segment} role="group" aria-label="Breakdown">
                {BREAKDOWN_KINDS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={styles.segBtn}
                    aria-pressed={group === item.id}
                    data-usage-group-btn={item.id}
                    onClick={() => setGroup(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{BREAKDOWN_KINDS.find((k) => k.id === group)?.label ?? "Name"}</th>
                  {group === "thread" ? <th>Project</th> : null}
                  <th className={styles.num}>Cost</th>
                  <th className={styles.num}>Share</th>
                  <th className={styles.num}>Tokens</th>
                  <th className={styles.num}>Turns</th>
                </tr>
              </thead>
              <tbody>
                {breakdownRows.length === 0 ? (
                  <tr data-usage-breakdown-empty={group}>
                    <td colSpan={group === "thread" ? 6 : 5} className={styles.breakdownEmpty}>
                      {group === "project" || group === "thread"
                        ? "No per-thread usage recorded in this range. Attribution starts from the first run after this update. Earlier turns were never stored per thread."
                        : "No usage in this range."}
                    </td>
                  </tr>
                ) : null}
                {breakdownRows.map((row) => {
                  const share = metric === "cost" ? row.costShare : row.tokenShare;
                  const modelAttr =
                    group === "model" ? `${row.detail}/${row.label}` : undefined;
                  return (
                    <tr
                      key={row.key}
                      data-usage-row={row.key}
                      data-usage-model={modelAttr}
                    >
                      <td>
                        <span className={styles.rowLabel}>
                          {group === "model" && row.detail ? (
                            <ProviderMark
                              providerId={row.detail}
                              providers={providers}
                              size={13}
                              className={styles.rowMark}
                            />
                          ) : null}
                          <BreakdownLabel
                            row={row}
                            group={group}
                            onSelectThread={onSelectThread}
                            openable={
                              !openableThreadIds || openableThreadIds.has(row.key)
                            }
                          />
                        </span>
                      </td>
                      {group === "thread" ? (
                        <td className={styles.dim}>{row.detail}</td>
                      ) : null}
                      <td className={styles.num}>
                        {row.unreported ? (
                          <span className={styles.unreportedCell}>usage not reported</span>
                        ) : row.costUnmetered ? (
                          <span className={styles.unreportedCell}>unmetered</span>
                        ) : (
                          formatCostUsd(row.costUsd)
                        )}
                      </td>
                      <td className={styles.num}>
                        {row.unreported ? "—" : formatShare(share)}
                      </td>
                      <td className={styles.num}>
                        {row.unreported ? "—" : formatTokenCount(processedTokens(row))}
                      </td>
                      <td className={styles.num}>{row.turns}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          </div>
        </div>
          )}
        </>
      )}
    </main>
  );
}

function BreakdownLabel({
  row,
  group,
  onSelectThread,
  openable,
}: {
  row: UsageBreakdownRow;
  group: UsageBreakdownKind;
  onSelectThread?: (id: string) => void;
  openable: boolean;
}) {
  if (group !== "thread" || !onSelectThread) return row.label;
  if (!openable) {
    return (
      <span
        className={styles.threadGone}
        data-usage-thread={row.key}
        data-usage-thread-unavailable=""
        title="This thread was deleted. Its usage stays in the report."
      >
        {row.label}
        <span className={styles.unavailableHint}>unavailable</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.threadLink}
      data-usage-thread={row.key}
      aria-label={`Open thread: ${row.label}`}
      onClick={() => onSelectThread(row.key)}
    >
      {row.label}
    </button>
  );
}

function Stat({
  label,
  value,
  kind,
  title,
}: {
  label: string;
  value: string;
  kind: string;
  title?: string;
}) {
  return (
    <div className={styles.stat} data-usage-stat={kind} title={title}>
      <span className={styles.statLabel}>{label}</span>
      <span
        className={styles.statValue}
        data-usage-wasted={kind === "wasted" ? "" : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function ProviderRow({
  row,
  metric,
  name,
}: {
  row: UsageProviderTotal;
  metric: UsageMetric;
  name: string;
}) {
  const unmetered = row.costUnmetered && metric === "cost";
  const share = metric === "cost" ? row.costShare : row.tokenShare;
  const meta = row.unreported
    ? "usage not reported"
    : unmetered
      ? `unmetered · ${formatTokenCount(processedTokens(row))} tokens`
      : [
          `${formatShare(share)} of ${metric === "cost" ? "cost" : "tokens"}`,
          metric === "cost" ? `${formatTokenCount(processedTokens(row))} tokens` : null,
          row.cacheMultiplier != null ? `${formatMultiplier(row.cacheMultiplier)} cache` : null,
        ]
          .filter(Boolean)
          .join(" · ");
  const value =
    row.unreported || unmetered ? "—" : formatMetric(metricValue(row, metric), metric);
  return (
    <div
      className={styles.providerRow}
      data-usage-provider={row.provider}
      data-usage-unreported={row.unreported ? "" : undefined}
      data-usage-cost-unmetered={unmetered ? "" : undefined}
      data-off={row.unreported || unmetered ? "" : undefined}
    >
      <div className={styles.providerHead}>
        <span
          className={styles.providerDot}
          style={{ background: row.unreported ? "var(--border)" : providerColor(row.provider) }}
        />
        <ProviderMark providerId={row.provider} size={13} decorative className={styles.providerMark} />
        <span className={styles.providerName}>{name}</span>
        <span className={styles.providerTurns}>{row.turns} turns</span>
        <span className={styles.providerValue}>{value}</span>
      </div>
      <p className={styles.providerMeta} data-usage-cache={row.cacheMultiplier != null ? row.provider : undefined}>
        {meta}
      </p>
    </div>
  );
}
