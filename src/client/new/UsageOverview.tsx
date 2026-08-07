import type { ActivityOverviewResponse } from "../../shared/sessionSchemas.ts";
import {
  compact,
  currency,
  decimal,
  integer,
  oneDecimal,
} from "./formatters.ts";
import "./UsageOverview.css";

type MetricProps = {
  label: string;
  value: string;
  secondary: string;
  tier: "primary" | "secondary";
};

function Metric({ label, value, secondary, tier }: MetricProps) {
  return (
    <div className={`usage-metric usage-metric-${tier}`}>
      <span className="usage-metric-label">{label}</span>
      <strong>{value}</strong>
      <small>{secondary}</small>
    </div>
  );
}

// TODO: Replace these temporary values with a preceding-period query.
const mockComparisons = {
  spend: "+18% vs prior 30d",
  processedInput: "+21% vs prior 30d",
  tokenReuse: "+0.4 pp vs prior 30d",
};

function share(value: number, total: number) {
  return total === 0 ? "0.0%" : `${decimal.format(value / total * 100)}%`;
}

export function UsageOverview({ data }: { data?: ActivityOverviewResponse }) {
  const summary = data?.summary;
  const costPerMillion = summary && summary.processedInput > 0
    ? summary.spend / (summary.processedInput / 1_000_000)
    : undefined;
  const sessionsPerActiveDay = summary && summary.activeDays > 0
    ? summary.sessions / summary.activeDays
    : undefined;
  const comparisons = data?.rangeDays === 30;
  const loading = data ? "—" : "Loading…";

  return (
    <section className="signal-summary" aria-labelledby="signal-summary-title">
      <header className="usage-overview-header">
        <h2 id="signal-summary-title">Usage overview</h2>
      </header>
      <div className="usage-metric-grid">
        <Metric
          label="Priced spend"
          value={summary ? currency.format(summary.spend) : "—"}
          secondary={comparisons ? mockComparisons.spend : loading}
          tier="primary"
        />
        <Metric
          label="Sessions"
          value={summary ? integer.format(summary.sessions) : "—"}
          secondary={summary && sessionsPerActiveDay !== undefined
            ? `${integer.format(summary.activeDays)} days · ${
              oneDecimal.format(sessionsPerActiveDay)
            }/day`
            : loading}
          tier="primary"
        />
        <Metric
          label="Processed input"
          value={summary ? compact.format(summary.processedInput) : "—"}
          secondary={comparisons ? mockComparisons.processedInput : loading}
          tier="primary"
        />
        <Metric
          label="Token reuse"
          value={summary?.tokenReuse === undefined
            ? "—"
            : `${decimal.format(summary.tokenReuse * 100)}%`}
          secondary={comparisons ? mockComparisons.tokenReuse : loading}
          tier="primary"
        />
        <Metric
          label="Cost / 1M processed"
          value={costPerMillion === undefined
            ? "—"
            : currency.format(costPerMillion)}
          secondary={data ? "based on priced spend" : "Loading…"}
          tier="secondary"
        />
        <Metric
          label="Cache-miss cost"
          value={summary ? currency.format(summary.spendAtMissCalls) : "—"}
          secondary={summary
            ? `${
              share(summary.spendAtMissCalls, summary.spend)
            } of priced spend`
            : "Loading…"}
          tier="secondary"
        />
        <Metric
          label="Subagent spend"
          value={summary ? currency.format(summary.subagentSpend) : "—"}
          secondary={summary
            ? `${share(summary.subagentSpend, summary.spend)} of priced spend`
            : "Loading…"}
          tier="secondary"
        />
        <Metric
          label="Top 10% of sessions"
          value={summary
            ? `${decimal.format(summary.topDecileSpendShare * 100)}%`
            : "—"}
          secondary={data ? "of priced spend" : "Loading…"}
          tier="secondary"
        />
      </div>
    </section>
  );
}
