import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCostUsd, formatElapsed } from "../format";
import {
  FLEET_RANGES,
  summarizeFleet,
  type FleetOutcome,
  type FleetPerception,
  type FleetProviderRow,
  type FleetSummary,
  type FleetThreadRow,
} from "../fleet";
import type { FleetEvidence } from "../shared/ipc";
import styles from "./FleetView.module.css";

export interface FleetViewProps {
  loadEvidence: () => Promise<FleetEvidence>;
}

const EMPTY_EVIDENCE: FleetEvidence = {
  collectedAt: 0,
  durabilityWindowDays: 14,
  threads: [],
  prs: [],
  notes: [],
};

const MISSING = "—";
const NOT_ENOUGH_HISTORY = "not enough history";
const NO_REVIEW_TAX = "no reviewed PRs to compare";

// ponytail: formatElapsed is (from, now); a duration is elapsed from epoch 0.
function formatSpan(ms: number): string {
  return formatElapsed(0, Math.max(0, ms));
}

function formatRate(share: number): string {
  if (!Number.isFinite(share)) return MISSING;
  return `${Math.round(share * 100)}%`;
}

function formatCostOrMissing(value: number | null): string {
  return value == null ? MISSING : formatCostUsd(value);
}

function formatShareOrHistory(share: number | null): string {
  return share == null ? NOT_ENOUGH_HISTORY : formatRate(share);
}

function formatLines(value: number | null): string {
  return value == null ? MISSING : String(value);
}

export function reviewTaxCopy(tax: number | null): string {
  if (tax == null || !Number.isFinite(tax)) return NO_REVIEW_TAX;
  if (tax > 1) return `agent PRs wait ${tax.toFixed(1)}× longer than human PRs`;
  if (tax < 1) {
    if (tax <= 0) return "agent PRs are reviewed faster";
    return `agent PRs are reviewed ${(1 / tax).toFixed(1)}× faster than human PRs`;
  }
  return "agent PRs are reviewed as quickly as human PRs";
}

// The card is opt-in, so the empty state must name the switch: otherwise it
// points at a card the user has never been shown.
const NO_ESTIMATES =
  "no estimates yet — turn on the time-saved card in Settings → General, then answer it when a thread finishes";

/**
 * Felt-vs-actual copy (issue #401). Neutral on purpose: the counterfactual
 * ("how long would this have taken me") is unknowable, so the surface shows
 * the felt sum against the measured clock and lets the ratio speak.
 */
export function perceptionHeadline(p: FleetPerception): string {
  if (p.estimates <= 0) return NO_ESTIMATES;
  const threads = p.estimates === 1 ? "1 thread" : `${p.estimates} threads`;
  return `you felt ~${formatSpan(p.feltSavedMs)} saved across ${threads}; they took ${formatSpan(p.wallClockMs)} wall-clock`;
}

export function perceptionRatioCopy(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return MISSING;
  return `felt ÷ wall-clock ${ratio.toFixed(1)}×`;
}

function FleetNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <aside className={styles.notes} data-fleet-notes="" role="note">
      <p className={styles.notesTitle}>Partial collection</p>
      <ul className={styles.notesList}>
        {notes.map((note, i) => (
          <li key={`${i}:${note}`}>{note}</li>
        ))}
      </ul>
    </aside>
  );
}

function OutcomeBadge({
  outcome,
  url,
}: {
  outcome: FleetOutcome;
  url: string | null;
}) {
  const className = [
    styles.badge,
    outcome === "merged"
      ? styles.badgeMerged
      : outcome === "closed"
        ? styles.badgeClosed
        : outcome === "open"
          ? styles.badgeOpen
          : styles.badgeNone,
  ].join(" ");
  const badge = (
    <span className={className} data-fleet-outcome={outcome}>
      {outcome}
    </span>
  );
  if (!url) return badge;
  return (
    <a href={url} className={styles.prLink} target="_blank" rel="noreferrer">
      {badge}
    </a>
  );
}

function ProviderRow({ row }: { row: FleetProviderRow }) {
  return (
    <tr data-fleet-provider={row.provider}>
      <th scope="row">{row.provider}</th>
      <td className={styles.num}>{row.threads}</td>
      <td
        className={styles.num}
        data-fleet-cost-unmetered={row.costUnmetered ? "" : undefined}
      >
        {row.costUnmetered ? "unmetered" : formatCostUsd(row.costUsd)}
      </td>
      <td className={styles.num}>{formatRate(row.mergeRate)}</td>
      <td className={styles.num}>{formatRate(row.closeWithoutMergeRate)}</td>
      <td className={styles.num} data-cost-per-merged="">
        {formatCostOrMissing(row.costPerMergedPrUsd)}
      </td>
      <td className={styles.num} data-durable="">
        {formatShareOrHistory(row.durableShare)}
      </td>
      <td className={styles.num} data-rework="">
        {formatShareOrHistory(row.reworkShare)}
      </td>
      <td className={styles.num}>
        {row.reviewLatencyMs == null ? MISSING : formatSpan(row.reviewLatencyMs)}
      </td>
      <td className={styles.num}>
        {formatSpan(row.activeMs)} / {formatSpan(row.wallClockMs)}
      </td>
    </tr>
  );
}

function ThreadRow({ row }: { row: FleetThreadRow }) {
  return (
    <tr data-fleet-thread={row.threadId}>
      <th scope="row">{row.title}</th>
      <td>{row.provider}</td>
      <td
        className={styles.num}
        data-fleet-cost-unmetered={row.costUnmetered ? "" : undefined}
      >
        {row.costUnmetered ? "unmetered" : formatCostUsd(row.costUsd)}
      </td>
      <td className={styles.num}>
        {formatSpan(row.activeMs)} / {formatSpan(row.wallClockMs)}
      </td>
      <td className={styles.num} data-felt-saved="">
        {row.feltSavedMs == null ? MISSING : `~${formatSpan(row.feltSavedMs)}`}
      </td>
      <td className={styles.num}>{formatLines(row.linesAdded)}</td>
      <td className={styles.num} data-durable="">
        {formatShareOrHistory(row.durableShare)}
      </td>
      <td>
        <OutcomeBadge outcome={row.outcome} url={row.prUrl} />
      </td>
    </tr>
  );
}

export function FleetReport({ summary }: { summary: FleetSummary }) {
  const agentMs = summary.totals.reviewLatencyMs;
  const humanMs = summary.humanReviewLatencyMs;
  return (
    <div className={styles.body} data-fleet-report="">
      <section className={styles.tax} data-fleet-review-tax="">
        <h2 className={styles.sectionTitle}>Review tax</h2>
        <p className={styles.taxHeadline}>{reviewTaxCopy(summary.reviewTax)}</p>
        {summary.reviewTax != null && (agentMs != null || humanMs != null) ? (
          <p className={styles.taxMeta}>
            {agentMs != null
              ? `agent PRs ${formatSpan(agentMs)} median`
              : "agent PRs have no reviews"}
            {" · "}
            {humanMs != null
              ? `human PRs ${formatSpan(humanMs)} median`
              : "human PRs have no reviews"}
          </p>
        ) : null}
      </section>

      <FleetNotes notes={summary.notes} />

      <section className={styles.tax} data-fleet-perception="">
        <h2 className={styles.sectionTitle}>Felt vs actual</h2>
        <p className={styles.taxHeadline} data-felt-headline="">
          {perceptionHeadline(summary.perception)}
        </p>
        {summary.perception.estimates > 0 ? (
          <p className={styles.taxMeta}>
            <span data-felt-vs-wall="">
              {perceptionRatioCopy(summary.perception.feltVsWall)}
            </span>
            {" · "}
            <span data-felt-active="">
              agent-active {formatSpan(summary.perception.activeMs)}
            </span>
          </p>
        ) : null}
      </section>

      <section className={styles.section} aria-label="Providers">
        <h2 className={styles.sectionTitle}>Providers</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Threads</th>
                <th scope="col">Cost</th>
                <th scope="col">Merge</th>
                <th scope="col">Closed</th>
                <th scope="col">Cost / merged</th>
                <th scope="col">Durable</th>
                <th scope="col">Rework</th>
                <th scope="col">Review</th>
                <th scope="col">Active / wall</th>
              </tr>
            </thead>
            <tbody>
              {summary.providers.map((row) => (
                <ProviderRow key={row.provider} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.section} aria-label="Threads">
        <h2 className={styles.sectionTitle}>Threads</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Provider</th>
                <th scope="col">Cost</th>
                <th scope="col">Active / wall</th>
                <th scope="col">Felt</th>
                <th scope="col">Lines added</th>
                <th scope="col">Durable</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {summary.threads.map((row) => (
                <ThreadRow key={row.threadId} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function FleetView({ loadEvidence }: FleetViewProps) {
  const [evidence, setEvidence] = useState<FleetEvidence>(EMPTY_EVIDENCE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<(typeof FLEET_RANGES)[number]>(7);
  const [now, setNow] = useState(() => Date.now());
  const loadGen = useRef(0);

  const loadAll = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadEvidence();
      if (gen !== loadGen.current) return;
      setEvidence(
        next && typeof next === "object" && !Array.isArray(next)
          ? next
          : EMPTY_EVIDENCE,
      );
      setNow(Date.now());
    } catch (err) {
      if (gen !== loadGen.current) return;
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to load fleet evidence";
      setError(msg);
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [loadEvidence]);

  useEffect(() => {
    void loadAll();
    return () => {
      loadGen.current += 1;
    };
  }, [loadAll]);

  const summary = useMemo(
    () => summarizeFleet(evidence, range, now),
    [evidence, range, now],
  );
  const empty =
    !loading &&
    !error &&
    summary.providers.length === 0 &&
    summary.threads.length === 0;

  return (
    <main className={styles.main} data-fleet="" data-range={range}>
      <header className={styles.header}>
        <h1 className={styles.title}>Fleet</h1>
        <div className={styles.controls}>
          <div className={styles.segment} role="group" aria-label="Range">
            {FLEET_RANGES.map((item) => (
              <button
                key={item}
                type="button"
                className={styles.segBtn}
                aria-pressed={range === item}
                data-fleet-range={item}
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
            title="Refresh"
          >
            Refresh
          </button>
        </div>
      </header>

      {loading && summary.providers.length === 0 && summary.threads.length === 0 && !error ? (
        <p className={styles.hint} aria-live="polite" data-fleet-loading="">
          Loading fleet…
        </p>
      ) : empty ? (
        <div className={styles.empty} data-fleet-empty="">
          <FleetNotes notes={summary.notes} />
          <p className={styles.emptyTitle}>No fleet data in this range</p>
          <p className={styles.emptyHint}>
            Merge rate, review tax, and cost per merged PR show up here once
            threads and pull requests land.
          </p>
        </div>
      ) : error &&
        summary.providers.length === 0 &&
        summary.threads.length === 0 ? (
        <div className={styles.empty} data-fleet-error="">
          <p className={styles.emptyTitle}>Could not load fleet</p>
          <p className={styles.emptyHint} role="alert">
            {error}
          </p>
        </div>
      ) : (
        <FleetReport summary={summary} />
      )}
    </main>
  );
}
