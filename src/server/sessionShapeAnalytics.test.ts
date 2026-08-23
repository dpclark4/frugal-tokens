import { deepStrictEqual, strictEqual } from "node:assert";
import { sessionDistributionResponseSchema } from "../shared/sessionSchemas.ts";
import type { StoredSessionDistributionRollup } from "./conversationRepository.ts";
import { aggregateSessionDistributions } from "./sessionShapeAnalytics.ts";

function day(
  date: string,
  firstTurnAt: number,
  input: number,
  cacheRead: number,
  cost: number,
  turns: number,
  spanMs: number,
) {
  return {
    date,
    turns,
    firstTurnAt,
    lastCallAt: firstTurnAt + spanMs,
    input,
    cacheRead,
    peakContext: input / 2,
    cost,
    hasPricedCost: true,
    hasUnpricedCost: false,
    models: [],
  };
}

Deno.test("aggregates compact rollups into in-range session distributions", () => {
  const start = new Date(2026, 6, 1).getTime();
  const end = new Date(2026, 6, 2, 23, 59).getTime();
  const roots: StoredSessionDistributionRollup[] = [{
    rootSessionID: 1,
    initialInput: 20,
    overview: {
      days: [
        day("2026-06-30", start - 86_400_000, 9_999, 0, 99, 9, 1_000),
        day("2026-07-01", start + 3_600_000, 100, 25, 1, 2, 120_000),
      ],
      executionIntervals: [],
    },
  }, {
    rootSessionID: 2,
    initialInput: 200,
    overview: {
      days: [day("2026-07-02", start + 86_400_000, 300, 150, 3, 6, 60_000)],
      executionIntervals: [],
    },
  }];

  const result = aggregateSessionDistributions(roots, start, end, 30);

  sessionDistributionResponseSchema.parse(result);
  strictEqual(result.sampleSize, 2);
  strictEqual(result.unpricedSessions, 0);
  strictEqual(result.multiDaySessions, 0);
  strictEqual(result.multiDaySessionRate, 0);
  deepStrictEqual(result.metrics, [
    {
      key: "cost",
      distribution: {
        p10: 1.2,
        p25: 1.5,
        median: 2,
        average: 2,
        p75: 2.5,
        p90: 2.8,
      },
    },
    {
      key: "processedInput",
      distribution: {
        p10: 120,
        p25: 150,
        median: 200,
        average: 200,
        p75: 250,
        p90: 280,
      },
    },
    {
      key: "userTurns",
      distribution: {
        p10: 2.4,
        p25: 3,
        median: 4,
        average: 4,
        p75: 5,
        p90: 5.6,
      },
    },
    {
      key: "observedSpan",
      distribution: {
        p10: 66_000,
        p25: 75_000,
        median: 90_000,
        average: 90_000,
        p75: 105_000,
        p90: 114_000,
      },
    },
    {
      key: "startingContext",
      distribution: {
        p10: 38,
        p25: 65,
        median: 110,
        average: 110,
        p75: 155,
        p90: 182,
      },
    },
    {
      key: "peakContext",
      distribution: {
        p10: 60,
        p25: 75,
        median: 100,
        average: 100,
        p75: 125,
        p90: 140,
      },
    },
    {
      key: "tokenReuse",
      distribution: {
        p10: 0.275,
        p25: 0.3125,
        median: 0.375,
        average: 0.375,
        p75: 0.4375,
        p90: 0.475,
      },
    },
  ]);
});

Deno.test("keeps the root sample when token reuse is unavailable", () => {
  const start = new Date(2026, 6, 1).getTime();
  const result = aggregateSessionDistributions(
    [{
      rootSessionID: 1,
      overview: {
        days: [day("2026-07-01", start, 0, 0, 0, 1, 0)],
        executionIntervals: [],
      },
    }],
    start,
    start + 86_400_000,
    30,
  );

  strictEqual(result.sampleSize, 1);
  strictEqual(
    result.metrics.find((metric) => metric.key === "tokenReuse")?.distribution,
    undefined,
  );
});
