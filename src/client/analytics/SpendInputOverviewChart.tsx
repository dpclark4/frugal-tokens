import { useMemo, useState } from "react";
import {
  canonicalModelId,
  displayModelName,
} from "../../shared/modelNames.ts";
import type { UsageResponse } from "../../shared/sessionSchemas.ts";

type Range = 7 | 30 | 90 | "all";

type DailyModel = {
  model: string;
  input: number;
  cost: number;
};

type DailyUsage = {
  date: string;
  timestamp: number;
  input: number;
  cost: number;
  models: DailyModel[];
};

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const day = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const colors = [
  "#786578",
  "#c18a3d",
  "#8c7658",
  "#b4522d",
  "#637b86",
  "#466244",
  "#9a7466",
  "#78916c",
];

const WIDTH = 1200;
const LEFT = 78;
const RIGHT = 18;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const SPEND_TOP = 22;
const SPEND_BOTTOM = 242;
const INPUT_TOP = 294;
const INPUT_BOTTOM = 430;
const AXIS_Y = 470;

function localDateKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function parseDate(value: string) {
  return new Date(`${value}T00:00:00`);
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function niceMaximum(value: number) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const rounded = normalized <= 1
    ? 1
    : normalized <= 2
    ? 2
    : normalized <= 5
    ? 5
    : 10;
  return rounded * magnitude;
}

function buildDays(usage: UsageResponse, range: Range): DailyUsage[] {
  const source = new Map(usage.days.map((entry) => [entry.date, entry]));
  const sourceDates = usage.days.map((entry) => parseDate(entry.date));
  const latestSource = sourceDates.at(-1);
  const end = range === "all"
    ? latestSource
    : new Date();
  const start = range === "all"
    ? sourceDates[0]
    : end
    ? addDays(end, -(range - 1))
    : undefined;
  if (!start || !end) return [];

  const result: DailyUsage[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const dateKey = localDateKey(date);
    const entry = source.get(dateKey);
    const grouped = new Map<string, DailyModel>();
    for (const item of entry?.models ?? []) {
      const model = canonicalModelId(item.model);
      const bucket = grouped.get(model) ?? { model, input: 0, cost: 0 };
      bucket.input += item.input;
      bucket.cost += item.cost ?? 0;
      grouped.set(model, bucket);
    }
    const models = [...grouped.values()];
    result.push({
      date: dateKey,
      timestamp: date.getTime(),
      input: models.reduce((sum, model) => sum + model.input, 0),
      cost: models.reduce((sum, model) => sum + model.cost, 0),
      models,
    });
  }
  return result;
}

function ChartTooltip({ entry, modelColors, alignRight }: {
  entry: DailyUsage;
  modelColors: Map<string, string>;
  alignRight: boolean;
}) {
  const effectiveRate = entry.input === 0
    ? undefined
    : entry.cost / (entry.input / 1_000_000);
  const models = entry.models.toSorted((a, b) => b.cost - a.cost || b.input - a.input);
  return (
    <div className={`combined-usage-tooltip${alignRight ? " align-right" : ""}`}>
      <p>{day.format(new Date(entry.timestamp))}</p>
      <div className="combined-tooltip-totals">
        <div><strong>{money.format(entry.cost)}</strong><span>spend</span></div>
        <div><strong>{compact.format(entry.input)}</strong><span>input processed</span></div>
      </div>
      {effectiveRate !== undefined && (
        <p className="effective-rate">{money.format(effectiveRate)} per 1M processed tokens</p>
      )}
      {models.length > 0 && (
        <div className="combined-tooltip-models">
          {models.slice(0, 6).map((model) => (
            <div key={model.model}>
              <span><i style={{ background: modelColors.get(model.model) }} />{displayModelName(model.model)}</span>
              <span>{money.format(model.cost)} · {compact.format(model.input)}</span>
            </div>
          ))}
          {models.length > 6 && <small>+{models.length - 6} more models</small>}
        </div>
      )}
    </div>
  );
}

export function SpendInputOverviewChart({ usage, range }: {
  usage: UsageResponse;
  range: Range;
}) {
  const [hovered, setHovered] = useState<number>();
  const data = useMemo(() => buildDays(usage, range), [usage, range]);
  const models = useMemo(() => {
    const totals = new Map<string, { cost: number; input: number }>();
    for (const entry of data) {
      for (const model of entry.models) {
        const total = totals.get(model.model) ?? { cost: 0, input: 0 };
        total.cost += model.cost;
        total.input += model.input;
        totals.set(model.model, total);
      }
    }
    return [...totals.entries()].sort(([, a], [, b]) =>
      b.cost - a.cost || b.input - a.input
    ).map(([model, total], index) => ({
      model,
      ...total,
      color: colors[index % colors.length],
    }));
  }, [data]);
  const modelColors = useMemo(
    () => new Map(models.map((model) => [model.model, model.color])),
    [models],
  );
  const totalCost = data.reduce((sum, entry) => sum + entry.cost, 0);
  const totalInput = data.reduce((sum, entry) => sum + entry.input, 0);
  const spendMaximum = niceMaximum(Math.max(...data.map((entry) => entry.cost), 0));
  const inputMaximum = niceMaximum(Math.max(...data.map((entry) => entry.input), 0));
  const step = data.length === 0 ? PLOT_WIDTH : PLOT_WIDTH / data.length;
  const barWidth = Math.max(2, Math.min(32, step * .72));
  const x = (index: number) => LEFT + step * (index + .5);
  const spendY = (value: number) =>
    SPEND_BOTTOM - (value / spendMaximum) * (SPEND_BOTTOM - SPEND_TOP);
  const inputY = (value: number) =>
    INPUT_BOTTOM - (value / inputMaximum) * (INPUT_BOTTOM - INPUT_TOP);
  const inputPath = data.map((entry, index) =>
    `${index === 0 ? "M" : "L"}${x(index)},${inputY(entry.input)}`
  ).join(" ");
  const tickIndexes = data.length <= 8
    ? data.map((_, index) => index)
    : [0, Math.floor((data.length - 1) / 3), Math.floor((data.length - 1) * 2 / 3), data.length - 1];
  const hoveredEntry = hovered === undefined ? undefined : data[hovered];

  function updateHover(clientX: number, target: SVGSVGElement) {
    if (data.length === 0) return;
    const bounds = target.getBoundingClientRect();
    const chartX = (clientX - bounds.left) / bounds.width * WIDTH;
    const index = Math.max(0, Math.min(data.length - 1, Math.floor((chartX - LEFT) / step)));
    setHovered(index);
  }

  return (
    <>
      <div className="combined-usage-heading">
        <div className="combined-total">
          <span>Spend</span>
          <strong>{money.format(totalCost)}</strong>
        </div>
        <div className="combined-total">
          <span>Input processed</span>
          <strong>{compact.format(totalInput)}</strong>
        </div>
        {models.length > 0 && (
          <div className="combined-model-table" aria-label="Spend by model">
            {models.slice(0, 5).map((model) => (
              <span key={model.model} className="combined-model-item">
                <i style={{ background: model.color }} />
                <span title={model.model}>{displayModelName(model.model)}</span>
                <strong>{money.format(model.cost)}</strong>
              </span>
            ))}
            {models.length > 5 && (
              <span className="model-overflow combined-model-overflow">
                <button type="button" aria-label={`Show ${models.length - 5} more models`}>
                  +{models.length - 5} models
                </button>
                <span className="model-overflow-popover" role="tooltip">
                  {models.slice(5).map((model) => (
                    <span key={model.model} className="model-summary-item">
                      <i style={{ background: model.color }} />
                      <span title={model.model}>{displayModelName(model.model)}</span>
                      <strong>{money.format(model.cost)}</strong>
                    </span>
                  ))}
                </span>
              </span>
            )}
          </div>
        )}
      </div>
      <div className="combined-usage-chart">
        {data.length === 0
          ? <div className="chart-message">No usage in this range.</div>
          : (
            <div className="combined-chart-stage">
              <svg
                viewBox={`0 0 ${WIDTH} 492`}
                role="img"
                aria-label="Daily spend bars by model above a line showing total processed input"
                onPointerMove={(event) => updateHover(event.clientX, event.currentTarget)}
                onPointerLeave={() => setHovered(undefined)}
              >
                {[0, .5, 1].map((ratio) => {
                  const spendValue = spendMaximum * (1 - ratio);
                  const y = SPEND_TOP + (SPEND_BOTTOM - SPEND_TOP) * ratio;
                  return (
                    <g key={`spend-${ratio}`}>
                      <line className="combined-grid" x1={LEFT} y1={y} x2={WIDTH - RIGHT} y2={y} />
                      <text className="combined-axis-label" x={LEFT - 10} y={y + 3} textAnchor="end">
                        ${compact.format(spendValue)}
                      </text>
                    </g>
                  );
                })}
                <text className="combined-panel-label" x="8" y={SPEND_TOP + 3}>SPEND</text>
                <text className="combined-panel-unit" x="8" y={SPEND_TOP + 18}>daily · USD</text>

                {data.map((entry, index) => {
                  let accumulated = 0;
                  return models.map((model) => {
                    const value = entry.models.find((item) => item.model === model.model)?.cost ?? 0;
                    const bottom = spendY(accumulated);
                    accumulated += value;
                    const top = spendY(accumulated);
                    return value === 0 ? null : (
                      <rect
                        key={`${entry.date}:${model.model}`}
                        x={x(index) - barWidth / 2}
                        y={top}
                        width={barWidth}
                        height={Math.max(1, bottom - top)}
                        fill={model.color}
                      />
                    );
                  });
                })}

                {[0, .5, 1].map((ratio) => {
                  const inputValue = inputMaximum * (1 - ratio);
                  const y = INPUT_TOP + (INPUT_BOTTOM - INPUT_TOP) * ratio;
                  return (
                    <g key={`input-${ratio}`}>
                      <line className="combined-grid" x1={LEFT} y1={y} x2={WIDTH - RIGHT} y2={y} />
                      <text className="combined-axis-label" x={LEFT - 10} y={y + 3} textAnchor="end">
                        {compact.format(inputValue)}
                      </text>
                    </g>
                  );
                })}
                <text className="combined-panel-label" x="8" y={INPUT_TOP + 3}>INPUT</text>
                <text className="combined-panel-unit" x="8" y={INPUT_TOP + 18}>processed</text>
                <path className="combined-input-line" d={inputPath} />
                {data.map((entry, index) => entry.input > 0 && (
                  <circle key={entry.date} className="combined-input-point" cx={x(index)} cy={inputY(entry.input)} r="2.2" />
                ))}

                {tickIndexes.map((index) => (
                  <text
                    key={data[index].date}
                    className="combined-axis-label"
                    x={x(index)}
                    y={AXIS_Y}
                    textAnchor={index === 0 ? "start" : index === data.length - 1 ? "end" : "middle"}
                  >
                    {day.format(new Date(data[index].timestamp))}
                  </text>
                ))}

                {hoveredEntry && hovered !== undefined && (
                  <g aria-hidden="true">
                    <rect className="combined-hover-band" x={x(hovered) - step / 2} y={SPEND_TOP} width={step} height={INPUT_BOTTOM - SPEND_TOP} />
                    <line className="combined-hover-line" x1={x(hovered)} y1={SPEND_TOP} x2={x(hovered)} y2={INPUT_BOTTOM} />
                    <circle className="combined-hover-point" cx={x(hovered)} cy={inputY(hoveredEntry.input)} r="4" />
                  </g>
                )}
              </svg>
              {hoveredEntry && hovered !== undefined && (
                <div className="combined-tooltip-position" style={{ left: `${x(hovered) / WIDTH * 100}%` }}>
                  <ChartTooltip entry={hoveredEntry} modelColors={modelColors} alignRight={hovered > data.length * .62} />
                </div>
              )}
            </div>
          )}
      </div>
    </>
  );
}
