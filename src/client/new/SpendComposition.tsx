import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpendCompositionData } from "../../shared/sessionSchemas.ts";
import { displayModelName } from "../../shared/modelNames.ts";
import {
  compact,
  currency,
  dashboardChartFont,
  dashboardChartLabelSize,
} from "./formatters.ts";
import { minorModelColor, modelColor, otherModelColor } from "./modelColors.ts";
import "./SpendComposition.css";

type Metric = "spend" | "tokens";
type CompositionModel = SpendCompositionData["models"][number];
type CompositionDay = SpendCompositionData["days"][number];
type ChartRow = {
  date: string;
  source: CompositionDay;
  [key: string]: string | number | CompositionDay;
};

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const longDate = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatRate(value?: number) {
  return value === undefined ? "—" : currency.format(value);
}

function compactModelName(model: string) {
  return displayModelName(model).replace(/^(?:Claude|GPT)\s+/, "");
}

function BarValue({ value, maximum, formatted, color }: {
  value: number;
  maximum: number;
  formatted: string;
  color: string;
}) {
  const width = maximum === 0
    ? 0
    : Math.max(value > 0 ? 2 : 0, value / maximum * 100);
  return (
    <span className="composition-bar-value">
      <i
        style={{ width: `${width}%`, backgroundColor: color }}
        aria-hidden="true"
      />
      <strong>{formatted}</strong>
    </span>
  );
}

function ModelTable({ data }: { data: SpendCompositionData }) {
  const maxSpend = Math.max(
    data.other?.spend ?? 0,
    ...data.models.map((model) => model.spend),
  );
  const maxTokens = Math.max(
    data.other?.processedInput ?? 0,
    ...data.models.map((model) => model.processedInput),
  );

  return (
    <div className="composition-ranking">
      <div className="composition-table-header" aria-hidden="true">
        <span>Model</span>
        <span>Spend</span>
        <span>Tokens</span>
        <span className="composition-rate-heading">
          $/1M<span>processed</span>
        </span>
      </div>
      <ol className="composition-models">
        {data.models.map((model) => {
          const color = modelColor(model, data.models);
          const name = displayModelName(model.model);
          return (
            <li key={model.model}>
              <span
                className="composition-model-name"
                title={name}
                aria-label={name}
              >
                <strong>
                  <span className="composition-model-name-full">{name}</span>
                  <span className="composition-model-name-compact">
                    {compactModelName(model.model)}
                  </span>
                </strong>
              </span>
              <BarValue
                value={model.spend}
                maximum={maxSpend}
                formatted={currency.format(model.spend)}
                color={color}
              />
              <BarValue
                value={model.processedInput}
                maximum={maxTokens}
                formatted={compact.format(model.processedInput)}
                color={color}
              />
              <span
                className="composition-rate"
                title="Priced spend divided by processed input tokens."
              >
                {formatRate(model.effectiveCostPerMillion)}
              </span>
            </li>
          );
        })}
        {data.other && (
          <li className="composition-other-row">
            <span className="composition-model-name">
              <strong>Other</strong>
            </span>
            <BarValue
              value={data.other.spend}
              maximum={maxSpend}
              formatted={currency.format(data.other.spend)}
              color={otherModelColor}
            />
            <BarValue
              value={data.other.processedInput}
              maximum={maxTokens}
              formatted={compact.format(data.other.processedInput)}
              color={otherModelColor}
            />
            <span
              className="composition-rate"
              title="Priced spend divided by processed input tokens."
            >
              {formatRate(
                data.other.processedInput === 0
                  ? undefined
                  : data.other.spend / data.other.processedInput * 1_000_000,
              )}
            </span>
          </li>
        )}
      </ol>
    </div>
  );
}

function CompositionTooltip({ active, payload, data, metric }: {
  active?: boolean;
  payload?: Array<{ payload?: ChartRow }>;
  data: SpendCompositionData;
  metric: Metric;
}) {
  const day = payload?.[0]?.payload?.source;
  if (!active || !day) return null;
  const values = [
    ...data.models.map((model) => ({
      model,
      value: day.models.find((item) => item.model === model.model),
    })),
    ...day.otherModels.map((model) => ({ model, value: model })),
  ].filter(({ value }) =>
    (value?.spend ?? 0) > 0 || (value?.processedInput ?? 0) > 0
  ).toSorted((a, b) =>
    metric === "spend"
      ? (b.value?.spend ?? 0) - (a.value?.spend ?? 0)
      : (b.value?.processedInput ?? 0) - (a.value?.processedInput ?? 0)
  );
  const colorModels = [...data.models, ...day.otherModels];
  const totalSpend = day.models.reduce(
    (sum, model) => sum + model.spend,
    day.otherSpend,
  );
  const totalTokens = day.models.reduce(
    (sum, model) => sum + model.processedInput,
    day.otherProcessedInput,
  );
  const dailyRate = totalTokens === 0
    ? undefined
    : totalSpend / totalTokens * 1_000_000;

  return (
    <div className="composition-tooltip">
      <header>
        <strong>{longDate.format(parseDate(day.date))}</strong>
        <span>
          {metric === "spend"
            ? currency.format(totalSpend)
            : `${compact.format(totalTokens)} tokens`}
          {` · ${formatRate(dailyRate)}/1M`}
        </span>
      </header>
      {values.map(({ model, value }) => {
        if (!value) return null;
        const rate = value.processedInput === 0
          ? undefined
          : value.spend / value.processedInput * 1_000_000;
        return (
          <div key={model.model}>
            <i
              style={{
                backgroundColor: model.provider === "other"
                  ? minorModelColor(model.model)
                  : modelColor(model, colorModels),
              }}
              aria-hidden="true"
            />
            <span>{displayModelName(model.model)}</span>
            <strong>
              {metric === "spend"
                ? currency.format(value.spend)
                : compact.format(value.processedInput)}
            </strong>
            <small>{formatRate(rate)}/1M</small>
          </div>
        );
      })}
    </div>
  );
}

function CompositionChart(
  { data, metric }: {
    data: SpendCompositionData;
    metric: Metric;
  },
) {
  const series = useMemo(() => [
    ...data.models.map((model, index) => ({
      key: `model${index}`,
      model,
      color: modelColor(model, data.models),
    })),
    ...(data.other
      ? [{ key: "other", model: undefined, color: otherModelColor }]
      : []),
  ], [data]);
  const rows = useMemo(() =>
    data.days.map((day) => {
      const row: ChartRow = { date: day.date, source: day };
      data.models.forEach((model, index) => {
        const value = day.models.find((item) => item.model === model.model);
        row[`model${index}`] = metric === "spend"
          ? value?.spend ?? 0
          : value?.processedInput ?? 0;
      });
      if (data.other) {
        row.other = metric === "spend"
          ? day.otherSpend
          : day.otherProcessedInput;
      }
      return row;
    }), [data, metric]);

  return (
    <div
      className="composition-chart"
      role="img"
      aria-label={`${
        metric === "spend" ? "Spend" : "Processed input tokens"
      } by day, stacked by model.`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 10, right: 4, bottom: 2, left: 0 }}
          barCategoryGap="18%"
        >
          <CartesianGrid
            yAxisId="volume"
            vertical={false}
            syncWithTicks
            stroke="#d7e0dd"
            strokeDasharray="3 5"
          />
          <XAxis
            dataKey="date"
            tickFormatter={(value) =>
              shortDate.format(parseDate(String(value)))}
            minTickGap={42}
            axisLine={false}
            tickLine={false}
            tick={{
              fill: "#73807c",
              fontSize: dashboardChartLabelSize,
              fontFamily: dashboardChartFont,
            }}
          />
          <YAxis
            yAxisId="volume"
            width={48}
            tickFormatter={(value) =>
              metric === "spend"
                ? `$${compact.format(Number(value))}`
                : compact.format(Number(value))}
            axisLine={false}
            tickLine={false}
            tick={{
              fill: "#73807c",
              fontSize: dashboardChartLabelSize,
              fontFamily: dashboardChartFont,
            }}
          />
          <Tooltip
            cursor={{ stroke: "#52615d", strokeDasharray: "3 3" }}
            content={(props) => (
              <CompositionTooltip
                active={props.active}
                payload={props.payload as Array<{ payload?: ChartRow }>}
                data={data}
                metric={metric}
              />
            )}
          />
          {series.map((item) => (
            <Bar
              key={item.key}
              yAxisId="volume"
              dataKey={item.key}
              stackId="composition"
              fill={item.color}
              fillOpacity={0.82}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SpendComposition({ data }: { data: SpendCompositionData }) {
  const [metric, setMetric] = useState<Metric>("spend");
  const empty = data.models.length === 0;

  return (
    <section
      className="spend-composition"
      aria-labelledby="spend-composition-title"
    >
      <div className={`composition-body${empty ? " empty" : ""}`}>
        <div className="composition-card composition-ranking-card">
          <header className="composition-header">
            <h2 id="spend-composition-title">Spend</h2>
          </header>
          {empty
            ? (
              <p className="composition-empty">
                No model usage in this period.
              </p>
            )
            : <ModelTable data={data} />}
        </div>
        {!empty && (
          <div className="composition-card composition-chart-card">
            <header className="composition-header composition-chart-header">
              <div className="composition-header-controls">
                <div className="composition-toggle" aria-label="Chart metric">
                  <button
                    type="button"
                    className={metric === "spend" ? "active" : ""}
                    aria-pressed={metric === "spend"}
                    onClick={() => setMetric("spend")}
                  >
                    Spend
                  </button>
                  <button
                    type="button"
                    className={metric === "tokens" ? "active" : ""}
                    aria-pressed={metric === "tokens"}
                    onClick={() => setMetric("tokens")}
                  >
                    Tokens
                  </button>
                </div>
                <div className="composition-summary">
                  <strong>
                    {metric === "spend"
                      ? currency.format(data.spend)
                      : compact.format(data.processedInput)}
                  </strong>
                </div>
              </div>
            </header>
            <div className="composition-trend">
              <CompositionChart data={data} metric={metric} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
