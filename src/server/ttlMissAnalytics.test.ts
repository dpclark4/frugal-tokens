import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { aggregateTtlMisses } from "./ttlMissAnalytics.ts";
import type { UsageCall } from "./usage.ts";

const MINUTE = 60 * 1_000;
const start = Date.UTC(2026, 0, 1);

function call(
  session: string,
  startedAt: number,
  options: {
    root?: string;
    chain?: string;
    sessionStartedAt?: number;
    followsCompaction?: boolean;
    model?: string;
  } = {},
): UsageCall {
  const root = options.root ?? session;
  return {
    harness: "claude-code",
    session: { id: session, rootID: root },
    cacheChainID: options.chain ?? session,
    turnID: `${session}:${startedAt}`,
    turnOrdinal: 1,
    sessionStartedAt: options.sessionStartedAt ?? start,
    provider: "anthropic",
    model: options.model ?? "claude-sonnet-4-5",
    startedAt,
    followsCompaction: options.followsCompaction,
    tokens: {
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 100,
      cacheWrite5m: 100,
      cacheWrite1h: 0,
      freshPrompt: 0,
      output: 0,
      reasoning: 0,
      processed: 100,
    },
  };
}

Deno.test("counts every root TTL miss in its elapsed-time bucket", () => {
  const calls = [
    call("affected", start),
    call("affected", start + 60 * MINUTE),
    call("affected", start + 3 * 60 * MINUTE),
    call("affected", start + 11 * 60 * MINUTE),
    call("clean", start),
  ];

  const result = aggregateTtlMisses(calls, start, 90);
  strictEqual(Math.abs(result.totalCost - 0.001875) < 1e-12, true);
  strictEqual(Math.abs(result.totalSessionCost - 0.001875) < 1e-12, true);
  strictEqual(Math.abs(result.affectedSessionCost - 0.0015) < 1e-12, true);
  strictEqual(Math.abs(result.misses.attributedCost - 0.001125) < 1e-12, true);
  strictEqual(
    Math.abs(result.misses.underTwoHoursCost - 0.000375) < 1e-12,
    true,
  );
  strictEqual(
    Math.abs(result.misses.twoToEightHoursCost - 0.000375) < 1e-12,
    true,
  );
  strictEqual(
    Math.abs(result.misses.eightHoursOrMoreCost - 0.000375) < 1e-12,
    true,
  );
  deepStrictEqual({
    ...result,
    totalCost: 0,
    totalSessionCost: 0,
    affectedSessionCost: 0,
    misses: {
      ...result.misses,
      attributedCost: 0,
      underTwoHoursCost: 0,
      twoToEightHoursCost: 0,
      eightHoursOrMoreCost: 0,
    },
  }, {
    rangeDays: 90,
    sessions: 2,
    totalCost: 0,
    hasUnpricedTotalCost: false,
    totalSessionCost: 0,
    hasUnpricedSessionCost: false,
    affectedSessions: 1,
    affectedSessionCost: 0,
    hasUnpricedAffectedSessionCost: false,
    misses: {
      total: 3,
      attributedCost: 0,
      unpriced: 0,
      underTwoHours: 1,
      underTwoHoursSessions: 1,
      underTwoHoursCost: 0,
      twoToEightHours: 1,
      twoToEightHoursSessions: 1,
      twoToEightHoursCost: 0,
      eightHoursOrMore: 1,
      eightHoursOrMoreSessions: 1,
      eightHoursOrMoreCost: 0,
    },
    subagents: { affectedSessions: 0, misses: 0 },
    cacheMisses: {
      affectedSessions: 1,
      otherAffectedSessions: 0,
      affectedSessionCost: 0.0015,
      hasUnpricedAffectedSessionCost: false,
      compaction: {
        affectedSessions: 0,
        misses: 0,
        attributedCost: 0,
        expectedReadCost: 0,
        estimatedExtraCost: 0,
        missedTokens: 0,
        unpriced: 0,
      },
      unexpected: {
        affectedSessions: 0,
        affectedSessionCost: 0,
        hasUnpricedAffectedSessionCost: false,
        full: {
          affectedSessions: 0,
          misses: 0,
          attributedCost: 0,
          expectedReadCost: 0,
          estimatedExtraCost: 0,
          missedTokens: 0,
          unpriced: 0,
        },
        partial: {
          affectedSessions: 0,
          misses: 0,
          attributedCost: 0,
          expectedReadCost: 0,
          estimatedExtraCost: 0,
          missedTokens: 0,
          unpriced: 0,
        },
      },
      full: {
        affectedSessions: 1,
        misses: 3,
        attributedCost: 0.0011250000000000001,
        expectedReadCost: 0.00009,
        estimatedExtraCost: 0.001035,
        missedTokens: 300,
        unpriced: 0,
      },
      partial: {
        affectedSessions: 0,
        misses: 0,
        attributedCost: 0,
        expectedReadCost: 0,
        estimatedExtraCost: 0,
        missedTokens: 0,
        unpriced: 0,
      },
    },
  });
});

Deno.test("counts each session once per TTL return-gap bucket", () => {
  const result = aggregateTtlMisses([
    call("affected", start),
    call("affected", start + 30 * MINUTE),
    call("affected", start + 60 * MINUTE),
    call("affected", start + 4 * 60 * MINUTE),
  ], start, 90);

  strictEqual(result.misses.underTwoHours, 2);
  strictEqual(result.misses.underTwoHoursSessions, 1);
  strictEqual(result.misses.twoToEightHours, 1);
  strictEqual(result.misses.twoToEightHoursSessions, 1);
  strictEqual(result.misses.eightHoursOrMoreSessions, 0);
});

Deno.test("counts a session once across other miss causes", () => {
  const result = aggregateTtlMisses([
    call("affected", start),
    call("affected", start + MINUTE, { followsCompaction: true }),
    call("affected", start + 2 * MINUTE),
  ], start, 90);

  strictEqual(result.cacheMisses.compaction.misses, 1);
  strictEqual(result.cacheMisses.unexpected.full.misses, 1);
  strictEqual(result.cacheMisses.otherAffectedSessions, 1);
});

Deno.test("keeps a recent model-switch full miss out of unexpected metrics", () => {
  const result = aggregateTtlMisses([
    call("switched", start, { model: "gpt-5.6-terra" }),
    call("switched", start + 2 * MINUTE, { model: "gpt-5.6-luna" }),
  ], start, 90);

  strictEqual(result.cacheMisses.full.misses, 1);
  strictEqual(result.cacheMisses.unexpected.full.misses, 0);
  strictEqual(result.cacheMisses.otherAffectedSessions, 0);
});

Deno.test("separates subagent misses and keeps compactions outside TTL", () => {
  const calls = [
    call("root", start),
    call("root", start + 10 * MINUTE, { followsCompaction: true }),
    call("child", start, { root: "root" }),
    call("child", start + 10 * MINUTE, { root: "root" }),
    call("old", start - 2 * MINUTE, {
      sessionStartedAt: start - 2 * MINUTE,
    }),
    call("old", start + 10 * MINUTE, {
      sessionStartedAt: start - 2 * MINUTE,
    }),
  ];

  deepStrictEqual(aggregateTtlMisses(calls, start, 90), {
    rangeDays: 90,
    sessions: 1,
    totalCost: 0.001875,
    hasUnpricedTotalCost: false,
    totalSessionCost: 0.00075,
    hasUnpricedSessionCost: false,
    affectedSessions: 0,
    affectedSessionCost: 0,
    hasUnpricedAffectedSessionCost: false,
    misses: {
      total: 0,
      attributedCost: 0,
      unpriced: 0,
      underTwoHours: 0,
      underTwoHoursSessions: 0,
      underTwoHoursCost: 0,
      twoToEightHours: 0,
      twoToEightHoursSessions: 0,
      twoToEightHoursCost: 0,
      eightHoursOrMore: 0,
      eightHoursOrMoreSessions: 0,
      eightHoursOrMoreCost: 0,
    },
    subagents: { affectedSessions: 1, misses: 1 },
    cacheMisses: {
      affectedSessions: 1,
      otherAffectedSessions: 1,
      affectedSessionCost: 0.00075,
      hasUnpricedAffectedSessionCost: false,
      compaction: {
        affectedSessions: 1,
        misses: 1,
        attributedCost: 0.000375,
        expectedReadCost: 0.00003,
        estimatedExtraCost: 0.000345,
        missedTokens: 100,
        unpriced: 0,
      },
      unexpected: {
        affectedSessions: 0,
        affectedSessionCost: 0,
        hasUnpricedAffectedSessionCost: false,
        full: {
          affectedSessions: 0,
          misses: 0,
          attributedCost: 0,
          expectedReadCost: 0,
          estimatedExtraCost: 0,
          missedTokens: 0,
          unpriced: 0,
        },
        partial: {
          affectedSessions: 0,
          misses: 0,
          attributedCost: 0,
          expectedReadCost: 0,
          estimatedExtraCost: 0,
          missedTokens: 0,
          unpriced: 0,
        },
      },
      full: {
        affectedSessions: 1,
        misses: 1,
        attributedCost: 0.000375,
        expectedReadCost: 0.00003,
        estimatedExtraCost: 0.000345,
        missedTokens: 100,
        unpriced: 0,
      },
      partial: {
        affectedSessions: 0,
        misses: 0,
        attributedCost: 0,
        expectedReadCost: 0,
        estimatedExtraCost: 0,
        missedTokens: 0,
        unpriced: 0,
      },
    },
  });
});

Deno.test("reports incomplete affected-session and miss pricing", () => {
  const result = aggregateTtlMisses(
    [
      call("unknown", start, { model: "unknown-model" }),
      call("unknown", start + 10 * MINUTE, { model: "unknown-model" }),
    ],
    start,
    90,
  );

  strictEqual(result.affectedSessions, 1);
  strictEqual(result.totalCost, 0);
  strictEqual(result.hasUnpricedTotalCost, true);
  strictEqual(result.totalSessionCost, 0);
  strictEqual(result.hasUnpricedSessionCost, true);
  strictEqual(result.affectedSessionCost, 0);
  strictEqual(result.hasUnpricedAffectedSessionCost, true);
  strictEqual(result.misses.total, 1);
  strictEqual(result.misses.attributedCost, 0);
  strictEqual(result.misses.unpriced, 1);
  strictEqual(result.cacheMisses.full.misses, 1);
  strictEqual(result.cacheMisses.full.unpriced, 1);
});

Deno.test("separates full and partial miss costs", () => {
  const before = call("mixed", start);
  before.tokens.cacheRead = 900;
  before.tokens.cacheWrite = 100;
  before.tokens.cacheWrite5m = 100;
  before.tokens.processed = 1_000;
  const partial = call("mixed", start + MINUTE);
  partial.tokens.cacheRead = 500;
  partial.tokens.cacheWrite = 500;
  partial.tokens.cacheWrite5m = 500;
  partial.tokens.processed = 1_000;
  const full = call("mixed", start + 2 * MINUTE);
  full.tokens.cacheWrite = 1_000;
  full.tokens.cacheWrite5m = 1_000;
  full.tokens.processed = 1_000;

  const result = aggregateTtlMisses([before, partial, full], start, 90);

  strictEqual(result.cacheMisses.affectedSessions, 1);
  strictEqual(result.cacheMisses.partial.misses, 1);
  strictEqual(result.cacheMisses.partial.missedTokens, 500);
  strictEqual(result.cacheMisses.full.misses, 1);
  strictEqual(result.cacheMisses.full.missedTokens, 1_000);
});
