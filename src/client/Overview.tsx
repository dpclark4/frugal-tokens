import type { OverviewResponse } from "../shared/sessionSchemas.ts";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

type Distribution = NonNullable<
  OverviewResponse["sessionProfile"]["turns"]
>;

function percent(value?: number) {
  return value === undefined ? "-" : `${decimal.format(value * 100)}%`;
}

function duration(value: number) {
  const minutes = value / 60_000;
  if (minutes < 1) return `${integer.format(value / 1_000)} sec`;
  if (minutes < 60) return `${decimal.format(minutes)} min`;
  return `${decimal.format(minutes / 60)} hr`;
}

function days(value: number) {
  const formatted = decimal.format(value);
  return `${formatted} ${formatted === decimal.format(1) ? "day" : "days"}`;
}

function MetricRow({
  label,
  values,
  format = decimal.format,
  tooltip,
}: {
  label: string;
  values?: Distribution;
  format?: (value: number) => string;
  tooltip?: string;
}) {
  const value = (number: number) => (
    <>
      {format(number)}
    </>
  );
  return (
    <tr>
      <th scope="row" title={tooltip}>{label}</th>
      <td>{values ? value(values.median) : "-"}</td>
      <td>{values ? value(values.average) : "-"}</td>
      <td>{values ? value(values.p90) : "-"}</td>
    </tr>
  );
}

export function CompactOverview({
  data,
  error,
}: {
  data?: OverviewResponse;
  error?: string;
}) {
  if (error) return <div className="ttl-miss-message chart-error">{error}</div>;
  if (!data) return <div className="ttl-miss-message">Loading overview...</div>;
  const knownSpend = data.models.reduce((sum, model) => sum + model.spend, 0);
  return (
    <div className="compact-overview">
      <div className="compact-overview-summary">
        <div
          title={`${integer.format(data.activeDays)} of ${integer.format(data.rangeDays)} selected days had activity; ${
            integer.format(data.activeWeekdays)
          } weekdays, ${integer.format(data.weekendDays)} weekend days`}
        >
          <strong>{integer.format(data.activeDays)}</strong>
          <span>Active days</span>
        </div>
        <div>
          <strong>{integer.format(data.sessions)}</strong>
          <span>Sessions</span>
        </div>
        <div>
          <strong>{currency.format(knownSpend)}</strong>
          <span>Spend</span>
        </div>
        <div title="Overall cache reuse across all included model calls (token-weighted)">
          <strong>{percent(data.sessionProfile.overallEfficiency)}</strong>
          <span>Overall token reuse</span>
        </div>
        <div
          title={`${integer.format(data.multiDaySessions)} of ${integer.format(data.sessions)} sessions`}
        >
          <strong>{percent(data.multiDaySessionRate)}</strong>
          <span>Multi-day sessions</span>
        </div>
      </div>
      <div className="compact-overview-table">
        <table className="overview-table">
          <thead>
            <tr>
              <th>Activity per active day</th>
              <th>Median</th>
              <th>Average</th>
              <th>P90</th>
            </tr>
          </thead>
          <tbody>
            <MetricRow label="Sessions" values={data.activity.sessions} />
            <MetricRow
              label="Peak concurrent sessions"
              values={data.activity.peakConcurrentSessions}
              tooltip={`Distribution of each active day's peak root sessions executing or within ${data.rotationInactivityMinutes} minutes of a recorded turn, bounded by each session's observed activity`}
            />
            <MetricRow label="Turns" values={data.activity.turns} />
            <MetricRow
              label="Spend"
              values={data.activity.spend}
              format={currency.format}
            />
            <tr className="compact-metric-group">
              <th colSpan={4}>Session profile</th>
            </tr>
            <MetricRow
              label="Active dates / session"
              values={data.sessionProfile.activeSpan}
              format={days}
              tooltip="Distinct calendar dates with activity per session"
            />
            <MetricRow
              label="Turns / session"
              values={data.sessionProfile.turns}
            />
            <MetricRow
              label="Input processed"
              values={data.sessionProfile.input}
              format={compact.format}
            />
            <MetricRow
              label="Peak context"
              values={data.sessionProfile.peakContext}
              format={compact.format}
            />
            <MetricRow
              label="Session duration"
              values={data.sessionProfile.elapsed}
              format={duration}
              tooltip="First turn to final model call"
            />
            <MetricRow
              label="Spend / session"
              values={data.sessionProfile.spend}
              format={currency.format}
            />
            <MetricRow
              label="Token reuse / session"
              values={data.sessionProfile.efficiency}
              format={percent}
              tooltip="Cache reuse calculated per session; P50, average, and P90 summarize those session-level percentages"
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}
