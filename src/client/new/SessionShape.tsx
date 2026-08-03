import "./SessionShape.css";

type DistributionMetric = {
  label: string;
  median: string;
  p10: string;
  p25: string;
  p75: string;
  p90: string;
  average: string;
  detail?: string;
  positions: {
    p10: number;
    q1: number;
    median: number;
    average: number;
    q3: number;
    p90: number;
  };
};

const mockSessionMetrics: DistributionMetric[] = [
  {
    label: "Cost / session",
    median: "$0.39",
    p10: "$0.04",
    p25: "$0.12",
    p75: "$0.88",
    p90: "$4.71",
    average: "$1.18",
    detail: "priced usage only",
    positions: {
      p10: 7,
      q1: 20,
      median: 32,
      average: 57,
      q3: 47,
      p90: 90,
    },
  },
  {
    label: "Processed input / session",
    median: "533K",
    p10: "48K",
    p25: "180K",
    p75: "1.4M",
    p90: "8.5M",
    average: "1.9M",
    detail: "cumulative across model calls",
    positions: {
      p10: 5,
      q1: 18,
      median: 31,
      average: 62,
      q3: 49,
      p90: 91,
    },
  },
  {
    label: "User turns / session",
    median: "6",
    p10: "1",
    p25: "3",
    p75: "11",
    p90: "20",
    average: "8.7",
    positions: {
      p10: 4,
      q1: 17,
      median: 35,
      average: 47,
      q3: 56,
      p90: 88,
    },
  },
  {
    label: "Observed span / session",
    median: "9.8 min",
    p10: "1.2 min",
    p25: "3.4 min",
    p75: "28 min",
    p90: "1.4 hr",
    average: "22 min",
    detail: "first to last event · includes idle time",
    positions: {
      p10: 6,
      q1: 16,
      median: 27,
      average: 66,
      q3: 48,
      p90: 92,
    },
  },
  {
    label: "Starting context",
    median: "8.0K",
    p10: "4.2K",
    p25: "6.0K",
    p75: "11.0K",
    p90: "15.4K",
    average: "9.1K",
    detail: "input on first model call",
    positions: {
      p10: 9,
      q1: 24,
      median: 43,
      average: 47,
      q3: 61,
      p90: 88,
    },
  },
  {
    label: "Peak context",
    median: "71K",
    p10: "9.6K",
    p25: "28K",
    p75: "104K",
    p90: "163K",
    average: "82K",
    detail: "largest input on any model call",
    positions: {
      p10: 6,
      q1: 23,
      median: 44,
      average: 60,
      q3: 67,
      p90: 93,
    },
  },
  {
    label: "Token reuse",
    median: "88.4%",
    p10: "51.2%",
    p25: "76.0%",
    p75: "93.2%",
    p90: "96.7%",
    average: "81.7%",
    detail: "share of processed input served from cache",
    positions: {
      p10: 8,
      q1: 45,
      median: 74,
      average: 61,
      q3: 86,
      p90: 95,
    },
  },
];

function DistributionStrip({ metric }: { metric: DistributionMetric }) {
  const { positions } = metric;
  const tooltip = [
    ["P10", metric.p10],
    ["P25", metric.p25],
    ["Median", metric.median],
    ["Mean", metric.average],
    ["P75", metric.p75],
    ["P90", metric.p90],
  ];
  const ariaLabel = `${metric.label}: ${
    tooltip.map(([label, value]) => `${label} ${value}`).join(", ")
  }`;
  return (
    <tr>
      <th scope="row">
        <div className="shape-metric-label">
          <span>{metric.label}</span>
          {metric.detail && <small>{metric.detail}</small>}
        </div>
      </th>
      <td className="shape-p50">
        <strong>{metric.median}</strong>
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
            {tooltip.map(([label, value]) => (
              <span key={label}>
                <small>{label}</small>
                <strong>{value}</strong>
              </span>
            ))}
          </span>
        </div>
        <div className="shape-range" aria-hidden="true">
          <span>P10 {metric.p10}</span>
          <span>P90 {metric.p90}</span>
        </div>
      </td>
    </tr>
  );
}

export function SessionShape() {
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
              Each row summarizes sessions in the selected period. Box =
              P25–P75, whisker = P10–P90, vertical tick = median, diamond =
              mean.
            </span>
          </button>
        </div>
        <div className="session-shape-meta">
          <span className="mock-data-badge">Mock data</span>
          <span className="shape-sample-size">n=238</span>
        </div>
      </div>
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
          <tbody>
            {mockSessionMetrics.map((metric) => (
              <DistributionStrip metric={metric} key={metric.label} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

