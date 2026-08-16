import { useEffect, useState } from "react";
import type { TtlMissMetrics } from "../../shared/sessionSchemas.ts";
import { getCacheMissOverview } from "../api.ts";
import { currency, decimal, integer } from "./formatters.ts";
import "./CacheOverview.css";

type CacheOverviewProps = {
  range: 30 | 90;
  harness: string;
  onDataChange?: (data: TtlMissMetrics | undefined) => void;
};

type CauseRow = {
  label: string;
  cost: number;
  misses: number;
  sessions: number;
  depth?: 1 | 2;
};

function share(value: number, total: number) {
  return total === 0 ? "0%" : `${decimal.format(value / total * 100)}%`;
}

function CacheSummary({ metrics }: { metrics: TtlMissMetrics }) {
  return (
    <div className="cache-summary-grid">
      <div className="cache-summary-metric">
        <span>Cost</span>
        <strong>{currency.format(metrics.combined.attributedCost)}</strong>
      </div>
      <div className="cache-summary-metric">
        <span>Misses</span>
        <strong>{integer.format(metrics.combined.misses)}</strong>
      </div>
      <div className="cache-summary-metric">
        <span>Affected sessions</span>
        <strong>
          {share(metrics.combined.affectedSessions, metrics.sessions)}
        </strong>
      </div>
      <div className="cache-summary-metric">
        <span>Misses / session</span>
        <strong>
          {metrics.combined.affectedSessions === 0 ? "0" : decimal.format(
            metrics.combined.misses / metrics.combined.affectedSessions,
          )}
        </strong>
      </div>
    </div>
  );
}

function CauseRows({ rows }: { rows: CauseRow[] }) {
  return rows.filter((row) => row.misses > 0).map((row) => (
    <tr
      className={row.depth === undefined
        ? undefined
        : `cache-cause-child cache-cause-depth-${row.depth}`}
      key={row.label}
    >
      <th scope="row">{row.label}</th>
      <td>{currency.format(row.cost)}</td>
      <td>{integer.format(row.misses)}</td>
      <td>{integer.format(row.sessions)}</td>
    </tr>
  ));
}

function ScopeRow({
  expanded,
  label,
  cost,
  misses,
  sessions,
  onToggle,
}: {
  expanded: boolean;
  label: string;
  cost: number;
  misses: number;
  sessions: number;
  onToggle: () => void;
}) {
  return (
    <tr className="cache-scope-row">
      <th scope="row">
        <button type="button" aria-expanded={expanded} onClick={onToggle}>
          <span aria-hidden="true">{expanded ? "▾" : "›"}</span>
          {label}
        </button>
      </th>
      <td>{currency.format(cost)}</td>
      <td>{integer.format(misses)}</td>
      <td>{integer.format(sessions)}</td>
    </tr>
  );
}

function CacheMissTable({ metrics }: { metrics: TtlMissMetrics }) {
  const [rootExpanded, setRootExpanded] = useState(true);
  const [subagentsExpanded, setSubagentsExpanded] = useState(false);
  const { cacheMisses, misses, subagents } = metrics;
  const rootMisses = cacheMisses.full.misses + cacheMisses.partial.misses;
  const rootCost = cacheMisses.full.attributedCost +
    cacheMisses.partial.attributedCost;
  const rootRows: CauseRow[] = [
    {
      label: "TTL",
      cost: misses.attributedCost,
      misses: misses.total,
      sessions: metrics.affectedSessions,
      depth: 1,
    },
    {
      label: "<30 min",
      cost: misses.underThirtyMinutesCost,
      misses: misses.underThirtyMinutes,
      sessions: misses.underThirtyMinutesSessions,
      depth: 2,
    },
    {
      label: "30 min–2 hr",
      cost: misses.thirtyMinutesToTwoHoursCost,
      misses: misses.thirtyMinutesToTwoHours,
      sessions: misses.thirtyMinutesToTwoHoursSessions,
      depth: 2,
    },
    {
      label: "2–8 hr",
      cost: misses.twoToEightHoursCost,
      misses: misses.twoToEightHours,
      sessions: misses.twoToEightHoursSessions,
      depth: 2,
    },
    {
      label: "8+ hr",
      cost: misses.eightHoursOrMoreCost,
      misses: misses.eightHoursOrMore,
      sessions: misses.eightHoursOrMoreSessions,
      depth: 2,
    },
    {
      label: "Thinking change",
      cost: cacheMisses.thinkingChange.attributedCost,
      misses: cacheMisses.thinkingChange.misses,
      sessions: cacheMisses.thinkingChange.affectedSessions,
      depth: 1,
    },
    {
      label: "Compaction",
      cost: cacheMisses.compaction.attributedCost,
      misses: cacheMisses.compaction.misses,
      sessions: cacheMisses.compaction.affectedSessions,
      depth: 1,
    },
    {
      label: "Model change",
      cost: cacheMisses.modelChange.attributedCost,
      misses: cacheMisses.modelChange.misses,
      sessions: cacheMisses.modelChange.affectedSessions,
      depth: 1,
    },
    {
      label: "Unexpected full",
      cost: cacheMisses.unexpected.full.attributedCost,
      misses: cacheMisses.unexpected.full.misses,
      sessions: cacheMisses.unexpected.full.affectedSessions,
      depth: 1,
    },
    {
      label: "Unexpected partial",
      cost: cacheMisses.unexpected.partial.attributedCost,
      misses: cacheMisses.unexpected.partial.misses,
      sessions: cacheMisses.unexpected.partial.affectedSessions,
      depth: 1,
    },
  ];
  const subagentRows: CauseRow[] = [
    {
      label: "TTL",
      cost: subagents.ttl.attributedCost,
      misses: subagents.ttl.misses,
      sessions: subagents.ttl.affectedSessions,
      depth: 1,
    },
    {
      label: "Thinking change",
      cost: subagents.thinkingChange.attributedCost,
      misses: subagents.thinkingChange.misses,
      sessions: subagents.thinkingChange.affectedSessions,
      depth: 1,
    },
    {
      label: "Compaction",
      cost: subagents.compaction.attributedCost,
      misses: subagents.compaction.misses,
      sessions: subagents.compaction.affectedSessions,
      depth: 1,
    },
    {
      label: "Model change",
      cost: subagents.modelChange.attributedCost,
      misses: subagents.modelChange.misses,
      sessions: subagents.modelChange.affectedSessions,
      depth: 1,
    },
    {
      label: "Unexpected full",
      cost: subagents.unexpected.full.attributedCost,
      misses: subagents.unexpected.full.misses,
      sessions: subagents.unexpected.full.affectedSessions,
      depth: 1,
    },
    {
      label: "Unexpected partial",
      cost: subagents.unexpected.partial.attributedCost,
      misses: subagents.unexpected.partial.misses,
      sessions: subagents.unexpected.partial.affectedSessions,
      depth: 1,
    },
  ];

  return (
    <div className="cache-overview-table-wrap">
      <table className="cache-overview-table">
        <thead>
          <tr>
            <th scope="col">Scope / cause</th>
            <th scope="col">Cost</th>
            <th scope="col">Misses</th>
            <th scope="col">Sessions</th>
          </tr>
        </thead>
        <tbody>
          <ScopeRow
            expanded={rootExpanded}
            label="Root sessions"
            cost={rootCost}
            misses={rootMisses}
            sessions={cacheMisses.affectedSessions}
            onToggle={() => setRootExpanded((value) => !value)}
          />
          {rootExpanded && <CauseRows rows={rootRows} />}
        </tbody>
        {subagents.misses > 0 && (
          <tbody className="cache-subagent-rows">
            <ScopeRow
              expanded={subagentsExpanded}
              label="Subagents"
              cost={subagents.attributedCost}
              misses={subagents.misses}
              sessions={subagents.affectedSessions}
              onToggle={() => setSubagentsExpanded((value) => !value)}
            />
            {subagentsExpanded && <CauseRows rows={subagentRows} />}
          </tbody>
        )}
      </table>
    </div>
  );
}

export function CacheOverview({
  range,
  harness,
  onDataChange,
}: CacheOverviewProps) {
  const [metrics, setMetrics] = useState<TtlMissMetrics>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setMetrics(undefined);
    setError(undefined);
    onDataChange?.(undefined);
    getCacheMissOverview(range, harness).then((result) => {
      if (active) {
        setMetrics(result);
        onDataChange?.(result);
      }
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load cache metrics",
        );
        onDataChange?.(undefined);
      }
    });
    return () => {
      active = false;
    };
  }, [range, harness]);

  return (
    <section
      className="new-placeholder-section cache-overview-section"
      aria-labelledby="cache-section-title"
    >
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
        : error
        ? <p className="cache-overview-message error">{error}</p>
        : (
          <div
            className="cache-overview-loading"
            role="status"
            aria-label="Loading cache misses"
          >
            <div className="cache-loading-summary" aria-hidden="true">
              {Array.from(
                { length: 4 },
                (_, index) => (
                  <span className="dashboard-loading-bar" key={index} />
                ),
              )}
            </div>
            <div className="cache-loading-table" aria-hidden="true">
              {Array.from(
                { length: 8 },
                (_, index) => (
                  <span className="dashboard-loading-bar" key={index} />
                ),
              )}
            </div>
          </div>
        )}
    </section>
  );
}
