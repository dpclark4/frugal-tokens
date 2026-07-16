import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useState } from "react";
import type { UsageResponse } from "../../shared/sessionSchemas.ts";

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const day = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function formatTokens(value: number) {
  return `${compact.format(value)} tokens`;
}

function SessionInputTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{
    payload?: {
      date: string;
      endDate?: string;
      median: number;
      p90: number;
      average: number;
      sessions: number;
    };
  }>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const dateLabel = row.endDate
    ? `${day.format(new Date(`${row.date}T00:00:00`))} - ${
      day.format(new Date(`${row.endDate}T00:00:00`))
    }`
    : day.format(new Date(`${row.date}T00:00:00`));
  return (
    <div className="usage-tooltip">
      <p>{dateLabel}</p>
      <strong>
        {row.sessions} {row.sessions === 1 ? "session" : "sessions"}
      </strong>
      <div className="usage-tooltip-models">
        <div>
          <span>Median</span>
          <span>{formatTokens(row.median)}</span>
        </div>
        <div>
          <span>p90</span>
          <span>{formatTokens(row.p90)}</span>
        </div>
        <div>
          <span>Average</span>
          <span>{formatTokens(row.average)}</span>
        </div>
      </div>
    </div>
  );
}

export function SessionInputChart({ usage, range }: {
  usage: UsageResponse;
  range: 7 | 30 | 90 | "all";
}) {
  const [bucket, setBucket] = useState<"day" | "week">("week");
  const cohorts = bucket === "day"
    ? usage.sessionInputDays
    : usage.sessionInputWeeks;
  const sessions = cohorts.reduce(
    (sum, entry) => sum + entry.sessions,
    0,
  );
  const data = cohorts.map((entry) => ({
    ...entry,
    p90Band: entry.p90 - entry.median,
  }));

  return (
    <>
      <div className="usage-chart-heading">
        <div>
          <p className="eyebrow">Usage pulse</p>
          <h2>Model input volume per session</h2>
          <p className="chart-total">
            <strong>
              {sessions} {sessions === 1 ? "session" : "sessions"}
            </strong>
            <span>{range === "all" ? "All time" : `Last ${range} days`}</span>
          </p>
        </div>
        <div className="segmented" aria-label="Session size rollup">
          {(["day", "week"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={bucket === value ? "active" : undefined}
              aria-pressed={bucket === value}
              onClick={() => setBucket(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      <div className="usage-chart-body">
        {data.length === 0
          ? <div className="chart-message">No usage in this range.</div>
          : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={data}
                margin={{ top: 8, right: 8, left: 4, bottom: 0 }}
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
                  tickFormatter={(value: number) => compact.format(value)}
                  tickLine={false}
                  axisLine={false}
                  width={54}
                />
                <Tooltip
                  content={(props) => (
                    <SessionInputTooltip
                      active={props.active}
                      payload={props.payload as Array<
                        {
                          payload?: {
                            date: string;
                            endDate?: string;
                            median: number;
                            p90: number;
                            average: number;
                            sessions: number;
                          };
                        }
                      >}
                    />
                  )}
                />
                <Area
                  dataKey="median"
                  stackId="percentiles"
                  stroke="none"
                  fill="transparent"
                />
                <Area
                  dataKey="p90Band"
                  stackId="percentiles"
                  stroke="none"
                  fill="#c18a3d"
                  fillOpacity={0.2}
                />
                <Line
                  dataKey="median"
                  name="Median"
                  stroke="#466244"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
      </div>
      {data.length > 0 && (
        <div className="cache-legend" aria-label="Session input legend">
          <span>
            <i style={{ background: "#466244" }} />Median
          </span>
          <span>
            <i style={{ background: "#c18a3d", opacity: 0.35 }} />Median to p90
          </span>
        </div>
      )}
      <p className="chart-note session-input-note">
        Sessions are grouped by start{" "}
        {bucket === "day" ? "date" : "week"}. Input includes uncached,
        cache-read, and cache-write tokens.
      </p>
    </>
  );
}
