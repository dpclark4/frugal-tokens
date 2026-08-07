import { deepStrictEqual } from "node:assert/strict";
import { aggregateUsage, aggregateUsageRollups } from "./usageAnalytics.ts";
import type { UsageCall } from "./usage.ts";

function usageCall(
  session: string,
  sessionStartedAt: number,
  input: number,
): UsageCall {
  return {
    harness: "opencode",
    session: { id: session, rootID: session },
    cacheChainID: session,
    turnID: `${session}:${sessionStartedAt}`,
    turnOrdinal: 1,
    sessionStartedAt,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    startedAt: sessionStartedAt,
    tokens: {
      uncachedInput: input,
      cacheRead: 0,
      freshPrompt: input,
      output: 0,
      reasoning: 0,
      processed: input,
    },
  };
}

Deno.test("aggregates daily and weekly session input percentiles", () => {
  const firstDay = new Date(2026, 6, 10).getTime();
  const secondDay = new Date(2026, 6, 11).getTime();
  const calls = [
    usageCall("small", firstDay, 100),
    usageCall("small", firstDay + 1, 50),
    usageCall("medium", firstDay, 300),
    usageCall("large", firstDay, 600),
    usageCall("next-day", secondDay, 1_000),
  ];

  const response = aggregateUsage(calls).response;
  deepStrictEqual(response.sessionInputDays, [
    {
      date: "2026-07-10",
      median: 300,
      p90: 540,
      average: 350,
      sessions: 3,
    },
    {
      date: "2026-07-11",
      median: 1_000,
      p90: 1_000,
      average: 1_000,
      sessions: 1,
    },
  ]);
  deepStrictEqual(response.sessionInputWeeks, [
    {
      date: "2026-07-06",
      endDate: "2026-07-12",
      median: 450,
      p90: 880,
      average: 512.5,
      sessions: 4,
    },
  ]);
});

Deno.test("aggregates initial input by day and harness", () => {
  const firstDay = new Date(2026, 6, 10).getTime();
  const secondDay = new Date(2026, 6, 11).getTime();
  const response = aggregateUsage([], undefined, "full", [
    { harness: "claude-code", sessionStartedAt: firstDay, input: 100 },
    { harness: "claude-code", sessionStartedAt: firstDay + 1, input: 300 },
    { harness: "codex", sessionStartedAt: firstDay, input: 500 },
    { harness: "claude-code", sessionStartedAt: secondDay, input: 800 },
  ]).response;

  deepStrictEqual(response.initialInputSummary, {
    median: 400,
    average: 425,
    sessions: 4,
  });
  deepStrictEqual(response.initialInputDays, [
    {
      date: "2026-07-10",
      harness: "claude-code",
      median: 200,
      average: 200,
      sessions: 2,
    },
    {
      date: "2026-07-10",
      harness: "codex",
      median: 500,
      average: 500,
      sessions: 1,
    },
    {
      date: "2026-07-11",
      harness: "claude-code",
      median: 800,
      average: 800,
      sessions: 1,
    },
  ]);
});

Deno.test("aggregates subagent adoption, calls, and cost share", () => {
  const startedAt = new Date(2026, 6, 10).getTime();
  const sessionStartedAt = new Date(2026, 6, 1).getTime();
  const rootCall = usageCall("with-child", startedAt, 100);
  rootCall.sessionStartedAt = sessionStartedAt;
  rootCall.computedCost = 2;
  const childCall = usageCall("child", startedAt, 100);
  childCall.session = {
    id: "child",
    rootID: "with-child",
    parentID: "with-child",
  };
  childCall.cacheChainID = "child";
  childCall.sessionStartedAt = sessionStartedAt;
  childCall.computedCost = 3;
  const rootOnlyCall = usageCall("root-only", startedAt, 100);
  rootOnlyCall.sessionStartedAt = sessionStartedAt;
  rootOnlyCall.computedCost = 5;

  const response = aggregateUsage([rootCall, childCall, rootOnlyCall]).response;
  deepStrictEqual(response.subagentDays, [{
    date: "2026-07-10",
    rootOnly: 1,
    withSubagents: 1,
    withMultipleSubagents: 0,
    subagents: 1,
    totalInput: 300,
    subagentInput: 100,
    totalCost: 10,
    subagentCost: 3,
    hasUnpricedCost: false,
  }]);
  deepStrictEqual(response.subagentWeeks, [{
    date: "2026-07-06",
    endDate: "2026-07-12",
    rootOnly: 1,
    withSubagents: 1,
    withMultipleSubagents: 0,
    subagents: 1,
    totalInput: 300,
    subagentInput: 100,
    totalCost: 10,
    subagentCost: 3,
    hasUnpricedCost: false,
  }]);
});

Deno.test("aggregates compact usage rollups and sparse subagent activity", () => {
  const firstDay = new Date(2026, 6, 10, 9).getTime();
  const secondDay = new Date(2026, 6, 11, 9).getTime();
  const sessionStartedAt = new Date(2026, 6, 1).getTime();
  const day = (
    date: string,
    startedAt: number,
    input: number,
    cost: number,
  ) => ({
    date,
    turns: 1,
    firstTurnAt: startedAt,
    lastCallAt: startedAt + 1,
    input,
    cacheRead: 0,
    peakContext: input,
    cost,
    hasPricedCost: true,
    hasUnpricedCost: false,
    models: [{
      model: "claude-sonnet-4-5",
      input,
      cacheRead: 0,
      cost,
      hasPricedCost: true,
      hasUnpricedCost: false,
    }],
  });
  const response = aggregateUsageRollups(
    [{
      rootSessionID: 1,
      sessionStartedAt,
      directInput: 100,
      subagentInput: 150,
      subagentModelCalls: 2,
      overview: {
        days: [
          day("2026-07-10", firstDay, 200, 5),
          day("2026-07-11", secondDay, 50, 1),
        ],
        executionIntervals: [],
      },
    }, {
      rootSessionID: 3,
      sessionStartedAt,
      directInput: 100,
      subagentInput: 0,
      subagentModelCalls: 0,
      overview: {
        days: [day("2026-07-10", firstDay + 1, 100, 5)],
        executionIntervals: [],
      },
    }],
    [{
      rootSessionID: 1,
      subagentSessionID: 2,
      date: "2026-07-10",
      input: 100,
      cost: 3,
      hasUnpricedCost: false,
    }, {
      rootSessionID: 1,
      subagentSessionID: 2,
      date: "2026-07-11",
      input: 50,
      cost: 1,
      hasUnpricedCost: false,
    }],
  ).response;

  deepStrictEqual(response.subagentDays, [{
    date: "2026-07-10",
    rootOnly: 1,
    withSubagents: 1,
    withMultipleSubagents: 0,
    subagents: 1,
    totalInput: 300,
    subagentInput: 100,
    totalCost: 10,
    subagentCost: 3,
    hasUnpricedCost: false,
  }, {
    date: "2026-07-11",
    rootOnly: 0,
    withSubagents: 1,
    withMultipleSubagents: 0,
    subagents: 1,
    totalInput: 50,
    subagentInput: 50,
    totalCost: 1,
    subagentCost: 1,
    hasUnpricedCost: false,
  }]);
  deepStrictEqual(response.subagentWeeks, [{
    date: "2026-07-06",
    endDate: "2026-07-12",
    rootOnly: 1,
    withSubagents: 1,
    withMultipleSubagents: 0,
    subagents: 1,
    totalInput: 350,
    subagentInput: 150,
    totalCost: 11,
    subagentCost: 4,
    hasUnpricedCost: false,
  }]);
  deepStrictEqual(response.days, [{
    date: "2026-07-10",
    models: [{ model: "claude-sonnet-4-5", input: 300, cost: 10 }],
  }, {
    date: "2026-07-11",
    models: [{ model: "claude-sonnet-4-5", input: 50, cost: 1 }],
  }]);
});

Deno.test("falls back to reported cost when a computed price is unavailable", () => {
  const startedAt = new Date(2026, 6, 10).getTime();
  const priced = usageCall("priced", startedAt, 100);
  priced.computedCost = 2;
  const reported = usageCall("reported", startedAt, 100);
  reported.reportedCost = 3;

  const response = aggregateUsage([priced, reported]).response;

  deepStrictEqual(response.days, [{
    date: "2026-07-10",
    models: [{
      model: "claude-sonnet-4-5",
      input: 200,
      cost: 5,
    }],
  }]);
  deepStrictEqual(response.hasUnpricedCost, true);
});
