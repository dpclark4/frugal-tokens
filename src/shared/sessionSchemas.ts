import { z } from "zod";

export const harnessSchema = z.enum(["opencode", "claude-code", "pi", "codex"]);

export const tokenUsageSchema = z.object({
  uncachedInput: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().positive().optional(),
  cacheWrite5m: z.number().int().nonnegative().optional(),
  cacheWrite1h: z.number().int().nonnegative().optional(),
  freshPrompt: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
});

export const toolEventSchema = z.object({
  name: z.string(),
  status: z.string(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  childSessionID: z.string().optional(),
  inputPreview: z.string().optional(),
  outputPreview: z.string().optional(),
});

export const callActivitySchema = z.object({
  finishReason: z.string().optional(),
  images: z.number().int().positive().optional(),
  hasText: z.boolean(),
  hasReasoning: z.boolean(),
  tools: z.array(toolEventSchema),
});

export const cacheStatusSchema = z.enum([
  "baseline",
  "hit",
  "partial-hit",
  "full-miss",
  "not-comparable",
  "unknown",
]);

export const cacheAssessmentReasonSchema = z.enum([
  "no-predecessor",
  "model-change",
  "no-reusable-cache",
  "no-input-context",
]);

export const cacheAssessmentSchema = z.object({
  status: cacheStatusSchema,
  reason: cacheAssessmentReasonSchema.optional(),
  cause: z.enum(["compaction", "ttl"]).optional(),
  retainedRatio: z.number().nonnegative().optional(),
  previousReusableTokens: z.number().int().positive().optional(),
});

export const cacheSummarySchema = z.object({
  baseline: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  partialHits: z.number().int().nonnegative(),
  fullMisses: z.number().int().nonnegative(),
  notComparable: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  compactionRelatedMisses: z.number().int().nonnegative(),
  ttlRelatedMisses: z.number().int().nonnegative(),
  unexpectedMisses: z.number().int().nonnegative(),
});

export const cacheIssueSchema = z.object({
  status: z.enum(["partial-hit", "full-miss"]),
  cause: z.enum(["compaction", "ttl"]).optional(),
  turn: z.number().int().positive(),
  scope: z.string().optional(),
});

export const turnCacheSummarySchema = cacheSummarySchema.extend({
  totalCacheRead: z.number().int().nonnegative(),
  peakCacheRead: z.number().int().nonnegative(),
  totalNewInput: z.number().int().nonnegative(),
  cachedInputShare: z.number().min(0).max(1).optional(),
});

export const sessionSummarySchema = z.object({
  id: z.string(),
  harness: harnessSchema,
  title: z.string(),
  updatedAt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  providers: z.array(z.string()),
  models: z.array(z.string()),
  userTurns: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  subagentCount: z.number().int().nonnegative().optional(),
  subagentModelCalls: z.number().int().nonnegative().optional(),
  inclusiveUserTurns: z.number().int().nonnegative().optional(),
  inclusiveModelCalls: z.number().int().nonnegative().optional(),
  inclusiveReportedCost: z.number().nonnegative().optional(),
  inclusiveComputedCost: z.number().nonnegative().optional(),
  inclusiveImageInputs: z.number().int().nonnegative().optional(),
  inclusiveTokens: tokenUsageSchema.optional(),
  reportedCost: z.number().nonnegative().optional(),
  computedCost: z.number().nonnegative().optional(),
  cacheSummary: cacheSummarySchema.optional(),
  cacheIssues: z.array(cacheIssueSchema).optional(),
  compactionCount: z.number().int().nonnegative().optional(),
  contextLatest: z.number().int().nonnegative().optional(),
  contextPeak: z.number().int().nonnegative().optional(),
  contextPeakTurn: z.number().int().positive().optional(),
  contextPeakCall: z.number().int().positive().optional(),
  tokens: tokenUsageSchema,
});

export const contextEventSchema = z.object({
  type: z.string().min(1),
  sourceOrder: z.number().int().positive(),
  occurredAt: z.number().optional(),
});

export const modelCallSchema = z.object({
  id: z.string(),
  callWithinTurn: z.number().int().positive(),
  preview: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  reportedCost: z.number().nonnegative().optional(),
  computedCost: z.number().nonnegative().optional(),
  tokens: tokenUsageSchema,
  activity: callActivitySchema,
  contextEventsBefore: z.array(contextEventSchema).optional(),
  cacheAssessment: cacheAssessmentSchema.optional(),
});

export const userTurnSchema = z.object({
  number: z.number().int().positive(),
  startedAt: z.number(),
  calls: z.array(modelCallSchema),
  cacheAssessment: cacheAssessmentSchema.optional(),
  cacheSummary: turnCacheSummarySchema.optional(),
});

const sessionDetailBaseSchema = sessionSummarySchema.extend({
  parentID: z.string().optional(),
  agent: z.string().optional(),
  turns: z.array(userTurnSchema),
  contextEvents: z.array(contextEventSchema).optional(),
});

export type SessionDetail = z.infer<typeof sessionDetailBaseSchema> & {
  subagents: SessionDetail[];
};

export const sessionDetailSchema: z.ZodType<SessionDetail> =
  sessionDetailBaseSchema.extend({
    subagents: z.lazy(() => z.array(sessionDetailSchema)),
  });

export const sessionListResponseSchema = z.object({
  items: z.array(sessionSummarySchema),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalItems: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
});

export const usageResponseSchema = z.object({
  hasUnpricedCost: z.boolean(),
  subagentCoverage: z.enum(["full", "partial", "none"]),
  subagentDays: z.array(z.object({
    date: z.string(),
    rootOnly: z.number().int().nonnegative(),
    withSubagents: z.number().int().nonnegative(),
    withMultipleSubagents: z.number().int().nonnegative(),
    subagents: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    subagentCalls: z.number().int().nonnegative(),
    totalInput: z.number().int().nonnegative(),
    subagentInput: z.number().int().nonnegative(),
    totalCost: z.number().nonnegative(),
    subagentCost: z.number().nonnegative(),
    hasUnpricedCost: z.boolean(),
  })),
  subagentWeeks: z.array(z.object({
    date: z.string(),
    endDate: z.string(),
    rootOnly: z.number().int().nonnegative(),
    withSubagents: z.number().int().nonnegative(),
    withMultipleSubagents: z.number().int().nonnegative(),
    subagents: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    subagentCalls: z.number().int().nonnegative(),
    totalInput: z.number().int().nonnegative(),
    subagentInput: z.number().int().nonnegative(),
    totalCost: z.number().nonnegative(),
    subagentCost: z.number().nonnegative(),
    hasUnpricedCost: z.boolean(),
  })),
  sessionInputDays: z.array(z.object({
    date: z.string(),
    median: z.number().nonnegative(),
    p90: z.number().nonnegative(),
    average: z.number().nonnegative(),
    sessions: z.number().int().positive(),
  })),
  sessionInputWeeks: z.array(z.object({
    date: z.string(),
    endDate: z.string(),
    median: z.number().nonnegative(),
    p90: z.number().nonnegative(),
    average: z.number().nonnegative(),
    sessions: z.number().int().positive(),
  })),
  days: z.array(z.object({
    date: z.string(),
    models: z.array(z.object({
      model: z.string(),
      input: z.number().int().nonnegative(),
      cost: z.number().nonnegative().optional(),
    })),
  })),
});

const distributionSchema = z.object({
  average: z.number().nonnegative(),
  median: z.number().nonnegative(),
  p90: z.number().nonnegative(),
});

export const overviewResponseSchema = z.object({
  rangeDays: z.number().int().positive(),
  rotationInactivityMinutes: z.number().int().positive(),
  sessions: z.number().int().nonnegative(),
  activeDays: z.number().int().nonnegative(),
  activeWeekdays: z.number().int().nonnegative(),
  elapsedWeekdays: z.number().int().nonnegative(),
  weekendDays: z.number().int().nonnegative(),
  weekdayActivityRate: z.number().min(0).max(1),
  subagentCoverage: z.enum(["full", "partial", "none"]),
  activity: z.object({
    sessions: distributionSchema.optional(),
    peakConcurrentSessions: distributionSchema.optional(),
    turns: distributionSchema.optional(),
    spend: distributionSchema.optional(),
    hasUnpricedCost: z.boolean(),
  }),
  sessionProfile: z.object({
    turns: distributionSchema.optional(),
    input: distributionSchema.optional(),
    peakContext: distributionSchema.optional(),
    elapsed: distributionSchema.optional(),
    spend: distributionSchema.optional(),
    efficiency: distributionSchema.optional(),
    overallEfficiency: z.number().min(0).max(1).optional(),
    hasUnpricedCost: z.boolean(),
  }),
  multiDaySessions: z.number().int().nonnegative(),
  multiDaySessionRate: z.number().min(0).max(1),
  averageActiveSpan: z.number().nonnegative(),
  models: z.array(z.object({
    model: z.string(),
    sessions: z.number().int().nonnegative(),
    input: z.number().int().nonnegative(),
    spend: z.number().nonnegative(),
    spendShare: z.number().min(0).max(1),
    efficiency: z.number().min(0).max(1).optional(),
    hasUnpricedCost: z.boolean(),
    isOther: z.boolean(),
  })),
});

const performanceDistributionSchema = z.object({
  lowerWhisker: z.number().min(0).max(1),
  q1: z.number().min(0).max(1),
  median: z.number().min(0).max(1),
  q3: z.number().min(0).max(1),
  upperWhisker: z.number().min(0).max(1),
  average: z.number().min(0).max(1),
  sampleSize: z.number().int().positive(),
  outliers: z.number().int().nonnegative(),
});

const cacheLossBucketSchema = z.object({
  bucket: z.enum(["0-16k", "16-64k", "64-128k", "128k+"]),
  requests: z.number().int().nonnegative(),
  unretainedTokens: z.number().int().nonnegative(),
});

const cacheRetentionSchema = z.object({
  comparableRequests: z.number().int().positive(),
  requestsWithLoss: z.number().int().nonnegative(),
  partialHits: z.number().int().nonnegative(),
  fullMisses: z.number().int().nonnegative(),
  retainedTokens: z.number().int().nonnegative(),
  unretainedTokens: z.number().int().nonnegative(),
  retainedShare: z.number().min(0).max(1),
  lossRequestRate: z.number().min(0).max(1),
  p90UnretainedTokens: z.number().nonnegative(),
  lossBuckets: z.array(cacheLossBucketSchema),
});

const performanceWeekSchema = z.object({
  date: z.string(),
  endDate: z.string(),
  sessions: z.number().int().nonnegative(),
  sessionsWithMiss: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  turnsWithMiss: z.number().int().nonnegative(),
  efficiency: performanceDistributionSchema.optional(),
  finalContextShare: performanceDistributionSchema.optional(),
  cacheRetention: cacheRetentionSchema.optional(),
});

const imageCohortSchema = z.object({
  cohort: z.enum(["no-image", "first-turn-image", "later-turn-image"]),
  sessions: z.number().int().nonnegative(),
  sessionsWithMiss: z.number().int().nonnegative(),
});

const performanceProviderSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  selectedModel: z.string(),
  sessions: z.number().int().nonnegative(),
  sessionsWithMiss: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  turnsWithMiss: z.number().int().nonnegative(),
  imageCohorts: z.array(imageCohortSchema),
  weeks: z.array(performanceWeekSchema),
});

export const performanceResponseSchema = z.object({
  rangeDays: z.number().int().positive(),
  models: z.object({
    openai: z.array(z.string()),
    anthropic: z.array(z.string()),
  }),
  openai: performanceProviderSchema,
  anthropic: performanceProviderSchema,
});

export const ttlMissMetricsSchema = z.object({
  rangeDays: z.number().int().positive(),
  sessions: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative(),
  hasUnpricedTotalCost: z.boolean(),
  totalSessionCost: z.number().nonnegative(),
  hasUnpricedSessionCost: z.boolean(),
  affectedSessions: z.number().int().nonnegative(),
  affectedSessionCost: z.number().nonnegative(),
  hasUnpricedAffectedSessionCost: z.boolean(),
  misses: z.object({
    total: z.number().int().nonnegative(),
    attributedCost: z.number().nonnegative(),
    unpriced: z.number().int().nonnegative(),
    underTwoHours: z.number().int().nonnegative(),
    underTwoHoursCost: z.number().nonnegative(),
    twoToEightHours: z.number().int().nonnegative(),
    twoToEightHoursCost: z.number().nonnegative(),
    eightHoursOrMore: z.number().int().nonnegative(),
    eightHoursOrMoreCost: z.number().nonnegative(),
  }),
  subagents: z.object({
    affectedSessions: z.number().int().nonnegative(),
    misses: z.number().int().nonnegative(),
  }),
  cacheMisses: z.object({
    affectedSessions: z.number().int().nonnegative(),
    affectedSessionCost: z.number().nonnegative(),
    hasUnpricedAffectedSessionCost: z.boolean(),
    compaction: z.object({
      affectedSessions: z.number().int().nonnegative(),
      misses: z.number().int().nonnegative(),
      attributedCost: z.number().nonnegative(),
      expectedReadCost: z.number().nonnegative(),
      estimatedExtraCost: z.number(),
      missedTokens: z.number().int().nonnegative(),
      unpriced: z.number().int().nonnegative(),
    }),
    unexpected: z.object({
      affectedSessions: z.number().int().nonnegative(),
      affectedSessionCost: z.number().nonnegative(),
      hasUnpricedAffectedSessionCost: z.boolean(),
      full: z.object({
        affectedSessions: z.number().int().nonnegative(),
        misses: z.number().int().nonnegative(),
        attributedCost: z.number().nonnegative(),
        expectedReadCost: z.number().nonnegative(),
        estimatedExtraCost: z.number(),
        missedTokens: z.number().int().nonnegative(),
        unpriced: z.number().int().nonnegative(),
      }),
      partial: z.object({
        affectedSessions: z.number().int().nonnegative(),
        misses: z.number().int().nonnegative(),
        attributedCost: z.number().nonnegative(),
        expectedReadCost: z.number().nonnegative(),
        estimatedExtraCost: z.number(),
        missedTokens: z.number().int().nonnegative(),
        unpriced: z.number().int().nonnegative(),
      }),
    }),
    full: z.object({
      affectedSessions: z.number().int().nonnegative(),
      misses: z.number().int().nonnegative(),
      attributedCost: z.number().nonnegative(),
      expectedReadCost: z.number().nonnegative(),
      estimatedExtraCost: z.number(),
      missedTokens: z.number().int().nonnegative(),
      unpriced: z.number().int().nonnegative(),
    }),
    partial: z.object({
      affectedSessions: z.number().int().nonnegative(),
      misses: z.number().int().nonnegative(),
      attributedCost: z.number().nonnegative(),
      expectedReadCost: z.number().nonnegative(),
      estimatedExtraCost: z.number(),
      missedTokens: z.number().int().nonnegative(),
      unpriced: z.number().int().nonnegative(),
    }),
  }),
});

export type ModelCall = z.infer<typeof modelCallSchema>;
export type ContextEvent = z.infer<typeof contextEventSchema>;
export type CacheAssessment = z.infer<typeof cacheAssessmentSchema>;
export type CacheSummary = z.infer<typeof cacheSummarySchema>;
export type CacheIssue = z.infer<typeof cacheIssueSchema>;
export type TurnCacheSummary = z.infer<typeof turnCacheSummarySchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type UsageResponse = z.infer<typeof usageResponseSchema>;
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;
export type PerformanceResponse = z.infer<typeof performanceResponseSchema>;
export type TtlMissMetrics = z.infer<typeof ttlMissMetricsSchema>;
