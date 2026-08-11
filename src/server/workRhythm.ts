import type {
  WorkRhythmData,
  WorkRhythmDay,
  WorkRhythmSession,
} from "../shared/sessionSchemas.ts";
import type { StoredOverviewRollup } from "./overviewAnalytics.ts";
import {
  estimatedWorkIntervals,
  mergeWorkIntervals,
  WORK_RHYTHM_FALLBACK_MINUTES,
  WORK_RHYTHM_GAP_TIMEOUT_MINUTES,
  WORK_RHYTHM_INITIAL_MINUTES,
  type WorkInterval,
} from "../shared/workTime.ts";
const WEEKDAYS = [
  { weekday: 1 as const, label: "Mon" },
  { weekday: 2 as const, label: "Tue" },
  { weekday: 3 as const, label: "Wed" },
  { weekday: 4 as const, label: "Thu" },
  { weekday: 5 as const, label: "Fri" },
  { weekday: 6 as const, label: "Sat" },
  { weekday: 0 as const, label: "Sun" },
];

type Interval = WorkInterval;

function zonedAt(date: Temporal.PlainDate, timeZone: string) {
  return Temporal.ZonedDateTime.from({
    timeZone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: 0,
  });
}

function zonedDateKey(timestamp: number, timeZone: string) {
  return Temporal.Instant.fromEpochMilliseconds(timestamp)
    .toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

function overlapMs(intervals: Interval[], span: Interval) {
  let total = 0;
  for (const interval of intervals) {
    if (interval.end <= span.start) continue;
    if (interval.start >= span.end) break;
    total += Math.max(
      0,
      Math.min(interval.end, span.end) - Math.max(interval.start, span.start),
    );
  }
  return total;
}

function percentile(values: number[], quantile: number) {
  const index = (values.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const remainder = index - lower;
  return values[lower] + (values[upper] - values[lower]) * remainder;
}

function workStructure(
  intervalsByRoot: Interval[][],
  merged: Interval[],
  activeDays: number,
): Pick<WorkRhythmData, "parallelWork" | "workBlocks"> {
  const events = new Map<number, number>();
  for (const intervals of intervalsByRoot) {
    for (const interval of intervals) {
      events.set(interval.start, (events.get(interval.start) ?? 0) + 1);
      events.set(interval.end, (events.get(interval.end) ?? 0) - 1);
    }
  }

  const concurrentMs = [0, 0, 0];
  let active = 0;
  let peak = 0;
  let previous: number | undefined;
  for (const [at, delta] of [...events].toSorted(([a], [b]) => a - b)) {
    if (previous !== undefined && active > 0) {
      concurrentMs[Math.min(active, 3) - 1] += at - previous;
    }
    active += delta;
    peak = Math.max(peak, active);
    previous = at;
  }

  const totalMs = concurrentMs.reduce((sum, duration) => sum + duration, 0);
  const share = (duration: number) => totalMs === 0 ? 0 : duration / totalMs;
  const durationMinutes = merged.map((interval) =>
    (interval.end - interval.start) / 60_000
  ).toSorted((a, b) => a - b);
  const durationDistribution = durationMinutes.length === 0 ? undefined : {
    p10: percentile(durationMinutes, 0.1),
    p25: percentile(durationMinutes, 0.25),
    median: percentile(durationMinutes, 0.5),
    average: durationMinutes.reduce((sum, value) => sum + value, 0) /
      durationMinutes.length,
    p75: percentile(durationMinutes, 0.75),
    p90: percentile(durationMinutes, 0.9),
  };

  return {
    parallelWork: {
      overlappingShare: share(concurrentMs[1] + concurrentMs[2]),
      activeTimeShare: {
        oneSession: share(concurrentMs[0]),
        twoSessions: share(concurrentMs[1]),
        threePlusSessions: share(concurrentMs[2]),
      },
      peakConcurrentSessions: peak,
    },
    workBlocks: {
      count: durationMinutes.length,
      blocksPerActiveDay: activeDays === 0
        ? 0
        : durationMinutes.length / activeDays,
      oneHourShare: durationMinutes.length === 0
        ? 0
        : durationMinutes.filter((duration) => duration >= 60).length /
          durationMinutes.length,
      durationMinutes: durationDistribution,
    },
  };
}

function intensity(
  minutes: number,
  nonzero: number[],
): WorkRhythmDay["intensity"] {
  if (minutes <= 0) return 0;
  const lower = nonzero.filter((value) => value < minutes).length;
  return Math.min(
    4,
    Math.floor(lower * 4 / nonzero.length) + 1,
  ) as WorkRhythmDay["intensity"];
}

export function workRhythmRange(
  rangeDays: 30 | 90,
  timeZone: string,
  now = Date.now(),
) {
  const endDate = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(timeZone).toPlainDate();
  const startDate = endDate.subtract({ days: rangeDays - 1 });
  return {
    start: zonedAt(startDate, timeZone).epochMilliseconds,
    end: now,
  };
}

export function aggregateWorkRhythm(
  roots: StoredOverviewRollup[],
  start: number,
  end: number,
  timeZone: string,
): WorkRhythmData {
  // Constructing a ZonedDateTime validates the IANA identifier as well as
  // giving all calendar boundaries their correct DST-sensitive instants.
  const startDate = Temporal.Instant.fromEpochMilliseconds(start)
    .toZonedDateTimeISO(timeZone).toPlainDate();
  const endDate = Temporal.Instant.fromEpochMilliseconds(end)
    .toZonedDateTimeISO(timeZone).toPlainDate();
  const dates: Temporal.PlainDate[] = [];
  for (
    let date = startDate;
    Temporal.PlainDate.compare(date, endDate) <= 0;
    date = date.add({ days: 1 })
  ) dates.push(date);

  const intervalsByRoot = roots.map((root) =>
    mergeWorkIntervals(
      estimatedWorkIntervals(root.rootExecutionIntervals ?? []),
      start,
      end,
    )
  ).filter((intervals) => intervals.length > 0);
  const merged = mergeWorkIntervals(intervalsByRoot.flat(), start, end);
  const totalMs = merged.reduce(
    (sum, interval) => sum + interval.end - interval.start,
    0,
  );

  const dayValues = new Map<string, Omit<WorkRhythmDay, "intensity">>();
  for (const date of dates) {
    const next = date.add({ days: 1 });
    const span = {
      start: Math.max(start, zonedAt(date, timeZone).epochMilliseconds),
      end: Math.min(end, zonedAt(next, timeZone).epochMilliseconds),
    };
    dayValues.set(date.toString(), {
      date: date.toString(),
      estimatedActiveMinutes: overlapMs(merged, span) / 60_000,
      spend: 0,
      hasUnpricedSpend: false,
      processedInputTokens: 0,
      userTurns: 0,
      rootSessions: 0,
      topSessions: [],
    });
  }

  const dailyRoots = new Map<string, Set<string>>();
  const dailySessions = new Map<
    string,
    Map<
      string,
      WorkRhythmSession & {
        processedInput: number;
        modelSpend: number;
      }
    >
  >();
  for (const root of roots) {
    const rootKey = `${root.harness ?? "unknown"}:${
      root.sessionID ?? root.rootSessionID
    }`;
    const rootDates = root.overview.days.map((day) =>
      zonedDateKey(day.firstTurnAt, timeZone)
    ).toSorted();
    const activeDateRange = {
      start: rootDates[0] ?? startDate.toString(),
      end: rootDates.at(-1) ?? endDate.toString(),
    };
    const totalSpend = root.overview.days.reduce(
      (sum, day) => sum + day.cost,
      0,
    );
    const hasUnpricedTotalSpend = root.overview.days.some((day) =>
      day.hasUnpricedCost
    );
    for (const rollupDay of root.overview.days) {
      if (rollupDay.firstTurnAt < start || rollupDay.firstTurnAt > end) {
        continue;
      }
      const key = zonedDateKey(rollupDay.firstTurnAt, timeZone);
      const day = dayValues.get(key);
      if (!day) continue;
      day.spend += rollupDay.cost;
      day.hasUnpricedSpend ||= rollupDay.hasUnpricedCost;
      day.processedInputTokens += rollupDay.input;
      day.userTurns += rollupDay.turns;
      const rootsOnDate = dailyRoots.get(key) ?? new Set<string>();
      rootsOnDate.add(rootKey);
      dailyRoots.set(key, rootsOnDate);

      if (root.harness && root.sessionID) {
        const rankedModel = rollupDay.models.toSorted((a, b) =>
          b.cost - a.cost || b.input - a.input || a.model.localeCompare(b.model)
        )[0];
        const sessions = dailySessions.get(key) ?? new Map();
        const previous = sessions.get(rootKey);
        sessions.set(
          rootKey,
          previous
            ? {
              ...previous,
              model: (rankedModel?.cost ?? -1) > previous.modelSpend
                ? rankedModel!.model
                : previous.model,
              modelSpend: Math.max(
                previous.modelSpend,
                rankedModel?.cost ?? -1,
              ),
              startTime: new Date(Math.min(
                new Date(previous.startTime).getTime(),
                rollupDay.firstTurnAt,
              )).toISOString(),
              spend: previous.spend + rollupDay.cost,
              hasUnpricedSpend: previous.hasUnpricedSpend ||
                rollupDay.hasUnpricedCost,
              processedInput: previous.processedInput + rollupDay.input,
            }
            : {
              id: root.sessionID,
              title: root.title ?? null,
              harness: root.harness,
              model: rankedModel?.model ?? null,
              modelSpend: rankedModel?.cost ?? -1,
              startTime: new Date(rollupDay.firstTurnAt).toISOString(),
              activeDateRange,
              spend: rollupDay.cost,
              hasUnpricedSpend: rollupDay.hasUnpricedCost,
              totalSpend,
              hasUnpricedTotalSpend,
              processedInput: rollupDay.input,
            },
        );
        dailySessions.set(key, sessions);
      }
    }
  }

  const nonzero = [...dayValues.values()].map((day) =>
    day.estimatedActiveMinutes
  ).filter((minutes) => minutes > 0).toSorted((a, b) => a - b);
  const days: Record<string, WorkRhythmDay> = {};
  for (const day of dayValues.values()) {
    day.rootSessions = dailyRoots.get(day.date)?.size ?? 0;
    day.topSessions = [...(dailySessions.get(day.date)?.values() ?? [])]
      .toSorted((a, b) =>
        b.spend - a.spend || b.processedInput - a.processedInput ||
        a.id.localeCompare(b.id)
      ).slice(0, 3).map(({
        processedInput: _processedInput,
        modelSpend: _modelSpend,
        ...session
      }) => session);
    days[day.date] = {
      ...day,
      intensity: intensity(day.estimatedActiveMinutes, nonzero),
    };
  }

  const weekdayActivity = WEEKDAYS.map(({ weekday, label }) => {
    const matching = dates.map((date) => days[date.toString()]).filter((day) =>
      dateWeekday(day.date) === weekday
    );
    const totalMinutes = matching.reduce(
      (sum, day) => sum + day.estimatedActiveMinutes,
      0,
    );
    return {
      weekday,
      label,
      averageMinutes: matching.length === 0
        ? 0
        : totalMinutes / matching.length,
      totalMinutes,
      occurrences: matching.length,
      activeOccurrences: matching.filter((day) =>
        day.estimatedActiveMinutes > 0
      ).length,
    };
  });

  const hourlyMs = Array.from({ length: 24 }, () => 0);
  const hourlyDates = Array.from({ length: 24 }, () => new Set<string>());
  for (const date of dates) {
    const dayEnd = zonedAt(date.add({ days: 1 }), timeZone).epochMilliseconds;
    let cursor = zonedAt(date, timeZone);
    while (cursor.epochMilliseconds < dayEnd) {
      const next = cursor.add({ hours: 1 });
      const hour = cursor.hour;
      const duration = overlapMs(merged, {
        start: Math.max(start, cursor.epochMilliseconds),
        end: Math.min(end, next.epochMilliseconds, dayEnd),
      });
      hourlyMs[hour] += duration;
      if (duration > 0) hourlyDates[hour].add(date.toString());
      cursor = next;
    }
  }
  const hourlyActivity = hourlyMs.map((duration, hour) => ({
    hour,
    estimatedMinutes: duration / 60_000,
    shareOfTotal: totalMs === 0 ? 0 : duration / totalMs,
    activeDates: hourlyDates[hour].size,
  }));
  const peakHour = totalMs === 0 ? undefined : hourlyMs.reduce(
    (best, value, hour) => value > hourlyMs[best] ? hour : best,
    0,
  );

  const activeDays =
    [...dayValues.values()].filter((day) => day.estimatedActiveMinutes > 0)
      .length;
  const structure = workStructure(intervalsByRoot, merged, activeDays);

  return {
    range: { start: startDate.toString(), end: endDate.toString() },
    estimatedActiveMinutes: totalMs / 60_000,
    methodology: {
      initialMinutes: WORK_RHYTHM_INITIAL_MINUTES,
      continuationGapTimeoutMinutes: WORK_RHYTHM_GAP_TIMEOUT_MINUTES,
      fallbackMinutes: WORK_RHYTHM_FALLBACK_MINUTES,
      overlapsCountedOnce: true,
    },
    weekdayActivity,
    hourlyActivity,
    afterHoursShare: totalMs === 0
      ? 0
      : hourlyMs.slice(20).reduce((sum, value) => sum + value, 0) / totalMs,
    peakHour,
    ...structure,
    days,
  };
}

function dateWeekday(date: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return (Temporal.PlainDate.from(date).dayOfWeek % 7) as
    | 0
    | 1
    | 2
    | 3
    | 4
    | 5
    | 6;
}
