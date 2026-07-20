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

function efficiencyCall(
  session: string,
  startedAt: number,
  efficiency: number,
): UsageCall {
  const result = call(session, 1, startedAt, 0);
  return {
    ...result,
    sessionStartedAt: startedAt,
    tokens: {
      ...result.tokens,
      uncachedInput: 100 - efficiency * 100,
      cacheRead: efficiency * 100,
      freshPrompt: 100 - efficiency * 100,
      processed: 100,
    },
  };
}

Deno.test("aggregates weekly session and turn cache miss rates by model", () => {
  const start = new Date(2026, 2, 2).getTime();
  const end = new Date(2026, 2, 8, 23, 59).getTime();
  const result = aggregatePerformance([
    call("missed", 1, start + 10, 0, 100),
    call("missed", 2, start + 20, 0),
    call("clean", 1, start + 30, 0, 100),
    call("partial", 1, start + 32, 0, 100),
    call("partial", 2, start + 34, 50),
    call("compacted", 1, start + 40, 0, 100),
    { ...call("compacted", 2, start + 50, 0), followsCompaction: true },
    call("expired", 1, start + 60, 0, 100),
    call("expired", 2, start + 2 * 60 * 60 * 1_000, 0),
  ], start, end, "gpt-5.4", "all");

  strictEqual(result.openai.sessions, 5);
  strictEqual(result.openai.sessionsWithMiss, 2);
  strictEqual(result.openai.turns, 9);
  strictEqual(result.openai.turnsWithMiss, 2);
  strictEqual(result.openai.weeks.length, 1);
  strictEqual(result.openai.weeks[0].sessions, 5);
  strictEqual(result.anthropic.sessions, 0);
});

Deno.test("calculates weekly session cache-efficiency box plot values", () => {
  const start = new Date(2026, 2, 2).getTime();
  const end = new Date(2026, 2, 8, 23, 59).getTime();
  const result = aggregatePerformance(
    [0, 0.25, 0.5, 0.75, 1].map((efficiency, index) =>
      efficiencyCall(`session-${index}`, start + index * 10, efficiency)
    ),
    start,
    end,
  );
  const distribution = result.openai.weeks[0].efficiency!;

  strictEqual(distribution.lowerWhisker, 0);
  strictEqual(distribution.q1, 0.25);
  strictEqual(distribution.median, 0.5);
  strictEqual(distribution.q3, 0.75);
  strictEqual(distribution.upperWhisker, 1);
  strictEqual(distribution.average, 0.5);
  strictEqual(distribution.sampleSize, 5);
  strictEqual(distribution.outliers, 0);
});

Deno.test("uses Tukey whiskers and reports efficiency outliers", () => {
  const start = new Date(2026, 2, 2).getTime();
  const end = new Date(2026, 2, 8, 23, 59).getTime();
  const result = aggregatePerformance(
    [0, 0.5, 0.5, 0.5, 1].map((efficiency, index) =>
      efficiencyCall(`session-${index}`, start + index * 10, efficiency)
    ),
    start,
    end,
  );
  const distribution = result.openai.weeks[0].efficiency!;

  strictEqual(distribution.lowerWhisker, 0.5);
  strictEqual(distribution.upperWhisker, 0.5);
  strictEqual(distribution.outliers, 2);
});
