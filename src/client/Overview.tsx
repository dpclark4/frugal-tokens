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

function modelName(model: string) {
  if (model === "Other") return model;
  return model.replace(/[-_]20\d{6}$/, "").split(/[-_]/).map((part) => {
    if (part.toLowerCase() === "gpt") return "GPT";
    return part.length === 0 ? part : part[0].toUpperCase() + part.slice(1);
  }).join(" ");
}

function MetricRow({
  label,
  values,
  format = decimal.format,
  partial = false,
  tooltip,
}: {
  label: string;
  values?: Distribution;
  format?: (value: number) => string;
  partial?: boolean;
  tooltip?: string;
}) {
  const value = (number: number) => (
    <>
      {partial && <sup title="Known priced spend only">*</sup>}
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
  const hasUnpricedSpend = data.models.some((model) => model.hasUnpricedCost);
  return (
    <div className="compact-overview">
      <div className="compact-overview-summary">
        <div
          title={`${integer.format(data.activeWeekdays)} weekdays, ${
            integer.format(data.weekendDays)
          } weekend days`}
        >
          <strong>{integer.format(data.activeDays)}</strong>
          <span>Active days</span>
        </div>
        <div>
          <strong>{integer.format(data.sessions)}</strong>
          <span>Sessions</span>
        </div>
        <div title="Spend using known model prices">
          <strong>
            {hasUnpricedSpend && <sup>*</sup>}
            {currency.format(knownSpend)}
          </strong>
          <span>Priced spend</span>
        </div>
        <div title="Token-weighted efficiency">
          <strong>{percent(data.sessionProfile.overallEfficiency)}</strong>
          <span>Token reuse</span>
        </div>
        <div title={`${integer.format(data.multiDaySessions)} sessions`}>
          <strong>{percent(data.multiDaySessionRate)}</strong>
          <span>Multi-day</span>
        </div>
        <div title="Average distinct active dates per session">
          <strong>{days(data.averageActiveSpan)}</strong>
          <span>Days / session</span>
        </div>
      </div>
      <div className="compact-overview-table">
        <table className="overview-table">
          <thead>
            <tr>
              <th>Activity per active day</th>
              <th>P50</th>
              <th>Avg</th>
              <th>P90</th>
            </tr>
          </thead>
          <tbody>
            <MetricRow label="Sessions" values={data.activity.sessions} />
            <MetricRow
              label="Peak concurrent sessions"
              values={data.activity.peakConcurrentSessions}
              tooltip={`Distribution of each active day's peak root sessions executing or within ${data.rotationInactivityMinutes} minutes after recorded completion`}
            />
            <MetricRow label="Turns" values={data.activity.turns} />
            <MetricRow
              label="Spend"
              values={data.activity.spend}
              format={currency.format}
              partial={data.activity.hasUnpricedCost}
            />
            <tr className="compact-metric-group">
              <th colSpan={4}>Session profile</th>
            </tr>
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
              partial={data.sessionProfile.hasUnpricedCost}
            />
            <MetricRow
              label="Efficiency"
              values={data.sessionProfile.efficiency}
              format={percent}
            />
          </tbody>
        </table>
      </div>
      {data.models.length > 0 && (
        <div className="compact-models">
          <div className="compact-model-heading">
            <h3>Top models by spend</h3>
            <small>Share</small>
            <strong>Spend</strong>
          </div>
          <div className="compact-model-list">
            {data.models.map((model) => (
              <div
                className="compact-model-row"
                key={`${model.model}:${model.isOther}`}
              >
                <span title={model.model}>{modelName(model.model)}</span>
                <i>
                  <b style={{ width: `${model.spendShare * 100}%` }} />
                </i>
                <small>{percent(model.spendShare)}</small>
                <strong>
                  {model.hasUnpricedCost && <sup>*</sup>}
                  {currency.format(model.spend)}
                </strong>
              </div>
            ))}
          </div>
        </div>
      )}
      {(data.activity.hasUnpricedCost || data.subagentCoverage !== "full") && (
        <p className="compact-overview-note">
          {data.activity.hasUnpricedCost &&
            "* Spend and share use known prices"}
          {data.activity.hasUnpricedCost && data.subagentCoverage !== "full" &&
            " · "}
          {data.subagentCoverage === "partial" && "Partial subagent coverage"}
          {data.subagentCoverage === "none" && "No subagent coverage"}
        </p>
      )}
    </div>
  );
}
