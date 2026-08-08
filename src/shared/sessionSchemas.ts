import { z } from "zod";
import { modelProviderValues } from "./modelMetadata.ts";

export const harnessSchema = z.enum([
  "opencode",
  "claude-code",
  "pi",
  "codex",
  "cursor",
]);

export const sessionMissFilterValues = [
  "compaction",
  "ttl",
  "thinking-change",
  "full-miss",
  "partial-miss",
] as const;

export const sessionMissFilterSchema = z.enum(sessionMissFilterValues);
export const sessionMissFiltersSchema = z.array(sessionMissFilterSchema);

export function parseSessionMissFilters(
  value?: string,
): SessionMissFilter[] | undefined {
  if (value === undefined || value === "" || value === "all") return undefined;
  if (value === "none") return [];
  const values = [...new Set(value.split(","))];
  const parsed = sessionMissFiltersSchema.safeParse(values);
  return parsed.success ? parsed.data : undefined;
}

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

export const cacheMissCauseSchema = z.enum([
  "compaction",
  "ttl",
  "thinking-change",
]);

export const cacheAssessmentSchema = z.object({
  status: cacheStatusSchema,
  reason: cacheAssessmentReasonSchema.optional(),
  cause: cacheMissCauseSchema.optional(),
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
  thinkingChangeRelatedMisses: z.number().int().nonnegative(),
  unexpectedMisses: z.number().int().nonnegative(),
});

export const cacheIssueSchema = z.object({
  status: z.enum(["partial-hit", "full-miss"]),
  cause: cacheMissCauseSchema.optional(),
  turn: z.number().int().positive(),
  scope: z.string().optional(),
});

export const turnCacheSummarySchema = cacheSummarySchema.extend({
  totalCacheRead: z.number().int().nonnegative(),
  peakCacheRead: z.number().int().nonnegative(),
  totalNewInput: z.number().int().nonnegative(),
  cachedInputShare: z.number().min(0).max(1).optional(),
});

export const thinkingSummarySchema = z.object({
  latest: z.string().optional(),
  values: z.array(z.string()),
  classifiedCalls: z.number().int().nonnegative(),
});

export const sessionSummarySchema = z.object({
  id: z.string(),
  // Enriched by the archive adapter; raw harness summaries do not have these
  // canonical fields until they are persisted.
  internalID: z.number().int().positive().optional(),
  sourcePath: z.string().optional(),
  workingDirectory: z.string().optional(),
  harness: harnessSchema,
  title: z.string(),
  updatedAt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  providers: z.array(z.string()),
  models: z.array(z.string()),
  userTurns: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  thinking: thinkingSummarySchema.optional(),
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

export const sessionListItemSchema = sessionSummarySchema.omit({
  internalID: true,
  sourcePath: true,
  subagentModelCalls: true,
});

export const compactionTriggerSchema = z.enum([
  "manual",
  "automatic",
  "threshold",
  "overflow",
  "unknown",
]);

export const compactionCheckpointItemSchema = z.object({
  ordinal: z.number().int().positive(),
  sourceEntryID: z.string().optional(),
  kind: z.string().min(1),
  role: z.string().optional(),
  contentAvailability: z.enum([
    "plaintext",
    "encrypted",
    "reference-only",
    "unavailable",
  ]),
  contentPreview: z.string().optional(),
  originalLength: z.number().int().nonnegative().optional(),
  truncated: z.boolean(),
  contentHash: z.string().optional(),
  nativeMetadata: z.record(z.string(), z.unknown()).optional(),
});

export const compactionDetailSchema = z.object({
  sourceID: z.string().optional(),
  trigger: compactionTriggerSchema,
  resultKind: z.enum([
    "plaintext-summary",
    "encrypted-checkpoint",
    "unavailable",
  ]),
  checkpointCompleteness: z.enum([
    "complete",
    "partial",
    "summary-only",
    "unknown",
  ]),
  preContextTokens: z.number().int().nonnegative().optional(),
  postContextTokens: z.number().int().nonnegative().optional(),
  droppedContextTokens: z.number().int().nonnegative().optional(),
  retainedItemCount: z.number().int().nonnegative().optional(),
  droppedItemCount: z.number().int().nonnegative().optional(),
  nativeMetadata: z.record(z.string(), z.unknown()).optional(),
  checkpointItems: z.array(compactionCheckpointItemSchema),
});

export const contextEventSchema = z.object({
  type: z.string().min(1),
  sourceOrder: z.number().int().positive(),
  occurredAt: z.number().optional(),
  compaction: compactionDetailSchema.optional(),
});

export const reasoningSettingSchema = z.object({
  settingName: z.string(),
  settingValue: z.string(),
  sourceFieldPath: z.string().optional(),
  sourceOrder: z.number().int().positive().optional(),
  observedAt: z.number().optional(),
  provenance: z.enum(["explicit", "inherited", "session_fallback"]),
});

export const modelCallSchema = z.object({
  id: z.string(),
  callWithinTurn: z.number().int().positive(),
  preview: z.string().optional(),
  responsePreview: z.string().optional(),
  responseOriginalLength: z.number().int().nonnegative().optional(),
  responseTruncated: z.boolean().optional(),
  provider: z.string(),
  model: z.string(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  reportedCost: z.number().nonnegative().optional(),
  computedCost: z.number().nonnegative().optional(),
  tokens: tokenUsageSchema,
  activity: callActivitySchema,
  reasoningSetting: reasoningSettingSchema.optional(),
  contextEventsBefore: z.array(contextEventSchema).optional(),
  cacheAssessment: cacheAssessmentSchema.optional(),
});

export const turnInputSchema = z.object({
  kind: z.string(),
  preview: z.string().optional(),
  originalLength: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  mimeType: z.string().optional(),
});

export const userTurnSchema = z.object({
  number: z.number().int().positive(),
  startedAt: z.number(),
  inputs: z.array(turnInputSchema).optional(),
  reasoningSetting: reasoningSettingSchema.optional(),
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
  items: z.array(sessionListItemSchema),
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
  initialInputSummary: z.object({
    median: z.number().nonnegative(),
    average: z.number().nonnegative(),
    sessions: z.number().int().positive(),
  }).optional(),
  initialInputDays: z.array(z.object({
    date: z.string(),
    harness: harnessSchema,
    median: z.number().nonnegative(),
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

export const workRhythmSessionSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  harness: harnessSchema,
  model: z.string().nullable(),
  startTime: z.string(),
  activeDateRange: z.object({ start: z.string(), end: z.string() }),
  spend: z.number().nonnegative(),
  hasUnpricedSpend: z.boolean(),
  totalSpend: z.number().nonnegative(),
  hasUnpricedTotalSpend: z.boolean(),
});

export const workRhythmDaySchema = z.object({
  date: z.string(),
  estimatedActiveMinutes: z.number().nonnegative(),
  spend: z.number().nonnegative(),
  hasUnpricedSpend: z.boolean(),
  processedInputTokens: z.number().int().nonnegative(),
  userTurns: z.number().int().nonnegative(),
  rootSessions: z.number().int().nonnegative(),
  intensity: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
  topSessions: z.array(workRhythmSessionSchema),
});

export const workRhythmDataSchema = z.object({
  range: z.object({ start: z.string(), end: z.string() }),
  estimatedActiveMinutes: z.number().nonnegative(),
  methodology: z.object({
    initialMinutes: z.literal(5),
    completionGapTimeoutMinutes: z.literal(10),
    fallbackMinutes: z.literal(5),
    overlapsCountedOnce: z.literal(true),
  }),
  weekdayActivity: z.array(z.object({
    weekday: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
    ]),
    label: z.string(),
    averageMinutes: z.number().nonnegative(),
    totalMinutes: z.number().nonnegative(),
    occurrences: z.number().int().nonnegative(),
    activeOccurrences: z.number().int().nonnegative(),
  })),
  hourlyActivity: z.array(z.object({
    hour: z.number().int().min(0).max(23),
    estimatedMinutes: z.number().nonnegative(),
    shareOfTotal: z.number().min(0).max(1),
    activeDates: z.number().int().nonnegative(),
  })),
  afterHoursShare: z.number().min(0).max(1),
  peakHour: z.number().int().min(0).max(23).optional(),
  days: z.record(z.string(), workRhythmDaySchema),
});

const spendCompositionModelSchema = z.object({
  model: z.string(),
  provider: z.enum(modelProviderValues),
  tier: z.string(),
  tierRank: z.number().int().nonnegative(),
  generation: z.string().optional(),
  variant: z.string().optional(),
  spend: z.number().nonnegative(),
  processedInput: z.number().int().nonnegative(),
  effectiveCostPerMillion: z.number().nonnegative().optional(),
  spendRank: z.number().int().positive(),
  tokenRank: z.number().int().positive(),
  selectedBySpend: z.boolean(),
  selectedByTokens: z.boolean(),
  hasUnpricedCost: z.boolean(),
});

export const spendCompositionSchema = z.object({
  spend: z.number().nonnegative(),
  processedInput: z.number().int().nonnegative(),
  hasUnpricedCost: z.boolean(),
  models: z.array(spendCompositionModelSchema).max(10),
  other: z.object({
    spend: z.number().nonnegative(),
    processedInput: z.number().int().nonnegative(),
    hasUnpricedCost: z.boolean(),
  }).optional(),
  days: z.array(z.object({
    date: z.string(),
    models: z.array(z.object({
      model: z.string(),
      spend: z.number().nonnegative(),
      processedInput: z.number().int().nonnegative(),
      hasUnpricedCost: z.boolean(),
    })),
    otherSpend: z.number().nonnegative(),
    otherProcessedInput: z.number().int().nonnegative(),
    otherHasUnpricedCost: z.boolean(),
    otherModels: z.array(z.object({
      model: z.string(),
      provider: z.enum(modelProviderValues),
      tier: z.string(),
      tierRank: z.number().int().nonnegative(),
      generation: z.string().optional(),
      variant: z.string().optional(),
      spend: z.number().nonnegative(),
      processedInput: z.number().int().nonnegative(),
      hasUnpricedCost: z.boolean(),
    })),
  })),
});

export const activityOverviewResponseSchema = z.object({
  rangeDays: z.union([z.literal(30), z.literal(90)]),
  startDate: z.string(),
  endDate: z.string(),
  summary: z.object({
    activeDays: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    processedInput: z.number().int().nonnegative(),
    tokenReuse: z.number().min(0).max(1).optional(),
    spend: z.number().nonnegative(),
    hasUnpricedCost: z.boolean(),
    spendAtMissCalls: z.number().nonnegative(),
    subagentSpend: z.number().nonnegative(),
    topDecileSpendShare: z.number().min(0).max(1),
  }),
  workRhythm: workRhythmDataSchema,
  spendComposition: spendCompositionSchema,
  days: z.array(z.object({
    date: z.string(),
    processedInput: z.number().int().nonnegative(),
    spend: z.number().nonnegative(),
    hasUnpricedCost: z.boolean(),
    sessions: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    estimatedActiveMs: z.number().int().nonnegative(),
    models: z.array(z.object({
      model: z.string(),
      input: z.number().int().nonnegative(),
      spend: z.number().nonnegative(),
    })),
    topSessions: z.array(z.object({
      id: z.number().int().positive(),
      title: z.string(),
      harness: harnessSchema.optional(),
      models: z.array(z.string()),
      turns: z.number().int().nonnegative(),
      processedInput: z.number().int().nonnegative(),
      spend: z.number().nonnegative(),
      hasUnpricedCost: z.boolean(),
    })),
  })),
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
    activeSpan: distributionSchema.optional(),
    input: distributionSchema.optional(),
    initialInput: distributionSchema.optional(),
    peakContext: distributionSchema.optional(),
    elapsed: distributionSchema.optional(),
    spend: distributionSchema.optional(),
    efficiency: distributionSchema.optional(),
    overallEfficiency: z.number().min(0).max(1).optional(),
    hasUnpricedCost: z.boolean(),
  }),
  multiDaySessions: z.number().int().nonnegative(),
  multiDaySessionRate: z.number().min(0).max(1),
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

const runtimeDistributionSchema = z.object({
  average: z.number().nonnegative(),
  median: z.number().nonnegative(),
  p95: z.number().nonnegative(),
});

export const toolCallsResponseSchema = z.object({
  rangeDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  startAt: z.number(),
  endAt: z.number(),
  expanded: z.boolean(),
  tools: z.array(z.object({
    tool: z.string(),
    count: z.number().int().positive(),
    modelCalls: z.number().int().positive(),
    callsPerModelCall: z.number().positive(),
    toolRuntime: runtimeDistributionSchema.optional(),
    modelRuntime: runtimeDistributionSchema.optional(),
  })),
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
    underThirtyMinutes: z.number().int().nonnegative(),
    underThirtyMinutesSessions: z.number().int().nonnegative(),
    underThirtyMinutesCost: z.number().nonnegative(),
    thirtyMinutesToTwoHours: z.number().int().nonnegative(),
    thirtyMinutesToTwoHoursSessions: z.number().int().nonnegative(),
    thirtyMinutesToTwoHoursCost: z.number().nonnegative(),
    underTwoHours: z.number().int().nonnegative(),
    underTwoHoursSessions: z.number().int().nonnegative(),
    underTwoHoursCost: z.number().nonnegative(),
    twoToEightHours: z.number().int().nonnegative(),
    twoToEightHoursSessions: z.number().int().nonnegative(),
    twoToEightHoursCost: z.number().nonnegative(),
    eightHoursOrMore: z.number().int().nonnegative(),
    eightHoursOrMoreSessions: z.number().int().nonnegative(),
    eightHoursOrMoreCost: z.number().nonnegative(),
  }),
  subagents: z.object({
    affectedSessions: z.number().int().nonnegative(),
    misses: z.number().int().nonnegative(),
  }),
  cacheMisses: z.object({
    affectedSessions: z.number().int().nonnegative(),
    otherAffectedSessions: z.number().int().nonnegative(),
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
    thinkingChange: z.object({
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
export type SessionMissFilter = z.infer<typeof sessionMissFilterSchema>;
export type TurnInput = z.infer<typeof turnInputSchema>;
export type ContextEvent = z.infer<typeof contextEventSchema>;
export type CompactionDetail = z.infer<typeof compactionDetailSchema>;
export type CompactionCheckpointItem = z.infer<
  typeof compactionCheckpointItemSchema
>;
export type CacheMissCause = z.infer<typeof cacheMissCauseSchema>;
export type CacheAssessment = z.infer<typeof cacheAssessmentSchema>;
export type CacheSummary = z.infer<typeof cacheSummarySchema>;
export type CacheIssue = z.infer<typeof cacheIssueSchema>;
export type TurnCacheSummary = z.infer<typeof turnCacheSummarySchema>;
export type SessionListItem = z.infer<typeof sessionListItemSchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type UsageResponse = z.infer<typeof usageResponseSchema>;
export const sessionShapeMetricKeySchema = z.enum([
  "cost",
  "processedInput",
  "userTurns",
  "observedSpan",
  "startingContext",
  "peakContext",
  "tokenReuse",
]);

export const sessionShapeResponseSchema = z.object({
  rangeDays: z.union([z.literal(30), z.literal(90)]),
  sampleSize: z.number().int().nonnegative(),
  unpricedSessions: z.number().int().nonnegative(),
  multiDaySessions: z.number().int().nonnegative(),
  multiDaySessionRate: z.number().min(0).max(1),
  metrics: z.array(z.object({
    key: sessionShapeMetricKeySchema,
    distribution: z.object({
      p10: z.number().nonnegative(),
      p25: z.number().nonnegative(),
      median: z.number().nonnegative(),
      average: z.number().nonnegative(),
      p75: z.number().nonnegative(),
      p90: z.number().nonnegative(),
    }).optional(),
  })),
});

export type WorkRhythmSession = z.infer<typeof workRhythmSessionSchema>;
export type WorkRhythmDay = z.infer<typeof workRhythmDaySchema>;
export type WorkRhythmData = z.infer<typeof workRhythmDataSchema>;
export type ActivityOverviewResponse = z.infer<
  typeof activityOverviewResponseSchema
>;
export type SpendCompositionData = z.infer<typeof spendCompositionSchema>;
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;
export type SessionShapeResponse = z.infer<typeof sessionShapeResponseSchema>;
export type PerformanceResponse = z.infer<typeof performanceResponseSchema>;
export type ToolCallsResponse = z.infer<typeof toolCallsResponseSchema>;
export type TtlMissMetrics = z.infer<typeof ttlMissMetricsSchema>;
