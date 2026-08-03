import { useEffect, useState } from "react";
import type { ActivityOverviewResponse } from "../../shared/sessionSchemas.ts";
import { compact, currency, fullDate, integer, monthName } from "./formatters.ts";
import "./ActivityCalendar.css";

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

export function ActivityCalendar({ data }: { data?: ActivityOverviewResponse }) {
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

