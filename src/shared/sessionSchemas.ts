import { z } from "zod";

export const harnessSchema = z.enum(["opencode", "claude-code"]);

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
});

export const callActivitySchema = z.object({
  finishReason: z.string().optional(),
  hasText: z.boolean(),
  hasReasoning: z.boolean(),
  tools: z.array(toolEventSchema),
});

export const cacheStatusSchema = z.enum([
  "hit",
  "partial-miss",
  "full-miss",
  "unknown",
]);

export const cacheAssessmentSchema = z.object({
  status: cacheStatusSchema,
  retainedRatio: z.number().nonnegative().optional(),
  previousReusableTokens: z.number().int().positive().optional(),
});

export const cacheSummarySchema = z.object({
  hits: z.number().int().nonnegative(),
  partialMisses: z.number().int().nonnegative(),
  fullMisses: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
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
  reportedCost: z.number().nonnegative().optional(),
  computedCost: z.number().nonnegative().optional(),
  cacheSummary: cacheSummarySchema.optional(),
  tokens: tokenUsageSchema,
});

export const modelCallSchema = z.object({
  id: z.string(),
  callWithinTurn: z.number().int().positive(),
  provider: z.string(),
  model: z.string(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  reportedCost: z.number().nonnegative().optional(),
  computedCost: z.number().nonnegative().optional(),
  tokens: tokenUsageSchema,
  activity: callActivitySchema,
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

export type ModelCall = z.infer<typeof modelCallSchema>;
export type CacheAssessment = z.infer<typeof cacheAssessmentSchema>;
export type CacheSummary = z.infer<typeof cacheSummarySchema>;
export type TurnCacheSummary = z.infer<typeof turnCacheSummarySchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
