import type { TtlMissMetrics } from "../shared/sessionSchemas.ts";
import { assessCache, ttlExpired } from "./cacheAnalysis.ts";
import { computeModelCallCost, estimateModelCacheMissCost } from "./pricing.ts";
import type { UsageCall } from "./usage.ts";

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;

type TtlMiss = { gap: number; attributedCost?: number };

function ttlMisses(calls: UsageCall[]) {
  const misses: TtlMiss[] = [];
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
        misses.push({
          gap: call.startedAt - previous.startedAt,
          attributedCost: estimateModelCacheMissCost(
            previous.tokens,
            call.tokens,
            call.model,
            call.startedAt,
          )?.actualMissedCost,
        });
      }
      previous = call;
    }
  }
  return misses;
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
    totalSessionCost: 0,
    hasUnpricedSessionCost: false,
    affectedSessions: 0,
    affectedSessionCost: 0,
    hasUnpricedAffectedSessionCost: false,
    misses: {
      total: 0,
      attributedCost: 0,
      unpriced: 0,
      underTwoHours: 0,
      underTwoHoursCost: 0,
      twoToEightHours: 0,
      twoToEightHoursCost: 0,
      eightHoursOrMore: 0,
      eightHoursOrMoreCost: 0,
    },
    subagents: { affectedSessions: 0, misses: 0 },
  };

  for (const calls of sessions.values()) {
    const rootCalls = calls.filter((call) =>
      call.session.id === call.session.rootID
    );
    const rootMisses = ttlMisses(rootCalls);
    let rootSessionCost = 0;
    let hasUnpricedRootSessionCost = false;
    for (const call of rootCalls) {
      const cost = call.computedCost ?? computeModelCallCost(
        call.tokens,
        call.model,
        call.startedAt,
      );
      if (cost === undefined) hasUnpricedRootSessionCost = true;
      else rootSessionCost += cost;
    }
    result.totalSessionCost += rootSessionCost;
    result.hasUnpricedSessionCost ||= hasUnpricedRootSessionCost;
    if (rootMisses.length > 0) {
      result.affectedSessions++;
      result.affectedSessionCost += rootSessionCost;
      result.hasUnpricedAffectedSessionCost ||= hasUnpricedRootSessionCost;
    }
    result.misses.total += rootMisses.length;
    for (const miss of rootMisses) {
      if (miss.attributedCost === undefined) result.misses.unpriced++;
      else result.misses.attributedCost += miss.attributedCost;
      if (miss.gap < TWO_HOURS_MS) {
        result.misses.underTwoHours++;
        result.misses.underTwoHoursCost += miss.attributedCost ?? 0;
      } else if (miss.gap < EIGHT_HOURS_MS) {
        result.misses.twoToEightHours++;
        result.misses.twoToEightHoursCost += miss.attributedCost ?? 0;
      } else {
        result.misses.eightHoursOrMore++;
        result.misses.eightHoursOrMoreCost += miss.attributedCost ?? 0;
      }
    }

    const subagentMisses = ttlMisses(
      calls.filter((call) => call.session.id !== call.session.rootID),
    );
    if (subagentMisses.length > 0) result.subagents.affectedSessions++;
    result.subagents.misses += subagentMisses.length;
  }

  return result;
}
