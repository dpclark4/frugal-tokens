import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
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
import { harnessIcon } from "../harness.ts";
import {
  compact,
  currency,
  dashboardChartFont,
  dashboardChartLabelSize,
  integer,
} from "./formatters.ts";
import { saveOverviewReturnScroll } from "./overviewReturnScroll.ts";
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
    <div className="tooltip-surface rhythm-tooltip">
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
    <div className="tooltip-surface rhythm-tooltip">
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
            tick={{
              fill: "#52615d",
              fontSize: dashboardChartLabelSize,
              fontFamily: dashboardChartFont,
            }}
          />
          <Tooltip
            cursor={{ fill: "rgba(15, 113, 105, .045)" }}
            content={(props) => (
              <WeekdayTooltip
                active={props.active}
                payload={
                  /* SAFETY: Recharts wraps rows from this chart data in tooltip payload entries. */
                  props.payload as Array<{ payload?: WeekdayRow }>
                }
              />
            )}
          />
          <Bar
            dataKey="averageMinutes"
            fill="#0f7169"
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
            tick={{
              fill: "#6f7d78",
              fontSize: dashboardChartLabelSize,
              fontFamily: dashboardChartFont,
            }}
          />
          <YAxis hide domain={[0, "dataMax"]} />
          <Tooltip
            cursor={{ fill: "rgba(15, 113, 105, .045)" }}
            content={(props) => (
              <HourlyTooltip
                active={props.active}
                payload={
                  /* SAFETY: Recharts wraps rows from this chart data in tooltip payload entries. */
                  props.payload as Array<{ payload?: HourlyRow }>
                }
              />
            )}
          />
          <Bar
            dataKey="estimatedMinutes"
            fill="#0f7169"
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
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const selected = parseDate(selectedDate);
    return new Date(selected.getFullYear(), selected.getMonth(), 1);
  });

  useEffect(() => {
    const selected = parseDate(selectedDate);
    setVisibleMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
  }, [selectedDate]);

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

const harnessNames = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
  opencode: "OpenCode",
} satisfies Record<WorkRhythmSession["harness"], string>;

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
  const sessionsBySpend = day.sessions.toSorted((a, b) =>
    b.spend - a.spend ||
    b.estimatedActiveMinutes - a.estimatedActiveMinutes ||
    a.id.localeCompare(b.id)
  );

  function openSession(session: WorkRhythmSession) {
    saveOverviewReturnScroll();
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
          <span>Sessions</span>
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
        aria-labelledby="day-sessions-title"
      >
        <div className="expensive-sessions-heading">
          <h4 id="day-sessions-title">Highest spend this day</h4>
          <span>{integer.format(day.sessions.length)} sessions</span>
        </div>
        {sessionsBySpend.length
          ? (
            <ol className="day-spend-sessions">
              {sessionsBySpend.map((session) => {
                const span = sessionDateSpan(session);
                return (
                  <li key={`${session.harness}:${session.id}`}>
                    <button
                      type="button"
                      onClick={() => openSession(session)}
                      aria-label={`Open ${sessionName(session)}, ${
                        currency.format(session.spend)
                      } on this date`}
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
                            <span
                              className="session-date-scope"
                              title={sessionDateExplanation(session, day.date)}
                            >
                              · spans {span}
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

const timelineHour = 60 * 60 * 1_000;

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function RangeStructureSummary({ data }: { data: WorkRhythmData }) {
  const { parallelWork, workBlocks } = data;
  const concurrency = [
    { label: "1 session", value: parallelWork.activeTimeShare.oneSession },
    { label: "2 sessions", value: parallelWork.activeTimeShare.twoSessions },
    {
      label: "3+ sessions",
      value: parallelWork.activeTimeShare.threeSessions +
        parallelWork.activeTimeShare.fourPlusSessions,
    },
  ];
  const durations = [
    {
      label: "Under 15m",
      value: workBlocks.durationShare.underFifteenMinutes,
    },
    {
      label: "15–60m",
      value: workBlocks.durationShare.fifteenToSixtyMinutes,
    },
    { label: "Over 1h", value: workBlocks.durationShare.oneHourPlus },
  ];
  return (
    <div className="range-structure-summary">
      <section
        aria-label="Active sessions distribution"
        title="Share of estimated active time by number of simultaneously active root sessions."
      >
        <h4>Sessions at once</h4>
        <div className="structure-values">
          {concurrency.map((segment) => (
            <span key={segment.label}>
              {segment.label} <strong>{percent(segment.value)}</strong>
            </span>
          ))}
        </div>
      </section>
      <section
        aria-label="Work block duration distribution"
        title="A work block is a continuous span of estimated active work; a gap longer than the configured threshold starts a new block."
      >
        <h4>Work block length</h4>
        <div className="structure-values">
          {durations.map((segment) => (
            <span key={segment.label}>
              {segment.label} <strong>{percent(segment.value)}</strong>
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

function floorTimelineHour(timestamp: number, step: number) {
  const date = new Date(timestamp);
  date.setMinutes(0, 0, 0);
  date.setHours(Math.floor(date.getHours() / step) * step);
  return date.getTime();
}

function ceilTimelineHour(timestamp: number, step: number) {
  const floor = floorTimelineHour(timestamp, step);
  return floor === timestamp ? floor : floor + step * timelineHour;
}

function timelineDayBounds(day: WorkRhythmDay) {
  const date = parseDate(day.date);
  return {
    start: date.getTime(),
    end: new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + 1,
    ).getTime(),
  };
}

const minimumTimelineWindow = 4 * timelineHour;
const timelineZoomLevels = [12, 6, 3, 1] as const;
type TimelineZoom = "fit" | (typeof timelineZoomLevels)[number];
type TimelineSelection = { start: number; end: number };
type TimelineSegment = {
  start: number;
  end: number;
  overlapping: boolean;
};
type TimelineDrag = TimelineSelection & {
  pointerId: number;
  startClientX: number;
};

function timelineFitBounds(day: WorkRhythmDay) {
  const dayBounds = timelineDayBounds(day);
  const starts = day.sessions.flatMap((session) =>
    session.intervals.map((interval) => interval.start)
  );
  const ends = day.sessions.flatMap((session) =>
    session.intervals.map((interval) => interval.end)
  );
  if (!starts.length || !ends.length) {
    return {
      start: dayBounds.start,
      end: Math.min(dayBounds.end, dayBounds.start + minimumTimelineWindow),
    };
  }

  const paddedStart = Math.min(...starts) - timelineHour / 2;
  const paddedEnd = Math.max(...ends) + timelineHour / 2;
  const daySpan = dayBounds.end - dayBounds.start;
  const span = Math.min(
    daySpan,
    Math.max(minimumTimelineWindow, paddedEnd - paddedStart),
  );
  const midpoint = (paddedStart + paddedEnd) / 2;
  const start = Math.max(
    dayBounds.start,
    Math.min(dayBounds.end - span, midpoint - span / 2),
  );
  return { start, end: start + span };
}

function timelineActivityFocus(day: WorkRhythmDay) {
  const midpoints = day.sessions.flatMap((session) =>
    session.intervals.map((interval) => (interval.start + interval.end) / 2)
  ).toSorted((a, b) => a - b);
  return midpoints[Math.floor(midpoints.length / 2)] ??
    (timelineDayBounds(day).start + timelineDayBounds(day).end) / 2;
}

function timelineTickHours(span: number) {
  if (span > 16 * timelineHour) return 3;
  if (span > 8 * timelineHour) return 2;
  return 1;
}

function timelineSegments(
  session: WorkRhythmDay["sessions"][number],
  sessions: WorkRhythmDay["sessions"],
) {
  const others = sessions.filter((candidate) => candidate !== session)
    .flatMap((candidate) => candidate.intervals);
  return session.intervals.flatMap((interval) => {
    const boundaries = [
      interval.start,
      interval.end,
      ...others.flatMap((other) => [other.start, other.end]).filter((point) =>
        point > interval.start && point < interval.end
      ),
    ].toSorted((a, b) => a - b);
    const segments = boundaries.slice(0, -1).map((start, index) => {
      const end = boundaries[index + 1];
      return {
        start,
        end,
        overlapping: others.some((other) =>
          other.start < end && other.end > start
        ),
      };
    }).reduce<TimelineSegment[]>((joined, segment) => {
      const previous = joined.at(-1);
      if (
        previous?.end === segment.start &&
        previous.overlapping === segment.overlapping
      ) {
        previous.end = segment.end;
      } else {
        joined.push({ ...segment });
      }
      return joined;
    }, []);
    return segments.map((segment, index) => ({
      ...segment,
      startsInterval: index === 0,
      endsInterval: index === segments.length - 1,
    }));
  });
}

function ActivityTimeline({ day }: { day: WorkRhythmDay }) {
  const navigate = useNavigate();
  const viewportRef = useRef<HTMLDivElement>(null);
  const timelineDragRef = useRef<TimelineDrag | undefined>(undefined);
  const [zoom, setZoom] = useState<TimelineZoom>("fit");
  const [selection, setSelection] = useState<TimelineSelection>();
  const [tooltip, setTooltip] = useState<{
    session: WorkRhythmDay["sessions"][number];
    left: number;
    top: number;
  }>();

  useEffect(() => {
    timelineDragRef.current = undefined;
    setSelection(undefined);
    setZoom("fit");
    const frame = requestAnimationFrame(() => {
      viewportRef.current?.scrollTo({ top: 0, left: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [day.date]);

  const sessions = day.sessions.toSorted((a, b) =>
    a.intervals[0].start - b.intervals[0].start || a.id.localeCompare(b.id)
  );
  const bounds = timelineFitBounds(day);
  const span = bounds.end - bounds.start;
  const fitHours = span / timelineHour;
  const zoomOptions: TimelineZoom[] = [
    "fit",
    ...timelineZoomLevels.filter((hours) => hours < fitHours - 0.05),
  ];
  const zoomIndex = Math.max(0, zoomOptions.indexOf(zoom));
  const viewportHours = zoom === "fit" ? fitHours : zoom;
  const tickHours = timelineTickHours(viewportHours * timelineHour);
  const position = (timestamp: number) =>
    Math.max(0, Math.min(100, (timestamp - bounds.start) / span * 100));
  const ticks: number[] = [];
  for (
    let tick = ceilTimelineHour(bounds.start, tickHours);
    tick <= bounds.end;
    tick += tickHours * timelineHour
  ) ticks.push(tick);

  function zoomAround(nextZoom: TimelineZoom, center: number) {
    setZoom(nextZoom);
    requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollLeft = nextZoom === "fit"
        ? 0
        : center * viewport.scrollWidth - viewport.clientWidth / 2;
    });
  }

  function changeZoom(nextIndex: number) {
    const nextZoom = zoomOptions[nextIndex];
    if (nextZoom === undefined) return;
    const viewport = viewportRef.current;
    const center = zoom === "fit" || !viewport
      ? position(timelineActivityFocus(day)) / 100
      : (viewport.scrollLeft + viewport.clientWidth / 2) /
        viewport.scrollWidth;
    zoomAround(nextZoom, center);
  }

  function pointerPosition(target: HTMLSpanElement, clientX: number) {
    const trackBounds = target.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(1, (clientX - trackBounds.left) / trackBounds.width),
    );
  }

  function beginTimelineSelection(
    event: ReactPointerEvent<HTMLSpanElement>,
  ) {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const start = pointerPosition(event.currentTarget, event.clientX);
    timelineDragRef.current = {
      pointerId: event.pointerId,
      start,
      end: start,
      startClientX: event.clientX,
    };
    setSelection({ start, end: start });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function updateTimelineSelection(
    event: ReactPointerEvent<HTMLSpanElement>,
  ) {
    const drag = timelineDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.end = pointerPosition(event.currentTarget, event.clientX);
    setSelection({ start: drag.start, end: drag.end });
  }

  function finishTimelineSelection(
    event: ReactPointerEvent<HTMLSpanElement>,
  ) {
    const drag = timelineDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.end = pointerPosition(event.currentTarget, event.clientX);
    timelineDragRef.current = undefined;
    setSelection(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (Math.abs(event.clientX - drag.startClientX) < 8) return;

    const selectedHours = Math.abs(drag.end - drag.start) * fitHours;
    const nextZoom = zoomOptions
      .filter((option): option is Exclude<TimelineZoom, "fit"> =>
        option !== "fit" && option >= selectedHours
      )
      .at(-1) ?? "fit";
    zoomAround(nextZoom, (drag.start + drag.end) / 2);
  }

  function cancelTimelineSelection(event: ReactPointerEvent<HTMLSpanElement>) {
    if (timelineDragRef.current?.pointerId !== event.pointerId) return;
    timelineDragRef.current = undefined;
    setSelection(undefined);
  }

  function showSessionTooltip(
    target: HTMLButtonElement,
    session: WorkRhythmDay["sessions"][number],
  ) {
    const targetBounds = target.getBoundingClientRect();
    setTooltip({
      session,
      left: targetBounds.right + 8,
      top: targetBounds.top + targetBounds.height / 2,
    });
  }

  function openSession(session: WorkRhythmSession) {
    saveOverviewReturnScroll();
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
    <>
      <section className="activity-timeline" aria-label="Sessions by time">
        {day.estimatedActiveMinutes > 0 && (
          <header className="timeline-toolbar">
            <div className="timeline-summary">
              <span>
                Activity overlap{" "}
                <strong>
                  {percent(day.parallelWork.overlappingShare)}
                </strong>
              </span>
              <span>
                Peak concurrent sessions{" "}
                <strong>
                  {integer.format(day.parallelWork.peakConcurrentSessions)}
                </strong>
              </span>
            </div>
            {day.sessions.length > 0 && (
              <div className="timeline-legend" aria-label="Timeline colors">
                <span>
                  <i className="overlapping" />Overlap
                </span>
                <span>
                  <i />No overlap
                </span>
              </div>
            )}
            {day.sessions.length > 0 && (
              <div className="timeline-zoom" aria-label="Timeline zoom">
                <button
                  type="button"
                  disabled={zoomIndex === 0}
                  onClick={() =>
                    changeZoom(zoomIndex - 1)}
                  aria-label="Zoom out"
                >
                  −
                </button>
                <output aria-live="polite">
                  {zoom === "fit" ? "Fit" : `${zoom}h`}
                </output>
                <button
                  type="button"
                  disabled={zoomIndex === zoomOptions.length - 1}
                  onClick={() =>
                    changeZoom(zoomIndex + 1)}
                  aria-label="Zoom in"
                >
                  +
                </button>
              </div>
            )}
          </header>
        )}
        {day.sessions.length
          ? (
            <div
              className={`timeline-viewport${zoom === "fit" ? "" : " zoomed"}`}
              ref={viewportRef}
            >
              <div
                className="timeline-canvas"
                style={{
                  width: `${Math.max(1, fitHours / viewportHours) * 100}%`,
                }}
              >
                <div className="timeline-axis" aria-hidden="true">
                  {ticks.map((tick) => (
                    <span key={tick} style={{ left: `${position(tick)}%` }}>
                      {formatHour(new Date(tick).getHours())}
                    </span>
                  ))}
                </div>
                <ol className="timeline-rows">
                  {sessions.map((session) => {
                    return (
                      <li key={`${session.harness}:${session.id}`}>
                        <button
                          className={`timeline-harness harness-${session.harness}`}
                          type="button"
                          onClick={() => openSession(session)}
                          onMouseEnter={(event) =>
                            showSessionTooltip(event.currentTarget, session)}
                          onMouseLeave={() => setTooltip(undefined)}
                          onFocus={(event) =>
                            showSessionTooltip(event.currentTarget, session)}
                          onBlur={() => setTooltip(undefined)}
                          aria-describedby={tooltip?.session === session
                            ? "active-timeline-session-tooltip"
                            : undefined}
                          aria-label={`Open ${sessionName(session)}. ${
                            formatDuration(session.estimatedActiveMinutes)
                          } estimated active on this date.`}
                        >
                          <img
                            src={harnessIcon(session.harness)}
                            alt={harnessNames[session.harness]}
                          />
                        </button>
                        <span
                          className="timeline-track"
                          aria-hidden="true"
                          onPointerDown={beginTimelineSelection}
                          onPointerMove={updateTimelineSelection}
                          onPointerUp={finishTimelineSelection}
                          onPointerCancel={cancelTimelineSelection}
                        >
                          {ticks.map((tick) => (
                            <i
                              className="timeline-gridline"
                              key={tick}
                              style={{ left: `${position(tick)}%` }}
                            />
                          ))}
                          {timelineSegments(session, sessions).map((
                            segment,
                          ) => (
                            <i
                              className={`timeline-interval${
                                segment.overlapping ? " overlapping" : ""
                              }${
                                segment.startsInterval ? " starts-interval" : ""
                              }${segment.endsInterval ? " ends-interval" : ""}`}
                              key={`${segment.start}:${segment.end}`}
                              style={{
                                left: `${position(segment.start)}%`,
                                width: `${
                                  Math.max(
                                    0,
                                    position(segment.end) -
                                      position(segment.start),
                                  )
                                }%`,
                              }}
                            />
                          ))}
                          {selection && (
                            <i
                              className="timeline-selection"
                              style={{
                                left: `${
                                  Math.min(selection.start, selection.end) * 100
                                }%`,
                                width: `${
                                  Math.abs(selection.end - selection.start) *
                                  100
                                }%`,
                              }}
                            />
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          )
          : (
            <p className="timeline-empty">
              No estimated activity on this date.
            </p>
          )}
      </section>
      {tooltip && createPortal(
        <div
          className="tooltip-surface timeline-session-tooltip floating"
          id="active-timeline-session-tooltip"
          role="tooltip"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <strong>{sessionName(tooltip.session)}</strong>
          <span>
            {harnessNames[tooltip.session.harness]}
            {tooltip.session.model
              ? ` · ${displayModelName(tooltip.session.model)}`
              : ""}
          </span>
          <span>
            {timeOnly.format(new Date(tooltip.session.intervals[0].start))}–
            {timeOnly.format(new Date(tooltip.session.intervals.at(-1)!.end))}
            {" · "}
            {formatDuration(tooltip.session.estimatedActiveMinutes)}{" "}
            estimated active
          </span>
          <span>{currency.format(tooltip.session.spend)} on this date</span>
          <em>Click to open session</em>
        </div>,
        document.body,
      )}
    </>
  );
}

export function WorkRhythm({
  data,
  selectedDate,
  onSelect,
}: {
  data: WorkRhythmData;
  selectedDate: string;
  onSelect: (date: string) => void;
}) {
  const selectedDay = data.days[selectedDate] ?? {
    date: selectedDate,
    estimatedActiveMinutes: 0,
    spend: 0,
    processedInputTokens: 0,
    userTurns: 0,
    rootSessions: 0,
    intensity: 0 as const,
    topSessions: [],
    sessions: [],
    parallelWork: {
      overlappingShare: 0,
      activeTimeShare: {
        oneSession: 0,
        twoSessions: 0,
        threeSessions: 0,
        fourPlusSessions: 0,
      },
      peakConcurrentSessions: 0,
    },
    workBlocks: { count: 0 },
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
              <h3 id="weekday-chart-title">Average by day</h3>
            </div>
            <WeekdayChart data={data.weekdayActivity} />
          </section>
          <section
            className="rhythm-chart-section hourly-section"
            aria-labelledby="hourly-chart-title"
          >
            <div className="rhythm-subheading">
              <h3 id="hourly-chart-title">By hour</h3>
              {data.peakHour !== undefined && (
                <span className="hourly-peak">
                  <i aria-hidden="true" />Peak: {hourRange(data.peakHour)}
                </span>
              )}
            </div>
            <HourlyChart data={data.hourlyActivity} />
          </section>
        </div>
        <RangeStructureSummary data={data} />
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
            onSelect={onSelect}
          />
          <DayDetail day={selectedDay} />
        </div>
      </section>
      <ActivityTimeline day={selectedDay} />
    </section>
  );
}
