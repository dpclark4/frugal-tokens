import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  canonicalModelId,
  displayModelName,
} from "../../shared/modelNames.ts";
import type { UsageResponse } from "../../shared/sessionSchemas.ts";

type Metric = "cost" | "input";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const DAY_MS = 86_400_000;
const colors = ["#b4522d", "#466244", "#c18a3d", "#637b86", "#786578", "#8c7658", "#78916c", "#b46f62"];
const visibleModels = 5;

function formatValue(metric: Metric, value: number) {
  return metric === "cost" ? money.format(value) : `${compact.format(value)} tokens`;
}

function UsageTooltip({ active, label, payload, metric }: {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ color?: string; name?: string; value?: number }>;
  metric: Metric;
}) {
  if (!active || !payload?.length || label === undefined) return null;
  const items = payload.filter((item) => typeof item.value === "number")
    .sort((a, b) => b.value! - a.value!);
  const total = items.reduce((sum, item) => sum + item.value!, 0);
  return (
    <div className="usage-tooltip">
      <p>{day.format(new Date(Number(label)))}</p>
      <strong>{formatValue(metric, total)} total</strong>
      <div className="usage-tooltip-models">
        {items.map((item) => (
          <div key={item.name}>
            <span className="model-label"><i style={{ background: item.color }} />{item.name}</span>
            <span>{formatValue(metric, item.value!)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SpendInputChart({ usage, metric }: {
  usage: UsageResponse;
  metric: Metric;
}) {
  const models = [...new Set(usage.days.flatMap((entry) =>
    entry.models.map(({ model }) => canonicalModelId(model))
  ))].sort();
  const series = models.map((model, index) => ({
    model,
    label: displayModelName(model),
    key: `model${index}`,
    color: colors[index % colors.length],
    total: usage.days.flatMap((entry) =>
      entry.models.filter((item) => canonicalModelId(item.model) === model)
    ).reduce((sum, item) => sum + (item[metric] ?? 0), 0),
  })).sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
  const data = usage.days.map((entry) => {
    const row: Record<string, string | number | undefined> = {
      timestamp: new Date(`${entry.date}T00:00:00`).getTime(),
    };
    for (const item of entry.models) {
      const key = series.find(({ model }) =>
        model === canonicalModelId(item.model)
      )?.key;
      const value = item[metric];
      if (key && value !== undefined) {
        row[key] = (typeof row[key] === "number" ? row[key] : 0) + value;
      }
    }
    return row;
  });
  const total = series.reduce((sum, item) => sum + item.total, 0);
  const shownSeries = series.slice(0, visibleModels);
  const overflowSeries = series.slice(visibleModels);

  return (
    <>
      <div className="usage-chart-heading">
        <p className="chart-total"><strong>{formatValue(metric, total)}</strong></p>
      </div>
      <div className="usage-chart-body">
        {data.length === 0
          ? <div className="chart-message">No usage in this range.</div>
          : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 24, left: 4, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#dfdbd1" strokeDasharray="3 5" />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={[
                    (minimum: number) => minimum - DAY_MS / 2,
                    (maximum: number) => maximum + DAY_MS / 2,
                  ]}
                  tickFormatter={(value: number) => day.format(new Date(value))}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis tickFormatter={(value: number) => metric === "cost" ? `$${compact.format(value)}` : compact.format(value)} tickLine={false} axisLine={false} width={54} />
                <Tooltip cursor={{ fill: "rgba(70, 98, 68, .07)" }} content={(props) => (
                  <UsageTooltip active={props.active} label={props.label} payload={props.payload as Array<{ color?: string; name?: string; value?: number }>} metric={metric} />
                )} />
                {series.map(({ key, label, color }) => (
                  <Bar key={key} dataKey={key} name={label} stackId="models" fill={color} maxBarSize={48} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
      </div>
      {series.length > 0 && (
        <div className="model-summary" aria-label="Model totals">
          {shownSeries.map(({ model, label, color, total: modelTotal }) => (
            <span key={model} className="model-summary-item"><i style={{ background: color }} /><span title={model}>{label}</span><strong>{formatValue(metric, modelTotal)}</strong></span>
          ))}
          {overflowSeries.length > 0 && (
            <span className="model-overflow">
              <button type="button" aria-label={`Show ${overflowSeries.length} more models`}>+{overflowSeries.length} more</button>
              <span className="model-overflow-popover" role="tooltip">
                {overflowSeries.map(({ model, label, color, total: modelTotal }) => (
                  <span key={model} className="model-summary-item"><i style={{ background: color }} /><span title={model}>{label}</span><strong>{formatValue(metric, modelTotal)}</strong></span>
                ))}
              </span>
            </span>
          )}
        </div>
      )}
    </>
  );
}
