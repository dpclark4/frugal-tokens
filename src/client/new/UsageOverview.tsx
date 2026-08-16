import type { ActivityOverviewResponse } from "../../shared/sessionSchemas.ts";
import { compact, currency, decimal, integer } from "./formatters.ts";
import "./UsageOverview.css";

type MetricProps = {
  label: string;
  value: string;
  secondary?: string;
  tier: "primary" | "secondary";
};

function Metric({ label, value, secondary, tier }: MetricProps) {
  return (
    <div className={`usage-metric usage-metric-${tier}`}>
      <span className="usage-metric-label">{label}</span>
      <strong>{value}</strong>
      {secondary && <small>{secondary}</small>}
    </div>
  );
}

function share(value: number, total: number) {
  return total === 0 ? "0.0%" : `${decimal.format(value / total * 100)}%`;
}

export function UsageOverview({ data }: { data?: ActivityOverviewResponse }) {
  const summary = data?.summary;
  const costPerMillion = summary && summary.processedInput > 0
    ? summary.spend / (summary.processedInput / 1_000_000)
    : undefined;
  return (
    <section
      className={`signal-summary${data ? "" : " is-loading"}`}
      aria-labelledby="signal-summary-title"
      aria-busy={!data}
    >
      <header className="usage-overview-header">
        <h2 id="signal-summary-title">Usage</h2>
      </header>
      <div className="usage-metric-grid">
        <Metric
          label="Priced spend"
          value={summary ? currency.format(summary.spend) : "—"}
          tier="primary"
        />
        <Metric
          label="Sessions"
          value={summary ? integer.format(summary.sessions) : "—"}
          tier="primary"
        />
        <Metric
          label="Processed input"
          value={summary ? compact.format(summary.processedInput) : "—"}
          tier="primary"
        />
        <Metric
          label="Token reuse"
          value={summary?.tokenReuse === undefined
            ? "—"
            : `${decimal.format(summary.tokenReuse * 100)}%`}
          tier="primary"
        />
        <Metric
          label="Cost / 1M processed"
          value={costPerMillion === undefined
            ? "—"
            : currency.format(costPerMillion)}
          tier="secondary"
        />
        <Metric
          label="Cache-miss cost"
          value={summary ? currency.format(summary.spendAtMissCalls) : "—"}
          secondary={summary
            ? `${share(summary.spendAtMissCalls, summary.spend)} of spend`
            : "Loading…"}
          tier="secondary"
        />
        <Metric
          label="Subagent spend"
          value={summary ? currency.format(summary.subagentSpend) : "—"}
          secondary={summary
            ? `${share(summary.subagentSpend, summary.spend)} of spend`
            : "Loading…"}
          tier="secondary"
        />
        <Metric
          label="Spend from top 10% of sessions"
          value={summary
            ? `${decimal.format(summary.topDecileSpendShare * 100)}%`
            : "—"}
          tier="secondary"
        />
      </div>
    </section>
  );
}
