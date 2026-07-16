import type {
  CacheAssessment,
  CacheIssue,
  CacheSummary,
  ModelCall,
  SessionDetail,
  TurnCacheSummary,
} from "../shared/sessionSchemas.ts";

export const CACHE_HIT_RATIO = 0.9;
export const CACHE_FULL_MISS_RATIO = 0.1;

export function assessCache(
  previous: Pick<ModelCall, "provider" | "model" | "tokens"> | undefined,
  current: Pick<ModelCall, "provider" | "model" | "tokens">,
): CacheAssessment {
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
  "partial-hit": 2,
  "full-miss": 3,
};

function assessmentSeverity(assessment: CacheAssessment): number {
  return assessment.cause === "compaction" ? 0 : severity[assessment.status];
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
      const cacheAssessment = (call.contextEventsBefore ?? []).some((event) =>
          event.type === "compaction"
        ) &&
          (rawAssessment.status === "partial-hit" ||
            rawAssessment.status === "full-miss")
        ? { ...rawAssessment, cause: "compaction" as const }
        : rawAssessment;
      previous = call;
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
    unexpectedMisses: 0,
  };
  for (const turn of session.turns) {
    for (const call of turn.calls) {
      if (call.cacheAssessment?.cause === "compaction") {
        summary.compactionRelatedMisses++;
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
    ...session.turns.flatMap((turn) =>
      turn.cacheAssessment?.cause !== "compaction" &&
        (turn.cacheAssessment?.status === "full-miss" ||
          turn.cacheAssessment?.status === "partial-hit")
        ? [{
          status: turn.cacheAssessment.status,
          ...(turn.cacheAssessment.cause === undefined
            ? {}
            : { cause: turn.cacheAssessment.cause }),
          turn: turn.number,
          scope,
        }]
        : []
    ),
    ...session.subagents.flatMap((subagent) =>
      sessionCacheIssues(subagent, true)
    ),
  ];
}
