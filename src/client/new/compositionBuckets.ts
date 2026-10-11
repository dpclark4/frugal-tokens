import type { SpendCompositionData } from "../../shared/sessionSchemas.ts";

type Day = SpendCompositionData["days"][number];
export type CompositionBucket = Day & { endDate: string };

function weekKey(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7);
  return value.toISOString().slice(0, 10);
}

function mergeModels<T extends Day["models"][number]>(
  target: T[],
  source: T[],
) {
  for (const model of source) {
    const existing = target.find((item) => item.model === model.model);
    if (existing) {
      existing.spend += model.spend;
      existing.processedInput += model.processedInput;
      existing.hasUnpricedCost ||= model.hasUnpricedCost;
    } else {
      target.push({ ...model });
    }
  }
}

export function compositionBuckets(
  days: Day[],
  weekly: boolean,
): CompositionBucket[] {
  if (!weekly) return days.map((day) => ({ ...day, endDate: day.date }));
  const weeks = new Map<string, CompositionBucket>();
  for (const day of days) {
    const key = weekKey(day.date);
    let bucket = weeks.get(key);
    if (!bucket) {
      bucket = {
        date: day.date,
        endDate: day.date,
        models: [],
        otherModels: [],
        otherSpend: 0,
        otherProcessedInput: 0,
        otherHasUnpricedCost: false,
      };
      weeks.set(key, bucket);
    }
    bucket.endDate = day.date;
    mergeModels(bucket.models, day.models);
    mergeModels(bucket.otherModels, day.otherModels);
    bucket.otherSpend += day.otherSpend;
    bucket.otherProcessedInput += day.otherProcessedInput;
    bucket.otherHasUnpricedCost ||= day.otherHasUnpricedCost;
  }
  return [...weeks.values()];
}
