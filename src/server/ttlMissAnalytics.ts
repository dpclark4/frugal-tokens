import type { TtlMissMetrics } from "../shared/sessionSchemas.ts";
import { categorizeUsageCallCache } from "./cacheAnalysis.ts";
import { computeModelCallCost, estimateModelCacheMissCost } from "./pricing.ts";
import type { UsageCall } from "./usage.ts";

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;

type CacheMiss = {
  gap: number;
  status: "full-miss" | "partial-hit";
  ttl: boolean;
  compaction: boolean;
  attributedCost?: number;
  expectedReadCost?: number;
  estimatedExtraCost?: number;
  missedTokens?: number;
};

function cacheMisses(calls: UsageCall[]) {
  const misses: CacheMiss[] = [];
  for (const call of categorizeUsageCallCache(calls)) {
    const previous = call.previousComparableCall;
    const assessment = call.cacheAssessment;
    if (
      !previous || (assessment.status !== "partial-hit" &&
        assessment.status !== "full-miss")
    ) continue;
    const estimate = estimateModelCacheMissCost(
      previous.tokens,
      call.tokens,
      call.model,
      call.startedAt,
    );
    misses.push({
      gap: call.startedAt - previous.startedAt,
      status: assessment.status,
      ttl: assessment.cause === "ttl",
      compaction: assessment.cause === "compaction",
      attributedCost: estimate?.actualMissedCost,
      expectedReadCost: estimate?.expectedReadCost,
      estimatedExtraCost: estimate?.estimatedExtraCost,
      missedTokens: estimate?.missedTokens,
    });
  }
  return misses;
}

function emptyCacheMissCategory(): TtlMissMetrics["cacheMisses"]["full"] {
  return {
    affectedSessions: 0,
    misses: 0,
    attributedCost: 0,
    expectedReadCost: 0,
    estimatedExtraCost: 0,
    missedTokens: 0,
    unpriced: 0,
  };
}

function addCacheMisses(
  category: TtlMissMetrics["cacheMisses"]["full"],
  misses: CacheMiss[],
) {
  if (misses.length > 0) category.affectedSessions++;
  category.misses += misses.length;
  for (const miss of misses) {
    if (miss.attributedCost === undefined) category.unpriced++;
    else {
      category.attributedCost += miss.attributedCost;
      category.expectedReadCost += miss.expectedReadCost!;
      category.estimatedExtraCost += miss.estimatedExtraCost!;
      category.missedTokens += miss.missedTokens!;
    }
  }
}

export function aggregateTtlMisses(
  usageCalls: UsageCall[],
  start: number,
  rangeDays: number,
): TtlMissMetrics {
  const rangedCalls = usageCalls.filter((call) => call.startedAt >= start);
  const sessions = Map.groupBy(
    rangedCalls.filter((call) => call.sessionStartedAt >= start),
    (call) => `${call.harness}:${call.session.rootID}`,
  );
  const result: TtlMissMetrics = {
    rangeDays,
    sessions: sessions.size,
    totalCost: 0,
    hasUnpricedTotalCost: false,
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
    cacheMisses: {
      affectedSessions: 0,
      affectedSessionCost: 0,
      hasUnpricedAffectedSessionCost: false,
      compaction: emptyCacheMissCategory(),
      unexpected: {
        affectedSessions: 0,
        affectedSessionCost: 0,
        hasUnpricedAffectedSessionCost: false,
        full: emptyCacheMissCategory(),
        partial: emptyCacheMissCategory(),
      },
      full: emptyCacheMissCategory(),
      partial: emptyCacheMissCategory(),
    },
  };

  for (const call of rangedCalls) {
    const cost = call.computedCost ?? computeModelCallCost(
      call.tokens,
      call.model,
      call.startedAt,
    );
    if (cost === undefined) result.hasUnpricedTotalCost = true;
    else result.totalCost += cost;
  }

  for (const calls of sessions.values()) {
    const rootCalls = calls.filter((call) =>
      call.session.id === call.session.rootID
    );
    const allRootMisses = cacheMisses(rootCalls);
    const rootMisses = allRootMisses.filter((miss) => miss.ttl);
    const compactionMisses = allRootMisses.filter((miss) => miss.compaction);
    const unexpectedMisses = allRootMisses.filter((miss) =>
      !miss.ttl && !miss.compaction
    );
    const fullMisses = allRootMisses.filter((miss) =>
      miss.status === "full-miss"
    );
    const partialMisses = allRootMisses.filter((miss) =>
      miss.status === "partial-hit"
    );
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
    addCacheMisses(result.cacheMisses.full, fullMisses);
    addCacheMisses(result.cacheMisses.partial, partialMisses);
    addCacheMisses(result.cacheMisses.compaction, compactionMisses);
    addCacheMisses(
      result.cacheMisses.unexpected.full,
      unexpectedMisses.filter((miss) => miss.status === "full-miss"),
    );
    addCacheMisses(
      result.cacheMisses.unexpected.partial,
      unexpectedMisses.filter((miss) => miss.status === "partial-hit"),
    );
    if (allRootMisses.length > 0) {
      result.cacheMisses.affectedSessions++;
      result.cacheMisses.affectedSessionCost += rootSessionCost;
      result.cacheMisses.hasUnpricedAffectedSessionCost ||=
        hasUnpricedRootSessionCost;
    }
    if (unexpectedMisses.length > 0) {
      result.cacheMisses.unexpected.affectedSessions++;
      result.cacheMisses.unexpected.affectedSessionCost += rootSessionCost;
      result.cacheMisses.unexpected.hasUnpricedAffectedSessionCost ||=
        hasUnpricedRootSessionCost;
    }
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

    const subagentMisses = cacheMisses(
      calls.filter((call) => call.session.id !== call.session.rootID),
    ).filter((miss) => miss.ttl);
    if (subagentMisses.length > 0) result.subagents.affectedSessions++;
    result.subagents.misses += subagentMisses.length;
  }

  return result;
}
