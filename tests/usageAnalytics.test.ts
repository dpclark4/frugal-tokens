import { deepStrictEqual } from "node:assert/strict";
import { aggregateUsage } from "../src/server/usageAnalytics.ts";
import type { UsageCall } from "../src/server/usage.ts";

function usageCall(
  session: string,
  sessionStartedAt: number,
  input: number,
): UsageCall {
  return {
    harness: "opencode",
    session: { id: session, rootID: session },
    cacheChainID: session,
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
    calls: 3,
    subagentCalls: 1,
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
    calls: 3,
    subagentCalls: 1,
    totalInput: 300,
    subagentInput: 100,
    totalCost: 10,
    subagentCost: 3,
    hasUnpricedCost: false,
  }]);
});
