import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UsageResponse } from "../shared/sessionSchemas.ts";
import { getUsage } from "./api.ts";

type Metric = "cost" | "tokens";
type Range = 7 | 30 | "all";

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
const day = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const colors = [
  "#b4522d",
  "#466244",
  "#c18a3d",
  "#637b86",
  "#786578",
  "#8c7658",
  "#78916c",
  "#b46f62",
];
const visibleModels = 5;

function formatValue(metric: Metric, value: number) {
  return metric === "cost" ? money.format(value) : `${compact.format(value)} tokens`;
}

function UsageTooltip({
  active,
  label,
  payload,
  metric,
}: {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ color?: string; name?: string; value?: number }>;
  metric: Metric;
}) {
  if (!active || !payload?.length || label === undefined) return null;
  const items = payload
    .filter((item) => typeof item.value === "number")
    .sort((a, b) => b.value! - a.value!);
  const total = items.reduce((sum, item) => sum + item.value!, 0);
  return (
    <div className="usage-tooltip">
      <p>{day.format(new Date(`${String(label)}T00:00:00`))}</p>
      <strong>{formatValue(metric, total)} total</strong>
      <div className="usage-tooltip-models">
        {items.map((item) => (
          <div key={item.name}>
            <span className="model-label">
              <i style={{ background: item.color }} />
              {item.name}
            </span>
            <span>{formatValue(metric, item.value!)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function UsageChart({ harness }: { harness: string }) {
  const [metric, setMetric] = useState<Metric>("cost");
  const [range, setRange] = useState<Range>(30);
  const [usage, setUsage] = useState<UsageResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setUsage(undefined);
    setError(undefined);
    getUsage(range, harness).then((result) => active && setUsage(result)).catch(
      (reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Unable to load usage");
        }
      },
    );
    return () => {
      active = false;
    };
  }, [harness, range]);

  const models = usage
    ? [...new Set(usage.days.flatMap((entry) => entry.models.map(({ model }) => model)))]
      .sort()
    : [];
  const series = models.map((model, index) => {
    const values = usage?.days.flatMap((entry) =>
      entry.models.filter((item) => item.model === model)
    ) ?? [];
    return {
      model,
      key: `model${index}`,
      color: colors[index % colors.length],
      total: values.reduce((sum, item) => sum + (item[metric] ?? 0), 0),
    };
  }).sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
  const data = usage?.days.map((entry) => {
    const row: Record<string, string | number | undefined> = { date: entry.date };
    for (const item of entry.models) {
      const key = series.find(({ model }) => model === item.model)?.key;
      if (key) row[key] = item[metric];
    }
    return row;
  }) ?? [];
  const total = series.reduce((sum, item) => sum + item.total, 0);
  const shownSeries = series.slice(0, visibleModels);
  const overflowSeries = series.slice(visibleModels);

  return (
    <section className="usage-chart" aria-labelledby="usage-chart-title">
      <div className="usage-chart-heading">
        <div>
          <p className="eyebrow">Usage pulse</p>
          <h2 id="usage-chart-title">
            {metric === "cost" ? "Cost over time" : "Tokens by model"}
          </h2>
          {usage
            ? (
              <p className="chart-total">
                <strong>{formatValue(metric, total)}</strong>
                <span>{range === "all" ? "All time" : `Last ${range} days`}</span>
              </p>
            )
            : <p>Daily totals, stacked by model</p>}
        </div>
        <div className="chart-controls">
          <div className="segmented" aria-label="Chart metric">
            {(["cost", "tokens"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={metric === value ? "active" : undefined}
                aria-pressed={metric === value}
                onClick={() => setMetric(value)}
              >
                {value === "cost" ? "Cost" : "Tokens"}
              </button>
            ))}
          </div>
          <div className="segmented" aria-label="Chart range">
            {([7, 30, "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={range === value ? "active" : undefined}
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                {value === "all" ? "All" : `${value}D`}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="usage-chart-body">
        {!usage && !error && <div className="chart-message">Building daily totals...</div>}
        {error && <div className="chart-message chart-error">{error}</div>}
        {usage && data.length === 0 && (
          <div className="chart-message">No usage in this range.</div>
        )}
        {usage && data.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#dfdbd1" strokeDasharray="3 5" />
              <XAxis
                dataKey="date"
                tickFormatter={(value: string) => day.format(new Date(`${value}T00:00:00`))}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(value: number) => metric === "cost" ? `$${compact.format(value)}` : compact.format(value)}
                tickLine={false}
                axisLine={false}
                width={54}
              />
              <Tooltip
                cursor={{ fill: "rgba(70, 98, 68, .07)" }}
                content={(props) => (
                  <UsageTooltip
                    active={props.active}
                    label={props.label}
                    payload={props.payload as Array<{ color?: string; name?: string; value?: number }>}
                    metric={metric}
                  />
                )}
              />
              {series.map(({ key, model, color }) => (
                <Bar key={key} dataKey={key} name={model} stackId="models" fill={color} maxBarSize={48} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {usage && series.length > 0 && (
        <div className="model-summary" aria-label="Model totals">
          {shownSeries.map(({ model, color, total }) => (
            <span key={model} className="model-summary-item">
              <i style={{ background: color }} />
              <span>{model}</span>
              <strong>{formatValue(metric, total)}</strong>
            </span>
          ))}
          {overflowSeries.length > 0 && (
            <span className="model-overflow">
              <button type="button" aria-label={`Show ${overflowSeries.length} more models`}>
                +{overflowSeries.length} more
              </button>
              <span className="model-overflow-popover" role="tooltip">
                {overflowSeries.map(({ model, color, total }) => (
                  <span key={model} className="model-summary-item">
                    <i style={{ background: color }} />
                    <span>{model}</span>
                    <strong>{formatValue(metric, total)}</strong>
                  </span>
                ))}
              </span>
            </span>
          )}
        </div>
      )}
      {metric === "cost" && usage?.hasUnpricedCost && (
        <p className="chart-note">Some calls have no matching price and are omitted from cost totals.</p>
      )}
    </section>
  );
}
