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
]);

export const cacheAssessmentSchema = z.object({
  status: cacheStatusSchema,
  reason: cacheAssessmentReasonSchema.optional(),
  cause: z.enum(["compaction"]).optional(),
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
  unexpectedMisses: z.number().int().nonnegative(),
});

export const cacheIssueSchema = z.object({
  status: z.enum(["partial-hit", "full-miss"]),
  cause: z.enum(["compaction"]).optional(),
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
  cacheDays: z.array(z.object({
    date: z.string(),
    clean: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    fullMiss: z.number().int().nonnegative(),
    notComparable: z.number().int().nonnegative(),
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
