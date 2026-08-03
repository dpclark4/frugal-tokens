import type { ActivityOverviewResponse } from "../../shared/sessionSchemas.ts";
import { compact, currency, decimal, integer, oneDecimal } from "./formatters.ts";
import "./UsageOverview.css";

type SummaryMetricProps = {
  label: string;
  value: string;
  detail?: string;
  comparison?: string;
  emphasis?: "signal";
};

function SummaryMetric({
  label,
  value,
  detail,
  comparison,
  emphasis,
}: SummaryMetricProps) {
  return (
    <div className={`summary-metric${emphasis ? ` ${emphasis}` : ""}`}>
      <span className="summary-metric-label">{label}</span>
      <strong>{value}</strong>
      {detail && <small className="summary-metric-detail">{detail}</small>}
      {comparison && (
        <small className="summary-metric-comparison">{comparison}</small>
      )}
    </div>
  );
}

function SummarySecondary({
  label,
  value,
  detail,
  valueTitle,
  info,
}: {
  label: string;
  value: string;
  detail: string;
  valueTitle?: string;
  info?: string;
}) {
  return (
    <div className="summary-secondary">
      <div className="summary-secondary-label">
        <span>{label}</span>
        {info && (
          <button
            type="button"
            className="summary-secondary-info"
            aria-label={`About ${label.toLowerCase()}`}
          >
            <span aria-hidden="true">i</span>
            <span className="summary-secondary-tooltip">{info}</span>
          </button>
        )}
      </div>
      <strong title={valueTitle}>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

// TODO: Replace these temporary UI values with a true preceding-period query
// and cache/subagent aggregates from the API.
const mockSummaryComparisons = {
  spend: "+18% vs previous 30d",
  sessions: "+12% vs previous 30d",
  processedInput: "+21% vs previous 30d",
  tokenReuse: "+0.4 pp vs previous 30d",
  spendCoverageComparable: true,
};

const mockSummarySecondary = {
  cacheMissSessions: 149,
  cacheMissShare: "61.1%",
  missCost: 21.79,
  subagentSpend: 24.18,
  subagentShare: "5.6% of priced spend",
};

export function UsageOverview({ data }: { data?: ActivityOverviewResponse }) {
  const costPerMillion = data && data.summary.processedInput > 0
    ? data.summary.spend / (data.summary.processedInput / 1_000_000)
    : undefined;
  const sessionsPerActiveDay = data && data.summary.activeDays > 0
    ? data.summary.sessions / data.summary.activeDays
    : undefined;
  const showComparisons = data?.rangeDays === 30;
  const spendDetail = !data
    ? "Loading…"
    : data.summary.hasUnpricedCost
    ? "excludes unpriced usage"
    : "all usage priced";
  const effectiveRate = costPerMillion === undefined
    ? "—"
    : `${currency.format(costPerMillion)} / 1M processed`;
  const effectiveRateDetail = data ? "based on priced spend" : "Loading…";
  const sessionDetail = !data
    ? "Loading…"
    : sessionsPerActiveDay === undefined
    ? "no active days"
    : `${integer.format(data.summary.activeDays)} active days · ${
      oneDecimal.format(sessionsPerActiveDay)
    }/day`;

  return (
    <section className="signal-summary" aria-labelledby="signal-summary-title">
      <div className="dashboard-section-heading summary-heading">
        <h2 id="signal-summary-title">Usage overview</h2>
      </div>
      <div className="summary-metrics">
        <SummaryMetric
          label="Priced spend"
          value={data ? currency.format(data.summary.spend) : "—"}
          detail={spendDetail}
          comparison={showComparisons &&
              mockSummaryComparisons.spendCoverageComparable
            ? mockSummaryComparisons.spend
            : undefined}
        />
        <SummaryMetric
          label="Sessions"
          value={data ? integer.format(data.summary.sessions) : "—"}
          detail={sessionDetail}
          comparison={showComparisons
            ? mockSummaryComparisons.sessions
            : undefined}
        />
        <SummaryMetric
          label="Processed input"
          value={data ? compact.format(data.summary.processedInput) : "—"}
          detail={data ? "across model calls" : "Loading…"}
          comparison={showComparisons
            ? mockSummaryComparisons.processedInput
            : undefined}
        />
        <SummaryMetric
          label="Token reuse"
          value={data?.summary.tokenReuse === undefined
            ? "—"
            : `${decimal.format(data.summary.tokenReuse * 100)}%`}
          detail={data ? "token-weighted" : "Loading…"}
          comparison={showComparisons
            ? mockSummaryComparisons.tokenReuse
            : undefined}
          emphasis="signal"
        />
      </div>
      <div className="summary-secondary-row">
        <SummarySecondary
          label="Minimum effective rate"
          value={effectiveRate}
          detail={effectiveRateDetail}
          info="Priced spend divided by all processed input. This is a lower bound because some usage could not be priced."
        />
        <SummarySecondary
          label="Cache misses"
          value={`${
            integer.format(mockSummarySecondary.cacheMissSessions)
          } sessions · ${mockSummarySecondary.cacheMissShare}`}
          valueTitle="149 of 244 sessions had at least one classified cache miss. $21.79 is spend observed at miss calls, not necessarily avoidable cost."
          detail={`${
            currency.format(mockSummarySecondary.missCost)
          } at miss calls`}
        />
        <SummarySecondary
          label="Subagents"
          value={`${currency.format(mockSummarySecondary.subagentSpend)} spend`}
          detail={mockSummarySecondary.subagentShare}
        />
      </div>
    </section>
  );
}

