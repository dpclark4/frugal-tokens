import { strictEqual } from "node:assert/strict";
import { aggregatePerformance } from "./performanceAnalytics.ts";
import type { UsageCall } from "./usage.ts";

function call(
  session: string,
  turn: number,
  startedAt: number,
  cacheRead: number,
  cacheWrite?: number,
): UsageCall {
  return {
    harness: "codex",
    session: { id: session, rootID: session },
    cacheChainID: session,
    turnID: `${session}:${turn}`,
    turnOrdinal: turn,
    sessionStartedAt: startedAt - turn,
    provider: "openai",
    model: "gpt-5.4",
    startedAt,
    tokens: {
      uncachedInput: cacheWrite === undefined ? 100 : 0,
      cacheRead,
      cacheWrite,
      freshPrompt: 100,
      output: 0,
      reasoning: 0,
      processed: 100 + cacheRead + (cacheWrite ?? 0),
    },
  };
}

Deno.test("aggregates weekly session and turn cache miss rates by model", () => {
  const start = new Date(2026, 2, 2).getTime();
  const end = new Date(2026, 2, 8, 23, 59).getTime();
  const result = aggregatePerformance(
    [
      call("missed", 1, start + 10, 0, 100),
      call("missed", 2, start + 20, 0),
      call("clean", 1, start + 30, 0, 100),
      call("partial", 1, start + 32, 0, 100),
      call("partial", 2, start + 34, 50),
      call("compacted", 1, start + 40, 0, 100),
      { ...call("compacted", 2, start + 50, 0), followsCompaction: true },
      call("expired", 1, start + 60, 0, 100),
      call("expired", 2, start + 2 * 60 * 60 * 1_000, 0),
    ],
    start,
    end,
    "gpt-5.4",
    "all",
  );

  strictEqual(result.openai.sessions, 5);
  strictEqual(result.openai.eligibleSessions, 2);
  strictEqual(result.openai.sessionsWithMiss, 2);
  strictEqual(result.openai.turns, 9);
  strictEqual(result.openai.eligibleTurns, 2);
  strictEqual(result.openai.turnsWithMiss, 2);
  strictEqual(result.openai.modelCalls, 9);
  strictEqual(result.openai.eligibleModelCalls, 2);
  strictEqual(result.openai.modelCallsWithMiss, 2);
  strictEqual(result.openai.weeks.length, 1);
  strictEqual(result.openai.weeks[0].sessions, 5);
  strictEqual(result.openai.weeks[0].modelCalls, 9);
  strictEqual(result.openai.weeks[0].modelCallsWithMiss, 2);
  strictEqual(result.anthropic.sessions, 0);
});

Deno.test("buckets every partial and full cache loss", () => {
  const start = new Date(2026, 2, 2).getTime();
  const end = new Date(2026, 2, 8, 23, 59).getTime();
  const result = aggregatePerformance(
    [
      call("retention", 1, start + 10, 0, 100),
      call("retention", 2, start + 20, 80),
      call("hit", 1, start + 25, 0, 100),
      call("hit", 2, start + 26, 95),
      call("compacted", 1, start + 30, 0, 100),
      { ...call("compacted", 2, start + 40, 0), followsCompaction: true },
    ],
    start,
    end,
  );
  const buckets = result.openai.weeks[0].cacheLossBuckets!;

  strictEqual(buckets[0].requests, 2);
  strictEqual(buckets[0].unretainedTokens, 25);
  strictEqual(buckets[1].requests, 0);
  strictEqual(result.openai.weeks[0].reuseOpportunities, 2);
  strictEqual(result.openai.weeks[0].reusableTokensAtRisk, 200);
});

Deno.test("limits context loss to reusable overlap", () => {
  const start = new Date(2026, 2, 2).getTime();
  const end = new Date(2026, 2, 8, 23, 59).getTime();
  const smallerContext = call("smaller", 2, start + 20, 20);
  smallerContext.tokens.uncachedInput = 30;
  smallerContext.tokens.freshPrompt = 30;
  smallerContext.tokens.processed = 50;

  const result = aggregatePerformance(
    [
      call("smaller", 1, start + 10, 0, 100),
      smallerContext,
    ],
    start,
    end,
  );
  const buckets = result.openai.weeks[0].cacheLossBuckets!;

  strictEqual(buckets[0].requests, 1);
  strictEqual(buckets[0].unretainedTokens, 30);
});

Deno.test("excludes model changes from unexpected miss rates and volume", () => {
  const start = new Date(2026, 2, 2).getTime();
  const end = new Date(2026, 2, 8, 23, 59).getTime();
  const switched = call("switched", 2, start + 20, 0);
  switched.model = "gpt-5.3-codex";
  const result = aggregatePerformance(
    [
      call("switched", 1, start + 10, 0, 100),
      switched,
      call("unexpected", 1, start + 30, 0, 100),
      call("unexpected", 2, start + 40, 50),
    ],
    start,
    end,
  );
  const buckets = result.openai.weeks[0].cacheLossBuckets!;

  strictEqual(result.openai.sessionsWithMiss, 1);
  strictEqual(result.openai.turnsWithMiss, 1);
  strictEqual(result.openai.modelCallsWithMiss, 1);
  strictEqual(buckets[0].requests, 1);
});

Deno.test("excludes zero-input calls from performance eligibility", () => {
  const start = new Date(2026, 2, 2).getTime();
  const empty = call("empty", 1, start + 10, 0);
  empty.tokens.uncachedInput = 0;
  empty.tokens.freshPrompt = 0;
  empty.tokens.processed = 0;
  const result = aggregatePerformance(
    [empty],
    start,
    new Date(2026, 2, 8, 23, 59).getTime(),
  );

  strictEqual(result.openai.sessions, 0);
  strictEqual(result.openai.turns, 0);
  strictEqual(result.openai.modelCalls, 0);
});
