import type {
  CacheAssessment,
  CacheIssue,
  CacheSummary,
  ModelCall,
  SessionDetail,
  TurnCacheSummary,
} from "../shared/sessionSchemas.ts";
import { hasInputContext } from "../shared/contextMetrics.ts";
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
  if (
    previous.provider !== current.provider || previous.model !== current.model
  ) return { status: "not-comparable", reason: "model-change" };

  const previousReusableTokens = previous.tokens.cacheRead +
    (previous.tokens.cacheWrite ??
      (previous.provider === "openai" ? previous.tokens.uncachedInput : 0));
  if (previousReusableTokens === 0) {
    return { status: "not-comparable", reason: "no-reusable-cache" };
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

export type AssessedUsageCall = UsageCall & {
  cacheAssessment: CacheAssessment;
  previousComparableCall?: UsageCall;
};

export function categorizeUsageCallCache(
  calls: UsageCall[],
): AssessedUsageCall[] {
  const categorized: AssessedUsageCall[] = [];
  for (
    const chain of Map.groupBy(
      calls,
      (call) => `${call.harness}:${call.cacheChainID}`,
    ).values()
  ) {
    let previous: UsageCall | undefined;
    for (const call of chain.toSorted((a, b) => a.startedAt - b.startedAt)) {
      const rawAssessment = assessCache(previous, call);
      const cacheAssessment = isMiss(rawAssessment) && call.followsCompaction
        ? { ...rawAssessment, cause: "compaction" as const }
        : isMiss(rawAssessment) && previous && ttlExpired(previous, call)
        ? { ...rawAssessment, cause: "ttl" as const }
        : rawAssessment;
      categorized.push({
        ...call,
        cacheAssessment,
        ...(previous ? { previousComparableCall: previous } : {}),
      });
      if (hasInputContext(call.tokens)) previous = call;
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
    if (
      call.cacheAssessment?.status === "partial-hit" ||
      call.cacheAssessment?.status === "full-miss"
    ) {
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
  let previous: ModelCall | undefined;
  const turns = session.turns.map((turn) => {
    const calls = turn.calls.map((call) => {
      const rawAssessment = assessCache(previous, call);
      const followsCompaction = (call.contextEventsBefore ?? []).some((event) =>
        event.type === "compaction"
      );
      const cacheAssessment = isMiss(rawAssessment) && followsCompaction
        ? { ...rawAssessment, cause: "compaction" as const }
        : isMiss(rawAssessment) && previous && ttlExpired(previous, call)
        ? { ...rawAssessment, cause: "ttl" as const }
        : rawAssessment;
      // A contextless/opaque usage record must not break the chain between
      // the real requests on either side of it.
      if (hasInputContext(call.tokens)) previous = call;
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
      if (
        call.cacheAssessment?.status === "partial-hit" ||
        call.cacheAssessment?.status === "full-miss"
      ) {
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
      for (const cause of [undefined, "ttl"] as const) {
        const misses = turn.calls.filter((call) =>
          isMiss(call.cacheAssessment) &&
          call.cacheAssessment?.cause === cause
        );
        if (misses.length === 0) continue;
        const status = misses.some((call) =>
            call.cacheAssessment?.status === "full-miss"
          )
          ? "full-miss" as const
          : "partial-hit" as const;
        issues.push({
          status,
          ...(cause ? { cause } : {}),
          turn: turn.number,
          scope,
        });
      }
      return issues;
    }),
    ...session.subagents.flatMap((subagent) =>
      sessionCacheIssues(subagent, true)
    ),
  ];
}
