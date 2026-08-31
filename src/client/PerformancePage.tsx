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
type Lab = "openai" | "anthropic";
type HarnessSelection = "all" | SessionSummary["harness"];
type MissMetric = "sessions" | "turns" | "modelCalls";
type Week = ProviderResult["weeks"][number] & {
  sessionRate: number | null;
  turnRate: number | null;
  modelCallRate: number | null;
};

const missMetrics = [
  {
    key: "sessions",
    label: "Sessions affected",
    description: "Sessions with at least one unexpected miss",
    rateKey: "sessionRate",
    missKey: "sessionsWithMiss",
    eligibleKey: "eligibleSessions",
    color: "#b4522d",
  },
  {
    key: "turns",
    label: "Turns affected",
    description: "Turns with at least one unexpected miss",
    rateKey: "turnRate",
    missKey: "turnsWithMiss",
    eligibleKey: "eligibleTurns",
    color: "#466244",
  },
  {
    key: "modelCalls",
    label: "Calls missed",
    description: "Model calls with an unexpected miss",
    rateKey: "modelCallRate",
    missKey: "modelCallsWithMiss",
    eligibleKey: "eligibleModelCalls",
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
        <span>With reuse</span>
        <span>Affected</span>
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
            <span>{integer.format(week[metric.eligibleKey])}</span>
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
type CacheLossMode = "tokens" | "rate" | "raw";
type CacheLossWeek = ProviderResult["weeks"][number] & {
  loss0To16k: number | null;
  loss16To64k: number | null;
  loss64To128k: number | null;
  loss128kPlus: number | null;
};

const cacheLossModes = [
  {
    key: "tokens",
    label: "Context lost %",
    description: "Share of reusable context unexpectedly lost",
  },
  {
    key: "rate",
    label: "Miss rate %",
    description: "Share of reusable calls with an unexpected miss",
  },
  {
    key: "raw",
    label: "Miss count",
    description: "Number of unexpected cache misses",
  },
] as const;

function cacheLossEntry(
  week: ProviderResult["weeks"][number],
  bucket: CacheLossBucket,
) {
  return week.cacheLossBuckets?.find((entry) => entry.bucket === bucket);
}

function cacheLossValue(
  week: ProviderResult["weeks"][number],
  bucket: CacheLossBucket,
  mode: CacheLossMode,
) {
  const entry = cacheLossEntry(week, bucket);
  if (mode === "raw") return entry?.requests ?? 0;
  if (mode === "rate") {
    return week.reuseOpportunities === 0
      ? null
      : (entry?.requests ?? 0) / week.reuseOpportunities * 100;
  }
  return week.reusableTokensAtRisk === 0
    ? null
    : (entry?.unretainedTokens ?? 0) / week.reusableTokensAtRisk * 100;
}

function cacheLossAxisMax(
  results: Array<ProviderResult | undefined>,
  mode: CacheLossMode,
) {
  const maximum = Math.max(
    0,
    ...results.flatMap((result) =>
      (result?.weeks ?? []).map((week) =>
        cacheLossBuckets.reduce(
          (total, bucket) =>
            total + (cacheLossValue(week, bucket.bucket, mode) ?? 0),
          0,
        )
      )
    ),
  );
  return maximum === 0 ? 1 : maximum * 1.1;
}

function displayCacheLossValue(value: number | undefined, mode: CacheLossMode) {
  if (value === undefined) return "—";
  if (mode === "raw") return integer.format(value);
  return `${value.toFixed(1)}%`;
}

function cacheLossDifference(
  value: number,
  other: number | undefined,
  mode: CacheLossMode,
) {
  if (other === undefined) return "—";
  const difference = value - other;
  if (Math.abs(difference) < 0.05) return "Same";
  if (mode !== "raw") {
    return `${difference > 0 ? "+" : "−"}${Math.abs(difference).toFixed(1)} pp`;
  }
  return `${integer.format(Math.abs(difference))} ${
    difference > 0 ? "more" : "fewer"
  }`;
}

function CacheLossTooltip({ active, payload, comparisonWeeks, mode }: {
  active?: boolean;
  payload?: Array<{ payload?: CacheLossWeek }>;
  comparisonWeeks?: ProviderResult["weeks"];
  mode: CacheLossMode;
}) {
  const week = payload?.[0]?.payload;
  if (!active || !week) return null;
  const comparisonWeek = comparisonWeeks?.find((entry) =>
    entry.date === week.date
  );
  const valueHeading = mode === "tokens"
    ? "Context lost"
    : mode === "rate"
    ? "Miss rate"
    : "Misses";
  const detailHeading = mode === "rate" ? "Misses" : "Lost tokens";
  return (
    <div className="tooltip-surface usage-tooltip performance-tooltip comparison-tooltip cache-loss-comparison-tooltip">
      <p>
        {date.format(new Date(`${week.date}T00:00:00`))}–
        {date.format(new Date(`${week.endDate}T00:00:00`))}
      </p>
      <div className="cache-loss-tooltip-columns" aria-hidden="true">
        <span>Loss size</span>
        <span>{valueHeading}</span>
        <span>{detailHeading}</span>
        <span>Other cohort</span>
        <span>Difference</span>
      </div>
      {[...cacheLossBuckets].reverse().map((definition) => {
        const bucket = cacheLossEntry(week, definition.bucket);
        const misses = bucket?.requests ?? 0;
        const tokens = bucket?.unretainedTokens ?? 0;
        if (misses === 0) return null;
        const value = cacheLossValue(week, definition.bucket, mode) ?? 0;
        const otherValue = comparisonWeek
          ? cacheLossValue(comparisonWeek, definition.bucket, mode) ?? undefined
          : undefined;
        const difference = otherValue === undefined
          ? undefined
          : value - otherValue;
        return (
          <div className="cache-loss-tooltip-row" key={definition.bucket}>
            <span>{definition.label}</span>
            <strong>{displayCacheLossValue(value, mode)}</strong>
            <strong
              title={mode === "rate" ? undefined : integer.format(tokens)}
            >
              {mode === "rate"
                ? integer.format(misses)
                : compact.format(tokens)}
            </strong>
            <strong>{displayCacheLossValue(otherValue, mode)}</strong>
            <strong
              className={difference === undefined || Math.abs(difference) < 0.05
                ? "neutral"
                : difference > 0
                ? "negative"
                : "positive"}
            >
              {cacheLossDifference(value, otherValue, mode)}
            </strong>
          </div>
        );
      })}
      <div className="cache-loss-tooltip-coverage">
        <span>{integer.format(week.reuseOpportunities)} reusable calls</span>
        <span>{compact.format(week.reusableTokensAtRisk)} reusable tokens</span>
      </div>
    </div>
  );
}

function CacheLossPanel({ result, comparisonResult, mode, axisMaximum }: {
  result?: ProviderResult;
  comparisonResult?: ProviderResult;
  mode: CacheLossMode;
  axisMaximum: number;
}) {
  const rows: CacheLossWeek[] = (result?.weeks ?? []).map((week) => ({
    ...week,
    loss0To16k: cacheLossValue(week, "0-16k", mode),
    loss16To64k: cacheLossValue(week, "16-64k", mode),
    loss64To128k: cacheLossValue(week, "64-128k", mode),
    loss128kPlus: cacheLossValue(week, "128k+", mode),
  }));
  const hasData = rows.some((week) =>
    week.cacheLossBuckets?.some((bucket) => bucket.requests > 0)
  );

  return (
    <article className="performance-provider cache-loss-panel comparison-data-panel">
      {!result
        ? (
          <div className="performance-chart">
            <div className="chart-message">Loading cache misses…</div>
          </div>
        )
        : !hasData
        ? (
          <div className="performance-panel-message">
            No partial or full cache misses.
          </div>
        )
        : (
          <>
            <div className="performance-chart cache-loss-chart">
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
                    tick={{
                      fontFamily: dashboardChartFont,
                      fontSize: dashboardChartLabelSize,
                    }}
                  />
                  <YAxis
                    domain={[0, axisMaximum]}
                    tickFormatter={(value) =>
                      mode === "raw"
                        ? compact.format(value)
                        : `${Number(value).toFixed(value < 10 ? 1 : 0)}%`}
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
                      <CacheLossTooltip
                        comparisonWeeks={comparisonResult?.weeks}
                        mode={mode}
                      />
                    }
                  />
                  {cacheLossBuckets.map((bucket) => (
                    <Bar
                      key={bucket.key}
                      dataKey={bucket.key}
                      name={bucket.label}
                      stackId="loss"
                      fill={bucket.color}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="performance-legend cache-loss-legend">
              {[...cacheLossBuckets].reverse().map((bucket) => (
                <span key={bucket.key}>
                  <i style={{ background: bucket.color }} /> {bucket.label} lost
                </span>
              ))}
            </div>
          </>
        )}
    </article>
  );
}

type ComparisonCohort = {
  lab: Lab;
  harness: HarnessSelection;
  model: string;
  result?: ProviderResult;
  models: string[];
  error?: string;
  updateLab: (lab: Lab) => void;
  updateHarness: (harness: HarnessSelection) => void;
  updateModel: (model: string) => void;
};

function comparisonRows(result?: ProviderResult): Week[] {
  return (result?.weeks ?? []).map((week) => ({
    ...week,
    sessionRate: rate(week.sessionsWithMiss, week.eligibleSessions),
    turnRate: rate(week.turnsWithMiss, week.eligibleTurns),
    modelCallRate: rate(week.modelCallsWithMiss, week.eligibleModelCalls),
  }));
}

function useComparison(lab: Lab, harness: string, model: string) {
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
    result: response?.[lab],
    models: response?.models[lab] ?? [],
    error,
  };
}

function harnessSelection(value: string): HarnessSelection {
  switch (value) {
    case "opencode":
    case "claude-code":
    case "pi":
    case "codex":
    case "cursor":
      return value;
    default:
      return "all";
  }
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
            onChange={(event) =>
              cohort.updateHarness(harnessSelection(event.target.value))}
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
        const eligible = result?.[metric.eligibleKey] ?? 0;
        const misses = result?.[metric.missKey] ?? 0;
        const enabled = visible.has(metric.key);
        return (
          <button
            className={enabled ? "active" : undefined}
            type="button"
            aria-pressed={enabled}
            aria-label={`${metric.description}: ${
              displayRate(rate(misses, eligible))
            }`}
            title={metric.description}
            onClick={() => onToggle(metric.key)}
            key={metric.key}
          >
            <i style={{ background: metric.color }} />
            <strong>
              {result ? displayRate(rate(misses, eligible)) : "–"}
            </strong>
            <span>{metric.label}</span>
            <small>
              {integer.format(misses)} of {integer.format(eligible)} with reuse
            </small>
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
                    isAnimationActive={false}
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
  const navigate = route.useNavigate();
  const [harnesses, setHarnesses] = useState<SessionSummary["harness"][]>([]);
  const leftResult = useComparison(
    search.leftLab,
    search.leftHarness,
    search.leftModel,
  );
  const rightResult = useComparison(
    search.rightLab,
    search.rightHarness,
    search.rightModel,
  );
  const comparisonA = {
    lab: search.leftLab,
    harness: search.leftHarness,
    model: search.leftModel,
    ...leftResult,
    updateLab(lab: Lab) {
      void navigate({
        search: { ...search, leftLab: lab, leftModel: "all" },
      });
    },
    updateHarness(harness: HarnessSelection) {
      void navigate({ search: { ...search, leftHarness: harness } });
    },
    updateModel(model: string) {
      void navigate({ search: { ...search, leftModel: model } });
    },
  } satisfies ComparisonCohort;
  const comparisonB = {
    lab: search.rightLab,
    harness: search.rightHarness,
    model: search.rightModel,
    ...rightResult,
    updateLab(lab: Lab) {
      void navigate({
        search: { ...search, rightLab: lab, rightModel: "all" },
      });
    },
    updateHarness(harness: HarnessSelection) {
      void navigate({ search: { ...search, rightHarness: harness } });
    },
    updateModel(model: string) {
      void navigate({ search: { ...search, rightModel: model } });
    },
  } satisfies ComparisonCohort;
  const [visibleMetricsA, setVisibleMetricsA] = useState<Set<MissMetric>>(
    () => new Set(missMetrics.map((metric) => metric.key)),
  );
  const [visibleMetricsB, setVisibleMetricsB] = useState<Set<MissMetric>>(
    () => new Set(missMetrics.map((metric) => metric.key)),
  );
  const [cacheLossMode, setCacheLossMode] = useState<CacheLossMode>("tokens");
  const comparisonARows = comparisonRows(comparisonA.result);
  const comparisonBRows = comparisonRows(comparisonB.result);
  const comparisonAAxisMaximum = missRateAxisMax(
    comparisonARows,
    visibleMetricsA,
  );
  const comparisonBAxisMaximum = missRateAxisMax(
    comparisonBRows,
    visibleMetricsB,
  );
  const contextLossAxisMaximum = cacheLossAxisMax(
    [comparisonA.result, comparisonB.result],
    cacheLossMode,
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

  return (
    <main className="new-page performance-page">
      <SiteHeader active="performance" />
      <section className="performance-comparison-shell">
        <div className="performance-grid comparison-controls-grid">
          <ComparisonControls
            cohort={comparisonA}
            harnesses={harnesses}
          />
          <ComparisonControls
            cohort={comparisonB}
            harnesses={harnesses}
          />
        </div>
        <section className="performance-comparison-section">
          <h2>Unexpected cache miss rate</h2>
          <div className="performance-grid">
            <article className="performance-provider comparison-data-panel">
              <ComparisonMetrics
                result={comparisonA.result}
                visible={visibleMetricsA}
                onToggle={toggleMetricA}
              />
              <ComparisonChart
                cohort={comparisonA}
                rows={comparisonARows}
                visible={visibleMetricsA}
                axisMaximum={comparisonAAxisMaximum}
                comparisonRows={comparisonBRows}
              />
            </article>
            <article className="performance-provider comparison-data-panel">
              <ComparisonMetrics
                result={comparisonB.result}
                visible={visibleMetricsB}
                onToggle={toggleMetricB}
              />
              <ComparisonChart
                cohort={comparisonB}
                rows={comparisonBRows}
                visible={visibleMetricsB}
                axisMaximum={comparisonBAxisMaximum}
                comparisonRows={comparisonARows}
              />
            </article>
          </div>
        </section>
        <section className="performance-comparison-section">
          <div className="performance-section-heading">
            <h2>Impact of unexpected cache misses</h2>
            <div
              className="performance-view-toggle"
              role="group"
              aria-label="Context loss measure"
            >
              {cacheLossModes.map((mode) => (
                <button
                  className={cacheLossMode === mode.key ? "active" : undefined}
                  type="button"
                  aria-pressed={cacheLossMode === mode.key}
                  title={mode.description}
                  onClick={() => setCacheLossMode(mode.key)}
                  key={mode.key}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
          <div className="performance-grid">
            <CacheLossPanel
              result={comparisonA.result}
              comparisonResult={comparisonB.result}
              mode={cacheLossMode}
              axisMaximum={contextLossAxisMaximum}
            />
            <CacheLossPanel
              result={comparisonB.result}
              comparisonResult={comparisonA.result}
              mode={cacheLossMode}
              axisMaximum={contextLossAxisMaximum}
            />
          </div>
        </section>
      </section>
    </main>
  );
}
