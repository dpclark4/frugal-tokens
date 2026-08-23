import { useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { displayModelName } from "../shared/modelNames.ts";
import type {
  PerformanceResponse,
  SessionSummary,
} from "../shared/sessionSchemas.ts";
import { getHarnesses, getPerformance } from "./api.ts";
import { HarnessOptions } from "./HarnessOptions.tsx";
import { SiteHeader } from "./SiteHeader.tsx";
import {
  dashboardChartFont,
  dashboardChartLabelSize,
} from "./new/formatters.ts";

const route = getRouteApi("/performance");
const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const date = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

type ProviderResult = PerformanceResponse["openai"];
type DistributionKey = "efficiency" | "finalContextShare";
type Lab = "openai" | "anthropic";
type MissMetric = "sessions" | "turns" | "modelCalls";
type Week = ProviderResult["weeks"][number] & {
  sessionRate: number | null;
  turnRate: number | null;
  modelCallRate: number | null;
};

const missMetrics = [
  {
    key: "sessions",
    label: "Sessions",
    rateKey: "sessionRate",
    missKey: "sessionsWithMiss",
    color: "#b4522d",
  },
  {
    key: "turns",
    label: "Turns",
    rateKey: "turnRate",
    missKey: "turnsWithMiss",
    color: "#466244",
  },
  {
    key: "modelCalls",
    label: "Model calls",
    rateKey: "modelCallRate",
    missKey: "modelCallsWithMiss",
    color: "#4d7180",
  },
] as const;

function rate(part: number, total: number) {
  return total === 0 ? null : part / total * 100;
}

function displayRate(value: number | null) {
  return value === null ? "No data" : `${value.toFixed(1)}%`;
}

function missRateAxisMax(rows: Week[], visible: Set<MissMetric>) {
  const maximum = Math.max(
    0,
    ...rows.flatMap((week) =>
      missMetrics
        .filter((metric) => visible.has(metric.key))
        .map((metric) => week[metric.rateKey])
        .filter((value): value is number => value !== null)
    ),
  );
  const withHeadroom = maximum * 1.15;
  return [5, 10, 20, 25, 50, 75, 100].find((limit) => withHeadroom <= limit) ??
    100;
}

function MissTooltip({ active, payload, visible, comparisonRows }: {
  active?: boolean;
  payload?: Array<{ payload?: Week }>;
  visible: Set<MissMetric>;
  comparisonRows: Week[];
}) {
  const week = payload?.[0]?.payload;
  if (!active || !week) return null;
  const comparison = comparisonRows.find((row) => row.date === week.date);
  return (
    <div className="tooltip-surface usage-tooltip performance-tooltip comparison-tooltip">
      <p>
        {date.format(new Date(`${week.date}T00:00:00`))}–
        {date.format(new Date(`${week.endDate}T00:00:00`))}
      </p>
      <div className="comparison-tooltip-table-head" aria-hidden="true">
        <span>Category</span>
        <span>Total</span>
        <span>Misses</span>
        <span>Rate</span>
        <span>Other</span>
        <span>Difference</span>
      </div>
      {missMetrics.filter((metric) => visible.has(metric.key)).map((metric) => {
        const currentRate = week[metric.rateKey];
        const otherRate = comparison?.[metric.rateKey] ?? null;
        const difference = currentRate === null || otherRate === null
          ? null
          : currentRate - otherRate;
        const roundedDifference = difference === null
          ? null
          : Math.round(difference * 10) / 10;
        return (
          <div className="comparison-tooltip-row" key={metric.key}>
            <span>{metric.label}</span>
            <span>{integer.format(week[metric.key])}</span>
            <span>{integer.format(week[metric.missKey])}</span>
            <strong>{displayRate(currentRate)}</strong>
            <strong>{otherRate === null ? "—" : displayRate(otherRate)}</strong>
            <strong
              className={roundedDifference === null || roundedDifference === 0
                ? "neutral"
                : roundedDifference > 0
                ? "negative"
                : "positive"}
            >
              {roundedDifference === null
                ? "—"
                : roundedDifference === 0
                ? "Same"
                : `${Math.abs(roundedDifference).toFixed(1)} pp ${
                  roundedDifference > 0 ? "higher" : "lower"
                }`}
            </strong>
          </div>
        );
      })}
    </div>
  );
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function EfficiencyBoxPlot({
  weeks,
  distribution,
  label,
}: {
  weeks: ProviderResult["weeks"];
  distribution: DistributionKey;
  label: string;
}) {
  const [selected, setSelected] = useState<ProviderResult["weeks"][number]>();
  const width = 720;
  const height = 260;
  const left = 42;
  const right = 10;
  const top = 14;
  const bottom = 40;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const step = plotWidth / Math.max(weeks.length, 1);
  const y = (value: number) => top + (1 - value) * plotHeight;
  const selectedEfficiency = selected?.[distribution];

  return (
    <div className="efficiency-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Weekly ${label.toLowerCase()} distributions`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((value) => (
          <g key={value}>
            <line
              x1={left}
              x2={width - right}
              y1={y(value)}
              y2={y(value)}
              className="efficiency-grid-line"
            />
            <text
              x={left - 9}
              y={y(value) + 4}
              textAnchor="end"
              className="efficiency-axis-label efficiency-y-axis-label"
            >
              {Math.round(value * 100)}%
            </text>
          </g>
        ))}
        {weeks.map((week, index) => {
          const value = week[distribution];
          const x = left + step * index + step / 2;
          const boxWidth = Math.min(24, step * .48);
          return (
            <g key={week.date}>
              {value && (
                <g
                  className={`efficiency-box ${
                    value.sampleSize < 5 ? "small-sample" : ""
                  }`}
                  tabIndex={0}
                  role="img"
                  aria-label={`${week.date}, ${label.toLowerCase()} median ${
                    percent(value.median)
                  }, ${value.sampleSize} sessions`}
                  onMouseEnter={() => setSelected(week)}
                  onMouseLeave={() => setSelected(undefined)}
                  onFocus={() => setSelected(week)}
                  onBlur={() => setSelected(undefined)}
                >
                  <line
                    x1={x}
                    x2={x}
                    y1={y(value.upperWhisker)}
                    y2={y(value.lowerWhisker)}
                  />
                  <line
                    x1={x - boxWidth / 3}
                    x2={x + boxWidth / 3}
                    y1={y(value.upperWhisker)}
                    y2={y(value.upperWhisker)}
                  />
                  <line
                    x1={x - boxWidth / 3}
                    x2={x + boxWidth / 3}
                    y1={y(value.lowerWhisker)}
                    y2={y(value.lowerWhisker)}
                  />
                  <rect
                    x={x - boxWidth / 2}
                    y={y(value.q3)}
                    width={boxWidth}
                    height={Math.max(1, y(value.q1) - y(value.q3))}
                  />
                  <line
                    className="efficiency-median"
                    x1={x - boxWidth / 2}
                    x2={x + boxWidth / 2}
                    y1={y(value.median)}
                    y2={y(value.median)}
                  />
                </g>
              )}
              {(index % 2 === 0 || weeks.length <= 8) && (
                <text
                  x={x}
                  y={height - 17}
                  textAnchor="middle"
                  className="efficiency-axis-label"
                >
                  {date.format(new Date(`${week.date}T00:00:00`))}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="efficiency-tooltip-slot" aria-live="polite">
        {selected && selectedEfficiency
          ? (
            <div className="efficiency-tooltip">
              <div className="efficiency-tooltip-heading">
                <p>
                  {date.format(new Date(`${selected.date}T00:00:00`))}–
                  {date.format(new Date(`${selected.endDate}T00:00:00`))}
                </p>
                <strong>{selectedEfficiency.sampleSize} sessions</strong>
                {selectedEfficiency.sampleSize < 5 && (
                  <small>Small sample</small>
                )}
              </div>
              <dl>
                <div>
                  <dt>Lower</dt>
                  <dd>{percent(selectedEfficiency.lowerWhisker)}</dd>
                </div>
                <div>
                  <dt>P25</dt>
                  <dd>{percent(selectedEfficiency.q1)}</dd>
                </div>
                <div>
                  <dt>Median</dt>
                  <dd>{percent(selectedEfficiency.median)}</dd>
                </div>
                <div>
                  <dt>P75</dt>
                  <dd>{percent(selectedEfficiency.q3)}</dd>
                </div>
                <div>
                  <dt>Upper</dt>
                  <dd>{percent(selectedEfficiency.upperWhisker)}</dd>
                </div>
                <div>
                  <dt>Average</dt>
                  <dd>{percent(selectedEfficiency.average)}</dd>
                </div>
                <div>
                  <dt>Outliers</dt>
                  <dd>{selectedEfficiency.outliers}</dd>
                </div>
              </dl>
            </div>
          )
          : (
            <span className="efficiency-tooltip-hint">
              Hover to see details
            </span>
          )}
      </div>
    </div>
  );
}

function DistributionPanel({
  title,
  result,
  distribution,
  label,
}: {
  title: string;
  result?: ProviderResult;
  distribution: DistributionKey;
  label: string;
}) {
  return (
    <article className="performance-provider efficiency-panel">
      <div className="performance-provider-heading">
        <div>
          <h2>{title}</h2>
        </div>
        <span className="efficiency-model">
          {displayModelName(result?.selectedModel ?? "all")}
        </span>
      </div>
      {!result
        ? (
          <div className="performance-chart">
            <div className="chart-message">Loading distribution…</div>
          </div>
        )
        : (
          <EfficiencyBoxPlot
            weeks={result.weeks}
            distribution={distribution}
            label={label}
          />
        )}
    </article>
  );
}

const cacheLossBuckets = [
  { bucket: "0-16k", key: "loss0To16k", label: "0–16k", color: "#dbad94" },
  { bucket: "16-64k", key: "loss16To64k", label: "16–64k", color: "#c97850" },
  {
    bucket: "64-128k",
    key: "loss64To128k",
    label: "64–128k",
    color: "#a94b2a",
  },
  { bucket: "128k+", key: "loss128kPlus", label: "128k+", color: "#762d1b" },
] as const;

type CacheLossBucket = (typeof cacheLossBuckets)[number]["bucket"];
type CacheLossWeek = ProviderResult["weeks"][number] & {
  loss0To16k: number | null;
  loss16To64k: number | null;
  loss64To128k: number | null;
  loss128kPlus: number | null;
};

function lossTokens(
  retention: ProviderResult["weeks"][number]["cacheRetention"],
  bucket: CacheLossBucket,
) {
  if (!retention) return null;
  return retention.lossBuckets.find((entry) => entry.bucket === bucket)
    ?.unretainedTokens ?? 0;
}

function CacheLossTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ payload?: CacheLossWeek }>;
}) {
  const week = payload?.[0]?.payload;
  const retention = week?.cacheRetention;
  if (!active || !week || !retention) return null;
  return (
    <div className="tooltip-surface usage-tooltip performance-tooltip">
      <p>
        {date.format(new Date(`${week.date}T00:00:00`))}–
        {date.format(new Date(`${week.endDate}T00:00:00`))}
      </p>
      <div className="cache-loss-tooltip-columns" aria-hidden="true">
        <span />
        <span>Requests</span>
        <span>Tokens</span>
      </div>
      {[...retention.lossBuckets].reverse().map((bucket) =>
        bucket.unretainedTokens > 0 && (
          <div className="cache-loss-tooltip-row" key={bucket.bucket}>
            <span>
              {cacheLossBuckets.find((entry) =>
                entry.bucket === bucket.bucket
              )
                ?.label} misses
            </span>
            <strong>{integer.format(bucket.requests)}</strong>
            <strong title={integer.format(bucket.unretainedTokens)}>
              {compact.format(bucket.unretainedTokens)}
            </strong>
          </div>
        )
      )}
    </div>
  );
}

function CacheLossPanel(
  { title, result }: { title: string; result?: ProviderResult },
) {
  const rows: CacheLossWeek[] = (result?.weeks ?? []).map((week) => ({
    ...week,
    loss0To16k: lossTokens(week.cacheRetention, "0-16k"),
    loss16To64k: lossTokens(week.cacheRetention, "16-64k"),
    loss64To128k: lossTokens(week.cacheRetention, "64-128k"),
    loss128kPlus: lossTokens(week.cacheRetention, "128k+"),
  }));
  const hasData = rows.some((week) =>
    week.cacheRetention?.lossBuckets.some((bucket) =>
      bucket.unretainedTokens > 0
    )
  );

  return (
    <article className="performance-provider cache-retention-panel">
      <div className="performance-provider-heading">
        <h2>{title}</h2>
        <span className="efficiency-model">
          {displayModelName(result?.selectedModel ?? "all")}
        </span>
      </div>
      {!result
        ? (
          <div className="performance-chart">
            <div className="chart-message">Loading cache misses…</div>
          </div>
        )
        : !hasData
        ? (
          <div className="image-cohort-message">
            No partial or full cache misses.
          </div>
        )
        : (
          <>
            <div className="performance-chart cache-retention-chart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={rows}
                  margin={{ top: 12, right: 24, bottom: 4, left: -12 }}
                >
                  <CartesianGrid vertical={false} stroke="#e6e2d9" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(value) =>
                      date.format(new Date(`${value}T00:00:00`))}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    tickFormatter={(value) => compact.format(value)}
                    tickLine={false}
                    axisLine={false}
                    width={48}
                  />
                  <Tooltip content={<CacheLossTooltip />} />
                  {cacheLossBuckets.map((bucket) => (
                    <Bar
                      key={bucket.key}
                      dataKey={bucket.key}
                      name={`${bucket.label} misses`}
                      stackId="loss"
                      fill={bucket.color}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="performance-legend cache-retention-legend">
              {[...cacheLossBuckets].reverse().map((bucket) => (
                <span key={bucket.key}>
                  <i style={{ background: bucket.color }} /> {bucket.label}{" "}
                  misses
                </span>
              ))}
            </div>
          </>
        )}
    </article>
  );
}

const imageCohortLabels = {
  "no-image": "No image",
  "first-turn-image": "Image in first turn",
  "later-turn-image": "Image introduced later",
} as const;

function ImageCohortPanel({
  title,
  result,
}: {
  title: string;
  result?: ProviderResult;
}) {
  return (
    <article className="performance-provider image-cohort-panel">
      <div className="performance-provider-heading">
        <h2>{title}</h2>
        <span className="efficiency-model">
          {displayModelName(result?.selectedModel ?? "all")}
        </span>
      </div>
      {!result
        ? <div className="image-cohort-message">Loading image cohorts…</div>
        : (
          <div className="image-cohort-list">
            {result.imageCohorts.map((cohort) => {
              const missRate = rate(cohort.sessionsWithMiss, cohort.sessions);
              const title =
                `${cohort.sessionsWithMiss} of ${cohort.sessions} sessions`;
              return (
                <div
                  className="image-cohort-row"
                  key={cohort.cohort}
                  title={title}
                >
                  <div>
                    <span>{imageCohortLabels[cohort.cohort]}</span>
                    <strong>{displayRate(missRate)}</strong>
                  </div>
                  <i>
                    <b style={{ width: `${missRate ?? 0}%` }} />
                  </i>
                  <small>{cohort.sessionsWithMiss} of {cohort.sessions}</small>
                </div>
              );
            })}
          </div>
        )}
    </article>
  );
}

type ComparisonCohort = {
  lab: Lab;
  harness: string;
  model: string;
  result?: ProviderResult;
  models: string[];
  error?: string;
  updateLab: (lab: Lab) => void;
  updateHarness: (harness: string) => void;
  updateModel: (model: string) => void;
};

function comparisonRows(result?: ProviderResult): Week[] {
  return (result?.weeks ?? []).map((week) => ({
    ...week,
    sessionRate: rate(week.sessionsWithMiss, week.sessions),
    turnRate: rate(week.turnsWithMiss, week.turns),
    modelCallRate: rate(week.modelCallsWithMiss, week.modelCalls),
  }));
}

function useComparison(initialLab: Lab, initialHarness = "all") {
  const [lab, setLab] = useState<Lab>(initialLab);
  const [harness, setHarness] = useState(initialHarness);
  const [model, setModel] = useState("all");
  const [response, setResponse] = useState<PerformanceResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setResponse(undefined);
    setError(undefined);
    getPerformance(
      harness,
      lab === "openai" ? model : "all",
      lab === "anthropic" ? model : "all",
    ).then((next) => {
      if (active) setResponse(next);
    }).catch((reason) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : "Unable to load");
      }
    });
    return () => {
      active = false;
    };
  }, [lab, harness, model]);

  return {
    lab,
    harness,
    model,
    result: response?.[lab],
    models: response?.models[lab] ?? [],
    error,
    updateLab(nextLab: Lab) {
      setLab(nextLab);
      setModel("all");
    },
    updateHarness: setHarness,
    updateModel: setModel,
  } satisfies ComparisonCohort;
}

function ComparisonControls({
  cohort,
  harnesses,
}: {
  cohort: ComparisonCohort;
  harnesses: SessionSummary["harness"][];
}) {
  return (
    <div className="comparison-config">
      <div className="comparison-controls">
        <label>
          <span>Lab</span>
          <select
            value={cohort.lab}
            onChange={(event) =>
              cohort.updateLab(
                event.target.value === "anthropic" ? "anthropic" : "openai",
              )}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label>
          <span>Harness</span>
          <select
            value={cohort.harness}
            onChange={(event) => cohort.updateHarness(event.target.value)}
          >
            <HarnessOptions harnesses={harnesses} />
          </select>
        </label>
        <label>
          <span>Model</span>
          <select
            value={cohort.model}
            onChange={(event) => cohort.updateModel(event.target.value)}
          >
            <option value="all">All models</option>
            {cohort.models.toSorted((a, b) =>
              b.localeCompare(a, undefined, {
                numeric: true,
                sensitivity: "base",
              })
            ).map((availableModel) => (
              <option key={availableModel} value={availableModel}>
                {displayModelName(availableModel)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function ComparisonMetrics({
  result,
  visible,
  onToggle,
}: {
  result?: ProviderResult;
  visible: Set<MissMetric>;
  onToggle: (metric: MissMetric) => void;
}) {
  return (
    <div className="comparison-metrics">
      {missMetrics.map((metric) => {
        const total = result?.[metric.key] ?? 0;
        const misses = result?.[metric.missKey] ?? 0;
        const enabled = visible.has(metric.key);
        return (
          <button
            className={enabled ? "active" : undefined}
            type="button"
            aria-pressed={enabled}
            onClick={() => onToggle(metric.key)}
            key={metric.key}
          >
            <i style={{ background: metric.color }} />
            <strong>{result ? displayRate(rate(misses, total)) : "–"}</strong>
            <span>{metric.label}</span>
            <small>{integer.format(misses)} of {integer.format(total)}</small>
          </button>
        );
      })}
    </div>
  );
}

function ComparisonChart({
  cohort,
  rows,
  visible,
  axisMaximum,
  comparisonRows,
}: {
  cohort: ComparisonCohort;
  rows: Week[];
  visible: Set<MissMetric>;
  axisMaximum: number;
  comparisonRows: Week[];
}) {
  return (
    <div className="performance-chart comparison-chart">
      {cohort.error
        ? <div className="chart-message">{cohort.error}</div>
        : !cohort.result
        ? <div className="chart-message">Loading comparison…</div>
        : visible.size === 0
        ? <div className="chart-message">Select a metric above.</div>
        : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={rows}
              margin={{ top: 12, right: 24, bottom: 4, left: -12 }}
            >
              <CartesianGrid vertical={false} stroke="#e6e2d9" />
              <XAxis
                dataKey="date"
                tickFormatter={(value) =>
                  date.format(new Date(`${value}T00:00:00`))}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
                tick={{
                  fontFamily: dashboardChartFont,
                  fontSize: dashboardChartLabelSize,
                }}
              />
              <YAxis
                domain={[0, axisMaximum]}
                tickFormatter={(value) => `${value}%`}
                tickLine={false}
                axisLine={false}
                tick={{
                  fontFamily: dashboardChartFont,
                  fontSize: dashboardChartLabelSize,
                }}
                width={48}
              />
              <Tooltip
                content={
                  <MissTooltip
                    visible={visible}
                    comparisonRows={comparisonRows}
                  />
                }
              />
              {missMetrics.map((metric) =>
                visible.has(metric.key) && (
                  <Line
                    key={metric.key}
                    type="linear"
                    dataKey={metric.rateKey}
                    name={metric.label}
                    stroke={metric.color}
                    strokeWidth={2}
                    dot={{ r: 3, fill: metric.color, strokeWidth: 0 }}
                    activeDot={{
                      r: 5,
                      fill: metric.color,
                      stroke: "#fffdf8",
                      strokeWidth: 2,
                    }}
                    connectNulls={false}
                  />
                )
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
    </div>
  );
}

export function PerformancePage() {
  const search = route.useSearch();
  const [data, setData] = useState<PerformanceResponse>();
  const [harnesses, setHarnesses] = useState<SessionSummary["harness"][]>([]);
  const [error, setError] = useState<string>();
  const comparisonA = useComparison("openai");
  const comparisonB = useComparison("openai", "pi");
  const [visibleMetricsA, setVisibleMetricsA] = useState<Set<MissMetric>>(
    () => new Set(missMetrics.map((metric) => metric.key)),
  );
  const [visibleMetricsB, setVisibleMetricsB] = useState<Set<MissMetric>>(
    () => new Set(missMetrics.map((metric) => metric.key)),
  );
  const comparisonARows = comparisonRows(comparisonA.result);
  const comparisonBRows = comparisonRows(comparisonB.result);
  const comparisonAxisMaximum = missRateAxisMax(
    [...comparisonARows, ...comparisonBRows],
    new Set([...visibleMetricsA, ...visibleMetricsB]),
  );

  function toggleMetricA(metric: MissMetric) {
    setVisibleMetricsA((current) => {
      const next = new Set(current);
      if (next.has(metric)) next.delete(metric);
      else next.add(metric);
      return next;
    });
  }

  function toggleMetricB(metric: MissMetric) {
    setVisibleMetricsB((current) => {
      const next = new Set(current);
      if (next.has(metric)) next.delete(metric);
      else next.add(metric);
      return next;
    });
  }

  useEffect(() => {
    getHarnesses().then(setHarnesses).catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    getPerformance(search.harness, search.openai, search.anthropic).then(
      (result) => {
        if (active) setData(result);
      },
    ).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load performance",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [search.harness, search.openai, search.anthropic]);

  return (
    <main className="new-page performance-page">
      <SiteHeader active="performance" />
      <section className="performance-intro">
        <h2>Cache miss rate</h2>
      </section>
      <section className="performance-comparison-shell">
        {error && <div className="error performance-error">{error}</div>}
        <div className="performance-grid">
          <article className="performance-provider comparison-panel">
            <ComparisonControls
              cohort={comparisonA}
              harnesses={harnesses}
            />
            <ComparisonMetrics
              result={comparisonA.result}
              visible={visibleMetricsA}
              onToggle={toggleMetricA}
            />
            <ComparisonChart
              cohort={comparisonA}
              rows={comparisonARows}
              visible={visibleMetricsA}
              axisMaximum={comparisonAxisMaximum}
              comparisonRows={comparisonBRows}
            />
          </article>
          <article className="performance-provider comparison-panel">
            <ComparisonControls
              cohort={comparisonB}
              harnesses={harnesses}
            />
            <ComparisonMetrics
              result={comparisonB.result}
              visible={visibleMetricsB}
              onToggle={toggleMetricB}
            />
            <ComparisonChart
              cohort={comparisonB}
              rows={comparisonBRows}
              visible={visibleMetricsB}
              axisMaximum={comparisonAxisMaximum}
              comparisonRows={comparisonARows}
            />
          </article>
        </div>
      </section>
      <section className="performance-section-heading">
        <h2>Cache efficiency</h2>
        <p>
          Cached input as a percent of total session input. Higher means more
          context was served from cache.
        </p>
      </section>
      <section className="performance-grid">
        <DistributionPanel
          title="OpenAI"
          result={data?.openai}
          distribution="efficiency"
          label="Cache efficiency"
        />
        <DistributionPanel
          title="Anthropic"
          result={data?.anthropic}
          distribution="efficiency"
          label="Cache efficiency"
        />
      </section>
      <section className="performance-section-heading">
        <h2>Context efficiency</h2>
        <p>
          Final input context as a percent of total session input. Higher means
          less earlier context processing.
        </p>
      </section>
      <section className="performance-grid">
        <DistributionPanel
          title="OpenAI"
          result={data?.openai}
          distribution="finalContextShare"
          label="Context efficiency"
        />
        <DistributionPanel
          title="Anthropic"
          result={data?.anthropic}
          distribution="finalContextShare"
          label="Context efficiency"
        />
      </section>
      <section className="performance-section-heading">
        <h2>Miss rate by image use</h2>
      </section>
      <section className="performance-grid">
        <ImageCohortPanel title="OpenAI" result={data?.openai} />
        <ImageCohortPanel title="Anthropic" result={data?.anthropic} />
      </section>
      <section className="performance-section-heading">
        <h2>Unexpected cache-miss volume</h2>
        <p>
          Partial/full misses not attributed to compaction or cache expiry,
          grouped by inferred context loss.
        </p>
      </section>
      <section className="performance-grid">
        <CacheLossPanel title="OpenAI" result={data?.openai} />
        <CacheLossPanel title="Anthropic" result={data?.anthropic} />
      </section>
    </main>
  );
}
