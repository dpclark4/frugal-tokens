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

const harnesses: Array<{
  value: Harness;
  label: string;
  color: string;
}> = [
  { value: "claude-code", label: "Claude Code", color: "#b4522d" },
  { value: "codex", label: "Codex", color: "#637b86" },
  { value: "opencode", label: "OpenCode", color: "#466244" },
  { value: "pi", label: "Pi", color: "#786578" },
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

function InitialInputTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ payload?: ChartRow }>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row || row.cohorts.length === 0) return null;
  const cohorts = [...row.cohorts].sort((a, b) => b.median - a.median);
  return (
    <div className="usage-tooltip initial-input-tooltip">
      <p>{day.format(new Date(`${row.date}T00:00:00`))}</p>
      <strong>Median initial input</strong>
      <div className="initial-input-tooltip-header" aria-hidden="true">
        <span>Harness</span>
        <span>Median</span>
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

export function InitialInputChart({ usage }: { usage: UsageResponse }) {
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
  const sessions = cohorts.reduce((sum, cohort) => sum + cohort.sessions, 0);
  const visibleHarnesses = harnesses.filter(({ value }) =>
    cohorts.some((cohort) => cohort.harness === value)
  );

  return (
    <>
      <div className="usage-chart-heading">
        <p className="chart-total">
          <strong>
            {sessions} session {sessions === 1 ? "start" : "starts"}
          </strong>
        </p>
      </div>
      <div className="usage-chart-body">
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
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
      </div>
      {visibleHarnesses.length > 0 && (
        <div className="model-summary" aria-label="Harness legend">
          {visibleHarnesses.map(({ value, label, color }) => (
            <span key={value} className="model-summary-item">
              <i style={{ background: color }} />
              <span>{label}</span>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
