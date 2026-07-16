import type { TtlMissMetrics } from "../shared/sessionSchemas.ts";
import { assessCache, ttlExpired } from "./cacheAnalysis.ts";
import type { UsageCall } from "./usage.ts";

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;

function ttlMissGaps(calls: UsageCall[]) {
  const gaps: number[] = [];
  for (
    const chain of Map.groupBy(calls, (call) => call.cacheChainID).values()
  ) {
    let previous: UsageCall | undefined;
    for (const call of chain.sort((a, b) => a.startedAt - b.startedAt)) {
      const assessment = assessCache(previous, call);
      const miss = assessment.status === "partial-hit" ||
        assessment.status === "full-miss";
      if (
        miss && !call.followsCompaction && previous &&
        ttlExpired(previous, call)
      ) {
        gaps.push(call.startedAt - previous.startedAt);
      }
      previous = call;
    }
  }
  return gaps;
}

export function aggregateTtlMisses(
  usageCalls: UsageCall[],
  start: number,
  rangeDays: number,
): TtlMissMetrics {
  const sessions = Map.groupBy(
    usageCalls.filter((call) => call.sessionStartedAt >= start),
    (call) => `${call.harness}:${call.session.rootID}`,
  );
  const result: TtlMissMetrics = {
    rangeDays,
    sessions: sessions.size,
    affectedSessions: 0,
    misses: {
      total: 0,
      underTwoHours: 0,
      twoToEightHours: 0,
      eightHoursOrMore: 0,
    },
    subagents: { affectedSessions: 0, misses: 0 },
  };

  for (const calls of sessions.values()) {
    const rootGaps = ttlMissGaps(
      calls.filter((call) => call.session.id === call.session.rootID),
    );
    if (rootGaps.length > 0) result.affectedSessions++;
    result.misses.total += rootGaps.length;
    for (const gap of rootGaps) {
      if (gap < TWO_HOURS_MS) result.misses.underTwoHours++;
      else if (gap < EIGHT_HOURS_MS) result.misses.twoToEightHours++;
      else result.misses.eightHoursOrMore++;
    }

    const subagentGaps = ttlMissGaps(
      calls.filter((call) => call.session.id !== call.session.rootID),
    );
    if (subagentGaps.length > 0) result.subagents.affectedSessions++;
    result.subagents.misses += subagentGaps.length;
  }

  return result;
}
