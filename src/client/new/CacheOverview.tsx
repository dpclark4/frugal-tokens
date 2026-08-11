import { useEffect, useState } from "react";
import type { TtlMissMetrics } from "../../shared/sessionSchemas.ts";
import { getCacheMissOverview } from "../api.ts";
import { currency, decimal, integer } from "./formatters.ts";
import "./CacheOverview.css";

type CacheOverviewProps = {
  range: 30 | 90;
  harness: string;
};

type CauseRow = {
  label: string;
  cost?: number;
  misses: number;
  sessions?: number;
  child?: boolean;
};

function share(value: number, total: number) {
  return total === 0 ? "0%" : `${decimal.format(value / total * 100)}%`;
}

function CacheSummary({ metrics }: { metrics: TtlMissMetrics }) {
  const { cacheMisses } = metrics;
  const cost = cacheMisses.full.attributedCost +
    cacheMisses.partial.attributedCost;
  const misses = cacheMisses.full.misses + cacheMisses.partial.misses;

  return (
    <div className="cache-summary-grid">
      <div className="cache-summary-metric">
        <span>Cost</span>
        <strong>{currency.format(cost)}</strong>
      </div>
      <div className="cache-summary-metric">
        <span>Misses</span>
        <strong>{integer.format(misses)}</strong>
      </div>
      <div className="cache-summary-metric">
        <span>Affected sessions</span>
        <strong>{share(cacheMisses.affectedSessions, metrics.sessions)}</strong>
      </div>
      <div className="cache-summary-metric">
        <span>Misses / session</span>
        <strong>
          {cacheMisses.affectedSessions === 0
            ? "0"
            : decimal.format(misses / cacheMisses.affectedSessions)}
        </strong>
      </div>
    </div>
  );
}

function CacheMissTable({ metrics }: { metrics: TtlMissMetrics }) {
  const { cacheMisses, misses } = metrics;
  const rows: CauseRow[] = [
    {
      label: "TTL",
      cost: misses.attributedCost,
      misses: misses.total,
      sessions: metrics.affectedSessions,
    },
    {
      label: "<30 min",
      cost: misses.underThirtyMinutesCost,
      misses: misses.underThirtyMinutes,
      sessions: misses.underThirtyMinutesSessions,
      child: true,
    },
    {
      label: "30 min–2 hr",
      cost: misses.thirtyMinutesToTwoHoursCost,
      misses: misses.thirtyMinutesToTwoHours,
      sessions: misses.thirtyMinutesToTwoHoursSessions,
      child: true,
    },
    {
      label: "2–8 hr",
      cost: misses.twoToEightHoursCost,
      misses: misses.twoToEightHours,
      sessions: misses.twoToEightHoursSessions,
      child: true,
    },
    {
      label: "8+ hr",
      cost: misses.eightHoursOrMoreCost,
      misses: misses.eightHoursOrMore,
      sessions: misses.eightHoursOrMoreSessions,
      child: true,
    },
    {
      label: "Thinking change",
      cost: cacheMisses.thinkingChange.attributedCost,
      misses: cacheMisses.thinkingChange.misses,
      sessions: cacheMisses.thinkingChange.affectedSessions,
    },
    {
      label: "Compaction",
      cost: cacheMisses.compaction.attributedCost,
      misses: cacheMisses.compaction.misses,
      sessions: cacheMisses.compaction.affectedSessions,
    },
    {
      label: "Model change",
      cost: cacheMisses.modelChange.attributedCost,
      misses: cacheMisses.modelChange.misses,
      sessions: cacheMisses.modelChange.affectedSessions,
    },
    {
      label: "Unexpected full",
      cost: cacheMisses.unexpected.full.attributedCost,
      misses: cacheMisses.unexpected.full.misses,
      sessions: cacheMisses.unexpected.full.affectedSessions,
    },
    {
      label: "Unexpected partial",
      cost: cacheMisses.unexpected.partial.attributedCost,
      misses: cacheMisses.unexpected.partial.misses,
      sessions: cacheMisses.unexpected.partial.affectedSessions,
    },
  ];

  const visibleRows = rows.filter((row) => row.misses > 0);

  return (
    <div className="cache-overview-table-wrap">
      <table className="cache-overview-table">
        <thead>
          <tr>
            <th scope="col">Cause</th>
            <th scope="col">Cost</th>
            <th scope="col">Misses</th>
            <th scope="col">Sessions</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row) => (
            <tr className={row.child ? "cache-cause-child" : undefined} key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.cost === undefined ? "" : currency.format(row.cost)}</td>
              <td>{integer.format(row.misses)}</td>
              <td>{row.sessions === undefined ? "" : integer.format(row.sessions)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CacheOverview({ range, harness }: CacheOverviewProps) {
  const [metrics, setMetrics] = useState<TtlMissMetrics>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setError(undefined);
    getCacheMissOverview(range, harness).then((result) => {
      if (active) setMetrics(result);
    }).catch((reason) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : "Unable to load cache metrics");
      }
    });
    return () => {
      active = false;
    };
  }, [range, harness]);

  return (
    <section className="new-placeholder-section cache-overview-section" aria-labelledby="cache-section-title">
      <header>
        <h2 id="cache-section-title">Cache misses</h2>
      </header>
      {metrics
        ? (
          <>
            <CacheSummary metrics={metrics} />
            <CacheMissTable metrics={metrics} />
          </>
        )
        : <p className={error ? "cache-overview-message error" : "cache-overview-message"}>{error ?? "Loading…"}</p>}
    </section>
  );
}
