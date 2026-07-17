import { deepStrictEqual, ok, strictEqual } from "node:assert";
import type { SessionDetail, TokenUsage } from "../shared/sessionSchemas.ts";
import { overviewResponseSchema } from "../shared/sessionSchemas.ts";
import { aggregateOverview } from "./overviewAnalytics.ts";

function tokens(input: number, cacheRead: number): TokenUsage {
  return {
    uncachedInput: input - cacheRead,
    cacheRead,
    freshPrompt: input - cacheRead,
    output: 0,
    reasoning: 0,
    processed: input,
  };
}

function session(
  id: string,
  turns: Array<{
    startedAt: number;
    input: number;
    cacheRead: number;
    cost?: number;
    model?: string;
  }>,
  subagents: SessionDetail[] = [],
): SessionDetail {
  const usage = turns.map((turn) => tokens(turn.input, turn.cacheRead));
  return {
    id,
    harness: "opencode",
    title: id,
    updatedAt: turns.at(-1)?.startedAt ?? 0,
    startedAt: turns.at(0)?.startedAt,
    endedAt: turns.at(-1)?.startedAt,
    providers: ["test"],
    models: [...new Set(turns.map((turn) => turn.model ?? "model"))],
    userTurns: turns.length,
    modelCalls: turns.length,
    tokens: tokens(
      usage.reduce(
        (sum, value) =>
          sum + value.uncachedInput + value.cacheRead + (value.cacheWrite ?? 0),
        0,
      ),
      usage.reduce((sum, value) => sum + value.cacheRead, 0),
    ),
    turns: turns.map((turn, index) => ({
      number: index + 1,
      startedAt: turn.startedAt,
      calls: [{
        id: `${id}-${index + 1}`,
        callWithinTurn: 1,
        provider: "test",
        model: turn.model ?? "model",
        startedAt: turn.startedAt,
        completedAt: turn.startedAt + 60_000,
        computedCost: turn.cost,
        tokens: tokens(turn.input, turn.cacheRead),
        activity: { hasText: true, hasReasoning: false, tools: [] },
      }],
    })),
    subagents,
  };
}

Deno.test("aggregates active dates and inclusive subagent work", () => {
  const friday = new Date(2026, 6, 10, 9).getTime();
  const saturday = new Date(2026, 6, 11, 9).getTime();
  const child = session("child", [{
    startedAt: saturday,
    input: 900,
    cacheRead: 0,
    cost: 9,
  }]);
  const roots = [
    session("multi-day", [{
      startedAt: friday,
      input: 100,
      cacheRead: 50,
      cost: 1,
    }], [child]),
    session("friday-only", [{
      startedAt: friday + 60_000,
      input: 100,
      cacheRead: 100,
      cost: 2,
    }]),
  ];

  const result = aggregateOverview(
    roots,
    new Date(2026, 6, 10).getTime(),
    new Date(2026, 6, 11, 23, 59).getTime(),
    2,
  );

  overviewResponseSchema.parse(result);
  strictEqual(result.activeDays, 2);
  strictEqual(result.activeWeekdays, 1);
  strictEqual(result.weekendDays, 1);
  strictEqual(result.weekdayActivityRate, 1);
  strictEqual(result.sessions, 2);
  strictEqual(result.multiDaySessions, 1);
  strictEqual(result.averageActiveSpan, 1.5);
  deepStrictEqual(result.activity.sessions, {
    average: 1.5,
    median: 1.5,
    p90: 1.9,
  });
  deepStrictEqual(result.sessionProfile.turns, {
    average: 1.5,
    median: 1.5,
    p90: 1.9,
  });
});

Deno.test("keeps overall efficiency token-weighted", () => {
  const startedAt = new Date(2026, 6, 10, 9).getTime();
  const result = aggregateOverview(
    [
      session("large", [{
        startedAt,
        input: 900,
        cacheRead: 0,
        cost: 9,
      }]),
      session("small", [{
        startedAt: startedAt + 60_000,
        input: 100,
        cacheRead: 100,
        cost: 1,
      }]),
    ],
    new Date(2026, 6, 10).getTime(),
    startedAt + 3_600_000,
    1,
  );

  ok(Math.abs(result.sessionProfile.overallEfficiency! - 0.1) < 1e-10);
  ok(Math.abs(result.sessionProfile.efficiency!.average - 0.5) < 1e-10);
  ok(Math.abs(result.sessionProfile.efficiency!.median - 0.5) < 1e-10);
});

Deno.test("keeps known spend when some calls are unpriced", () => {
  const startedAt = new Date(2026, 6, 10, 9).getTime();
  const result = aggregateOverview(
    [
      session("priced", [{
        startedAt,
        input: 100,
        cacheRead: 0,
        cost: 5,
      }]),
      session("unpriced", [{
        startedAt: startedAt + 60_000,
        input: 100,
        cacheRead: 0,
      }]),
    ],
    new Date(2026, 6, 10).getTime(),
    startedAt + 3_600_000,
    1,
  );

  strictEqual(result.activity.hasUnpricedCost, true);
  strictEqual(result.activity.spend!.median, 5);
  strictEqual(result.sessionProfile.spend!.median, 2.5);
});
