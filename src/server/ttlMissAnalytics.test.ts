import { deepStrictEqual } from "node:assert/strict";
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
  } = {},
): UsageCall {
  const root = options.root ?? session;
  return {
    harness: "claude-code",
    session: { id: session, rootID: root },
    cacheChainID: options.chain ?? session,
    sessionStartedAt: options.sessionStartedAt ?? start,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    startedAt,
    followsCompaction: options.followsCompaction,
    tokens: {
      uncachedInput: 100,
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

  deepStrictEqual(aggregateTtlMisses(calls, start, 90), {
    rangeDays: 90,
    sessions: 2,
    affectedSessions: 1,
    misses: {
      total: 3,
      underTwoHours: 1,
      twoToEightHours: 1,
      eightHoursOrMore: 1,
    },
    subagents: { affectedSessions: 0, misses: 0 },
  });
});

Deno.test("separates subagent misses and excludes compactions and old sessions", () => {
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
    affectedSessions: 0,
    misses: {
      total: 0,
      underTwoHours: 0,
      twoToEightHours: 0,
      eightHoursOrMore: 0,
    },
    subagents: { affectedSessions: 1, misses: 1 },
  });
});
