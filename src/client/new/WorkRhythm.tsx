import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  WorkRhythmData,
  WorkRhythmDay,
  WorkRhythmSession,
} from "./workRhythmTypes.ts";
import { displayModelName } from "../../shared/modelNames.ts";
import { compact, currency, decimal, integer } from "./formatters.ts";
import "./WorkRhythm.css";

const readableDate = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const monthYear = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});
const timeOnly = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const shortMonth = new Intl.DateTimeFormat(undefined, { month: "short" });
const fullMonthDay = new Intl.DateTimeFormat(undefined, {
  month: "long",
  day: "numeric",
});

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

function formatDuration(minutes: number, compactTotal = false) {
  if (compactTotal && minutes > 24 * 60) {
    return `${(minutes / (24 * 60)).toFixed(1)}d`;
  }
  if (compactTotal && minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${hours}h${remainder ? ` ${remainder}m` : ""}`;
}

function formatHour(hour: number) {
  const normalized = ((hour % 24) + 24) % 24;
  if (normalized === 0) return "12 AM";
  if (normalized === 12) return "12 PM";
  return `${normalized % 12} ${normalized < 12 ? "AM" : "PM"}`;
}

function formatHourTick(hour: number) {
  if (hour === 0) return "12a";
  if (hour === 6) return "6a";
  if (hour === 12) return "12p";
  if (hour === 18) return "6p";
  return "";
}

function hourRange(hour: number) {
  return `${formatHour(hour)}–${formatHour(hour + 1)}`;
}

type WeekdayRow = WorkRhythmData["weekdayActivity"][number];
type HourlyRow = WorkRhythmData["hourlyActivity"][number];

function WeekdayTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ payload?: WeekdayRow }>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rhythm-tooltip">
      <strong>{row.label}</strong>
      <span>{formatDuration(row.averageMinutes)} average per {row.label}</span>
      <span>
        {formatDuration(row.totalMinutes)} total across {row.occurrences}{" "}
        {row.label}s
      </span>
      <span>
        {row.activeOccurrences} of {row.occurrences} {row.label}s active
      </span>
    </div>
  );
}

function HourlyTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ payload?: HourlyRow }>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rhythm-tooltip">
      <strong>{hourRange(row.hour)}</strong>
      <span>{formatDuration(row.estimatedMinutes)} estimated active</span>
      <span>{(row.shareOfTotal * 100).toFixed(1)}% of observed activity</span>
      <span>Active on {row.activeDates} days</span>
    </div>
  );
}

function WeekdayChart({ data }: { data: WorkRhythmData["weekdayActivity"] }) {
  const summary = data.map((row) =>
    `${row.label} ${formatDuration(row.averageMinutes)}`
  ).join(", ");
  return (
    <div
      className="weekday-chart"
      role="img"
      tabIndex={0}
      aria-label={`Average estimated active time per weekday occurrence: ${summary}.`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 2, right: 76, bottom: 2, left: 4 }}
        >
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis
            type="category"
            dataKey="label"
            width={40}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#52615d", fontSize: 11, fontFamily: "var(--mono)" }}
          />
          <Tooltip
            cursor={{ fill: "rgba(15, 113, 105, .045)" }}
            content={(props) => (
              <WeekdayTooltip
                active={props.active}
                payload={props.payload as Array<{ payload?: WeekdayRow }>}
              />
            )}
          />
          <Bar
            dataKey="averageMinutes"
            fill="var(--dashboard-signal)"
            fillOpacity={0.76}
            barSize={12}
            radius={[0, 2, 2, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
      <div className="weekday-values" aria-hidden="true">
        {data.map((row) => (
          <span key={row.weekday}>{formatDuration(row.averageMinutes)}</span>
        ))}
      </div>
    </div>
  );
}

function HourlyChart({ data }: { data: WorkRhythmData["hourlyActivity"] }) {
  const peak = data.reduce(
    (best, row) => row.estimatedMinutes > best.estimatedMinutes ? row : best,
    data[0],
  );
  const hasActivity = peak.estimatedMinutes > 0;
  return (
    <div
      className="hourly-chart"
      role="img"
      tabIndex={0}
      aria-label={hasActivity
        ? `Estimated active time by hour. Peak is ${hourRange(peak.hour)} at ${
          formatDuration(peak.estimatedMinutes)
        }.`
        : "No estimated activity by hour."}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 3, right: 6, bottom: 0, left: 6 }}
          barCategoryGap="18%"
        >
          <XAxis
            dataKey="hour"
            height={20}
            ticks={[0, 6, 12, 18]}
            interval={0}
            tickFormatter={formatHourTick}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#6f7d78", fontSize: 11, fontFamily: "var(--mono)" }}
          />
          <YAxis hide domain={[0, "dataMax"]} />
          <Tooltip
            cursor={{ fill: "rgba(15, 113, 105, .045)" }}
            content={(props) => (
              <HourlyTooltip
                active={props.active}
                payload={props.payload as Array<{ payload?: HourlyRow }>}
              />
            )}
          />
          <Bar
            dataKey="estimatedMinutes"
            fill="var(--dashboard-signal)"
            fillOpacity={0.72}
            radius={[1.5, 1.5, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function monthIndex(date: Date) {
  return date.getFullYear() * 12 + date.getMonth();
}

function calendarCells(month: Date) {
  const leading =
    (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0)
    .getDate();
  return [
    ...Array.from({ length: leading }, () => undefined),
    ...Array.from(
      { length: count },
      (_, index) => new Date(month.getFullYear(), month.getMonth(), index + 1),
    ),
  ];
}

function CompactCalendar({ data, selectedDate, onSelect }: {
  data: WorkRhythmData;
  selectedDate: string;
  onSelect: (date: string) => void;
}) {
  const rangeStart = parseDate(data.range.start);
  const rangeEnd = parseDate(data.range.end);
  const firstMonth = monthIndex(rangeStart);
  const lastMonth = monthIndex(rangeEnd);
  const [visibleMonth, setVisibleMonth] = useState(() =>
    new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), 1)
  );

  useEffect(
    () =>
      setVisibleMonth(new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), 1)),
    [data.range.end],
  );

  const visibleIndex = monthIndex(visibleMonth);
  const today = dateKey(new Date());
  return (
    <div className="rhythm-calendar" aria-label="Choose a day to explore">
      <div className="rhythm-calendar-nav">
        <button
          type="button"
          disabled={visibleIndex <= firstMonth}
          onClick={() =>
            setVisibleMonth(
              new Date(
                visibleMonth.getFullYear(),
                visibleMonth.getMonth() - 1,
                1,
              ),
            )}
          aria-label="Previous month"
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <strong>{monthYear.format(visibleMonth)}</strong>
        <button
          type="button"
          disabled={visibleIndex >= lastMonth}
          onClick={() =>
            setVisibleMonth(
              new Date(
                visibleMonth.getFullYear(),
                visibleMonth.getMonth() + 1,
                1,
              ),
            )}
          aria-label="Next month"
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="rhythm-calendar-weekdays" aria-hidden="true">
        {["M", "T", "W", "T", "F", "S", "S"].map((label, index) => (
          <span key={`${label}-${index}`}>{label}</span>
        ))}
      </div>
      <div className="rhythm-calendar-days">
        {calendarCells(visibleMonth).map((date, index) => {
          if (!date) return <span key={`empty-${index}`} aria-hidden="true" />;
          const key = dateKey(date);
          const day = data.days[key];
          const disabled = key < data.range.start || key > data.range.end;
          const activity = day?.estimatedActiveMinutes ?? 0;
          const label = `${readableDate.format(date)}, ${
            formatDuration(activity)
          } estimated active${disabled ? ", outside report range" : ""}`;
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              className={`rhythm-calendar-day intensity-${day?.intensity ?? 0}${
                selectedDate === key ? " selected" : ""
              }${today === key ? " today" : ""}`}
              aria-label={label}
              aria-pressed={selectedDate === key}
              onClick={() => onSelect(key)}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const harnessNames: Record<WorkRhythmSession["harness"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
  opencode: "OpenCode",
};

function sessionName(session: WorkRhythmSession) {
  const title = session.title?.trim();
  if (title) return title;
  return `${harnessNames[session.harness]} session · ${
    timeOnly.format(new Date(session.startTime))
  }`;
}

function sessionDateSpan(session: WorkRhythmSession) {
  const { start, end } = session.activeDateRange;
  if (start === end) return undefined;
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth()
  ) {
    return `${
      shortMonth.format(startDate)
    } ${startDate.getDate()}–${endDate.getDate()}`;
  }
  return `${shortMonth.format(startDate)} ${startDate.getDate()}–${
    shortMonth.format(endDate)
  } ${endDate.getDate()}`;
}

function sessionDateExplanation(
  session: WorkRhythmSession,
  selectedDate: string,
) {
  const { start, end } = session.activeDateRange;
  if (selectedDate === start) {
    return `This session continued into ${
      fullMonthDay.format(parseDate(end))
    }.`;
  }
  if (selectedDate === end) {
    return `This session began on ${fullMonthDay.format(parseDate(start))}.`;
  }
  return `This session ran from ${
    fullMonthDay.format(parseDate(start))
  } through ${fullMonthDay.format(parseDate(end))}.`;
}

function DayDetail({ day }: { day: WorkRhythmDay }) {
  const navigate = useNavigate();

  function openSession(session: WorkRhythmSession) {
    navigate({
      to: "/sessions/$harness/$sessionId",
      params: { harness: session.harness, sessionId: session.id },
      search: {
        misses: undefined,
        paths: "relative",
        color: "time",
        model: "recorded",
        thinking: "recorded",
      },
    });
  }

  return (
    <div className="rhythm-day-detail">
      <div
        className="rhythm-day-metrics"
        aria-label={`Summary for ${readableDate.format(parseDate(day.date))}`}
      >
        <div>
          <span>Estimated active</span>
          <strong>{formatDuration(day.estimatedActiveMinutes)}</strong>
        </div>
        <div>
          <span>Root sessions</span>
          <strong>{integer.format(day.rootSessions)}</strong>
        </div>
        <div
          title={day.hasUnpricedSpend
            ? "Known spend excludes usage without available pricing."
            : undefined}
        >
          <span>{day.hasUnpricedSpend ? "Known spend" : "Spend"}</span>
          <strong>{currency.format(day.spend)}</strong>
        </div>
        <div>
          <span>Processed input</span>
          <strong>{compact.format(day.processedInputTokens)}</strong>
        </div>
      </div>
      <section
        className="expensive-sessions"
        aria-labelledby="expensive-sessions-title"
      >
        <div className="expensive-sessions-heading">
          <h4 id="expensive-sessions-title">Highest spend this day</h4>
          <button
            type="button"
            onClick={() =>
              navigate({
                to: "/",
                search: { harness: "all", range: 30, misses: undefined },
              })}
          >
            View all sessions
          </button>
        </div>
        {day.topSessions.length
          ? (
            <ol>
              {day.topSessions.slice(0, 3).map((session, index) => {
                const span = sessionDateSpan(session);
                const tooltipId = span
                  ? `session-spend-scope-${day.date}-${index}`
                  : undefined;
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      onClick={() => openSession(session)}
                      aria-describedby={tooltipId}
                      aria-label={`Open ${sessionName(session)}, ${
                        currency.format(session.spend)
                      } on this date${
                        session.totalSpend !== session.spend
                          ? `, ${currency.format(session.totalSpend)} total`
                          : ""
                      }`}
                    >
                      <span className="session-row-copy">
                        <strong>{sessionName(session)}</strong>
                        <small className="session-meta">
                          <span className="session-meta-main">
                            {harnessNames[session.harness]}
                            {session.model
                              ? ` · ${displayModelName(session.model)}`
                              : ""}
                          </span>
                          {span && (
                            <span className="session-date-scope">
                              ·{" "}
                              <span className="session-date-scope-label">
                                spans {span}
                              </span>
                              <span
                                className="session-spend-tooltip"
                                id={tooltipId}
                                role="tooltip"
                              >
                                <span>
                                  <span>
                                    Spend on{" "}
                                    {fullMonthDay.format(parseDate(day.date))}
                                  </span>
                                  <strong>
                                    {currency.format(session.spend)}
                                    {session.hasUnpricedSpend ? "*" : ""}
                                  </strong>
                                </span>
                                <span>
                                  <span>Entire session</span>
                                  <strong>
                                    {currency.format(session.totalSpend)}
                                    {session.hasUnpricedTotalSpend ? "*" : ""}
                                  </strong>
                                </span>
                                <em>
                                  {sessionDateExplanation(session, day.date)}
                                </em>
                              </span>
                            </span>
                          )}
                        </small>
                      </span>
                      <span
                        className="session-spend"
                        title={session.hasUnpricedSpend
                          ? "Known spend excludes usage without available pricing."
                          : undefined}
                      >
                        <strong>
                          {currency.format(session.spend)}
                          {session.hasUnpricedSpend ? "*" : ""}
                        </strong>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )
          : <p>No sessions on this date.</p>}
      </section>
    </div>
  );
}

function MethodologyTip({ label, children }: {
  label: string;
  children: string;
}) {
  return (
    <span className="structure-methodology" tabIndex={0} aria-label={label}>
      <Info size={11} aria-hidden="true" />
      <span role="tooltip">{children}</span>
    </span>
  );
}

function ParallelWork({ data }: { data: WorkRhythmData["parallelWork"] }) {
  const rows = [
    ["1 session", data.activeTimeShare.oneSession],
    ["2 sessions", data.activeTimeShare.twoSessions],
    ["3+ sessions", data.activeTimeShare.threePlusSessions],
  ] as const;
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <section
      className="work-structure-unit"
      aria-labelledby="parallel-work-title"
    >
      <header className="structure-heading">
        <h3 id="parallel-work-title">Parallel work</h3>
        <MethodologyTip label="Parallel work methodology">
          Concurrency is measured only where estimated active-work windows from
          different root sessions overlap. Subagents and idle session lifetime
          are excluded.
        </MethodologyTip>
      </header>
      <div className="parallel-summary">
        <strong>{percent(data.overlappingShare)}</strong>
        <span>
          active time<br />overlapping
        </span>
        <span className="parallel-peak">
          Peak <b>{integer.format(data.peakConcurrentSessions)}</b>
        </span>
      </div>
      <div className="concurrency-bars">
        {rows.map(([label, value]) => (
          <div className="concurrency-row" key={label}>
            <span>{label}</span>
            <i aria-hidden="true">
              <b style={{ width: `${value * 100}%` }} />
            </i>
            <strong>{percent(value)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function distributionPosition(value: number, minimum: number, maximum: number) {
  if (maximum === minimum) return 50;
  return 5 +
    90 * Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
}

function WorkBlockDistribution({
  distribution,
}: {
  distribution: NonNullable<WorkRhythmData["workBlocks"]["durationMinutes"]>;
}) {
  const position = (value: number) =>
    distributionPosition(value, distribution.p10, distribution.p90);
  const values = [
    ["P10", distribution.p10],
    ["P25", distribution.p25],
    ["Median", distribution.median],
    ["Mean", distribution.average],
    ["P75", distribution.p75],
    ["P90", distribution.p90],
  ] as const;
  const points = {
    p10: position(distribution.p10),
    p25: position(distribution.p25),
    median: position(distribution.median),
    average: position(distribution.average),
    p75: position(distribution.p75),
    p90: position(distribution.p90),
  };

  return (
    <div
      className="block-distribution"
      role="img"
      tabIndex={0}
      aria-label={values.map(([label, value]) =>
        `${label} ${formatDuration(value)}`
      ).join(", ")}
    >
      <span className="block-quartile-label" style={{ left: `${points.p25}%` }}>
        P25
      </span>
      <span className="block-quartile-label" style={{ left: `${points.p75}%` }}>
        P75
      </span>
      <span
        className="block-whisker"
        style={{ left: `${points.p10}%`, width: `${points.p90 - points.p10}%` }}
      />
      <span className="block-end" style={{ left: `${points.p10}%` }} />
      <span className="block-end" style={{ left: `${points.p90}%` }} />
      <span
        className="block-iqr"
        style={{ left: `${points.p25}%`, width: `${points.p75 - points.p25}%` }}
      />
      <span className="block-median" style={{ left: `${points.median}%` }} />
      <span className="block-average" style={{ left: `${points.average}%` }} />
      <span
        className="block-range block-range-start"
        style={{ left: `${points.p10}%` }}
      >
        {formatDuration(distribution.p10)}
      </span>
      <span
        className="block-range block-range-end"
        style={{ left: `${points.p90}%` }}
      >
        {formatDuration(distribution.p90)}
      </span>
      <span className="block-distribution-tooltip" role="tooltip">
        {values.map(([label, value]) => (
          <span key={label}>
            <small>{label}</small>
            <strong>{formatDuration(value)}</strong>
          </span>
        ))}
      </span>
    </div>
  );
}

function WorkBlocks({ data }: { data: WorkRhythmData["workBlocks"] }) {
  return (
    <section
      className="work-structure-unit"
      aria-labelledby="work-blocks-title"
    >
      <header className="structure-heading">
        <h3 id="work-blocks-title">Work blocks</h3>
        <MethodologyTip label="Work block methodology">
          A block is a continuous span of estimated active work across root
          sessions; a gap longer than 10 minutes starts a new block.
        </MethodologyTip>
      </header>
      <div className="block-summary">
        <span>
          <strong>
            {data.durationMinutes
              ? formatDuration(data.durationMinutes.median)
              : "—"}
          </strong>
          median
        </span>
        <span>
          <strong>{decimal.format(data.blocksPerActiveDay)}</strong>
          / active day
        </span>
      </div>
      {data.durationMinutes
        ? <WorkBlockDistribution distribution={data.durationMinutes} />
        : <div className="block-distribution-empty">No work blocks</div>}
      <div className="block-support">
        <span>{integer.format(data.count)} blocks</span>
        <span>{Math.round(data.oneHourShare * 100)}% lasted 1h+</span>
      </div>
    </section>
  );
}

function mostRecentActiveDate(data: WorkRhythmData) {
  return Object.values(data.days)
    .filter((day) => day.estimatedActiveMinutes > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1)?.date ?? data.range.end;
}

export function WorkRhythm({ data }: { data: WorkRhythmData }) {
  const defaultDate = useMemo(() => mostRecentActiveDate(data), [data]);
  const [selectedDate, setSelectedDate] = useState(defaultDate);
  useEffect(() => setSelectedDate(defaultDate), [defaultDate]);
  const selectedDay = data.days[selectedDate] ?? {
    date: selectedDate,
    estimatedActiveMinutes: 0,
    spend: 0,
    processedInputTokens: 0,
    userTurns: 0,
    rootSessions: 0,
    intensity: 0 as const,
    topSessions: [],
  };

  return (
    <section className="work-rhythm-module" aria-labelledby="work-rhythm-title">
      <div className="work-rhythm-overview">
        <header className="work-rhythm-header">
          <h2 id="work-rhythm-title">Estimated work</h2>
          <strong title={formatDuration(data.estimatedActiveMinutes)}>
            {formatDuration(data.estimatedActiveMinutes, true)}
          </strong>
        </header>
        <div className="rhythm-charts">
          <section
            className="rhythm-chart-section"
            aria-labelledby="weekday-chart-title"
          >
            <div className="rhythm-subheading">
              <h3 id="weekday-chart-title">By day</h3>
            </div>
            <WeekdayChart data={data.weekdayActivity} />
          </section>
          <section
            className="rhythm-chart-section hourly-section"
            aria-labelledby="hourly-chart-title"
          >
            <div className="rhythm-subheading">
              <h3 id="hourly-chart-title">By hour</h3>
            </div>
            <HourlyChart data={data.hourlyActivity} />
            <div className="hourly-annotations">
              {data.peakHour !== undefined && (
                <span>
                  <i aria-hidden="true" />Peak: {hourRange(data.peakHour)}
                </span>
              )}
            </div>
          </section>
        </div>
      </div>
      <section className="day-explorer" aria-labelledby="day-explorer-title">
        <header className="day-explorer-header">
          <h3 id="day-explorer-title">Day explorer</h3>
          <time dateTime={selectedDate}>
            {readableDate.format(parseDate(selectedDate))}
          </time>
        </header>
        <div className="day-explorer-body">
          <CompactCalendar
            data={data}
            selectedDate={selectedDate}
            onSelect={setSelectedDate}
          />
          <DayDetail day={selectedDay} />
        </div>
      </section>
      <div className="work-structure-row">
        <ParallelWork data={data.parallelWork} />
        <WorkBlocks data={data.workBlocks} />
      </div>
    </section>
  );
}
