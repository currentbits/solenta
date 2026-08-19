import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCostUsd, formatTokenSum } from "../format";
import type { UsageByDay, UsageReport } from "../shared/ipc";
import {
  USAGE_RANGES,
  summarizeUsage,
  type UsageRange,
} from "../usage";
import styles from "./UsageView.module.css";

export type UsageMetric = "cost" | "tokens";

export interface UsageViewProps {
  loadUsage: () => Promise<UsageReport>;
}

function metricValue(
  row: { costUsd: number; inputTokens: number; outputTokens: number },
  metric: UsageMetric,
): number {
  return metric === "cost" ? row.costUsd : row.inputTokens + row.outputTokens;
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

export function UsageView({ loadUsage }: UsageViewProps) {
  const [data, setData] = useState<UsageByDay>({});
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<UsageRange>(7);
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [now, setNow] = useState(() => Date.now());
  const loadGen = useRef(0);

  const loadAll = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
    try {
      const report = await loadUsage();
      if (gen !== loadGen.current) return;
      const next = report && typeof report === "object" ? report.byDay : null;
      setData(next && typeof next === "object" && !Array.isArray(next) ? next : {});
      setNow(Date.now());
    } catch {
      if (gen !== loadGen.current) return;
      setData({});
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
    () => summarizeUsage(data, range, new Date(now)),
    [data, range, now],
  );
  const empty = !loading && summary.providers.length === 0;

  const chartMax = useMemo(() => {
    let max = 0;
    for (const day of summary.days) {
      const value = metricValue(day, metric);
      if (value > max) max = value;
    }
    return max;
  }, [summary.days, metric]);

  const providers = useMemo(() => {
    return summary.providers.slice().sort((a, b) => {
      const diff = metricValue(b, metric) - metricValue(a, metric);
      return diff !== 0 ? diff : a.provider.localeCompare(b.provider);
    });
  }, [summary.providers, metric]);

  const models = useMemo(() => {
    return summary.models.slice().sort((a, b) => {
      const diff = metricValue(b, metric) - metricValue(a, metric);
      return diff !== 0 ? diff : a.model.localeCompare(b.model);
    });
  }, [summary.models, metric]);

  const totalLabel = formatMetric(metricValue(summary.totals, metric), metric);

  return (
    <main className={styles.main} data-usage="" data-range={range} data-metric={metric}>
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

      {loading && summary.providers.length === 0 && Object.keys(data).length === 0 ? (
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
            <p className={styles.totalMeta}>
              {formatCostUsd(summary.totals.costUsd)}
              {" · "}
              {formatTokenSum(summary.totals.inputTokens + summary.totals.outputTokens)}
              {" · "}
              {summary.totals.turns} turns
            </p>
          </section>

          <section className={styles.chartSection} aria-label="Daily usage">
            <h2 className={styles.sectionTitle}>Daily</h2>
            <div className={styles.chart} role="img" aria-label="Daily usage chart">
              {summary.days.map((day) => {
                const value = metricValue(day, metric);
                const label = `${day.day}: ${formatMetric(value, metric)}`;
                return (
                  <div
                    key={day.day}
                    className={styles.barCol}
                    data-usage-bar={day.day}
                    title={label}
                    aria-label={label}
                  >
                    <div
                      className={styles.bar}
                      style={{ height: `${barPercent(value, chartMax)}%` }}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          <section className={styles.providers} aria-label="Providers">
            <h2 className={styles.sectionTitle}>Providers</h2>
            {providers.map((row) => {
              const share = metric === "cost" ? row.costShare : row.tokenShare;
              const value = formatMetric(metricValue(row, metric), metric);
              return (
                <div
                  key={row.provider}
                  className={styles.providerRow}
                  data-usage-provider={row.provider}
                >
                  <span className={styles.providerName}>{row.provider}</span>
                  <div className={styles.shareTrack}>
                    <div
                      className={styles.shareFill}
                      style={{ width: `${barPercent(share, 1)}%` }}
                    />
                  </div>
                  <span className={styles.providerValue}>{value}</span>
                  <span className={styles.providerShare}>{formatShare(share)}</span>
                </div>
              );
            })}
          </section>

          <section className={styles.models} aria-label="Models">
            <h2 className={styles.sectionTitle}>Models</h2>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th>Cost</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Turns</th>
                </tr>
              </thead>
              <tbody>
                {models.map((row) => (
                  <tr
                    key={`${row.provider}\0${row.model}`}
                    data-usage-model={`${row.provider}/${row.model}`}
                  >
                    <td>{row.model}</td>
                    <td>{row.provider}</td>
                    <td>{formatCostUsd(row.costUsd)}</td>
                    <td>{formatTokenSum(row.inputTokens)}</td>
                    <td>{formatTokenSum(row.outputTokens)}</td>
                    <td>{row.turns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </main>
  );
}
