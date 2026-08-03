import type { ActivityOverviewResponse } from "../shared/sessionSchemas.ts";
import type { StoredOverviewRollup } from "./overviewAnalytics.ts";

export const ACTIVITY_INACTIVITY_MINUTES = 10;

type ModelBucket = {
  model: string;
  input: number;
  spend: number;
};

type TopSession = ActivityOverviewResponse["days"][number]["topSessions"][number];

type DayBucket = {
  processedInput: number;
  cacheRead: number;
  spend: number;
  hasUnpricedCost: boolean;
  sessions: number;
  turns: number;
  models: Map<string, ModelBucket>;
  topSessions: TopSession[];
};

type Interval = { start: number; end: number };

function dateKey(value: number) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function localDayBounds(date: string): Interval {
  const [year, month, day] = date.split("-").map(Number);
  return {
    start: new Date(year, month - 1, day).getTime(),
    end: new Date(year, month - 1, day + 1).getTime(),
  };
}

function estimatedActiveMs(date: string, intervals: Interval[]) {
  const day = localDayBounds(date);
  const clipped = intervals.filter((interval) =>
    interval.end > day.start && interval.start < day.end
  ).map((interval) => ({
    start: Math.max(day.start, interval.start),
    end: Math.min(day.end, interval.end),
  })).toSorted((a, b) => a.start - b.start);

  const merged: Interval[] = [];
  for (const interval of clipped) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return Math.round(merged.reduce((sum, interval) => sum + interval.end - interval.start, 0));
}

export function aggregateActivityOverview(
  roots: StoredOverviewRollup[],
  start: number,
  end: number,
  rangeDays: 30 | 90,
): ActivityOverviewResponse {
  const days = new Map<string, DayBucket>();
  const activityIntervals: Interval[] = [];
  const inactivityBuffer = ACTIVITY_INACTIVITY_MINUTES * 60_000;
  let sessions = 0;

  for (const root of roots) {
    const rangedDays = root.overview.days.filter((day) =>
      day.firstTurnAt >= start && day.firstTurnAt <= end
    );
    if (rangedDays.length === 0) continue;
    sessions++;

    for (const interval of root.overview.executionIntervals) {
      if (interval.executionEndAt + inactivityBuffer < start || interval.startedAt > end) {
        continue;
      }
      activityIntervals.push({
        start: interval.startedAt,
        end: Math.max(interval.startedAt, interval.executionEndAt) + inactivityBuffer,
      });
    }

    for (const day of rangedDays) {
      const bucket = days.get(day.date) ?? {
        processedInput: 0,
        cacheRead: 0,
        spend: 0,
        hasUnpricedCost: false,
        sessions: 0,
        turns: 0,
        models: new Map<string, ModelBucket>(),
        topSessions: [],
      };
      bucket.processedInput += day.input;
      bucket.cacheRead += day.cacheRead;
      bucket.spend += day.cost;
      bucket.hasUnpricedCost ||= day.hasUnpricedCost;
      bucket.sessions++;
      bucket.turns += day.turns;

      for (const model of day.models) {
        const modelBucket = bucket.models.get(model.model) ?? {
          model: model.model,
          input: 0,
          spend: 0,
        };
        modelBucket.input += model.input;
        modelBucket.spend += model.cost;
        bucket.models.set(model.model, modelBucket);
      }

      bucket.topSessions.push({
        id: root.rootSessionID,
        title: root.title ?? `Session ${root.rootSessionID}`,
        harness: root.harness,
        models: day.models.map((model) => model.model),
        turns: day.turns,
        processedInput: day.input,
        spend: day.cost,
        hasUnpricedCost: day.hasUnpricedCost,
      });
      days.set(day.date, bucket);
    }
  }

  const processedInput = [...days.values()].reduce(
    (sum, day) => sum + day.processedInput,
    0,
  );
  const cacheRead = [...days.values()].reduce(
    (sum, day) => sum + day.cacheRead,
    0,
  );

  return {
    rangeDays,
    startDate: dateKey(start),
    endDate: dateKey(end),
    summary: {
      activeDays: days.size,
      sessions,
      processedInput,
      tokenReuse: processedInput === 0 ? undefined : cacheRead / processedInput,
      spend: [...days.values()].reduce((sum, day) => sum + day.spend, 0),
      hasUnpricedCost: [...days.values()].some((day) => day.hasUnpricedCost),
    },
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
      ([date, day]) => ({
        date,
        processedInput: day.processedInput,
        spend: day.spend,
        hasUnpricedCost: day.hasUnpricedCost,
        sessions: day.sessions,
        turns: day.turns,
        estimatedActiveMs: estimatedActiveMs(date, activityIntervals),
        models: [...day.models.values()].toSorted((a, b) =>
          b.spend - a.spend || b.input - a.input || a.model.localeCompare(b.model)
        ).slice(0, 3),
        topSessions: day.topSessions.toSorted((a, b) =>
          b.spend - a.spend || b.processedInput - a.processedInput || a.id - b.id
        ).slice(0, 3),
      }),
    ),
  };
}
