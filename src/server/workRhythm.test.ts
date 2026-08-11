import { deepStrictEqual, strictEqual } from "node:assert";
import { workRhythmDataSchema } from "../shared/sessionSchemas.ts";
import { summarizeWorkTime } from "../shared/workTime.ts";
import type { StoredOverviewRollup } from "./overviewAnalytics.ts";
import { aggregateWorkRhythm, workRhythmRange } from "./workRhythm.ts";

const minute = 60_000;
const utc = (value: string) => new Date(`${value}Z`).getTime();

function root(
  id: string,
  turns: number[],
  options: {
    numericID?: number;
    harness?: StoredOverviewRollup["harness"];
    spend?: number;
    input?: number;
    title?: string;
    unpriced?: boolean;
    model?: string;
    rootIntervals?: Array<{ startedAt: number; executionEndAt: number }>;
  } = {},
): StoredOverviewRollup {
  const first = Math.min(...turns);
  return {
    rootSessionID: options.numericID ?? 1,
    rootExecutionIntervals: options.rootIntervals ?? turns.map((startedAt) => ({
      startedAt,
      executionEndAt: startedAt,
    })),
    sessionID: id,
    harness: options.harness ?? "pi",
    title: options.title,
    overview: {
      executionIntervals: turns.map((startedAt) => ({
        startedAt,
        executionEndAt: startedAt,
      })),
      days: turns.length === 0 ? [] : [{
        date: new Date(first).toISOString().slice(0, 10),
        turns: turns.length,
        firstTurnAt: first,
        lastCallAt: first,
        input: options.input ?? 0,
        cacheRead: 0,
        peakContext: options.input ?? 0,
        cost: options.spend ?? 0,
        hasPricedCost: !options.unpriced,
        hasUnpricedCost: options.unpriced ?? false,
        models: options.model
          ? [{
            model: options.model,
            input: options.input ?? 0,
            cacheRead: 0,
            cost: options.spend ?? 0,
            hasPricedCost: !options.unpriced,
            hasUnpricedCost: options.unpriced ?? false,
          }]
          : [],
      }],
    },
  };
}

Deno.test("work time groups nearby prompts into distinct continuous blocks", () => {
  const first = utc("2026-07-01T09:00:00");
  const summary = summarizeWorkTime([
    { startedAt: first, executionEndAt: first },
    { startedAt: first + 4 * minute, executionEndAt: first + 4 * minute },
    { startedAt: first + 20 * minute, executionEndAt: first + 20 * minute },
  ]);

  strictEqual(summary.activeMilliseconds / minute, 14);
  strictEqual(summary.blocks, 2);
});

Deno.test("work rhythm unions isolated, overlapping, duplicate, and touching turn windows globally", () => {
  const start = utc("2026-07-01T00:00:00");
  const end = utc("2026-07-02T00:00:00");
  const result = aggregateWorkRhythm(
    [
      root("a", [utc("2026-07-01T09:00:00"), utc("2026-07-01T09:50:00")]),
      root("b", [utc("2026-07-01T10:00:00"), utc("2026-07-01T10:03:00")], {
        numericID: 2,
        harness: "codex",
      }),
      root("c", [utc("2026-07-01T11:00:00"), utc("2026-07-01T11:00:00")], {
        numericID: 3,
      }),
      root("d", [utc("2026-07-01T12:00:00"), utc("2026-07-01T12:05:00")], {
        numericID: 4,
      }),
    ],
    start,
    end,
    "UTC",
  );

  // 10 isolated + 8 overlapping + 5 duplicate + 10 touching.
  strictEqual(result.estimatedActiveMinutes, 33);
  strictEqual(result.days["2026-07-01"].estimatedActiveMinutes, 33);
  strictEqual(
    result.hourlyActivity.reduce((sum, hour) => sum + hour.estimatedMinutes, 0),
    33,
  );
  workRhythmDataSchema.parse(result);
});

Deno.test("work rhythm extends activity between prompts within the timeout", () => {
  const start = utc("2026-07-01T00:00:00");
  const end = utc("2026-07-01T23:59:59");
  const first = utc("2026-07-01T10:00:00");

  const shortReview = aggregateWorkRhythm(
    [
      root("short-review", [first, first + 8 * minute], {
        rootIntervals: [{
          startedAt: first,
          executionEndAt: first + 12 * minute,
        }, {
          startedAt: first + 8 * minute,
          executionEndAt: first + 8 * minute,
        }],
      }),
    ],
    start,
    end,
    "UTC",
  );
  strictEqual(shortReview.estimatedActiveMinutes, 13);

  const longerReview = aggregateWorkRhythm(
    [
      root("longer-review", [first, first + 21 * minute], {
        rootIntervals: [{
          startedAt: first,
          executionEndAt: first + 12 * minute,
        }, {
          startedAt: first + 21 * minute,
          executionEndAt: first + 21 * minute,
        }],
      }),
    ],
    start,
    end,
    "UTC",
  );
  strictEqual(longerReview.estimatedActiveMinutes, 10);
});

Deno.test("work rhythm falls back to five minutes after the gap timeout", () => {
  const start = utc("2026-07-01T00:00:00");
  const end = utc("2026-07-01T23:59:59");
  const first = utc("2026-07-01T10:00:00");
  const followUp = first + 42 * minute;
  const result = aggregateWorkRhythm(
    [
      root("returned-later", [first, followUp], {
        rootIntervals: [{
          startedAt: first,
          executionEndAt: first + 12 * minute,
        }, {
          startedAt: followUp,
          executionEndAt: followUp,
        }],
      }),
    ],
    start,
    end,
    "UTC",
  );

  strictEqual(result.estimatedActiveMinutes, 10);
});

Deno.test("work rhythm continuity depends on prompt gaps, not execution windows", () => {
  const start = utc("2026-07-01T00:00:00");
  const end = utc("2026-07-01T23:59:59");
  const first = utc("2026-07-01T10:00:00");

  const midRun = aggregateWorkRhythm(
    [
      root("mid-run", [first, first + 8 * minute], {
        rootIntervals: [{
          startedAt: first,
          executionEndAt: first + 12 * minute,
        }, {
          startedAt: first + 8 * minute,
          executionEndAt: first + 8 * minute,
        }],
      }),
    ],
    start,
    end,
    "UTC",
  );
  strictEqual(midRun.estimatedActiveMinutes, 13);

  const immediate = aggregateWorkRhythm(
    [
      root("immediate-mid-run", [first, first + minute], {
        rootIntervals: [{
          startedAt: first,
          executionEndAt: first + 12 * minute,
        }, {
          startedAt: first + minute,
          executionEndAt: first + minute,
        }],
      }),
    ],
    start,
    end,
    "UTC",
  );
  strictEqual(immediate.estimatedActiveMinutes, 6);
});

Deno.test("work rhythm clips boundaries and splits merged activity across midnight and hours", () => {
  const start = utc("2026-07-01T00:00:00");
  const end = utc("2026-07-02T00:03:00");
  const result = aggregateWorkRhythm(
    [
      root("boundary", [utc("2026-07-01T00:02:00")]),
      root("midnight", [utc("2026-07-02T00:02:00")], { numericID: 2 }),
      root("hour", [utc("2026-07-01T13:02:00")], { numericID: 3 }),
    ],
    start,
    end,
    "UTC",
  );

  strictEqual(result.estimatedActiveMinutes, 12);
  strictEqual(result.days["2026-07-01"].estimatedActiveMinutes, 10);
  strictEqual(result.days["2026-07-02"].estimatedActiveMinutes, 2);
  strictEqual(result.hourlyActivity[0].estimatedMinutes, 4);
  strictEqual(result.hourlyActivity[12].estimatedMinutes, 3);
  strictEqual(result.hourlyActivity[13].estimatedMinutes, 2);
  strictEqual(result.hourlyActivity[0].activeDates, 2);
});

Deno.test("work rhythm includes inactive dates and complete weekday denominators", () => {
  const start = utc("2026-07-06T00:00:00"); // Monday
  const end = utc("2026-07-19T23:59:59"); // two complete weeks
  const result = aggregateWorkRhythm(
    [
      root("only-monday", [utc("2026-07-06T10:00:00")]),
    ],
    start,
    end,
    "UTC",
  );

  strictEqual(Object.keys(result.days).length, 14);
  strictEqual(result.days["2026-07-07"].estimatedActiveMinutes, 0);
  deepStrictEqual(result.weekdayActivity[0], {
    weekday: 1,
    label: "Mon",
    averageMinutes: 2.5,
    totalMinutes: 5,
    occurrences: 2,
    activeOccurrences: 1,
  });
  strictEqual(
    result.weekdayActivity.every((weekday) => weekday.occurrences === 2),
    true,
  );
});

Deno.test("work rhythm has deterministic zero behavior and earlier peak-hour ties", () => {
  const start = utc("2026-07-01T00:00:00");
  const end = utc("2026-07-01T23:59:59");
  const empty = aggregateWorkRhythm([], start, end, "UTC");
  strictEqual(empty.estimatedActiveMinutes, 0);
  strictEqual(empty.peakHour, undefined);
  strictEqual(empty.afterHoursShare, 0);
  strictEqual(empty.days["2026-07-01"].intensity, 0);

  const tied = aggregateWorkRhythm(
    [
      root("tie", [utc("2026-07-01T09:00:00"), utc("2026-07-01T10:00:00")]),
    ],
    start,
    end,
    "UTC",
  );
  strictEqual(tied.peakHour, 8);
});

Deno.test("work rhythm ranks top sessions by known spend, input, then public ID", () => {
  const start = utc("2026-07-01T00:00:00");
  const end = utc("2026-07-01T23:59:59");
  const at = utc("2026-07-01T10:00:00");
  const result = aggregateWorkRhythm(
    [
      root("public-c", [at], { numericID: 30, spend: 5, input: 100 }),
      root("public-b", [at], {
        numericID: 20,
        spend: 5,
        input: 200,
        unpriced: true,
      }),
      root("public-a", [at], {
        numericID: 10,
        spend: 5,
        input: 200,
        model: "model-a",
      }),
      root("public-high", [at], { numericID: 40, spend: 6, input: 1 }),
    ],
    start,
    end,
    "UTC",
  );

  deepStrictEqual(
    result.days["2026-07-01"].topSessions.map((session) => session.id),
    ["public-high", "public-a", "public-b"],
  );
  strictEqual(result.days["2026-07-01"].topSessions[1].model, "model-a");
  strictEqual(result.days["2026-07-01"].hasUnpricedSpend, true);
  strictEqual(result.days["2026-07-01"].topSessions[2].hasUnpricedSpend, true);
});

Deno.test("work rhythm ranges contain 30 or 90 local dates across DST", () => {
  const now = Date.parse("2026-11-10T20:00:00Z");
  for (const rangeDays of [30, 90] as const) {
    const range = workRhythmRange(rangeDays, "America/Los_Angeles", now);
    const result = aggregateWorkRhythm(
      [],
      range.start,
      range.end,
      "America/Los_Angeles",
    );
    strictEqual(Object.keys(result.days).length, rangeDays);
  }
});

Deno.test("work rhythm excludes subagent turns and unions root turns across harnesses", () => {
  const start = utc("2026-07-01T00:00:00");
  const end = utc("2026-07-01T23:59:59");
  const at = utc("2026-07-01T10:00:00");
  const pi = root("pi-root", [at, at + 3 * minute], {
    harness: "pi",
    rootIntervals: [{ startedAt: at, executionEndAt: at }],
  });
  const codex = root("codex-root", [at + minute], {
    numericID: 2,
    harness: "codex",
  });
  strictEqual(
    aggregateWorkRhythm([pi, codex], start, end, "UTC").estimatedActiveMinutes,
    6,
  );
  strictEqual(
    aggregateWorkRhythm([pi], start, end, "UTC").estimatedActiveMinutes,
    5,
  );
  strictEqual(
    aggregateWorkRhythm([codex], start, end, "UTC").estimatedActiveMinutes,
    5,
  );
});
