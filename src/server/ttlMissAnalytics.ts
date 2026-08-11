import type { TtlMissMetrics } from "../shared/sessionSchemas.ts";
import {
  type CacheMissRecord,
  categorizeUsageCallCache,
} from "./cacheAnalysis.ts";
import type {
  ModelCallCostSummary,
  StoredCacheMiss,
} from "./conversationRepository.ts";
import { computeModelCallCost, estimateModelCacheMissCost } from "./pricing.ts";
import type { UsageCall } from "./usage.ts";

const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1_000;

type CacheMiss = CacheMissRecord;

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
    );
    misses.push({
      gap: call.startedAt - previous.startedAt,
      status: assessment.status,
      ...(assessment.reason === undefined ? {} : { reason: assessment.reason }),
      ...(assessment.cause === undefined ? {} : { cause: assessment.cause }),
      retainedRatio: assessment.retainedRatio,
      previousReusableTokens: assessment.previousReusableTokens,
      previousContextTokens: previous.tokens.uncachedInput +
        previous.tokens.cacheRead + (previous.tokens.cacheWrite ?? 0),
      currentContextTokens: call.tokens.uncachedInput + call.tokens.cacheRead +
        (call.tokens.cacheWrite ?? 0),
      actualCacheReadTokens: call.tokens.cacheRead,
      missedTokens: estimate?.missedTokens ?? 0,
      modelCallCost: undefined,
      actualMissedCost: estimate?.actualMissedCost,
      expectedReadCost: estimate?.expectedReadCost,
      estimatedExtraCost: estimate?.estimatedExtraCost,
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
    if (miss.actualMissedCost === undefined) category.unpriced++;
    else {
      category.attributedCost += miss.actualMissedCost;
      category.expectedReadCost += miss.expectedReadCost!;
      category.estimatedExtraCost += miss.estimatedExtraCost!;
      category.missedTokens += miss.missedTokens;
    }
  }
}

export function aggregateTtlMisses(
  usageCalls: UsageCall[],
  start: number,
  rangeDays: number,
  storedMisses?: StoredCacheMiss[],
  storedCosts?: ModelCallCostSummary,
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
    subagents: { affectedSessions: 0, misses: 0 },
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
    const allRootMisses = storedMisses === undefined
      ? cacheMisses(rootCalls)
      : storedMisses.filter((miss) =>
        miss.harness === group.harness &&
        miss.rootID === group.rootID &&
        miss.sessionID === group.rootID
      );
    const rootMisses = allRootMisses.filter((miss) => miss.cause === "ttl");
    const compactionMisses = allRootMisses.filter((miss) =>
      miss.cause === "compaction"
    );
    const thinkingChangeMisses = allRootMisses.filter((miss) =>
      miss.cause === "thinking-change"
    );
    const modelChangeMisses = allRootMisses.filter((miss) =>
      miss.reason === "model-change" && miss.cause === undefined
    );
    const unexpectedMisses = allRootMisses.filter((miss) =>
      miss.cause === undefined && miss.reason !== "model-change"
    );
    const fullMisses = allRootMisses.filter((miss) =>
      miss.status === "full-miss"
    );
    const partialMisses = allRootMisses.filter((miss) =>
      miss.status === "partial-hit"
    );
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
    result.misses.total += rootMisses.length;
    let hasUnderThirtyMinutesMiss = false;
    let hasThirtyMinutesToTwoHoursMiss = false;
    let hasUnderTwoHoursMiss = false;
    let hasTwoToEightHoursMiss = false;
    let hasEightHoursOrMoreMiss = false;
    for (const miss of rootMisses) {
      if (miss.actualMissedCost === undefined) result.misses.unpriced++;
      else result.misses.attributedCost += miss.actualMissedCost;
      if (miss.gap < TWO_HOURS_MS) {
        hasUnderTwoHoursMiss = true;
        result.misses.underTwoHours++;
        result.misses.underTwoHoursCost += miss.actualMissedCost ?? 0;
        if (miss.gap < THIRTY_MINUTES_MS) {
          hasUnderThirtyMinutesMiss = true;
          result.misses.underThirtyMinutes++;
          result.misses.underThirtyMinutesCost += miss.actualMissedCost ?? 0;
        } else {
          hasThirtyMinutesToTwoHoursMiss = true;
          result.misses.thirtyMinutesToTwoHours++;
          result.misses.thirtyMinutesToTwoHoursCost += miss.actualMissedCost ??
            0;
        }
      } else if (miss.gap < EIGHT_HOURS_MS) {
        hasTwoToEightHoursMiss = true;
        result.misses.twoToEightHours++;
        result.misses.twoToEightHoursCost += miss.actualMissedCost ?? 0;
      } else {
        hasEightHoursOrMoreMiss = true;
        result.misses.eightHoursOrMore++;
        result.misses.eightHoursOrMoreCost += miss.actualMissedCost ?? 0;
      }
    }
    if (hasUnderThirtyMinutesMiss) result.misses.underThirtyMinutesSessions++;
    if (hasThirtyMinutesToTwoHoursMiss) {
      result.misses.thirtyMinutesToTwoHoursSessions++;
    }
    if (hasUnderTwoHoursMiss) result.misses.underTwoHoursSessions++;
    if (hasTwoToEightHoursMiss) result.misses.twoToEightHoursSessions++;
    if (hasEightHoursOrMoreMiss) result.misses.eightHoursOrMoreSessions++;

    const subagentMisses = storedMisses === undefined
      ? cacheMisses(
        calls.filter((call) => call.session.id !== call.session.rootID),
      ).filter((miss) => miss.cause === "ttl")
      : storedMisses.filter((miss) =>
        miss.harness === group.harness &&
        miss.rootID === group.rootID &&
        miss.sessionID !== group.rootID &&
        miss.cause === "ttl"
      );
    if (subagentMisses.length > 0) result.subagents.affectedSessions++;
    result.subagents.misses += subagentMisses.length;
  }

  return result;
}
