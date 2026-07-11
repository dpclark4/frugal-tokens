import type {
  CacheAssessment,
  CacheSummary,
  ModelCall,
  SessionDetail,
  TurnCacheSummary,
} from "../shared/sessionSchemas.ts";

export const CACHE_HIT_RATIO = 0.9;
export const CACHE_FULL_MISS_RATIO = 0.1;

export function assessCache(
  previous: ModelCall | undefined,
  current: ModelCall,
): CacheAssessment {
  if (
    !previous || previous.provider !== current.provider ||
    previous.model !== current.model
  ) {
    return { status: "unknown" };
  }

  const previousReusableTokens = previous.tokens.cacheRead +
    (previous.tokens.cacheWrite ??
      (previous.provider === "openai" ? previous.tokens.uncachedInput : 0));
  if (previousReusableTokens === 0) return { status: "unknown" };

  const retainedRatio = current.tokens.cacheRead / previousReusableTokens;
  const status = retainedRatio >= CACHE_HIT_RATIO
    ? "hit"
    : retainedRatio <= CACHE_FULL_MISS_RATIO
    ? "full-miss"
    : "partial-miss";
  return { status, retainedRatio, previousReusableTokens };
}

const severity: Record<CacheAssessment["status"], number> = {
  unknown: 0,
  hit: 1,
  "partial-miss": 2,
  "full-miss": 3,
};

export function summarizeTurnCache(calls: ModelCall[]): TurnCacheSummary {
  const summary: TurnCacheSummary = {
    hits: 0,
    partialMisses: 0,
    fullMisses: 0,
    unknown: 0,
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
    switch (call.cacheAssessment?.status) {
      case "hit":
        summary.hits++;
        break;
      case "partial-miss":
        summary.partialMisses++;
        break;
      case "full-miss":
        summary.fullMisses++;
        break;
      default:
        summary.unknown++;
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
      const cacheAssessment = assessCache(previous, call);
      previous = call;
      return { ...call, cacheAssessment };
    });
    const cacheAssessment = calls.reduce<CacheAssessment | undefined>(
      (worst, call) =>
        !worst || severity[call.cacheAssessment.status] > severity[worst.status]
          ? call.cacheAssessment
          : worst,
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
    // Future source compaction events can explain drops without changing the
    // token-based classification itself.
    subagents: session.subagents.map(analyzeSessionCache),
  };
}

export function summarizeSessionCache(session: SessionDetail): CacheSummary {
  const summary: CacheSummary = {
    hits: 0,
    partialMisses: 0,
    fullMisses: 0,
    unknown: 0,
  };
  for (const turn of session.turns) {
    for (const call of turn.calls) {
      switch (call.cacheAssessment?.status) {
        case "hit":
          summary.hits++;
          break;
        case "partial-miss":
          summary.partialMisses++;
          break;
        case "full-miss":
          summary.fullMisses++;
          break;
        default:
          summary.unknown++;
      }
    }
  }
  return summary;
}
