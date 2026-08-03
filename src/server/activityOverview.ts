import type { ActivityOverviewResponse } from "../shared/sessionSchemas.ts";
import type { StoredOverviewRollup } from "./overviewAnalytics.ts";

type DayBucket = {
  processedInput: number;
  cacheRead: number;
  spend: number;
  hasUnpricedCost: boolean;
};

function dateKey(value: number) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function aggregateActivityOverview(
  roots: StoredOverviewRollup[],
  start: number,
  end: number,
  rangeDays: 30 | 90,
): ActivityOverviewResponse {
  const days = new Map<string, DayBucket>();
  let sessions = 0;

  for (const root of roots) {
    const rangedDays = root.overview.days.filter((day) =>
      day.firstTurnAt >= start && day.firstTurnAt <= end
    );
    if (rangedDays.length === 0) continue;
    sessions++;

    for (const day of rangedDays) {
      const bucket = days.get(day.date) ?? {
        processedInput: 0,
        cacheRead: 0,
        spend: 0,
        hasUnpricedCost: false,
      };
      bucket.processedInput += day.input;
      bucket.cacheRead += day.cacheRead;
      bucket.spend += day.cost;
      bucket.hasUnpricedCost ||= day.hasUnpricedCost;
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
      ([date, day]) => ({ date, processedInput: day.processedInput }),
    ),
  };
}
