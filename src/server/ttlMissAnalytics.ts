import type { TtlMissMetrics } from "../shared/sessionSchemas.ts";
import {
  type CacheMissRecord,
  categorizeUsageCallCache,
} from "./cacheAnalysis.ts";
import type {
  ModelCallCostSummary,
  StoredCacheMiss,
  StoredCacheMissAggregate,
} from "./conversationRepository.ts";
import { computeModelCallCost, estimateModelCacheMissCost } from "./pricing.ts";
import type { UsageCall } from "./usage.ts";

const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;

type CacheMiss = {
  gap: number;
  gapBucket?: StoredCacheMissAggregate["gapBucket"];
  status: CacheMissRecord["status"];
  reason?: CacheMissRecord["reason"];
  cause?: CacheMissRecord["cause"];
  missedTokens: number;
  actualMissedCost?: number;
  expectedReadCost?: number;
  estimatedExtraCost?: number;
  count: number;
  unpriced: number;
};

function storedCacheMiss(miss: StoredCacheMiss): CacheMiss {
  const result: CacheMiss = {
    gap: miss.gap,
    status: miss.status,
    missedTokens: miss.missedTokens,
    actualMissedCost: miss.actualMissedCost,
    expectedReadCost: miss.expectedReadCost,
    estimatedExtraCost: miss.estimatedExtraCost,
    count: 1,
    unpriced: miss.actualMissedCost === undefined ? 1 : 0,
  };
  if (miss.reason !== undefined) result.reason = miss.reason;
  if (miss.cause !== undefined) result.cause = miss.cause;
  return result;
}

function aggregatedCacheMiss(miss: StoredCacheMissAggregate): CacheMiss {
  const result: CacheMiss = {
    gap: 0,
    gapBucket: miss.gapBucket,
    status: miss.status,
    missedTokens: miss.missedTokens,
    actualMissedCost: miss.attributedCost,
    expectedReadCost: miss.expectedReadCost,
    estimatedExtraCost: miss.estimatedExtraCost,
    count: miss.misses,
    unpriced: miss.unpriced,
  };
  if (miss.reason !== undefined) result.reason = miss.reason;
  if (miss.cause !== undefined) result.cause = miss.cause;
  return result;
}

function categorizedMisses(misses: CacheMiss[]) {
  return {
    ttl: misses.filter((miss) => miss.cause === "ttl"),
    compaction: misses.filter((miss) => miss.cause === "compaction"),
    thinkingChange: misses.filter((miss) => miss.cause === "thinking-change"),
    modelChange: misses.filter((miss) =>
      miss.reason === "model-change" && miss.cause === undefined
    ),
    unexpected: misses.filter((miss) =>
      miss.cause === undefined && miss.reason !== "model-change"
    ),
    full: misses.filter((miss) => miss.status === "full-miss"),
    partial: misses.filter((miss) => miss.status === "partial-hit"),
  };
}

export function sumCacheMissCost(misses: StoredCacheMissAggregate[]) {
  return misses.reduce((sum, miss) => sum + miss.attributedCost, 0);
}

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
      call.provider,
      assessment.previousReusableTokens,
    );
    const miss: CacheMiss = {
      gap: call.startedAt - previous.startedAt,
      status: assessment.status,
      missedTokens: estimate?.missedTokens ?? 0,
      actualMissedCost: estimate?.actualMissedCost,
      expectedReadCost: estimate?.expectedReadCost,
      estimatedExtraCost: estimate?.estimatedExtraCost,
      count: 1,
      unpriced: estimate === undefined ? 1 : 0,
    };
    if (assessment.reason !== undefined) miss.reason = assessment.reason;
    if (assessment.cause !== undefined) miss.cause = assessment.cause;
    misses.push(miss);
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
  if (misses.some((miss) => miss.count > 0)) category.affectedSessions++;
  for (const miss of misses) {
    category.misses += miss.count;
    category.unpriced += miss.unpriced;
    category.attributedCost += miss.actualMissedCost ?? 0;
    category.expectedReadCost += miss.expectedReadCost ?? 0;
    category.estimatedExtraCost += miss.estimatedExtraCost ?? 0;
    category.missedTokens += miss.missedTokens;
  }
}

export function aggregateTtlMisses(
  usageCalls: UsageCall[],
  start: number,
  rangeDays: number,
  storedMisses?: StoredCacheMiss[],
  storedCosts?: ModelCallCostSummary,
  storedAggregates?: StoredCacheMissAggregate[],
): TtlMissMetrics {
  const rangedCalls = usageCalls.filter((call) => call.startedAt >= start);
  const sessionGroups: Array<{
    harness: UsageCall["harness"];
    rootID: string;
    sessionStartedAt: number;
    calls: UsageCall[];
    rootCost?: number;
    hasUnpricedRootCost?: boolean;
  }> = storedCosts !== undefined
    ? storedCosts.sessions.map((session) => ({
      harness: session.harness,
      rootID: session.rootID,
      sessionStartedAt: session.sessionStartedAt,
      calls: [],
      rootCost: session.rootCost,
      hasUnpricedRootCost: session.hasUnpricedRootCost,
    }))
    : [
      ...Map.groupBy(
        rangedCalls.filter((call) => call.sessionStartedAt >= start),
        (call) => `${call.harness}:${call.session.rootID}`,
      ).values(),
    ].map((calls) => ({
      harness: calls[0].harness,
      rootID: calls[0].session.rootID,
      sessionStartedAt: calls[0].sessionStartedAt,
      calls,
    }));
  const result: TtlMissMetrics = {
    rangeDays,
    sessions: sessionGroups.length,
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
      underThirtyMinutes: 0,
      underThirtyMinutesSessions: 0,
      underThirtyMinutesCost: 0,
      thirtyMinutesToTwoHours: 0,
      thirtyMinutesToTwoHoursSessions: 0,
      thirtyMinutesToTwoHoursCost: 0,
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
    combined: {
      affectedSessions: 0,
      misses: 0,
      attributedCost: 0,
      missedTokens: 0,
      unpriced: 0,
    },
    subagents: {
      affectedSessions: 0,
      misses: 0,
      attributedCost: 0,
      missedTokens: 0,
      unpriced: 0,
      ttl: emptyCacheMissCategory(),
      compaction: emptyCacheMissCategory(),
      thinkingChange: emptyCacheMissCategory(),
      modelChange: emptyCacheMissCategory(),
      unexpected: {
        full: emptyCacheMissCategory(),
        partial: emptyCacheMissCategory(),
      },
      full: emptyCacheMissCategory(),
      partial: emptyCacheMissCategory(),
    },
    cacheMisses: {
      affectedSessions: 0,
      otherAffectedSessions: 0,
      affectedSessionCost: 0,
      hasUnpricedAffectedSessionCost: false,
      compaction: emptyCacheMissCategory(),
      thinkingChange: emptyCacheMissCategory(),
      modelChange: emptyCacheMissCategory(),
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

  if (storedCosts !== undefined) {
    result.totalCost = storedCosts.totalCost;
    result.hasUnpricedTotalCost = storedCosts.hasUnpricedTotalCost;
    result.totalSessionCost = storedCosts.totalSessionCost;
    result.hasUnpricedSessionCost = storedCosts.hasUnpricedSessionCost;
  } else {
    for (const call of rangedCalls) {
      const cost = call.computedCost ?? computeModelCallCost(
        call.tokens,
        call.model,
        call.startedAt,
        call.provider,
      );
      if (cost === undefined) result.hasUnpricedTotalCost = true;
      else result.totalCost += cost;
    }
  }

  for (const group of sessionGroups) {
    const calls = group.calls;
    const rootCalls = calls.filter((call) =>
      call.session.id === call.session.rootID
    );
    const allRootMisses = storedAggregates !== undefined
      ? storedAggregates.filter((miss) =>
        miss.harness === group.harness && miss.rootID === group.rootID &&
        miss.scope === "root"
      ).map(aggregatedCacheMiss)
      : storedMisses !== undefined
      ? storedMisses.filter((miss) =>
        miss.harness === group.harness &&
        miss.rootID === group.rootID &&
        miss.sessionID === group.rootID
      ).map(storedCacheMiss)
      : cacheMisses(rootCalls);
    const rootCategories = categorizedMisses(allRootMisses);
    const rootMisses = rootCategories.ttl;
    const compactionMisses = rootCategories.compaction;
    const thinkingChangeMisses = rootCategories.thinkingChange;
    const modelChangeMisses = rootCategories.modelChange;
    const unexpectedMisses = rootCategories.unexpected;
    const fullMisses = rootCategories.full;
    const partialMisses = rootCategories.partial;
    let rootSessionCost = group.rootCost ?? 0;
    let hasUnpricedRootSessionCost = group.hasUnpricedRootCost ?? false;
    if (storedCosts === undefined) {
      rootSessionCost = 0;
      hasUnpricedRootSessionCost = false;
      for (const call of rootCalls) {
        const cost = call.computedCost ?? computeModelCallCost(
          call.tokens,
          call.model,
          call.startedAt,
          call.provider,
        );
        if (cost === undefined) hasUnpricedRootSessionCost = true;
        else rootSessionCost += cost;
      }
      result.totalSessionCost += rootSessionCost;
      result.hasUnpricedSessionCost ||= hasUnpricedRootSessionCost;
    }
    addCacheMisses(result.cacheMisses.full, fullMisses);
    addCacheMisses(result.cacheMisses.partial, partialMisses);
    addCacheMisses(result.cacheMisses.compaction, compactionMisses);
    addCacheMisses(result.cacheMisses.thinkingChange, thinkingChangeMisses);
    addCacheMisses(result.cacheMisses.modelChange, modelChangeMisses);
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
    if (
      compactionMisses.length > 0 || thinkingChangeMisses.length > 0 ||
      modelChangeMisses.length > 0 || unexpectedMisses.length > 0
    ) {
      result.cacheMisses.otherAffectedSessions++;
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
    for (const miss of rootMisses) {
      result.misses.total += miss.count;
      result.misses.unpriced += miss.unpriced;
      result.misses.attributedCost += miss.actualMissedCost ?? 0;
      const bucket = miss.gapBucket ??
        (miss.gap < THIRTY_MINUTES_MS
          ? "under-thirty"
          : miss.gap < TWO_HOURS_MS
          ? "thirty-to-two"
          : miss.gap < EIGHT_HOURS_MS
          ? "two-to-eight"
          : "eight-plus");
      if (bucket === "under-thirty" || bucket === "thirty-to-two") {
        result.misses.underTwoHours += miss.count;
        result.misses.underTwoHoursCost += miss.actualMissedCost ?? 0;
      }
      if (bucket === "under-thirty") {
        result.misses.underThirtyMinutes += miss.count;
        result.misses.underThirtyMinutesCost += miss.actualMissedCost ?? 0;
      } else if (bucket === "thirty-to-two") {
        result.misses.thirtyMinutesToTwoHours += miss.count;
        result.misses.thirtyMinutesToTwoHoursCost += miss.actualMissedCost ?? 0;
      } else if (bucket === "two-to-eight") {
        result.misses.twoToEightHours += miss.count;
        result.misses.twoToEightHoursCost += miss.actualMissedCost ?? 0;
      } else {
        result.misses.eightHoursOrMore += miss.count;
        result.misses.eightHoursOrMoreCost += miss.actualMissedCost ?? 0;
      }
    }
    const ttlBuckets = new Set(
      rootMisses.map((miss) =>
        miss.gapBucket ??
          (miss.gap < THIRTY_MINUTES_MS
            ? "under-thirty"
            : miss.gap < TWO_HOURS_MS
            ? "thirty-to-two"
            : miss.gap < EIGHT_HOURS_MS
            ? "two-to-eight"
            : "eight-plus")
      ),
    );
    if (ttlBuckets.has("under-thirty")) {
      result.misses.underThirtyMinutesSessions++;
    }
    if (ttlBuckets.has("thirty-to-two")) {
      result.misses.thirtyMinutesToTwoHoursSessions++;
    }
    if (
      ttlBuckets.has("under-thirty") || ttlBuckets.has("thirty-to-two")
    ) result.misses.underTwoHoursSessions++;
    if (ttlBuckets.has("two-to-eight")) {
      result.misses.twoToEightHoursSessions++;
    }
    if (ttlBuckets.has("eight-plus")) {
      result.misses.eightHoursOrMoreSessions++;
    }

    const allSubagentMisses = storedAggregates !== undefined
      ? storedAggregates.filter((miss) =>
        miss.harness === group.harness && miss.rootID === group.rootID &&
        miss.scope === "subagent"
      ).map(aggregatedCacheMiss)
      : storedMisses !== undefined
      ? storedMisses.filter((miss) =>
        miss.harness === group.harness && miss.rootID === group.rootID &&
        miss.sessionID !== group.rootID
      ).map(storedCacheMiss)
      : cacheMisses(
        calls.filter((call) => call.session.id !== call.session.rootID),
      );
    const subagentCategories = categorizedMisses(allSubagentMisses);
    addCacheMisses(result.subagents.full, subagentCategories.full);
    addCacheMisses(result.subagents.partial, subagentCategories.partial);
    addCacheMisses(result.subagents.ttl, subagentCategories.ttl);
    addCacheMisses(
      result.subagents.compaction,
      subagentCategories.compaction,
    );
    addCacheMisses(
      result.subagents.thinkingChange,
      subagentCategories.thinkingChange,
    );
    addCacheMisses(
      result.subagents.modelChange,
      subagentCategories.modelChange,
    );
    addCacheMisses(
      result.subagents.unexpected.full,
      subagentCategories.unexpected.filter((miss) =>
        miss.status === "full-miss"
      ),
    );
    addCacheMisses(
      result.subagents.unexpected.partial,
      subagentCategories.unexpected.filter((miss) =>
        miss.status === "partial-hit"
      ),
    );
    if (allSubagentMisses.length > 0) result.subagents.affectedSessions++;
    if (allRootMisses.length > 0 || allSubagentMisses.length > 0) {
      result.combined.affectedSessions++;
    }
  }

  result.subagents.misses = result.subagents.full.misses +
    result.subagents.partial.misses;
  result.subagents.attributedCost = result.subagents.full.attributedCost +
    result.subagents.partial.attributedCost;
  result.subagents.missedTokens = result.subagents.full.missedTokens +
    result.subagents.partial.missedTokens;
  result.subagents.unpriced = result.subagents.full.unpriced +
    result.subagents.partial.unpriced;
  result.combined.misses = result.cacheMisses.full.misses +
    result.cacheMisses.partial.misses + result.subagents.misses;
  result.combined.attributedCost = result.cacheMisses.full.attributedCost +
    result.cacheMisses.partial.attributedCost +
    result.subagents.attributedCost;
  result.combined.missedTokens = result.cacheMisses.full.missedTokens +
    result.cacheMisses.partial.missedTokens + result.subagents.missedTokens;
  result.combined.unpriced = result.cacheMisses.full.unpriced +
    result.cacheMisses.partial.unpriced + result.subagents.unpriced;

  return result;
}
