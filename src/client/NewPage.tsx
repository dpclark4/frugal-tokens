import { useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import type { ActivityOverviewResponse } from "../shared/sessionSchemas.ts";
import { getActivityOverview } from "./api.ts";
import { SiteHeader } from "./SiteHeader.tsx";
import "./NewPage.css";

const route = getRouteApi("/new");
const integer = new Intl.NumberFormat("en-US");
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
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

function MetricCell({ label, value, detail, emphasis }: {
  label: string;
  value: string;
  detail: string;
  emphasis?: "spend" | "signal";
}) {
  return (
    <div className={`signal-metric${emphasis ? ` ${emphasis}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

type DistributionMetric = {
  label: string;
  median: string;
  p10: string;
  p90: string;
  detail: string;
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
    label: "Spend / session",
    median: "$0.39",
    p10: "$0.04",
    p90: "$4.71",
    detail: "known spend",
    positions: { p10: 7, q1: 20, median: 32, average: 57, q3: 47, p90: 90 },
  },
  {
    label: "Input processed",
    median: "533K",
    p10: "48K",
    p90: "8.5M",
    detail: "per session",
    positions: { p10: 5, q1: 18, median: 31, average: 62, q3: 49, p90: 91 },
  },
  {
    label: "Turns",
    median: "6",
    p10: "1",
    p90: "20",
    detail: "per session",
    positions: { p10: 4, q1: 17, median: 35, average: 47, q3: 56, p90: 88 },
  },
  {
    label: "Observed span",
    median: "9.8 min",
    p10: "1.2 min",
    p90: "1.4 hr",
    detail: "includes idle time",
    positions: { p10: 6, q1: 16, median: 27, average: 66, q3: 48, p90: 92 },
  },
  {
    label: "Initial input",
    median: "8.0K",
    p10: "4.2K",
    p90: "15.4K",
    detail: "starting context",
    positions: { p10: 9, q1: 24, median: 43, average: 47, q3: 61, p90: 88 },
  },
  {
    label: "Ending context",
    median: "44.6K",
    p10: "9.6K",
    p90: "163K",
    detail: "final model call",
    positions: { p10: 6, q1: 23, median: 44, average: 60, q3: 67, p90: 93 },
  },
  {
    label: "Model calls / turn",
    median: "4.2",
    p10: "1.1",
    p90: "12.9",
    detail: "workflow amplification",
    positions: { p10: 5, q1: 19, median: 36, average: 52, q3: 58, p90: 89 },
  },
  {
    label: "Token reuse / session",
    median: "88.4%",
    p10: "51.2%",
    p90: "96.7%",
    detail: "higher is better",
    positions: { p10: 8, q1: 45, median: 74, average: 61, q3: 86, p90: 95 },
  },
];

function DistributionStrip({ metric }: { metric: DistributionMetric }) {
  const { positions } = metric;
  return (
    <article className="shape-metric">
      <div className="shape-metric-heading">
        <div>
          <h3>{metric.label}</h3>
          <small>{metric.detail}</small>
        </div>
        <strong>{metric.median}</strong>
      </div>
      <div
        className="shape-distribution"
        role="img"
        aria-label={`${metric.label}: median ${metric.median}, P10 ${metric.p10}, P90 ${metric.p90}`}
      >
        <span
          className="shape-whisker"
          style={{ left: `${positions.p10}%`, width: `${positions.p90 - positions.p10}%` }}
        />
        <span
          className="shape-iqr"
          style={{ left: `${positions.q1}%`, width: `${positions.q3 - positions.q1}%` }}
        />
        <span className="shape-median" style={{ left: `${positions.median}%` }} />
        <span
          className="shape-average"
          style={{ left: `${positions.average}%` }}
          title="Mock average"
        />
      </div>
      <div className="shape-range">
        <span>P10 {metric.p10}</span>
        <span>P90 {metric.p90}</span>
      </div>
    </article>
  );
}

function SessionShape() {
  return (
    <section className="session-shape" aria-labelledby="session-shape-title">
      <div className="dashboard-section-heading">
        <div>
          <p className="dashboard-kicker">Per-session distributions</p>
          <h2 id="session-shape-title">Session shape</h2>
        </div>
        <span className="mock-data-badge">Mock data</span>
      </div>
      <p className="shape-key">
        Heavy band is the middle 50% · line is P10–P90 · tick is median · diamond is average
      </p>
      <div className="session-shape-grid">
        {mockSessionMetrics.map((metric) => (
          <DistributionStrip metric={metric} key={metric.label} />
        ))}
      </div>
    </section>
  );
}

function SummaryMatrix({
  data,
  range,
}: {
  data?: ActivityOverviewResponse;
  range: 30 | 90;
}) {
  const costPerMillion = data && data.summary.processedInput > 0
    ? data.summary.spend / (data.summary.processedInput / 1_000_000)
    : undefined;
  const ratePrefix = data?.summary.hasUnpricedCost ? "≥" : "";

  return (
    <section className="signal-summary" aria-labelledby="signal-summary-title">
      <div className="dashboard-section-heading">
        <div>
          <p className="dashboard-kicker">Period totals</p>
          <h2 id="signal-summary-title">{range}-day signal</h2>
        </div>
        <span className="live-data-badge">Live</span>
      </div>
      <div className="signal-matrix">
        <div className="signal-row">
          <span className="signal-row-label">Scale</span>
          <MetricCell
            label={data?.summary.hasUnpricedCost ? "Known spend" : "Spend"}
            value={data ? currency.format(data.summary.spend) : "—"}
            detail={data?.summary.hasUnpricedCost ? "some usage unpriced" : "period total"}
            emphasis="spend"
          />
          <MetricCell
            label="Processed input"
            value={data ? compact.format(data.summary.processedInput) : "—"}
            detail="cumulative tokens"
            emphasis="signal"
          />
        </div>
        <div className="signal-row">
          <span className="signal-row-label">Cadence</span>
          <MetricCell
            label="Sessions"
            value={data ? integer.format(data.summary.sessions) : "—"}
            detail="root sessions"
          />
          <MetricCell
            label="Active days"
            value={data ? `${integer.format(data.summary.activeDays)} / ${range}` : "—"}
            detail="days with work"
          />
        </div>
        <div className="signal-row">
          <span className="signal-row-label">Efficiency</span>
          <MetricCell
            label="Effective cost / 1M"
            value={costPerMillion === undefined
              ? "—"
              : `${ratePrefix}${currency.format(costPerMillion)}`}
            detail="processed input"
          />
          <MetricCell
            label="Token reuse"
            value={data?.summary.tokenReuse === undefined
              ? "—"
              : `${decimal.format(data.summary.tokenReuse * 100)}%`}
            detail="token-weighted"
            emphasis="signal"
          />
        </div>
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
  const label = `${fullDate.format(date)}, ${millionTokens(input)} processed input`;
  return (
    <button
      type="button"
      className={`activity-day heat-${level}${selectedDate === key ? " selected" : ""}`}
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
  for (const date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
    days.push(new Date(date));
  }

  return (
    <section className="activity-month activity-range" aria-label={dateRangeName(start, end)}>
      <h3>{dateRangeName(start, end)}</h3>
      <div className="activity-month-weekdays" aria-hidden="true">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
          <span key={`${day}-${index}`}>{day}</span>
        ))}
      </div>
      <div className="activity-month-days">
        {Array.from({ length: leadingDays }, (_, index) => (
          <span className="activity-day-spacer" key={`spacer-${index}`} />
        ))}
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
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
          <span key={`${day}-${index}`}>{day}</span>
        ))}
      </div>
      <div className="activity-month-days">
        {cells.map((day, index) => {
          if (day === undefined) {
            return <span className="activity-day-spacer" key={`spacer-${index}`} />;
          }
          const date = new Date(month.getFullYear(), month.getMonth(), day);
          const key = dateKey(date);
          const inRange = key >= startDate && key <= endDate;
          if (!inRange) {
            return <span className="activity-day-outside" key={key}>{day}</span>;
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
          <p className="dashboard-kicker">Processed input</p>
          <h2 id="new-calendar-title">Daily workload</h2>
        </div>
      </div>

      <div className="new-calendar-measure">
        <span>Relative to the busiest day</span>
        <div className="activity-heat-key" aria-label="Less to more processed input">
          <small>Less</small>
          {[1, 2, 3, 4, 5].map((level) => (
            <i className={`heat-${level}`} key={level} aria-hidden="true" />
          ))}
          <small>More</small>
        </div>
      </div>

      {!data
        ? <div className="activity-calendar-message">Loading daily activity…</div>
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
                <time dateTime={selectedDate}>{fullDate.format(parseDate(selectedDate))}</time>
                <strong>
                  {selectedDay?.hasUnpricedCost ? "Known spend " : "Spend "}
                  {currency.format(selectedDay?.spend ?? 0)}
                </strong>
              </div>
              <div className="day-detail-metrics">
                <div><span>Processed input</span><strong>{compact.format(selectedDay?.processedInput ?? 0)}</strong></div>
                <div><span>Sessions</span><strong>{integer.format(selectedDay?.sessions ?? 0)}</strong></div>
                <div><span>Turns</span><strong>{integer.format(selectedDay?.turns ?? 0)}</strong></div>
                <div title="Estimated using a 10-minute inactivity window; overlapping activity is counted once.">
                  <span>Estimated active</span>
                  <strong>{approximateDuration(selectedDay?.estimatedActiveMs ?? 0)}</strong>
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
                              {session.turns} turns · {compact.format(session.processedInput)} input
                            </small>
                          </li>
                        ))}
                      </ol>
                    )
                    : <p>No session details</p>}
                </section>
              </div>
              {selectedDay?.hasUnpricedCost && (
                <p className="day-detail-note">Spend excludes usage without known pricing.</p>
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
                  update({ harness: event.target.value as typeof search.harness })}
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
            <SummaryMatrix data={data} range={search.range} />
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
