import { deepStrictEqual, strictEqual } from "node:assert";
import { activityOverviewResponseSchema } from "../shared/sessionSchemas.ts";
import type { StoredOverviewRollup } from "./overviewAnalytics.ts";
import { aggregateActivityOverview } from "./activityOverview.ts";

function day(
  date: string,
  firstTurnAt: number,
  input: number,
  cacheRead: number,
  cost: number,
  hasUnpricedCost = false,
) {
  return {
    date,
    turns: 1,
    firstTurnAt,
    lastCallAt: firstTurnAt + 1_000,
    input,
    cacheRead,
    peakContext: input,
    cost,
    hasPricedCost: !hasUnpricedCost,
    hasUnpricedCost,
    models: [],
  };
}

Deno.test("activity overview returns only period totals and daily input", () => {
  const first = new Date(2026, 6, 1, 12).getTime();
  const second = new Date(2026, 6, 2, 12).getTime();
  const outside = new Date(2026, 5, 30, 12).getTime();
  const roots: StoredOverviewRollup[] = [{
    rootSessionID: 1,
    overview: {
      days: [
        day("2026-06-30", outside, 9_000_000, 0, 9),
        day("2026-07-01", first, 1_000_000, 800_000, 2),
        day("2026-07-02", second, 3_000_000, 2_500_000, 3, true),
      ],
      executionIntervals: [],
    },
  }, {
    rootSessionID: 2,
    overview: {
      days: [day("2026-07-02", second + 1_000, 2_000_000, 1_000_000, 4)],
      executionIntervals: [],
    },
  }];

  const result = aggregateActivityOverview(
    roots,
    new Date(2026, 6, 1).getTime(),
    new Date(2026, 6, 2, 23, 59).getTime(),
    30,
  );

  activityOverviewResponseSchema.parse(result);
  strictEqual(result.summary.activeDays, 2);
  strictEqual(result.summary.sessions, 2);
  strictEqual(result.summary.processedInput, 6_000_000);
  strictEqual(result.summary.tokenReuse, 4_300_000 / 6_000_000);
  strictEqual(result.summary.spend, 9);
  strictEqual(result.summary.hasUnpricedCost, true);
  deepStrictEqual(result.days, [
    { date: "2026-07-01", processedInput: 1_000_000 },
    { date: "2026-07-02", processedInput: 5_000_000 },
  ]);
});
