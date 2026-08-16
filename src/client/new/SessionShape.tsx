import { useEffect, useState } from "react";
import type {
  SessionShapeResponse,
  UsageResponse,
} from "../../shared/sessionSchemas.ts";
import { getSessionShape, getUsage } from "../api.ts";
import { InitialInputChart } from "../analytics/InitialInputChart.tsx";
import { compact, currency, decimal, integer } from "./formatters.ts";
import "./SessionShape.css";

type DistributionMetric = SessionShapeResponse["metrics"][number];
type MetricKey = DistributionMetric["key"];

type SessionShapeProps = {
  range: 30 | 90;
  harness: string;
  onDataChange?: (data: SessionShapeResponse | undefined) => void;
};

const metricLabels: Record<MetricKey, string> = {
  cost: "Cost",
  processedInput: "Processed input",
  userTurns: "Turns",
  observedSpan: "Duration",
  startingContext: "Starting context",
  peakContext: "Peak context",
  tokenReuse: "Token reuse",
};

function formatDuration(milliseconds: number) {
  const minutes = milliseconds / 60_000;
  if (minutes < 1) return `${decimal.format(milliseconds / 1_000)} sec`;
  if (minutes < 60) return `${decimal.format(minutes)} min`;
  return `${decimal.format(minutes / 60)} hr`;
}

function formatValue(key: MetricKey, value: number) {
  switch (key) {
    case "cost":
      return currency.format(value);
    case "processedInput":
    case "startingContext":
    case "peakContext":
      return compact.format(value);
    case "userTurns":
      return integer.format(value);
    case "observedSpan":
      return formatDuration(value);
    case "tokenReuse":
      return `${decimal.format(value * 100)}%`;
  }
}

function position(value: number, minimum: number, maximum: number) {
  if (maximum === minimum) return 50;
  return 5 +
    90 * Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
}

function ShapeLoadingRows() {
  return Object.values(metricLabels).map((label) => (
    <tr className="shape-loading-row" key={label}>
      <th scope="row">{label}</th>
      <td className="shape-p50">
        <span className="dashboard-loading-bar" />
      </td>
      <td className="shape-distribution-cell">
        <span className="dashboard-loading-bar shape-loading-distribution" />
      </td>
    </tr>
  ));
}

function DistributionStrip({
  metric,
  multiDaySessionRate,
  initialInputUsage,
  initialInputError,
}: {
  metric: DistributionMetric;
  multiDaySessionRate?: number;
  initialInputUsage?: UsageResponse;
  initialInputError?: string;
}) {
  const { distribution } = metric;
  const label = metricLabels[metric.key];
  const multiDay = metric.key === "observedSpan" &&
      multiDaySessionRate !== undefined
    ? `${decimal.format(multiDaySessionRate * 100)}% span multiple days`
    : undefined;
  const metricLabel = (
    <div className="shape-metric-label">
      <div className="shape-metric-name">
        {label}
        {metric.key === "startingContext" && (
          <div className="shape-context-help">
            <button type="button" aria-label="Show starting context by day">
              i
            </button>
            <div className="shape-context-popover">
              <strong>Starting context by day</strong>
              {initialInputUsage
                ? (
                  <InitialInputChart
                    usage={initialInputUsage}
                    bare
                    showLegend
                    label="Starting context"
                  />
                )
                : (
                  <span className="shape-context-message">
                    {initialInputError ?? "Loading…"}
                  </span>
                )}
            </div>
          </div>
        )}
      </div>
      {multiDay && (
        <small title="Share of sessions with activity on more than one day">
          {multiDay}
        </small>
      )}
    </div>
  );
  if (!distribution) {
    return (
      <tr>
        <th scope="row">{metricLabel}</th>
        <td className="shape-p50">—</td>
        <td className="shape-distribution-cell">No data</td>
      </tr>
    );
  }

  const tooltip = [
    ["P10", distribution.p10],
    ["P25", distribution.p25],
    ["Median", distribution.median],
    ["Mean", distribution.average],
    ["P75", distribution.p75],
    ["P90", distribution.p90],
  ] as const;
  const formatted = (value: number) => formatValue(metric.key, value);
  const ariaLabel = `${label}: ${
    tooltip.map(([name, value]) => `${name} ${formatted(value)}`).join(", ")
  }`;
  const positions = {
    p10: position(distribution.p10, distribution.p10, distribution.p90),
    q1: position(distribution.p25, distribution.p10, distribution.p90),
    median: position(distribution.median, distribution.p10, distribution.p90),
    average: position(distribution.average, distribution.p10, distribution.p90),
    q3: position(distribution.p75, distribution.p10, distribution.p90),
    p90: position(distribution.p90, distribution.p10, distribution.p90),
  };

  return (
    <tr>
      <th scope="row">{metricLabel}</th>
      <td className="shape-p50">
        <strong>{formatted(distribution.median)}</strong>
      </td>
      <td className="shape-distribution-cell">
        <div
          className="shape-distribution"
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
        >
          <span
            className="shape-end shape-end-start"
            style={{ left: `${positions.p10}%` }}
          />
          <span
            className="shape-end shape-end-end"
            style={{ left: `${positions.p90}%` }}
          />
          <span
            className="shape-whisker"
            style={{
              left: `${positions.p10}%`,
              width: `${positions.p90 - positions.p10}%`,
            }}
          />
          <span
            className="shape-iqr"
            style={{
              left: `${positions.q1}%`,
              width: `${positions.q3 - positions.q1}%`,
            }}
          />
          <span
            className="shape-median"
            style={{ left: `${positions.median}%` }}
          />
          <span
            className="shape-average"
            style={{ left: `${positions.average}%` }}
            aria-hidden="true"
          />
          <span className="shape-distribution-tooltip" role="tooltip">
            {tooltip.map(([name, value]) => (
              <span key={name}>
                <small>{name}</small>
                <strong>{formatted(value)}</strong>
              </span>
            ))}
          </span>
        </div>
        <div className="shape-range" aria-hidden="true">
          <span>{formatted(distribution.p10)}</span>
          <span>{formatted(distribution.p90)}</span>
        </div>
      </td>
    </tr>
  );
}

export function SessionShape({
  range,
  harness,
  onDataChange,
}: SessionShapeProps) {
  const [data, setData] = useState<SessionShapeResponse>();
  const [error, setError] = useState<string>();
  const [initialInputUsage, setInitialInputUsage] = useState<UsageResponse>();
  const [initialInputError, setInitialInputError] = useState<string>();

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    setInitialInputError(undefined);
    setInitialInputUsage(undefined);
    onDataChange?.(undefined);
    getSessionShape(range, harness).then((result) => {
      if (active) {
        setData(result);
        onDataChange?.(result);
      }
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load session shape",
        );
        onDataChange?.(undefined);
      }
    });
    getUsage(range, harness).then((result) => {
      if (active) setInitialInputUsage(result);
    }).catch((reason) => {
      if (active) {
        setInitialInputError(
          reason instanceof Error
            ? reason.message
            : "Unable to load initial input",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [range, harness]);

  return (
    <section className="session-shape" aria-labelledby="session-shape-title">
      <div className="dashboard-section-heading">
        <h2 id="session-shape-title">Session shape</h2>
        <div
          className="shape-key"
          role="img"
          aria-label="Distribution key: whiskers show P10 to P90, the box shows P25 to P75, the line is the median, and the diamond is the mean"
        >
          <div className="shape-key-diagram" aria-hidden="true">
            <span className="shape-key-whisker" />
            <span className="shape-key-end shape-key-end-start" />
            <span className="shape-key-end shape-key-end-end" />
            <span className="shape-key-box" />
            <span className="shape-key-median" />
            <span className="shape-key-mean" />
            <span className="shape-key-label shape-key-label-p10">P10</span>
            <span className="shape-key-label shape-key-label-p25">P25</span>
            <span className="shape-key-label shape-key-label-p75">P75</span>
            <span className="shape-key-label shape-key-label-median">
              Median
            </span>
            <span className="shape-key-label shape-key-label-mean">Mean</span>
            <span className="shape-key-label shape-key-label-p90">P90</span>
          </div>
        </div>
      </div>
      {error && <div className="new-overview-error">{error}</div>}
      <div className="session-shape-table-wrap">
        <table
          className="session-shape-table"
          aria-label="Per-session distributions"
        >
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Median</th>
              <th scope="col">Distribution</th>
            </tr>
          </thead>
          <tbody aria-busy={!data && !error}>
            {data
              ? data.metrics.map((metric) => (
                <DistributionStrip
                  metric={metric}
                  multiDaySessionRate={data.multiDaySessionRate}
                  initialInputUsage={initialInputUsage}
                  initialInputError={initialInputError}
                  key={metric.key}
                />
              ))
              : !error && <ShapeLoadingRows />}
          </tbody>
        </table>
      </div>
    </section>
  );
}
