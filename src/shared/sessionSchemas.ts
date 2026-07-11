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
});

export const userTurnSchema = z.object({
  number: z.number().int().positive(),
  startedAt: z.number(),
  calls: z.array(modelCallSchema),
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
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
