import { expect, test } from "vitest";
import type { SpendCompositionData } from "../../shared/sessionSchemas.ts";
import { compositionBuckets } from "./compositionBuckets.ts";

function day(date: string, spend = 1): SpendCompositionData["days"][number] {
  return {
    date,
    models: [{
      model: "primary",
      spend,
      processedInput: spend * 100,
      hasUnpricedCost: false,
    }],
    otherModels: [{
      model: "minor",
      provider: "other",
      tier: "unknown",
      tierRank: 0,
      spend: spend * 2,
      processedInput: spend * 200,
      hasUnpricedCost: true,
    }],
    otherSpend: spend * 2,
    otherProcessedInput: spend * 200,
    otherHasUnpricedCost: true,
  };
}

test("weekly buckets use Monday boundaries and preserve totals across years", () => {
  const days = [day("2025-12-31"), day("2026-01-04", 2), day("2026-01-05", 4)];
  const before = structuredClone(days);
  const buckets = compositionBuckets(days, true);
  expect(buckets.map(({ date, endDate }) => [date, endDate])).toEqual([
    ["2025-12-31", "2026-01-04"],
    ["2026-01-05", "2026-01-05"],
  ]);
  expect(buckets[0].models[0]).toMatchObject({ spend: 3, processedInput: 300 });
  expect(buckets[0].otherModels[0]).toMatchObject({
    spend: 6,
    processedInput: 600,
    hasUnpricedCost: true,
  });
  expect(buckets[0].otherSpend).toBe(6);
  expect(buckets[0].otherProcessedInput).toBe(600);
  expect(buckets[0].otherHasUnpricedCost).toBe(true);
  expect(days).toEqual(before);
});

test("daily buckets remain daily and empty periods stay empty", () => {
  const days = [day("2026-03-07"), day("2026-03-08"), day("2026-03-09")];
  expect(compositionBuckets(days, false)).toEqual(
    days.map((value) => ({ ...value, endDate: value.date })),
  );
  expect(compositionBuckets(days, true).map((value) => value.models[0].spend))
    .toEqual([2, 1]);
  expect(compositionBuckets([], true)).toEqual([]);
});

test("zero-usage days preserve empty weeks", () => {
  const days = Array.from(
    { length: 15 },
    (_, index) => day(`2026-06-${String(index + 1).padStart(2, "0")}`, 0),
  );
  expect(compositionBuckets(days, true).map((value) => value.otherSpend))
    .toEqual([0, 0, 0]);
});
