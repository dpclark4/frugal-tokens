import type { ReactNode } from "react";
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

function modelName(model: string) {
  if (model === "Other") return model;
  return model.replace(/[-_]20\d{6}$/, "").split(/[-_]/).map((part) => {
    if (part.toLowerCase() === "gpt") return "GPT";
    return part.length === 0 ? part : part[0].toUpperCase() + part.slice(1);
  }).join(" ");
}

function MetricRow({
  label,
  description,
  values,
  format = decimal.format,
  partial = false,
  sectionStart = false,
}: {
  label: string;
  description?: string;
  values?: Distribution;
  format?: (value: number) => string;
  partial?: boolean;
  sectionStart?: boolean;
}) {
  const value = (number: number) => (
    <>
      {format(number)}
      {partial && <sup title="Known priced spend only">*</sup>}
    </>
  );
  return (
    <tr className={sectionStart ? "section-start" : undefined}>
      <th scope="row">
        {label}
        {description && <small>{description}</small>}
      </th>
      <td>{values ? value(values.median) : "-"}</td>
      <td>{values ? value(values.average) : "-"}</td>
      <td>{values ? value(values.p90) : "-"}</td>
    </tr>
  );
}

function MetricTable({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="overview-table-block">
      <h3>{title}</h3>
      <div className="overview-table-wrap">
        <table className="overview-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Median</th>
              <th>Average</th>
              <th>P90</th>
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

export function Overview({
  data,
  error,
}: {
  data?: OverviewResponse;
  error?: string;
}) {
  return (
    <section className="overview-panel">
      <div className="overview-heading">
        <div>
          <p className="eyebrow">Working profile</p>
          <h2>Overview</h2>
        </div>
        <span>Last 90 days</span>
      </div>
      {error && <div className="overview-message">{error}</div>}
      {!data && !error && (
        <div className="overview-message">Loading overview...</div>
      )}
      {data && (
        <>
          <div className="overview-summary">
            <div>
              <strong>{integer.format(data.activeDays)}</strong>
              <span>Active days</span>
            </div>
            <div>
              <strong>{integer.format(data.activeWeekdays)}</strong>
              <span>Active weekdays</span>
            </div>
            <div>
              <strong>{integer.format(data.weekendDays)}</strong>
              <span>Weekend days</span>
            </div>
            <div>
              <strong>{percent(data.weekdayActivityRate)}</strong>
              <span>Weekday activity</span>
            </div>
            <div>
              <strong>{integer.format(data.sessions)}</strong>
              <span>Sessions worked on</span>
            </div>
          </div>

          <div className="overview-matrices">
            <MetricTable title="Activity per active day">
              <MetricRow
                label="Sessions worked on"
                values={data.activity.sessions}
              />
              <MetricRow label="Turns" values={data.activity.turns} />
              <MetricRow
                label="Spend"
                values={data.activity.spend}
                format={currency.format}
                partial={data.activity.hasUnpricedCost}
              />
            </MetricTable>
            <MetricTable title="Session profile">
              <MetricRow label="Turns" values={data.sessionProfile.turns} />
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
                label="Elapsed duration"
                description="First turn to final model call"
                values={data.sessionProfile.elapsed}
                format={duration}
              />
              <MetricRow
                label="Spend"
                values={data.sessionProfile.spend}
                format={currency.format}
                partial={data.sessionProfile.hasUnpricedCost}
              />
              <MetricRow
                label="Efficiency"
                values={data.sessionProfile.efficiency}
                format={percent}
              />
            </MetricTable>
          </div>

          <div className="overview-secondary">
            <div>
              <span>Overall efficiency</span>
              <strong>{percent(data.sessionProfile.overallEfficiency)}</strong>
              <small>Token-weighted reuse</small>
            </div>
            <div>
              <span>Multi-day sessions</span>
              <strong>{percent(data.multiDaySessionRate)}</strong>
              <small>{integer.format(data.multiDaySessions)} sessions</small>
            </div>
            <div>
              <span>Average active span</span>
              <strong>{decimal.format(data.averageActiveSpan)} days</strong>
              <small>Distinct dates per session</small>
            </div>
          </div>

          <div className="overview-models">
            <h3>Top models by spend</h3>
            <div className="overview-table-wrap">
              <table className="overview-table model-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Spend</th>
                    <th>Share</th>
                    <th>Input</th>
                    <th>Sessions</th>
                    <th>Efficiency</th>
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((model) => (
                    <tr key={`${model.model}:${model.isOther}`}>
                      <th scope="row" title={model.model}>
                        {modelName(model.model)}
                      </th>
                      <td>
                        {currency.format(model.spend)}
                        {model.hasUnpricedCost && (
                          <sup title="Some calls could not be priced">*</sup>
                        )}
                      </td>
                      <td>{percent(model.spendShare)}</td>
                      <td title={integer.format(model.input)}>
                        {compact.format(model.input)}
                      </td>
                      <td>{integer.format(model.sessions)}</td>
                      <td>{percent(model.efficiency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {(data.activity.hasUnpricedCost ||
            data.subagentCoverage !== "full") && (
            <p className="overview-note">
              {data.activity.hasUnpricedCost &&
                "Spend statistics use known prices only. "}
              {data.subagentCoverage !== "full" &&
                `Subagent coverage is ${data.subagentCoverage} for this harness selection.`}
            </p>
          )}
        </>
      )}
    </section>
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
        <div>
          <strong>{integer.format(data.activeDays)}</strong>
          <span>Active days</span>
          <small>
            {integer.format(data.activeWeekdays)} weekdays ·{" "}
            {integer.format(data.weekendDays)} weekend
          </small>
        </div>
        <div>
          <strong>{integer.format(data.sessions)}</strong>
          <span>Sessions</span>
          <small>Worked on</small>
        </div>
        <div>
          <strong>
            {currency.format(knownSpend)}
            {hasUnpricedSpend && <sup>*</sup>}
          </strong>
          <span>Spend</span>
          <small>Known prices</small>
        </div>
        <div>
          <strong>{percent(data.sessionProfile.overallEfficiency)}</strong>
          <span>Token reuse</span>
          <small>Weighted efficiency</small>
        </div>
        <div>
          <strong>{percent(data.multiDaySessionRate)}</strong>
          <span>Multi-day</span>
          <small>{integer.format(data.multiDaySessions)} sessions</small>
        </div>
        <div>
          <strong>{decimal.format(data.averageActiveSpan)} days</strong>
          <span>Avg active span</span>
          <small>Distinct dates</small>
        </div>
      </div>
      <div className="compact-overview-table">
        <table className="overview-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>P50</th>
              <th>Avg</th>
              <th>P90</th>
            </tr>
          </thead>
          <tbody>
            <MetricRow
              label="Sessions / active day"
              values={data.activity.sessions}
            />
            <MetricRow
              label="Turns / active day"
              values={data.activity.turns}
            />
            <MetricRow
              label="Spend / active day"
              values={data.activity.spend}
              format={currency.format}
              partial={data.activity.hasUnpricedCost}
            />
            <MetricRow
              label="Turns / session"
              values={data.sessionProfile.turns}
              sectionStart
            />
            <MetricRow
              label="Input / session"
              values={data.sessionProfile.input}
              format={compact.format}
            />
            <MetricRow
              label="Peak context"
              values={data.sessionProfile.peakContext}
              format={compact.format}
            />
            <MetricRow
              label="Elapsed duration"
              values={data.sessionProfile.elapsed}
              format={duration}
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
          <h3>Top models by spend</h3>
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
                  {currency.format(model.spend)}
                  {model.hasUnpricedCost && <sup>*</sup>}
                </strong>
              </div>
            ))}
          </div>
        </div>
      )}
      {(data.activity.hasUnpricedCost || data.subagentCoverage !== "full") && (
        <p className="compact-overview-note">
          {data.activity.hasUnpricedCost && "* Known priced spend only. "}
          {data.subagentCoverage !== "full" &&
            `${data.subagentCoverage} subagent coverage.`}
        </p>
      )}
    </div>
  );
}
