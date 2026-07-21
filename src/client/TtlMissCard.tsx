import { useEffect, useState } from "react";
import type {
  OverviewResponse,
  TtlMissMetrics,
} from "../shared/sessionSchemas.ts";
import { getTtlMissMetrics } from "./api.ts";
import { CompactOverview } from "./Overview.tsx";

const integer = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
type Range = 7 | 30 | 90 | "all";

function share(value: number, total: number) {
  return percent.format(total === 0 ? 0 : value / total);
}

function countLabel(value: number, singular: string, plural: string) {
  return `${integer.format(value)} ${value === 1 ? singular : plural}`;
}

function CacheMissOverview({ metrics }: { metrics: TtlMissMetrics }) {
  const { cacheMisses } = metrics;
  const totalMisses = cacheMisses.full.misses + cacheMisses.partial.misses;
  const attributedCost = cacheMisses.full.attributedCost +
    cacheMisses.partial.attributedCost;
  const unexpected = cacheMisses.unexpected;
  const unexpectedMisses = unexpected.full.misses + unexpected.partial.misses;
  const unexpectedCost = unexpected.full.attributedCost +
    unexpected.partial.attributedCost;
  const otherMisses = cacheMisses.compaction.misses + unexpectedMisses;
  const otherCost = cacheMisses.compaction.attributedCost + unexpectedCost;
  const rows = [
    { label: "Compaction", category: cacheMisses.compaction },
    { label: "Unexpected full", category: unexpected.full },
    { label: "Unexpected partial", category: unexpected.partial },
  ];

  return (
    <div className="cache-miss-overview">
      <div className="compact-overview-summary cache-miss-summary">
        <div>
          <strong>
            {integer.format(cacheMisses.affectedSessions)} ({
              share(cacheMisses.affectedSessions, metrics.sessions)
            })
          </strong>
          <span>Sessions with cache misses</span>
        </div>
        <div>
          <strong>{integer.format(totalMisses)}</strong>
          <span>Total cache misses</span>
        </div>
        <div>
          <strong>
            {money.format(cacheMisses.affectedSessionCost)} ({
              share(cacheMisses.affectedSessionCost, metrics.totalSessionCost)
            })
          </strong>
          <span>Spend in affected sessions</span>
        </div>
        <div>
          <strong>
            {money.format(attributedCost)} ({
              share(attributedCost, cacheMisses.affectedSessionCost)
            })
          </strong>
          <span>Cache-miss cost</span>
        </div>
      </div>

      <div className="cache-miss-details">
        <section className="cache-miss-section">
          <div className="cache-miss-section-heading">
            <h3>TTL misses</h3>
            <span>
              {countLabel(metrics.misses.total, "miss", "misses")} across{" "}
              {countLabel(metrics.affectedSessions, "session", "sessions")} ·{" "}
              {money.format(metrics.misses.attributedCost)}
            </span>
          </div>
          <div
            className="ttl-expiry-table"
            role="table"
            aria-label="TTL expiry misses by time since previous session"
          >
            <div className="ttl-expiry-header" role="row">
              <span role="columnheader">Time since previous session</span>
              <span role="columnheader">Misses</span>
              <span role="columnheader">Sessions</span>
              <span role="columnheader">Cost at miss</span>
            </div>
            {([
              [
                "< 2h",
                metrics.misses.underTwoHours,
                metrics.misses.underTwoHoursSessions,
                metrics.misses.underTwoHoursCost,
              ],
              [
                "2–8h",
                metrics.misses.twoToEightHours,
                metrics.misses.twoToEightHoursSessions,
                metrics.misses.twoToEightHoursCost,
              ],
              [
                "8h+",
                metrics.misses.eightHoursOrMore,
                metrics.misses.eightHoursOrMoreSessions,
                metrics.misses.eightHoursOrMoreCost,
              ],
            ] as const).map(([label, count, sessions, cost]) => (
              <div className="ttl-expiry-row" role="row" key={label}>
                <span role="cell">{label}</span>
                <span role="cell">{integer.format(count)}</span>
                <span role="cell">{integer.format(sessions)}</span>
                <span role="cell">{money.format(cost)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="cache-miss-section">
          <div className="cache-miss-section-heading">
            <h3>Other misses</h3>
            <span>
              {countLabel(otherMisses, "miss", "misses")} across{" "}
              {countLabel(
                cacheMisses.otherAffectedSessions,
                "session",
                "sessions",
              )} · {money.format(otherCost)}
            </span>
          </div>
          <div
            className="cache-miss-cost-table"
            role="table"
            aria-label="Other cache misses by cause"
          >
            <div className="cache-miss-cost-header" role="row">
              <span role="columnheader">Cause</span>
              <span role="columnheader">Misses</span>
              <span role="columnheader">Sessions</span>
              <span role="columnheader">Cost at miss</span>
            </div>
            {rows.map(({ label, category }) => (
              <div className="cache-miss-cost-row" role="row" key={label}>
                <span role="cell">{label}</span>
                <span role="cell">{integer.format(category.misses)}</span>
                <span role="cell">
                  {integer.format(category.affectedSessions)}
                </span>
                <span role="cell">{money.format(category.attributedCost)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export function TtlMissCard({
  harness,
  overview,
  overviewError,
  range,
}: {
  harness: string;
  overview?: OverviewResponse;
  overviewError?: string;
  range: Range;
}) {
  const [view, setView] = useState<"overview" | "cache">("overview");
  const [metrics, setMetrics] = useState<TtlMissMetrics>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setMetrics(undefined);
    setError(undefined);
    getTtlMissMetrics(range, harness).then((result) => {
      if (active) setMetrics(result);
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load cache miss metrics",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [harness, range]);

  return (
    <section className="ttl-miss-card" aria-label="Overview and cache misses">
      <div className="ttl-analytics-toolbar">
        <div
          className="chart-tabs"
          role="tablist"
          aria-label="Overview and cache miss view"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === "overview"}
            className={view === "overview" ? "active" : undefined}
            onClick={() => setView("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "cache"}
            className={view === "cache" ? "active" : undefined}
            onClick={() => setView("cache")}
          >
            Cache misses
          </button>
        </div>
      </div>
      {view === "overview" && (
        <CompactOverview data={overview} error={overviewError} />
      )}
      {view === "cache" && !metrics && !error && (
        <div className="ttl-miss-message">Analyzing cache misses...</div>
      )}
      {view === "cache" && error && (
        <div className="ttl-miss-message chart-error">{error}</div>
      )}
      {metrics && view === "cache" && <CacheMissOverview metrics={metrics} />}
    </section>
  );
}
