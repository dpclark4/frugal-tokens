import { z } from "zod";

export const tokenUsageSchema = z.object({
  uncachedInput: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().positive().optional(),
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
});

export const callActivitySchema = z.object({
  finishReason: z.string().optional(),
  hasText: z.boolean(),
  hasReasoning: z.boolean(),
  tools: z.array(toolEventSchema),
});

export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.number(),
  providers: z.array(z.string()),
  models: z.array(z.string()),
  userTurns: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  reportedCost: z.number().nonnegative(),
  tokens: tokenUsageSchema,
});

export const modelCallSchema = z.object({
  id: z.string(),
  callWithinTurn: z.number().int().positive(),
  provider: z.string(),
  model: z.string(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  reportedCost: z.number().nonnegative(),
  tokens: tokenUsageSchema,
  activity: callActivitySchema,
});

export const userTurnSchema = z.object({
  number: z.number().int().positive(),
  startedAt: z.number(),
  calls: z.array(modelCallSchema),
});

export const sessionDetailSchema = sessionSummarySchema.extend({
  turns: z.array(userTurnSchema),
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
export type SessionDetail = z.infer<typeof sessionDetailSchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
