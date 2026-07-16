import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsageResponse } from "../../shared/sessionSchemas.ts";

const day = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const costSeries = [
  { key: "rootCost", label: "Root-agent cost", color: "#466244" },
  { key: "subagentCost", label: "Subagent cost", color: "#786578" },
] as const;

type TooltipRow = {
  date: string;
  endDate?: string;
  rootOnly: number;
  withSubagents: number;
  withMultipleSubagents: number;
  subagents: number;
  totalInput: number;
  subagentInput: number;
  totalCost: number;
  subagentCost: number;
  hasUnpricedCost: boolean;
};

function percent(value: number, total: number) {
  return total === 0 ? "0%" : `${Math.round(value / total * 100)}%`;
}

function SubagentTick({ x, y, payload, shares }: {
  x?: number | string;
  y?: number | string;
  payload?: { value?: number };
  shares: Map<number, string>;
}) {
  const timestamp = payload?.value;
  if (timestamp === undefined) return null;
  return (
    <text
      x={Number(x ?? 0)}
      y={Number(y ?? 0)}
      fill="#78736b"
      fontSize={10}
      textAnchor="middle"
      pointerEvents="none"
    >
      <tspan x={Number(x ?? 0)} dy={14}>
        {day.format(new Date(timestamp))}
      </tspan>
      <tspan x={Number(x ?? 0)} dy={13} fill="#786578" fontWeight={600}>
        {shares.get(timestamp)}
      </tspan>
    </text>
  );
}

function SubagentTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ payload?: TooltipRow }>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const sessions = row.rootOnly + row.withSubagents;
  const dateLabel = row.endDate
    ? `${day.format(new Date(`${row.date}T00:00:00`))} - ${
      day.format(new Date(`${row.endDate}T00:00:00`))
    }`
    : day.format(new Date(`${row.date}T00:00:00`));
  return (
    <div
      className="usage-tooltip subagent-tooltip"
      onMouseMove={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
    >
      <p>{dateLabel}</p>
      <strong>
        {sessions} {sessions === 1 ? "session" : "sessions"}
        {` · ${money.format(row.totalCost)} ${
          row.hasUnpricedCost ? "priced" : "total"
        } cost`}
      </strong>
      <div className="usage-tooltip-models">
        <div>
          <span>Root-agent cost</span>
          <span>
            {money.format(row.totalCost - row.subagentCost)} ·{" "}
            {percent(row.totalCost - row.subagentCost, row.totalCost)}
          </span>
        </div>
        <div>
          <span>Subagent cost</span>
          <span>
            {money.format(row.subagentCost)} ·{" "}
            {percent(row.subagentCost, row.totalCost)}
          </span>
        </div>
        <div>
          <span>Sessions with subagents</span>
          <span>
            {row.withSubagents} · {percent(row.withSubagents, sessions)}
          </span>
        </div>
        <div>
          <span>Sessions with 2+ subagents</span>
          <span>
            {row.withMultipleSubagents} ·{" "}
            {percent(row.withMultipleSubagents, sessions)}
          </span>
        </div>
        <div>
          <span>Subagent runs</span>
          <span>{row.subagents}</span>
        </div>
        <div>
          <span>Input from subagents</span>
          <span>
            {compact.format(row.subagentInput)} tokens ·{" "}
            {percent(row.subagentInput, row.totalInput)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function SubagentChart({ usage, range }: {
  usage: UsageResponse;
  range: 7 | 30 | 90 | "all";
}) {
  const [bucket, setBucket] = useState<"day" | "week">("week");
  const allCohorts = bucket === "day"
    ? usage.subagentDays
    : usage.subagentWeeks;
  const cohorts = allCohorts.filter((entry) => entry.subagents > 0);
  const data = cohorts.map((entry) => ({
    ...entry,
    timestamp: new Date(`${entry.date}T00:00:00`).getTime(),
    rootCost: entry.totalCost - entry.subagentCost,
  }));
  const hasUnpricedCohort = allCohorts.some((entry) => entry.hasUnpricedCost);
  const totalSubagentCost = data.reduce(
    (sum, entry) => sum + entry.subagentCost,
    0,
  );
  const totalRangeCost = allCohorts.reduce(
    (sum, entry) => sum + entry.totalCost,
    0,
  );
  const bucketWidth = (bucket === "day" ? 1 : 7) * 86_400_000;
  const subagentShares = new Map(data.map((entry) => [
    entry.timestamp,
    percent(entry.subagentCost, entry.totalCost),
  ]));

  return (
    <>
      <div className="usage-chart-heading">
        <div>
          <p className="eyebrow">Workflow shape</p>
          <h2>Subagent cost contribution</h2>
          <dl className="subagent-summary">
            <div>
              <dt>Subagent spend %</dt>
              <dd>{percent(totalSubagentCost, totalRangeCost)}</dd>
            </div>
            <div>
              <dt>Subagent spend</dt>
              <dd>{money.format(totalSubagentCost)}</dd>
            </div>
            <div>
              <dt>Total spend</dt>
              <dd>{money.format(totalRangeCost)}</dd>
            </div>
          </dl>
          <p className="subagent-summary-range">
            {range === "all" ? "All time" : `Last ${range} days`}
            {hasUnpricedCohort ? " · Priced calls only" : ""}
          </p>
        </div>
        <div className="segmented" aria-label="Subagent rollup">
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
        {usage.subagentCoverage === "none"
          ? (
            <div className="chart-message">
              Subagent activity is not available for this harness.
            </div>
          )
          : data.length === 0
          ? (
            <div className="chart-message">
              No subagent activity in this range.
            </div>
          )
          : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                margin={{ top: 8, right: 8, left: 4, bottom: 0 }}
              >
                <CartesianGrid
                  vertical={false}
                  stroke="#dfdbd1"
                  strokeDasharray="3 5"
                />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={[
                    (minimum: number) => minimum - bucketWidth / 2,
                    (maximum: number) => maximum + bucketWidth / 2,
                  ]}
                  ticks={data.map((entry) => entry.timestamp)}
                  tick={<SubagentTick shares={subagentShares} />}
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  height={42}
                />
                <YAxis
                  tickFormatter={(value: number) => `$${compact.format(value)}`}
                  tickLine={false}
                  axisLine={false}
                  width={42}
                />
                <Tooltip
                  cursor={{ fill: "rgba(120, 101, 120, .07)" }}
                  trigger="hover"
                  position={{ y: 8 }}
                  isAnimationActive={false}
                  wrapperStyle={{ pointerEvents: "auto" }}
                  content={(props) => (
                    <SubagentTooltip
                      active={props.active}
                      payload={props.payload as Array<{
                        payload?: TooltipRow;
                      }>}
                    />
                  )}
                />
                <Bar
                  dataKey="subagentCost"
                  name="Subagent cost"
                  stackId="cost"
                  fill="#786578"
                  maxBarSize={48}
                  minPointSize={2}
                />
                <Bar
                  dataKey="rootCost"
                  name="Root-agent cost"
                  stackId="cost"
                  fill="#466244"
                  maxBarSize={48}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
      </div>
      {data.length > 0 && usage.subagentCoverage !== "none" && (
        <div className="cache-legend" aria-label="Subagent cost legend">
          {costSeries.map((item) => (
            <span key={item.key}>
              <i style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      )}
      {usage.subagentCoverage !== "none" && (
        <p className="chart-note session-input-note">
          Costs and active sessions are grouped by call{" "}
          {bucket}. Subagents are child sessions with model activity. Only
          periods with subagent activity are
          shown.{usage.subagentCoverage === "partial"
            ? " Some selected harnesses do not expose subagent activity."
            : ""}
          {hasUnpricedCohort
            ? " Cost totals include priced calls only where pricing is unavailable."
            : ""}
        </p>
      )}
    </>
  );
}
