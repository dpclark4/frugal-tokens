import { useEffect, useState } from "react";
import type { SessionShapeResponse } from "../../shared/sessionSchemas.ts";
import { getSessionShape } from "../api.ts";
import { compact, currency, decimal, integer } from "./formatters.ts";
import "./SessionShape.css";

type DistributionMetric = SessionShapeResponse["metrics"][number];
type MetricKey = DistributionMetric["key"];

type SessionShapeProps = {
  range: 30 | 90;
  harness: string;
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

function DistributionStrip({
  metric,
  multiDaySessionRate,
}: {
  metric: DistributionMetric;
  multiDaySessionRate?: number;
}) {
  const { distribution } = metric;
  const label = metricLabels[metric.key];
  const multiDay = metric.key === "observedSpan" &&
      multiDaySessionRate !== undefined
    ? `${decimal.format(multiDaySessionRate * 100)}% multi-day`
    : undefined;
  if (!distribution) {
    return (
      <tr>
        <th scope="row">
          <div className="shape-metric-label">
            <span>{label}</span>
            {multiDay && <small>{multiDay}</small>}
          </div>
        </th>
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
      <th scope="row">
        <div className="shape-metric-label">
          <span>{label}</span>
          {multiDay && <small>{multiDay}</small>}
        </div>
      </th>
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

export function SessionShape({ range, harness }: SessionShapeProps) {
  const [data, setData] = useState<SessionShapeResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    getSessionShape(range, harness).then((result) => {
      if (active) setData(result);
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to load session shape",
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
        <div className="session-shape-title">
          <h2 id="session-shape-title">Session shape</h2>
          <button
            type="button"
            className="shape-info"
            aria-label="About session shape distributions"
          >
            <span aria-hidden="true">i</span>
            <span className="shape-info-tooltip">
              <span>Box P25–P75 · whiskers P10–P90 · line median · ◇ mean</span>
              <span>Root sessions in the selected period</span>
            </span>
          </button>
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
              <th scope="col">Distribution · P10–P90</th>
            </tr>
          </thead>
          <tbody>
            {data?.metrics.map((metric) => (
              <DistributionStrip
                metric={metric}
                multiDaySessionRate={data.multiDaySessionRate}
                key={metric.key}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
