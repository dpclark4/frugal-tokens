import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsageResponse } from "../../shared/sessionSchemas.ts";

type Harness = UsageResponse["initialInputDays"][number]["harness"];
type Cohort = UsageResponse["initialInputDays"][number];
type ChartRow = {
  date: string;
  cohorts: Cohort[];
  [key: string]: string | Cohort[] | number | null;
};
type Gap = {
  dataKey: string;
};

const harnesses: Array<{
  value: Harness;
  label: string;
  color: string;
}> = [
  { value: "claude-code", label: "Claude Code", color: "#b4522d" },
  { value: "codex", label: "Codex", color: "#637b86" },
  { value: "opencode", label: "OpenCode", color: "#466244" },
  { value: "pi", label: "Pi", color: "#786578" },
  { value: "cursor", label: "Cursor", color: "#7b746a" },
];
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const day = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function lineKey(harness: Harness) {
  return `${harness}-median`;
}

function dateKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function datesBetween(first: string, last: string) {
  const dates: string[] = [];
  const current = new Date(`${first}T00:00:00`);
  const end = new Date(`${last}T00:00:00`).getTime();
  while (current.getTime() <= end) {
    dates.push(dateKey(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function InitialInputTooltip({
  active,
  payload,
  enabledHarnesses,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartRow }>;
  enabledHarnesses: Set<Harness>;
  label: string;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row || row.cohorts.length === 0) return null;
  const cohorts = row.cohorts
    .filter((cohort) => enabledHarnesses.has(cohort.harness))
    .toSorted((a, b) => b.median - a.median);
  if (cohorts.length === 0) return null;
  return (
    <div className="usage-tooltip initial-input-tooltip">
      <p>{day.format(new Date(`${row.date}T00:00:00`))}</p>
      <strong>Median {label.toLocaleLowerCase()}</strong>
      <div className="initial-input-tooltip-header" aria-hidden="true">
        <span>Harness</span>
        <span>Median</span>
        <span>Average</span>
        <span>Sessions</span>
      </div>
      <div className="initial-input-tooltip-rows">
        {cohorts.map((cohort) => {
          const harness = harnesses.find(({ value }) =>
            value === cohort.harness
          )!;
          return (
            <div key={cohort.harness}>
              <span className="model-label">
                <i style={{ background: harness.color }} />
                {harness.label}
              </span>
              <strong>{compact.format(cohort.median)}</strong>
              <strong>{compact.format(cohort.average)}</strong>
              <span>
                {cohort.sessions}
                {cohort.sessions < 5 && (
                  <small title="Fewer than five sessions">low sample</small>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <p className="initial-input-tooltip-note">
        First model-call input · includes cached input
      </p>
    </div>
  );
}

export function InitialInputChart({
  usage,
  bare = false,
  showLegend = !bare,
  label = "Initial input",
}: {
  usage: UsageResponse;
  bare?: boolean;
  showLegend?: boolean;
  label?: string;
}) {
  const [enabledHarnesses, setEnabledHarnesses] = useState<Set<Harness>>(
    () => new Set(harnesses.map(({ value }) => value)),
  );
  const cohorts = usage.initialInputDays;
  const cohortsByDate = Map.groupBy(cohorts, (cohort) => cohort.date);
  const observedDates = [...cohortsByDate.keys()].sort();
  const data: ChartRow[] = observedDates.length === 0
    ? []
    : datesBetween(observedDates[0], observedDates.at(-1)!).map((date) => {
      const dateCohorts = cohortsByDate.get(date) ?? [];
      const row: ChartRow = { date, cohorts: dateCohorts };
      for (const { value } of harnesses) row[lineKey(value)] = null;
      for (const cohort of dateCohorts) {
        row[lineKey(cohort.harness)] = cohort.median;
      }
      return row;
    });
  const availableHarnesses = harnesses.filter(({ value }) =>
    cohorts.some((cohort) => cohort.harness === value)
  );
  const visibleHarnesses = availableHarnesses.filter(({ value }) =>
    enabledHarnesses.has(value)
  );

  function toggleHarness(harness: Harness) {
    setEnabledHarnesses((current) => {
      const next = new Set(current);
      if (next.has(harness)) next.delete(harness);
      else next.add(harness);
      return next;
    });
  }
  const gaps: Gap[] = [];
  for (const { value } of visibleHarnesses) {
    const observed = observedDates.filter((date) =>
      cohortsByDate.get(date)?.some((cohort) => cohort.harness === value)
    );
    for (let index = 1; index < observed.length; index++) {
      const previous = observed[index - 1];
      const current = observed[index];
      const missingDates = datesBetween(previous, current).slice(1, -1);
      if (missingDates.length === 0) continue;
      const dataKey = `${lineKey(value)}-gap-${index}`;
      gaps.push({ dataKey });
      for (const row of data) {
        row[dataKey] = row.date === previous || row.date === current
          ? row[lineKey(value)]
          : null;
      }
    }
  }
  const sessions = cohorts.reduce((sum, cohort) => sum + cohort.sessions, 0);

  return (
    <>
      {!bare && (
        <div className="usage-chart-heading">
          <p className="chart-total">
            <strong>
              {sessions} session {sessions === 1 ? "start" : "starts"}
            </strong>
          </p>
        </div>
      )}
      <div
        className={`usage-chart-body${bare ? " bare-initial-input-chart" : ""}`}
      >
        {data.length === 0
          ? <div className="chart-message">No sessions in this range.</div>
          : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data}
                margin={{ top: 8, right: 24, left: 4, bottom: 0 }}
              >
                <CartesianGrid
                  vertical={false}
                  stroke="#dfdbd1"
                  strokeDasharray="3 5"
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value: string) =>
                    day.format(new Date(`${value}T00:00:00`))}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis
                  domain={[0, "auto"]}
                  tickFormatter={(value: number) => compact.format(value)}
                  tickLine={false}
                  axisLine={false}
                  width={54}
                />
                <Tooltip
                  content={(props) => (
                    <InitialInputTooltip
                      active={props.active}
                      payload={props.payload as Array<{
                        payload?: ChartRow;
                      }>}
                      enabledHarnesses={enabledHarnesses}
                      label={label}
                    />
                  )}
                />
                {visibleHarnesses.map(({ value, label, color }) => (
                  <Line
                    key={lineKey(value)}
                    dataKey={lineKey(value)}
                    name={label}
                    stroke={color}
                    strokeWidth={2.5}
                    dot={{ r: 2, strokeWidth: 0, fill: color }}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
                {gaps.map(({ dataKey }) => {
                  const harness = harnesses.find(({ value }) =>
                    dataKey.startsWith(lineKey(value))
                  )!;
                  return (
                    <Line
                      key={dataKey}
                      dataKey={dataKey}
                      stroke={harness.color}
                      strokeWidth={2.5}
                      strokeDasharray="2 4"
                      strokeLinecap="round"
                      dot={false}
                      activeDot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          )}
      </div>
      {showLegend && availableHarnesses.length > 0 && (
        <div
          className="model-summary initial-input-legend"
          aria-label="Harnesses"
        >
          {availableHarnesses.map(({ value, label, color }) => {
            const enabled = enabledHarnesses.has(value);
            return (
              <button
                key={value}
                type="button"
                className="model-summary-item"
                aria-pressed={enabled}
                onClick={() => toggleHarness(value)}
              >
                <i style={{ background: color }} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
