import type { PerformanceResponse } from "../shared/sessionSchemas.ts";
import { contextSize, hasInputContext } from "../shared/contextMetrics.ts";
import {
  type AssessedUsageCall,
  categorizeUsageCallCache,
  isUnexpectedMiss,
} from "./cacheAnalysis.ts";
import type { UsageCall } from "./usage.ts";

export const PERFORMANCE_RANGE_DAYS = 90;

export const PERFORMANCE_MODELS = {
  openai: [
    "gpt-5.2-codex",
    "gpt-5.2-codex-low",
    "gpt-5.2-codex-medium",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ],
  anthropic: [
    "claude-fable-5",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-5",
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-5",
  ],
} as const;

type Vendor = keyof typeof PERFORMANCE_MODELS;
type Week = PerformanceResponse[Vendor]["weeks"][number];

const CACHE_LOSS_BUCKETS = ["0-16k", "16-64k", "64-128k", "128k+"] as const;
type CacheLossBucket = (typeof CACHE_LOSS_BUCKETS)[number];

type CacheLossBucketTotals = {
  requests: number;
  unretainedTokens: number;
};

type CacheLossBuckets = {
  "0-16k": CacheLossBucketTotals;
  "16-64k": CacheLossBucketTotals;
  "64-128k": CacheLossBucketTotals;
  "128k+": CacheLossBucketTotals;
};

function cacheLossBucket(tokens: number): CacheLossBucket {
  if (tokens < 16_000) return "0-16k";
  if (tokens < 64_000) return "16-64k";
  if (tokens < 128_000) return "64-128k";
  return "128k+";
}

function emptyCacheLossBuckets(): CacheLossBuckets {
  return {
    "0-16k": { requests: 0, unretainedTokens: 0 },
    "16-64k": { requests: 0, unretainedTokens: 0 },
    "64-128k": { requests: 0, unretainedTokens: 0 },
    "128k+": { requests: 0, unretainedTokens: 0 },
  };
}

function vendorFor(call: UsageCall): Vendor | undefined {
  const provider = call.provider.toLowerCase();
  const model = call.model.toLowerCase();
  if (provider.includes("anthropic") || model.startsWith("claude-")) {
    return "anthropic";
  }
  if (provider.startsWith("openai") || model.startsWith("gpt-")) {
    return "openai";
  }
  return undefined;
}

function localDate(value: number) {
  const date = new Date(value);
  return Temporal.PlainDate.from({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  });
}

function weekKey(value: number) {
  const date = localDate(value);
  return date.subtract({ days: date.dayOfWeek - 1 }).toString();
}

function emptyWeek(date: string): Week {
  return {
    date,
    endDate: Temporal.PlainDate.from(date).add({ days: 6 }).toString(),
    sessions: 0,
    eligibleSessions: 0,
    sessionsWithMiss: 0,
    turns: 0,
    eligibleTurns: 0,
    turnsWithMiss: 0,
    modelCalls: 0,
    eligibleModelCalls: 0,
    modelCallsWithMiss: 0,
    reuseOpportunities: 0,
    reusableTokensAtRisk: 0,
  };
}

function isEligibleOpportunity(call: AssessedUsageCall) {
  return call.cacheAssessment.status === "hit" ||
    isUnexpectedMiss(call.cacheAssessment);
}

function weeksBetween(start: number, end: number) {
  const first = Temporal.PlainDate.from(weekKey(start));
  const last = Temporal.PlainDate.from(weekKey(end));
  const weeks = new Map<string, Week>();
  for (
    let date = first;
    Temporal.PlainDate.compare(date, last) <= 0;
    date = date.add({ weeks: 1 })
  ) {
    weeks.set(date.toString(), emptyWeek(date.toString()));
  }
  return weeks;
}

function providerResult(
  calls: AssessedUsageCall[],
  vendor: Vendor,
  selectedModel: string,
  start: number,
  end: number,
): PerformanceResponse[Vendor] {
  const matching = calls.filter((call) =>
    vendorFor(call) === vendor &&
    (selectedModel === "all" || call.model === selectedModel) &&
    call.sessionStartedAt >= start && call.sessionStartedAt <= end &&
    hasInputContext(call.tokens)
  );
  const lossCandidates = calls.filter((call) =>
    vendorFor(call) === vendor &&
    (selectedModel === "all" || call.model === selectedModel) &&
    call.startedAt >= start && call.startedAt <= end &&
    hasInputContext(call.tokens)
  );
  const weeks = weeksBetween(start, end);
  const sessions = Map.groupBy(
    matching,
    (call) => `${call.harness}:${call.session.rootID}`,
  );
  const cacheLossByWeek = new Map<string, CacheLossBuckets>();
  let eligibleSessions = 0;
  let sessionsWithMiss = 0;
  let turns = 0;
  let eligibleTurns = 0;
  let turnsWithMiss = 0;
  let modelCalls = 0;
  let eligibleModelCalls = 0;
  let modelCallsWithMiss = 0;
  let reusableTokensAtRisk = 0;

  for (const sessionCalls of sessions.values()) {
    const sessionWeek = weekKey(sessionCalls[0].sessionStartedAt);
    const bucket = weeks.get(sessionWeek);
    if (!bucket) continue;
    bucket.sessions++;
    const eligibleSessionCalls = sessionCalls.filter(isEligibleOpportunity);
    if (eligibleSessionCalls.length > 0) {
      eligibleSessions++;
      bucket.eligibleSessions++;
    }
    const sessionMiss = eligibleSessionCalls.some((call) =>
      isUnexpectedMiss(call.cacheAssessment)
    );
    if (sessionMiss) {
      sessionsWithMiss++;
      bucket.sessionsWithMiss++;
    }
    const sessionTurns = Map.groupBy(
      sessionCalls,
      (call) => `${call.session.id}:${call.turnID}`,
    );
    turns += sessionTurns.size;
    bucket.turns += sessionTurns.size;
    modelCalls += sessionCalls.length;
    bucket.modelCalls += sessionCalls.length;
    eligibleModelCalls += eligibleSessionCalls.length;
    bucket.eligibleModelCalls += eligibleSessionCalls.length;
    for (const call of eligibleSessionCalls) {
      if (isUnexpectedMiss(call.cacheAssessment)) {
        modelCallsWithMiss++;
        bucket.modelCallsWithMiss++;
      }
    }
    for (const turnCalls of sessionTurns.values()) {
      const eligibleTurnCalls = turnCalls.filter(isEligibleOpportunity);
      if (eligibleTurnCalls.length === 0) continue;
      eligibleTurns++;
      bucket.eligibleTurns++;
      if (
        eligibleTurnCalls.some((call) => isUnexpectedMiss(call.cacheAssessment))
      ) {
        turnsWithMiss++;
        bucket.turnsWithMiss++;
      }
    }
  }

  for (const call of lossCandidates) {
    if (!isEligibleOpportunity(call)) continue;
    const assessment = call.cacheAssessment;
    const previousReusable = assessment.previousReusableTokens;
    if (previousReusable === undefined) continue;

    const expectedReusable = Math.min(
      previousReusable,
      contextSize(call.tokens),
    );
    const date = weekKey(call.startedAt);
    const week = weeks.get(date);
    if (!week) continue;
    reusableTokensAtRisk += expectedReusable;
    week.reuseOpportunities++;
    week.reusableTokensAtRisk += expectedReusable;
    if (!isUnexpectedMiss(assessment)) continue;

    const retained = Math.min(call.tokens.cacheRead, expectedReusable);
    const unretained = Math.max(expectedReusable - retained, 0);
    if (unretained === 0) continue;

    const buckets = cacheLossByWeek.get(date) ?? emptyCacheLossBuckets();
    const bucket = buckets[cacheLossBucket(unretained)];
    bucket.requests++;
    bucket.unretainedTokens += unretained;
    cacheLossByWeek.set(date, buckets);
  }

  for (const [date, buckets] of cacheLossByWeek) {
    const week = weeks.get(date);
    if (!week) continue;
    week.cacheLossBuckets = CACHE_LOSS_BUCKETS.map((bucket) => ({
      bucket,
      ...buckets[bucket],
    }));
  }

  return {
    provider: vendor,
    selectedModel,
    sessions: sessions.size,
    eligibleSessions,
    sessionsWithMiss,
    turns,
    eligibleTurns,
    turnsWithMiss,
    modelCalls,
    eligibleModelCalls,
    modelCallsWithMiss,
    reusableTokensAtRisk,
    weeks: [...weeks.values()],
  };
}

export function aggregatePerformance(
  calls: UsageCall[],
  start: number,
  end: number,
  openaiModel = "all",
  anthropicModel = "all",
): PerformanceResponse {
  const assessed = categorizeUsageCallCache(calls);
  return {
    rangeDays: PERFORMANCE_RANGE_DAYS,
    models: {
      openai: [...PERFORMANCE_MODELS.openai],
      anthropic: [...PERFORMANCE_MODELS.anthropic],
    },
    openai: providerResult(
      assessed,
      "openai",
      openaiModel,
      start,
      end,
    ),
    anthropic: providerResult(
      assessed,
      "anthropic",
      anthropicModel,
      start,
      end,
    ),
  };
}
