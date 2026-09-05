import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCostUsd, formatTokenSum } from "../format";
import type { UsageReport } from "../shared/ipc";
import {
  USAGE_RANGES,
  processedTokens,
  summarizeUsage,
  type UsageBreakdownKind,
  type UsageBreakdownRow,
  type UsageProviderTotal,
  type UsageRange,
  type UsageTotals,
} from "../usage";
import type { ProviderLimitsLoader } from "../providerUsage";
import { ProviderQuotaSection } from "./ProviderQuota";
import styles from "./UsageView.module.css";

export type UsageMetric = "cost" | "tokens";

export interface UsageViewProps {
  loadUsage: () => Promise<UsageReport>;
  loadProviderLimits?: ProviderLimitsLoader;
  quotaDemo?: boolean;
}

const EMPTY_REPORT: UsageReport = { byDay: {}, threadsByDay: {} };

const BREAKDOWN_KINDS: { id: UsageBreakdownKind; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "day", label: "Day" },
  { id: "project", label: "Project" },
  { id: "thread", label: "Thread" },
];

const PROVIDER_COLORS: Record<string, string> = {
  claude: "var(--blue)",
  grok: "var(--green)",
  kimi: "var(--amber)",
  codex: "var(--danger)",
  opencode: "var(--text-muted)",
  muse: "var(--accent)",
};

function providerColor(id: string): string {
  return PROVIDER_COLORS[id] ?? "var(--text-muted)";
}

function metricValue(row: UsageTotals, metric: UsageMetric): number {
  return metric === "cost" ? row.costUsd : processedTokens(row);
}

function formatMetric(value: number, metric: UsageMetric): string {
  return metric === "cost" ? formatCostUsd(value) : formatTokenSum(value);
}

function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  return `${Math.round(share * 100)}%`;
}

function barPercent(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value) || value <= 0) return 0;
  return (value / max) * 100;
}

function formatMultiplier(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const text = n >= 100 ? n.toFixed(0) : n.toFixed(1);
  return `${text}×`;
}

function areaPath(values: number[], max: number, w: number, h: number): string {
  const n = values.length;
  if (n === 0) return "";
  const yOf = (v: number) => {
    if (!(max > 0) || !(v > 0)) return h;
    return 1.5 + (1 - v / max) * (h - 1.5);
  };
  const xOf = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const pts = values.map((v, i) => `${xOf(i)} ${yOf(v)}`);
  return `M 0 ${h} L ${pts.join(" L ")} L ${w} ${h} Z`;
}

function linePath(values: number[], max: number, w: number, h: number): string {
  const n = values.length;
  if (n === 0) return "";
  const yOf = (v: number) => {
    if (!(max > 0) || !(v > 0)) return h;
    return 1.5 + (1 - v / max) * (h - 1.5);
  };
  const xOf = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const pts = values.map((v, i) => `${xOf(i)} ${yOf(v)}`);
  return `M ${pts.join(" L ")}`;
}

export function UsageView({
  loadUsage,
  loadProviderLimits,
  quotaDemo = false,
}: UsageViewProps) {
  const [report, setReport] = useState<UsageReport>(EMPTY_REPORT);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<UsageRange>(7);
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [group, setGroup] = useState<UsageBreakdownKind>("model");
  const [now, setNow] = useState(() => Date.now());
  const loadGen = useRef(0);

  const loadAll = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
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
      setNow(Date.now());
    } catch {
      if (gen !== loadGen.current) return;
      setReport(EMPTY_REPORT);
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

  const summary = useMemo(
    () => summarizeUsage(report, range, new Date(now)),
    [report, range, now],
  );
  const empty = !loading && summary.providers.length === 0;

  const providers = useMemo(() => {
    return summary.providers.slice().sort((a, b) => {
      if (a.unreported !== b.unreported) return a.unreported ? 1 : -1;
      const diff = metricValue(b, metric) - metricValue(a, metric);
      return diff !== 0 ? diff : a.provider.localeCompare(b.provider);
    });
  }, [summary.providers, metric]);

  const plotted = useMemo(
    () => providers.filter((p) => !p.unreported),
    [providers],
  );

  const chartMax = useMemo(() => {
    let max = 0;
    for (const day of summary.days) {
      for (const row of plotted) {
        const cell = day.byProvider[row.provider];
        const value = cell ? metricValue(cell, metric) : 0;
        if (value > max) max = value;
      }
    }
    return max;
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

  return (
    <main
      className={styles.main}
      data-usage=""
      data-range={range}
      data-metric={metric}
      data-usage-group={group}
    >
      <header className={styles.header}>
        <h1 className={styles.title}>Usage</h1>
        <div className={styles.controls}>
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
          <div className={styles.segment} role="group" aria-label="Metric">
            <button
              type="button"
              className={styles.segBtn}
              aria-pressed={metric === "cost"}
              data-usage-metric="cost"
              onClick={() => setMetric("cost")}
            >
              Cost
            </button>
            <button
              type="button"
              className={styles.segBtn}
              aria-pressed={metric === "tokens"}
              data-usage-metric="tokens"
              onClick={() => setMetric("tokens")}
            >
              Tokens
            </button>
          </div>
          <button
            type="button"
            className={styles.refresh}
            onClick={() => void loadAll()}
            disabled={loading}
            title="Refresh"
          >
            Refresh
          </button>
        </div>
      </header>

      {loadProviderLimits ? (
        <div className={styles.quotaBlock}>
          <ProviderQuotaSection loadLimits={loadProviderLimits} demo={quotaDemo} />
        </div>
      ) : null}

      {loading && summary.providers.length === 0 && Object.keys(report.byDay).length === 0 ? (
        <p className={styles.hint} aria-live="polite">
          Loading usage…
        </p>
      ) : empty ? (
        <div className={styles.empty} data-usage-empty="">
          <p className={styles.emptyTitle}>No usage in this range</p>
          <p className={styles.emptyHint}>
            Token and cost totals from runs will show up here.
          </p>
        </div>
      ) : (
        <div className={styles.body}>
          <section className={styles.totals} data-usage-totals="">
            <p className={styles.totalValue}>{totalLabel}</p>
            {allUnreported || costUnmeteredTotal ? null : (
              <p className={styles.caveat} data-usage-caveat="">
                * if billed at full API rate
              </p>
            )}
            <p className={styles.totalMeta}>
              {allUnreported ? null : (
                <>
                  {costUnmeteredTotal
                    ? "unmetered"
                    : formatCostUsd(summary.totals.costUsd)}
                  {" · "}
                  {formatTokenSum(processedTokens(summary.totals))}
                  {" · "}
                </>
              )}
              {summary.totals.turns} turns
              {summary.totals.wastedUsd > 0
                ? ` · ${formatCostUsd(summary.totals.wastedUsd)} wasted`
                : ""}
            </p>
          </section>

          <section className={styles.providers} aria-label="Providers">
            <h2 className={styles.sectionTitle}>Providers</h2>
            {providers.map((row) => (
              <ProviderRow key={row.provider} row={row} metric={metric} />
            ))}
          </section>

          <div className={styles.stats} data-usage-stats="">
            <Stat label="Processed" value={formatTokenSum(processedTokens(summary.totals))} kind="processed" />
            <Stat
              label="Cached input"
              value={formatTokenSum(summary.totals.cachedInputTokens)}
              kind="cached"
            />
            <Stat
              label="Uncached input"
              value={formatTokenSum(summary.totals.inputTokens)}
              kind="uncached"
            />
            <Stat
              label="Output"
              value={formatTokenSum(summary.totals.outputTokens)}
              kind="output"
            />
          </div>

          <section className={styles.chartSection} aria-label="Daily usage">
            <h2 className={styles.sectionTitle}>Daily</h2>
            <div className={styles.chart} role="img" aria-label="Daily usage chart">
              {/* ponytail: hand-rolled overlay SVG, no zoom/stack; reach for a chart lib if we need either */}
              <svg
                className={styles.chartSvg}
                viewBox="0 0 100 40"
                preserveAspectRatio="none"
                data-usage-chart=""
                aria-hidden="true"
              >
                {plotted.map((row) => {
                  const values = summary.days.map((day) => {
                    const cell = day.byProvider[row.provider];
                    return cell ? metricValue(cell, metric) : 0;
                  });
                  const color = providerColor(row.provider);
                  return (
                    <g key={row.provider} data-usage-series={row.provider}>
                      <path d={areaPath(values, chartMax, 100, 40)} fill={color} opacity="0.22" />
                      <path
                        d={linePath(values, chartMax, 100, 40)}
                        fill="none"
                        stroke={color}
                        strokeWidth="1.25"
                        vectorEffect="non-scaling-stroke"
                        opacity="0.9"
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
                    return `${row.provider} ${formatMetric(value, metric)}`;
                  });
                  const label = bits.length > 0 ? `${day.day}: ${bits.join(", ")}` : day.day;
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
            {plotted.length > 0 && (
              <ul className={styles.legend} data-usage-legend="">
                {plotted.map((row) => (
                  <li key={row.provider} className={styles.legendItem}>
                    <span
                      className={styles.legendSwatch}
                      style={{ background: providerColor(row.provider) }}
                    />
                    {row.provider}
                  </li>
                ))}
              </ul>
            )}
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
                  <th>{group === "model" ? "Provider" : group === "thread" ? "Project" : ""}</th>
                  <th>Cost</th>
                  <th>Share</th>
                  <th>Tokens</th>
                  <th>Turns</th>
                  <th title="on runs that ended failed/stopped">Wasted</th>
                </tr>
              </thead>
              <tbody>
                {breakdownRows.length === 0 ? (
                  <tr data-usage-breakdown-empty={group}>
                    <td colSpan={7} className={styles.breakdownEmpty}>
                      {group === "project" || group === "thread"
                        ? "No per-thread usage recorded in this range. Attribution starts from the first run after this update — earlier turns were never stored per thread."
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
                      <td>{row.label}</td>
                      <td>{row.detail}</td>
                      <td>
                        {row.unreported ? (
                          <span className={styles.unreportedCell}>usage not reported</span>
                        ) : row.costUnmetered ? (
                          <span className={styles.unreportedCell}>unmetered</span>
                        ) : (
                          formatCostUsd(row.costUsd)
                        )}
                      </td>
                      <td>{row.unreported ? "—" : formatShare(share)}</td>
                      <td>
                        {row.unreported ? "—" : formatTokenSum(processedTokens(row))}
                      </td>
                      <td>{row.turns}</td>
                      <td data-usage-wasted="">
                        {row.unreported || !(row.wastedUsd > 0)
                          ? "—"
                          : formatCostUsd(row.wastedUsd)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  kind,
}: {
  label: string;
  value: string;
  kind: string;
}) {
  return (
    <div className={styles.stat} data-usage-stat={kind}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

function ProviderRow({
  row,
  metric,
}: {
  row: UsageProviderTotal;
  metric: UsageMetric;
}) {
  if (row.unreported) {
    return (
      <div
        className={styles.providerRowUnreported}
        data-usage-provider={row.provider}
        data-usage-unreported=""
      >
        <span className={styles.providerName}>{row.provider}</span>
        <span className={styles.unreportedMeta}>
          · {row.turns} turns · usage not reported
        </span>
      </div>
    );
  }
  if (row.costUnmetered && metric === "cost") {
    return (
      <div
        className={styles.providerRowUnreported}
        data-usage-provider={row.provider}
        data-usage-cost-unmetered=""
      >
        <span className={styles.providerName}>{row.provider}</span>
        <span className={styles.unreportedMeta}>
          · {row.turns} turns · unmetered
        </span>
      </div>
    );
  }
  const share = metric === "cost" ? row.costShare : row.tokenShare;
  const value = formatMetric(metricValue(row, metric), metric);
  const color = providerColor(row.provider);
  return (
    <div
      className={styles.providerRow}
      data-usage-provider={row.provider}
    >
      <span className={styles.providerName}>{row.provider}</span>
      <div className={styles.shareTrack}>
        <div
          className={styles.shareFill}
          style={{ width: `${barPercent(share, 1)}%`, background: color }}
        />
      </div>
      <span className={styles.providerValue}>{value}</span>
      <span className={styles.providerShare}>{formatShare(share)}</span>
      {row.cacheMultiplier != null && (
        <span className={styles.providerCache} data-usage-cache={row.provider}>
          {formatMultiplier(row.cacheMultiplier)} cache
        </span>
      )}
    </div>
  );
}
