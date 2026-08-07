import type {
  CacheAssessment,
  CacheIssue,
  CacheSummary,
  ModelCall,
  SessionDetail,
  TurnCacheSummary,
} from "../shared/sessionSchemas.ts";
import { hasInputContext } from "../shared/contextMetrics.ts";
import { computeModelCallCost, estimateModelCacheMissCost } from "./pricing.ts";
import { estimateCacheMissTokens } from "./cacheMissPricing.ts";
import type { UsageCall } from "./usage.ts";

export const CACHE_HIT_RATIO = 0.9;
export const CACHE_FULL_MISS_RATIO = 0.1;
export const CACHE_TTL_5M_MS = 5 * 60 * 1000;
export const CACHE_TTL_1H_MS = 60 * 60 * 1000;

export function assessCache(
  previous: Pick<ModelCall, "provider" | "model" | "tokens"> | undefined,
  current: Pick<ModelCall, "provider" | "model" | "tokens">,
): CacheAssessment {
  if (!hasInputContext(current.tokens)) {
    return { status: "not-comparable", reason: "no-input-context" };
  }
  if (!previous) return { status: "baseline", reason: "no-predecessor" };
  const previousReusableTokens = previous.tokens.cacheRead +
    (previous.tokens.cacheWrite ??
      (previous.provider === "openai" ? previous.tokens.uncachedInput : 0));
  if (previousReusableTokens === 0) {
    return { status: "not-comparable", reason: "no-reusable-cache" };
  }
  if (
    previous.provider !== current.provider || previous.model !== current.model
  ) {
    // Provider caches are model-scoped, so switching models loses the prior
    // reusable prefix even though its retention ratio cannot be observed.
    return {
      status: "full-miss",
      reason: "model-change",
      retainedRatio: 0,
      previousReusableTokens,
    };
  }

  const retainedRatio = current.tokens.cacheRead / previousReusableTokens;
  const status = retainedRatio >= CACHE_HIT_RATIO
    ? "hit"
    : retainedRatio <= CACHE_FULL_MISS_RATIO
    ? "full-miss"
    : "partial-hit";
  return { status, retainedRatio, previousReusableTokens };
}

const severity: Record<CacheAssessment["status"], number> = {
  baseline: 0,
  unknown: 0,
  "not-comparable": 0,
  hit: 1,
  "partial-hit": 3,
  "full-miss": 4,
};

function assessmentSeverity(assessment: CacheAssessment): number {
  if (assessment.cause === "compaction") return 0;
  if (assessment.cause === "ttl") return 2;
  return severity[assessment.status];
}

function isMiss(assessment: CacheAssessment | undefined): boolean {
  return assessment?.status === "partial-hit" ||
    assessment?.status === "full-miss";
}

function isUnexpectedMiss(assessment: CacheAssessment | undefined): boolean {
  return isMiss(assessment) && assessment?.cause === undefined &&
    assessment?.reason !== "model-change";
}

export function thinkingSettingChanged(
  previous: Pick<ModelCall, "reasoningSetting"> | undefined,
  current: Pick<ModelCall, "reasoningSetting">,
): boolean {
  if (!previous?.reasoningSetting || !current.reasoningSetting) return false;
  return previous.reasoningSetting.settingName !==
      current.reasoningSetting.settingName ||
    previous.reasoningSetting.settingValue !==
      current.reasoningSetting.settingValue;
}

function isClaude(call: Pick<ModelCall, "provider" | "model">): boolean {
  return call.provider.toLowerCase().includes("anthropic") ||
    call.model.toLowerCase().includes("claude");
}

export function ttlExpired(
  previous: Pick<ModelCall, "provider" | "model" | "tokens" | "startedAt">,
  current: Pick<ModelCall, "startedAt">,
): boolean {
  const elapsed = current.startedAt - previous.startedAt;
  if (elapsed < 0) return false;
  if (isClaude(previous)) {
    if (
      (previous.tokens.cacheWrite5m ?? 0) > 0 &&
      elapsed >= CACHE_TTL_5M_MS
    ) return true;
    if (
      (previous.tokens.cacheWrite1h ?? 0) > 0 &&
      elapsed >= CACHE_TTL_1H_MS
    ) return true;
  }
  return elapsed >= CACHE_TTL_1H_MS;
}

type CacheComparableCall = Pick<
  ModelCall,
  "provider" | "model" | "tokens" | "startedAt" | "reasoningSetting"
>;

export type CacheMissRecord = {
  gap: number;
  status: "full-miss" | "partial-hit";
  reason?: CacheAssessment["reason"];
  cause?: CacheAssessment["cause"];
  retainedRatio?: number;
  previousReusableTokens?: number;
  previousContextTokens: number;
  currentContextTokens: number;
  actualCacheReadTokens: number;
  missedTokens: number;
  modelCallCost?: number;
  actualMissedCost?: number;
  expectedReadCost?: number;
  estimatedExtraCost?: number;
};

function classifyCacheMiss(
  rawAssessment: CacheAssessment,
  previous: CacheComparableCall | undefined,
  current: CacheComparableCall,
  followsCompaction: boolean,
  initialCacheRead?: number,
): CacheAssessment {
  if (!isMiss(rawAssessment)) return rawAssessment;
  // Returning exactly to the cache-read floor observed on the first request
  // means none of the cache accumulated by this session was retained. Treat
  // that as a full session-cache miss even if the harness/system prefix makes
  // it look like a partial provider-cache hit against the preceding request.
  const assessment = rawAssessment.status === "partial-hit" &&
      initialCacheRead !== undefined &&
      current.tokens.cacheRead === initialCacheRead
    ? { ...rawAssessment, status: "full-miss" as const }
    : rawAssessment;
  // Compaction remains the most specific context reset explanation. Among
  // ordinary misses, TTL wins over a thinking change because the cache would
  // have expired regardless of the requested thinking level.
  if (followsCompaction) {
    return { ...assessment, cause: "compaction" as const };
  }
  if (previous && ttlExpired(previous, current)) {
    return { ...assessment, cause: "ttl" as const };
  }
  if (previous && thinkingSettingChanged(previous, current)) {
    return { ...assessment, cause: "thinking-change" as const };
  }
  return assessment;
}

function cacheMissRecord(
  previous: CacheComparableCall,
  current: CacheComparableCall,
  assessment: CacheAssessment,
): CacheMissRecord {
  const tokenEstimate = estimateCacheMissTokens(
    previous.tokens,
    current.tokens,
  );
  const costEstimate = estimateModelCacheMissCost(
    previous.tokens,
    current.tokens,
    current.model,
    current.startedAt,
    current.provider,
  );
  const modelCallCost = computeModelCallCost(
    current.tokens,
    current.model,
    current.startedAt,
    current.provider,
  );
  return {
    gap: current.startedAt - previous.startedAt,
    status: assessment.status === "full-miss" ? "full-miss" : "partial-hit",
    ...(assessment.reason === undefined ? {} : { reason: assessment.reason }),
    ...(assessment.cause === undefined ? {} : { cause: assessment.cause }),
    ...(assessment.retainedRatio === undefined
      ? {}
      : { retainedRatio: assessment.retainedRatio }),
    ...(assessment.previousReusableTokens === undefined
      ? {}
      : { previousReusableTokens: assessment.previousReusableTokens }),
    previousContextTokens: tokenEstimate.previousContext,
    currentContextTokens: tokenEstimate.currentContext,
    actualCacheReadTokens: tokenEstimate.actualCacheRead,
    missedTokens: tokenEstimate.missedTokens,
    ...(modelCallCost === undefined ? {} : { modelCallCost }),
    ...(costEstimate === undefined ? {} : {
      actualMissedCost: costEstimate.actualMissedCost,
      expectedReadCost: costEstimate.expectedReadCost,
      estimatedExtraCost: costEstimate.estimatedExtraCost,
    }),
  };
}

export type CacheAnalysisCall = CacheComparableCall & {
  id: string;
  followsCompaction?: boolean;
};

export type CacheMissAnalysis = CacheMissRecord & {
  callID: string;
  previousCallID: string;
};

function cacheBaselineKey(
  call: Pick<ModelCall, "provider" | "model">,
): string {
  return JSON.stringify([call.provider, call.model]);
}

export function analyzeCacheMisses(
  calls: CacheAnalysisCall[],
): CacheMissAnalysis[] {
  const misses: CacheMissAnalysis[] = [];
  const initialCacheReads = new Map<string, number>();
  let previous: CacheAnalysisCall | undefined;
  for (const current of calls) {
    const baselineKey = cacheBaselineKey(current);
    const rawAssessment = assessCache(previous, current);
    const assessment = classifyCacheMiss(
      rawAssessment,
      previous,
      current,
      current.followsCompaction ?? false,
      initialCacheReads.get(baselineKey),
    );
    if (previous && isMiss(assessment)) {
      misses.push({
        ...cacheMissRecord(previous, current, assessment),
        callID: current.id,
        previousCallID: previous.id,
      });
    }
    if (hasInputContext(current.tokens)) {
      if (!initialCacheReads.has(baselineKey)) {
        initialCacheReads.set(baselineKey, current.tokens.cacheRead);
      }
      previous = current;
    }
  }
  return misses;
}

export type AssessedUsageCall = UsageCall & {
  cacheAssessment: CacheAssessment;
  previousComparableCall?: UsageCall;
};

export function categorizeUsageCallCache(
  calls: UsageCall[],
): AssessedUsageCall[] {
  const categorized: AssessedUsageCall[] = [];
  const callsByID = new Map(
    calls.flatMap((call) =>
      call.modelCallID === undefined ? [] : [[call.modelCallID, call] as const]
    ),
  );
  for (
    const chain of Map.groupBy(
      calls,
      (call) => `${call.harness}:${call.cacheChainID}`,
    ).values()
  ) {
    const initialCacheReads = new Map<string, number>();
    let previous: UsageCall | undefined;
    for (const call of chain.toSorted((a, b) => a.startedAt - b.startedAt)) {
      const baselineKey = cacheBaselineKey(call);
      const comparable = call.previousModelCallID === undefined
        ? previous
        : callsByID.get(call.previousModelCallID);
      const rawAssessment = assessCache(comparable, call);
      const cacheAssessment = classifyCacheMiss(
        rawAssessment,
        comparable,
        call,
        call.followsCompaction ?? false,
        initialCacheReads.get(baselineKey),
      );
      categorized.push({
        ...call,
        cacheAssessment,
        ...(comparable ? { previousComparableCall: comparable } : {}),
      });
      if (hasInputContext(call.tokens)) {
        if (!initialCacheReads.has(baselineKey)) {
          initialCacheReads.set(baselineKey, call.tokens.cacheRead);
        }
        previous = call;
      }
    }
  }
  return categorized;
}

export function summarizeTurnCache(calls: ModelCall[]): TurnCacheSummary {
  const summary: TurnCacheSummary = {
    baseline: 0,
    hits: 0,
    partialHits: 0,
    fullMisses: 0,
    notComparable: 0,
    unknown: 0,
    compactionRelatedMisses: 0,
    ttlRelatedMisses: 0,
    thinkingChangeRelatedMisses: 0,
    unexpectedMisses: 0,
    totalCacheRead: 0,
    peakCacheRead: 0,
    totalNewInput: 0,
  };
  for (const call of calls) {
    summary.totalCacheRead += call.tokens.cacheRead;
    summary.peakCacheRead = Math.max(
      summary.peakCacheRead,
      call.tokens.cacheRead,
    );
    summary.totalNewInput += call.tokens.freshPrompt;
    if (call.cacheAssessment?.cause === "compaction") {
      summary.compactionRelatedMisses++;
      continue;
    }
    if (call.cacheAssessment?.cause === "ttl") {
      summary.ttlRelatedMisses++;
      continue;
    }
    if (call.cacheAssessment?.cause === "thinking-change") {
      summary.thinkingChangeRelatedMisses++;
      continue;
    }
    switch (call.cacheAssessment?.status) {
      case "baseline":
        summary.baseline++;
        break;
      case "hit":
        summary.hits++;
        break;
      case "partial-hit":
        summary.partialHits++;
        break;
      case "full-miss":
        summary.fullMisses++;
        break;
      case "not-comparable":
        summary.notComparable++;
        break;
      default:
        summary.unknown++;
    }
    if (isUnexpectedMiss(call.cacheAssessment)) {
      summary.unexpectedMisses++;
    }
  }
  const totalInput = summary.totalCacheRead + summary.totalNewInput;
  if (totalInput > 0) {
    summary.cachedInputShare = summary.totalCacheRead / totalInput;
  }
  return summary;
}

export function analyzeSessionCache(session: SessionDetail): SessionDetail {
  const initialCacheReads = new Map<string, number>();
  let previous: ModelCall | undefined;
  const turns = session.turns.map((turn) => {
    const calls = turn.calls.map((call) => {
      // Some importers expose a setting at turn scope only. Treat it as the
      // effective setting for calls that do not have a more specific value.
      const effectiveCall = call.reasoningSetting === undefined &&
          turn.reasoningSetting !== undefined
        ? { ...call, reasoningSetting: turn.reasoningSetting }
        : call;
      const baselineKey = cacheBaselineKey(effectiveCall);
      const rawAssessment = assessCache(previous, effectiveCall);
      const followsCompaction = (call.contextEventsBefore ?? []).some((event) =>
        event.type === "compaction"
      );
      const cacheAssessment = classifyCacheMiss(
        rawAssessment,
        previous,
        effectiveCall,
        followsCompaction,
        initialCacheReads.get(baselineKey),
      );
      // A contextless/opaque usage record must not break the chain between
      // the real requests on either side of it.
      if (hasInputContext(call.tokens)) {
        if (!initialCacheReads.has(baselineKey)) {
          initialCacheReads.set(baselineKey, call.tokens.cacheRead);
        }
        previous = effectiveCall;
      }
      return { ...call, cacheAssessment };
    });
    const cacheAssessment = calls.reduce<CacheAssessment | undefined>(
      (worst, call) => {
        if (call.cacheAssessment.cause === "compaction") return worst;
        return !worst ||
            assessmentSeverity(call.cacheAssessment) >
              assessmentSeverity(worst)
          ? call.cacheAssessment
          : worst;
      },
      undefined,
    );
    return {
      ...turn,
      calls,
      cacheAssessment,
      cacheSummary: summarizeTurnCache(calls),
    };
  });

  return {
    ...session,
    turns,
    subagents: session.subagents.map(analyzeSessionCache),
  };
}

export function summarizeSessionCache(session: SessionDetail): CacheSummary {
  const summary: CacheSummary = {
    baseline: 0,
    hits: 0,
    partialHits: 0,
    fullMisses: 0,
    notComparable: 0,
    unknown: 0,
    compactionRelatedMisses: 0,
    ttlRelatedMisses: 0,
    thinkingChangeRelatedMisses: 0,
    unexpectedMisses: 0,
  };
  for (const turn of session.turns) {
    for (const call of turn.calls) {
      if (call.cacheAssessment?.cause === "compaction") {
        summary.compactionRelatedMisses++;
        continue;
      }
      if (call.cacheAssessment?.cause === "ttl") {
        summary.ttlRelatedMisses++;
        continue;
      }
      if (call.cacheAssessment?.cause === "thinking-change") {
        summary.thinkingChangeRelatedMisses++;
        continue;
      }
      switch (call.cacheAssessment?.status) {
        case "baseline":
          summary.baseline++;
          break;
        case "hit":
          summary.hits++;
          break;
        case "partial-hit":
          summary.partialHits++;
          break;
        case "full-miss":
          summary.fullMisses++;
          break;
        case "not-comparable":
          summary.notComparable++;
          break;
        default:
          summary.unknown++;
      }
      if (isUnexpectedMiss(call.cacheAssessment)) {
        summary.unexpectedMisses++;
      }
    }
  }
  for (const subagent of session.subagents) {
    const nested = summarizeSessionCache(subagent);
    summary.baseline += nested.baseline;
    summary.hits += nested.hits;
    summary.partialHits += nested.partialHits;
    summary.fullMisses += nested.fullMisses;
    summary.notComparable += nested.notComparable;
    summary.unknown += nested.unknown;
    summary.compactionRelatedMisses += nested.compactionRelatedMisses;
    summary.ttlRelatedMisses += nested.ttlRelatedMisses;
    summary.thinkingChangeRelatedMisses += nested.thinkingChangeRelatedMisses;
    summary.unexpectedMisses += nested.unexpectedMisses;
  }
  return summary;
}

export function sessionCacheIssues(
  session: SessionDetail,
  nested = false,
): CacheIssue[] {
  const scope = nested
    ? session.agent ? `${session.agent}: ${session.title}` : session.title
    : undefined;
  return [
    ...session.turns.flatMap((turn) => {
      const issues: CacheIssue[] = [];
      for (const cause of [undefined, "ttl", "thinking-change"] as const) {
        const misses = turn.calls.filter((call) =>
          isMiss(call.cacheAssessment) &&
          call.cacheAssessment?.cause === cause
        );
        if (misses.length === 0) continue;
        for (const status of ["full-miss", "partial-hit"] as const) {
          if (!misses.some((call) => call.cacheAssessment?.status === status)) {
            continue;
          }
          issues.push({
            status,
            ...(cause ? { cause } : {}),
            turn: turn.number,
            scope,
          });
        }
      }
      return issues;
    }),
    ...session.subagents.flatMap((subagent) =>
      sessionCacheIssues(subagent, true)
    ),
  ];
}
