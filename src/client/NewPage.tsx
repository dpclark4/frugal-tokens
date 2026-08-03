import { useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type { ActivityOverviewResponse } from "../shared/sessionSchemas.ts";
import { getActivityOverview } from "./api.ts";
import { SiteHeader } from "./SiteHeader.tsx";
import "./NewPage.css";

const route = getRouteApi("/new");
const integer = new Intl.NumberFormat("en-US");
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const oneDecimal = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const monthName = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});
const fullDate = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

function dateRangeName(start: Date, end: Date) {
  const startMonth = start.toLocaleDateString(undefined, { month: "long" });
  const endMonth = end.toLocaleDateString(undefined, { month: "long" });
  if (start.getFullYear() !== end.getFullYear()) {
    return `${startMonth} ${start.getDate()}, ${start.getFullYear()} – ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
  }
  if (start.getMonth() === end.getMonth()) {
    return `${startMonth} ${start.getDate()}–${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${startMonth} ${start.getDate()} – ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
}

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function millionTokens(value: number) {
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function approximateDuration(value: number) {
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `~${hours}h${remainder === 0 ? "" : ` ${remainder}m`}`;
}

type SummaryMetricProps = {
  label: string;
  value: string;
  detail?: string;
  comparison?: string;
  emphasis?: "signal";
};

function SummaryMetric({
  label,
  value,
  detail,
  comparison,
  emphasis,
}: SummaryMetricProps) {
  return (
    <div className={`summary-metric${emphasis ? ` ${emphasis}` : ""}`}>
      <span className="summary-metric-label">{label}</span>
      <strong>{value}</strong>
      {detail && <small className="summary-metric-detail">{detail}</small>}
      {comparison && (
        <small className="summary-metric-comparison">{comparison}</small>
      )}
    </div>
  );
}

function SummarySecondary({
  label,
  value,
  detail,
  valueTitle,
  info,
}: {
  label: string;
  value: string;
  detail: string;
  valueTitle?: string;
  info?: string;
}) {
  return (
    <div className="summary-secondary">
      <div className="summary-secondary-label">
        <span>{label}</span>
        {info && (
          <button
            type="button"
            className="summary-secondary-info"
            aria-label={`About ${label.toLowerCase()}`}
          >
            <span aria-hidden="true">i</span>
            <span className="summary-secondary-tooltip">{info}</span>
          </button>
        )}
      </div>
      <strong title={valueTitle}>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

// TODO: Replace these temporary UI values with a true preceding-period query
// and cache/subagent aggregates from the API.
const mockSummaryComparisons = {
  spend: "+18% vs previous 30d",
  sessions: "+12% vs previous 30d",
  processedInput: "+21% vs previous 30d",
  tokenReuse: "+0.4 pp vs previous 30d",
  spendCoverageComparable: true,
};

const mockSummarySecondary = {
  cacheMissSessions: 149,
  cacheMissShare: "61.1%",
  missCost: 21.79,
  subagentSpend: 24.18,
  subagentShare: "5.6% of priced spend",
};

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

function SessionShape() {
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

function SummaryMatrix({ data }: { data?: ActivityOverviewResponse }) {
  const costPerMillion = data && data.summary.processedInput > 0
    ? data.summary.spend / (data.summary.processedInput / 1_000_000)
    : undefined;
  const sessionsPerActiveDay = data && data.summary.activeDays > 0
    ? data.summary.sessions / data.summary.activeDays
    : undefined;
  const showComparisons = data?.rangeDays === 30;
  const spendDetail = !data
    ? "Loading…"
    : data.summary.hasUnpricedCost
    ? "excludes unpriced usage"
    : "all usage priced";
  const effectiveRate = costPerMillion === undefined
    ? "—"
    : `${currency.format(costPerMillion)} / 1M processed`;
  const effectiveRateDetail = data ? "based on priced spend" : "Loading…";
  const sessionDetail = !data
    ? "Loading…"
    : sessionsPerActiveDay === undefined
    ? "no active days"
    : `${integer.format(data.summary.activeDays)} active days · ${
      oneDecimal.format(sessionsPerActiveDay)
    }/day`;

  return (
    <section className="signal-summary" aria-labelledby="signal-summary-title">
      <div className="dashboard-section-heading summary-heading">
        <h2 id="signal-summary-title">Usage overview</h2>
      </div>
      <div className="summary-metrics">
        <SummaryMetric
          label="Priced spend"
          value={data ? currency.format(data.summary.spend) : "—"}
          detail={spendDetail}
          comparison={showComparisons &&
              mockSummaryComparisons.spendCoverageComparable
            ? mockSummaryComparisons.spend
            : undefined}
        />
        <SummaryMetric
          label="Sessions"
          value={data ? integer.format(data.summary.sessions) : "—"}
          detail={sessionDetail}
          comparison={showComparisons
            ? mockSummaryComparisons.sessions
            : undefined}
        />
        <SummaryMetric
          label="Processed input"
          value={data ? compact.format(data.summary.processedInput) : "—"}
          detail={data ? "across model calls" : "Loading…"}
          comparison={showComparisons
            ? mockSummaryComparisons.processedInput
            : undefined}
        />
        <SummaryMetric
          label="Token reuse"
          value={data?.summary.tokenReuse === undefined
            ? "—"
            : `${decimal.format(data.summary.tokenReuse * 100)}%`}
          detail={data ? "token-weighted" : "Loading…"}
          comparison={showComparisons
            ? mockSummaryComparisons.tokenReuse
            : undefined}
          emphasis="signal"
        />
      </div>
      <div className="summary-secondary-row">
        <SummarySecondary
          label="Minimum effective rate"
          value={effectiveRate}
          detail={effectiveRateDetail}
          info="Priced spend divided by all processed input. This is a lower bound because some usage could not be priced."
        />
        <SummarySecondary
          label="Cache misses"
          value={`${
            integer.format(mockSummarySecondary.cacheMissSessions)
          } sessions · ${mockSummarySecondary.cacheMissShare}`}
          valueTitle="149 of 244 sessions had at least one classified cache miss. $21.79 is spend observed at miss calls, not necessarily avoidable cost."
          detail={`${
            currency.format(mockSummarySecondary.missCost)
          } at miss calls`}
        />
        <SummarySecondary
          label="Subagents"
          value={`${currency.format(mockSummarySecondary.subagentSpend)} spend`}
          detail={mockSummarySecondary.subagentShare}
        />
      </div>
    </section>
  );
}

function monthStarts(startDate: string, endDate: string) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  const months: Date[] = [];
  for (
    let month = new Date(start.getFullYear(), start.getMonth(), 1);
    month <= end;
    month = new Date(month.getFullYear(), month.getMonth() + 1, 1)
  ) {
    months.push(month);
  }
  return months;
}

function heatLevel(value: number, activeValues: number[]) {
  if (value === 0 || activeValues.length === 0) return 0;
  const logs = activeValues.map((item) => Math.log1p(item));
  const minimum = Math.min(...logs);
  const maximum = Math.max(...logs);
  if (minimum === maximum) return 5;
  return 1 + Math.round(
    ((Math.log1p(value) - minimum) / (maximum - minimum)) * 4,
  );
}

function ActivityDay({
  date,
  inputByDate,
  activeValues,
  selectedDate,
  onSelect,
  showValue = false,
}: {
  date: Date;
  inputByDate: Map<string, number>;
  activeValues: number[];
  selectedDate?: string;
  onSelect: (date: string) => void;
  showValue?: boolean;
}) {
  const key = dateKey(date);
  const input = inputByDate.get(key) ?? 0;
  const level = heatLevel(input, activeValues);
  const label = `${fullDate.format(date)}, ${
    millionTokens(input)
  } processed input`;
  return (
    <button
      type="button"
      className={`activity-day heat-${level}${
        selectedDate === key ? " selected" : ""
      }`}
      aria-label={label}
      aria-pressed={selectedDate === key}
      title={label}
      onClick={() => onSelect(key)}
    >
      <span>{date.getDate()}</span>
      {showValue && <small>{input === 0 ? "0" : millionTokens(input)}</small>}
    </button>
  );
}

function ActivityRange({
  startDate,
  endDate,
  inputByDate,
  activeValues,
  selectedDate,
  onSelect,
}: {
  startDate: string;
  endDate: string;
  inputByDate: Map<string, number>;
  activeValues: number[];
  selectedDate?: string;
  onSelect: (date: string) => void;
}) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  const leadingDays = (start.getDay() + 6) % 7;
  const days: Date[] = [];
  for (
    const date = new Date(start);
    date <= end;
    date.setDate(date.getDate() + 1)
  ) {
    days.push(new Date(date));
  }

  return (
    <section
      className="activity-month activity-range"
      aria-label={dateRangeName(start, end)}
    >
      <h3>{dateRangeName(start, end)}</h3>
      <div className="activity-month-weekdays" aria-hidden="true">
        {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
          <span key={`${day}-${index}`}>{day}</span>
        ))}
      </div>
      <div className="activity-month-days">
        {Array.from(
          { length: leadingDays },
          (_, index) => (
            <span className="activity-day-spacer" key={`spacer-${index}`} />
          ),
        )}
        {days.map((date) => (
          <ActivityDay
            key={dateKey(date)}
            date={date}
            inputByDate={inputByDate}
            activeValues={activeValues}
            selectedDate={selectedDate}
            onSelect={onSelect}
            showValue
          />
        ))}
      </div>
    </section>
  );
}

function ActivityMonth({
  month,
  startDate,
  endDate,
  inputByDate,
  activeValues,
  selectedDate,
  onSelect,
}: {
  month: Date;
  startDate: string;
  endDate: string;
  inputByDate: Map<string, number>;
  activeValues: number[];
  selectedDate?: string;
  onSelect: (date: string) => void;
}) {
  const daysInMonth = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0,
  ).getDate();
  const leadingDays = (month.getDay() + 6) % 7;
  const cells = [
    ...Array.from({ length: leadingDays }, () => undefined),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];

  return (
    <section className="activity-month" aria-label={monthName.format(month)}>
      <h3>{monthName.format(month)}</h3>
      <div className="activity-month-weekdays" aria-hidden="true">
        {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
          <span key={`${day}-${index}`}>{day}</span>
        ))}
      </div>
      <div className="activity-month-days">
        {cells.map((day, index) => {
          if (day === undefined) {
            return (
              <span className="activity-day-spacer" key={`spacer-${index}`} />
            );
          }
          const date = new Date(month.getFullYear(), month.getMonth(), day);
          const key = dateKey(date);
          const inRange = key >= startDate && key <= endDate;
          if (!inRange) {
            return (
              <span className="activity-day-outside" key={key}>{day}</span>
            );
          }
          return (
            <ActivityDay
              key={key}
              date={date}
              inputByDate={inputByDate}
              activeValues={activeValues}
              selectedDate={selectedDate}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </section>
  );
}

function ActivityCalendar({ data }: { data?: ActivityOverviewResponse }) {
  const [selectedDate, setSelectedDate] = useState<string>();

  useEffect(() => setSelectedDate(undefined), [data]);

  const inputByDate = new Map(
    data?.days.map((day) => [day.date, day.processedInput]) ?? [],
  );
  const activeValues = data?.days.map((day) => day.processedInput).filter(
    (value) => value > 0,
  ) ?? [];
  const selectedDay = selectedDate === undefined
    ? undefined
    : data?.days.find((day) => day.date === selectedDate);

  return (
    <section className="new-calendar" aria-labelledby="new-calendar-title">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="new-calendar-title">Activity by day</h2>
        </div>
      </div>

      <div className="new-calendar-measure">
        <span>Processed input · log-scaled within this period</span>
        <div
          className="activity-heat-key"
          aria-label="Less to more processed input on a logarithmic scale"
        >
          <small>Less</small>
          {[1, 2, 3, 4, 5].map((level) => (
            <i className={`heat-${level}`} key={level} aria-hidden="true" />
          ))}
          <small>More</small>
        </div>
      </div>

      {!data
        ? (
          <div className="activity-calendar-message">
            Loading daily activity…
          </div>
        )
        : (
          <div className={`activity-calendar-months range-${data.rangeDays}`}>
            {data.rangeDays === 30
              ? (
                <ActivityRange
                  startDate={data.startDate}
                  endDate={data.endDate}
                  inputByDate={inputByDate}
                  activeValues={activeValues}
                  selectedDate={selectedDate}
                  onSelect={setSelectedDate}
                />
              )
              : monthStarts(data.startDate, data.endDate).map((month) => (
                <ActivityMonth
                  key={`${month.getFullYear()}-${month.getMonth()}`}
                  month={month}
                  startDate={data.startDate}
                  endDate={data.endDate}
                  inputByDate={inputByDate}
                  activeValues={activeValues}
                  selectedDate={selectedDate}
                  onSelect={setSelectedDate}
                />
              ))}
          </div>
        )}

      <div className={`new-day-detail${selectedDate ? " selected" : ""}`}>
        {selectedDate === undefined
          ? (
            <>
              <span>Day detail</span>
              <strong>Select a date</strong>
            </>
          )
          : (
            <>
              <div className="day-detail-heading">
                <time dateTime={selectedDate}>
                  {fullDate.format(parseDate(selectedDate))}
                </time>
                <strong>
                  {selectedDay?.hasUnpricedCost ? "Known spend " : "Spend "}
                  {currency.format(selectedDay?.spend ?? 0)}
                </strong>
              </div>
              <div className="day-detail-metrics">
                <div>
                  <span>Processed input</span>
                  <strong>
                    {compact.format(selectedDay?.processedInput ?? 0)}
                  </strong>
                </div>
                <div>
                  <span>Sessions</span>
                  <strong>
                    {integer.format(selectedDay?.sessions ?? 0)}
                  </strong>
                </div>
                <div>
                  <span>Turns</span>
                  <strong>{integer.format(selectedDay?.turns ?? 0)}</strong>
                </div>
                <div title="Estimated using a 10-minute inactivity window; overlapping activity is counted once.">
                  <span>Estimated active</span>
                  <strong>
                    {approximateDuration(selectedDay?.estimatedActiveMs ?? 0)}
                  </strong>
                </div>
              </div>
              <div className="day-detail-breakdowns">
                <section>
                  <h3>Top models by spend</h3>
                  {selectedDay?.models.length
                    ? (
                      <ol>
                        {selectedDay.models.map((model) => (
                          <li key={model.model}>
                            <span>{model.model}</span>
                            <strong>{currency.format(model.spend)}</strong>
                          </li>
                        ))}
                      </ol>
                    )
                    : <p>No model details</p>}
                </section>
                <section>
                  <h3>Top sessions by spend</h3>
                  {selectedDay?.topSessions.length
                    ? (
                      <ol>
                        {selectedDay.topSessions.map((session) => (
                          <li key={session.id}>
                            <span title={session.title}>{session.title}</span>
                            <strong>{currency.format(session.spend)}</strong>
                            <small>
                              {session.turns} turns ·{" "}
                              {compact.format(session.processedInput)} input
                            </small>
                          </li>
                        ))}
                      </ol>
                    )
                    : <p>No session details</p>}
                </section>
              </div>
              {selectedDay?.hasUnpricedCost && (
                <p className="day-detail-note">
                  Spend excludes usage without known pricing.
                </p>
              )}
            </>
          )}
      </div>
    </section>
  );
}

export function NewPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [data, setData] = useState<ActivityOverviewResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    getActivityOverview(search.range, search.harness).then((result) => {
      if (active) setData(result);
    }).catch((reason) => {
      if (active) {
        setError(
          reason instanceof Error ? reason.message : "Unable to load overview",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [search.range, search.harness]);

  function update(next: Partial<typeof search>) {
    navigate({ search: { ...search, ...next }, resetScroll: false });
  }

  return (
    <main className="new-page">
      <SiteHeader active="new" />

      <section className="new-overview-panel">
        <div className="new-overview-toolbar">
          <span className="new-toolbar-label">Overview scope</span>
          <div className="new-overview-controls">
            <div className="segmented" aria-label="Overview range">
              {([30, 90] as const).map((range) => (
                <button
                  key={range}
                  type="button"
                  className={search.range === range ? "active" : undefined}
                  aria-pressed={search.range === range}
                  onClick={() => update({ range })}
                >
                  {range}D
                </button>
              ))}
            </div>
            <label className="new-harness-control">
              <span>Harness</span>
              <select
                value={search.harness}
                onChange={(event) =>
                  update({
                    harness: event.target.value as typeof search.harness,
                  })}
              >
                <option value="all">All harnesses</option>
                <option value="claude-code">Claude Code</option>
                <option value="opencode">OpenCode</option>
                <option value="pi">PI</option>
                <option value="codex">Codex</option>
              </select>
            </label>
          </div>
        </div>

        {error && <div className="new-overview-error">{error}</div>}

        <div className="new-overview-grid">
          <div className="new-overview-left">
            <SummaryMatrix data={data} />
            <SessionShape />
          </div>
          <ActivityCalendar data={data} />
        </div>
      </section>

      <section className="new-next-section" aria-labelledby="new-spend-title">
        <div>
          <p className="dashboard-kicker">Next question</p>
          <h2 id="new-spend-title">What made up the spend?</h2>
        </div>
        <p>Spend composition starts here in the next pass.</p>
      </section>
    </main>
  );
}
