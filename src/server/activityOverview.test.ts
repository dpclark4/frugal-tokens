import { deepStrictEqual, strictEqual } from "node:assert";
import {
  activityOverviewResponseSchema,
  workRhythmOverviewResponseSchema,
} from "../shared/sessionSchemas.ts";
import type { StoredOverviewRollup } from "./overviewAnalytics.ts";
import {
  aggregateActivityOverview,
  aggregateWorkRhythmOverview,
} from "./activityOverview.ts";
import type { OverviewDayRollup } from "./sessionRollups.ts";

function day(
  date: string,
  firstTurnAt: number,
  input: number,
  cacheRead: number,
  cost: number,
  hasUnpricedCost = false,
  models: OverviewDayRollup["models"] = [],
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
    models,
  };
}

Deno.test("activity overview returns period totals and daily drill-down data", () => {
  const first = new Date(2026, 6, 1, 12).getTime();
  const second = new Date(2026, 6, 2, 12).getTime();
  const outside = new Date(2026, 5, 30, 12).getTime();
  const roots: StoredOverviewRollup[] = [{
    rootSessionID: 1,
    startedAt: first - 60_000,
    endedAt: second + 120_000,
    subagentSpend: 2,
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
    1.5,
  );

  activityOverviewResponseSchema.parse(result);
  const workRhythm = aggregateWorkRhythmOverview(
    roots,
    new Date(2026, 6, 1).getTime(),
    new Date(2026, 6, 2, 23, 59).getTime(),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  workRhythmOverviewResponseSchema.parse(workRhythm);
  strictEqual(result.summary.sessions, 2);
  strictEqual(result.summary.processedInput, 6_000_000);
  strictEqual(result.summary.tokenReuse, 4_300_000 / 6_000_000);
  strictEqual(result.summary.spend, 9);
  strictEqual(result.summary.hasUnpricedCost, true);
  strictEqual(result.summary.spendAtMissCalls, 1.5);
  strictEqual(result.summary.subagentSpend, 2);
  strictEqual(result.summary.topDecileSpendShare, 5 / 9);
  deepStrictEqual(workRhythm.sessionDiagnostics.sessions, [{
    id: "2",
    title: "Session 2",
    primaryModel: null,
    estimatedActiveMinutes: 0,
    observedSessionMinutes: 1 / 60,
    spend: 4,
    hasUnpricedSpend: false,
    processedInput: 2_000_000,
    tokenReuse: 0.5,
    userTurns: 1,
  }, {
    id: "1",
    title: "Session 1",
    primaryModel: null,
    estimatedActiveMinutes: 0,
    observedSessionMinutes: (second + 120_000 - (first - 60_000)) / 60_000,
    spend: 5,
    hasUnpricedSpend: true,
    processedInput: 4_000_000,
    tokenReuse: 3_300_000 / 4_000_000,
    userTurns: 2,
  }]);
  deepStrictEqual(result.days, [
    {
      date: "2026-07-01",
      processedInput: 1_000_000,
      spend: 2,
      hasUnpricedCost: false,
      sessions: 1,
      turns: 1,
      estimatedActiveMs: 0,
      models: [],
      topSessions: [{
        id: 1,
        title: "Session 1",
        harness: undefined,
        models: [],
        turns: 1,
        processedInput: 1_000_000,
        spend: 2,
        hasUnpricedCost: false,
      }],
    },
    {
      date: "2026-07-02",
      processedInput: 5_000_000,
      spend: 7,
      hasUnpricedCost: true,
      sessions: 2,
      turns: 2,
      estimatedActiveMs: 0,
      models: [],
      topSessions: [{
        id: 2,
        title: "Session 2",
        harness: undefined,
        models: [],
        turns: 1,
        processedInput: 2_000_000,
        spend: 4,
        hasUnpricedCost: false,
      }, {
        id: 1,
        title: "Session 1",
        harness: undefined,
        models: [],
        turns: 1,
        processedInput: 3_000_000,
        spend: 3,
        hasUnpricedCost: true,
      }],
    },
  ]);
});

Deno.test("spend composition selects the union of top spend and token models", () => {
  const at = new Date(2026, 6, 1, 12).getTime();
  const values = [
    ["claude-fable-5", 10, 1],
    ["claude-opus-5", 9, 2],
    ["claude-sonnet-5", 8, 3],
    ["gpt-5.6-sol", 7, 4],
    ["gpt-5.6-terra", 6, 5],
    ["grok-4-5", 1, 100],
    ["kimi-k3", 0.5, 90],
    ["gpt-5.6-luna", 0.1, 0.1],
  ] as const;
  const models: OverviewDayRollup["models"] = values.map(
    ([model, cost, inputMillions]) => ({
      model,
      cost,
      input: inputMillions * 1_000_000,
      cacheRead: 0,
      hasPricedCost: true,
      hasUnpricedCost: false,
    }),
  );
  models[0].hasUnpricedCost = true;
  const totalCost = models.reduce((sum, model) => sum + model.cost, 0);
  const roots: StoredOverviewRollup[] = [{
    rootSessionID: 1,
    overview: {
      days: [day("2026-07-01", at, 205_100_000, 0, totalCost, false, models)],
      executionIntervals: [],
    },
  }];

  const result = aggregateActivityOverview(
    roots,
    new Date(2026, 6, 1).getTime(),
    new Date(2026, 6, 1, 23, 59).getTime(),
  ).spendComposition;

  deepStrictEqual(
    result.models.map((model) => model.model),
    values.slice(0, 7).map(([model]) => model),
  );
  strictEqual(result.other?.spend, 0.1);
  strictEqual(result.days[0].otherModels[0].model, "gpt-5.6-luna");
  strictEqual(
    result.models.find((model) => model.model === "grok-4-5")?.selectedByTokens,
    true,
  );
  strictEqual(
    result.models.find((model) => model.model === "grok-4-5")?.selectedBySpend,
    false,
  );
  strictEqual(result.models[0].provider, "anthropic");
  strictEqual(result.models[0].hasUnpricedCost, true);
  strictEqual(result.models[0].effectiveCostPerMillion, 10);
  activityOverviewResponseSchema.shape.spendComposition.parse(result);
});
