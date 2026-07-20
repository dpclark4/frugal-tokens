import type { PerformanceResponse } from "../shared/sessionSchemas.ts";
import {
  contextSize,
  hasInputContext,
} from "../shared/contextMetrics.ts";
import {
  categorizeUsageCallCache,
  type AssessedUsageCall,
} from "./cacheAnalysis.ts";
import type { UsageCall } from "./usage.ts";

export const PERFORMANCE_RANGE_DAYS = 90;

export const PERFORMANCE_MODELS = {
  openai: [
    "gpt-5.2-codex",
    "gpt-5.2-codex-low",
    "gpt-5.2-codex-medium",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ],
  anthropic: [
    "claude-fable-5",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-5",
  ],
} as const;

type Vendor = keyof typeof PERFORMANCE_MODELS;
type ImageCohort = PerformanceResponse[Vendor]["imageCohorts"][number]["cohort"];
type Week = PerformanceResponse[Vendor]["weeks"][number];

function vendorFor(call: UsageCall): Vendor | undefined {
  const provider = call.provider.toLowerCase();
  const model = call.model.toLowerCase();
  if (provider.includes("anthropic") || model.startsWith("claude-")) {
    return "anthropic";
  }
  if (provider.startsWith("openai") || model.startsWith("gpt-")) {
    return "openai";
  }
  return undefined;
}

function localDate(value: number) {
  const date = new Date(value);
  return Temporal.PlainDate.from({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  });
}

function weekKey(value: number) {
  const date = localDate(value);
  return date.subtract({ days: date.dayOfWeek - 1 }).toString();
}

function percentile(values: number[], quantile: number) {
  const index = (values.length - 1) * quantile;
  const lower = Math.floor(index);
  const remainder = index - lower;
  return values[lower] + (values[lower + 1] - values[lower]) * remainder ||
    values[lower];
}

function efficiencyDistribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const median = percentile(sorted, 0.5);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const included = sorted.filter((value) =>
    value >= lowerFence && value <= upperFence
  );
  return {
    lowerWhisker: included[0],
    q1,
    median,
    q3,
    upperWhisker: included.at(-1)!,
    average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    sampleSize: sorted.length,
    outliers: sorted.length - included.length,
  };
}

function emptyWeek(date: string): Week {
  return {
    date,
    endDate: Temporal.PlainDate.from(date).add({ days: 6 }).toString(),
    sessions: 0,
    sessionsWithMiss: 0,
    turns: 0,
    turnsWithMiss: 0,
  };
}

function weeksBetween(start: number, end: number) {
  const first = Temporal.PlainDate.from(weekKey(start));
  const last = Temporal.PlainDate.from(weekKey(end));
  const weeks = new Map<string, Week>();
  for (
    let date = first;
    Temporal.PlainDate.compare(date, last) <= 0;
    date = date.add({ weeks: 1 })
  ) {
    weeks.set(date.toString(), emptyWeek(date.toString()));
  }
  return weeks;
}

function imageCohorts(calls: AssessedUsageCall[]) {
  const cohorts = new Map<string, ImageCohort>();
  for (const call of calls) {
    const key = `${call.harness}:${call.session.rootID}`;
    if (!cohorts.has(key)) cohorts.set(key, "no-image");
    if (
      call.session.id !== call.session.rootID || (call.images ?? 0) === 0
    ) continue;
    if (call.turnOrdinal === 1) cohorts.set(key, "first-turn-image");
    else if (cohorts.get(key) !== "first-turn-image") {
      cohorts.set(key, "later-turn-image");
    }
  }
  return cohorts;
}

function providerResult(
  calls: AssessedUsageCall[],
  cohorts: Map<string, ImageCohort>,
  vendor: Vendor,
  selectedModel: string,
  start: number,
  end: number,
): PerformanceResponse[Vendor] {
  const matching = calls.filter((call) =>
    vendorFor(call) === vendor &&
    (selectedModel === "all" || call.model === selectedModel) &&
    call.sessionStartedAt >= start && call.sessionStartedAt <= end &&
    hasInputContext(call.tokens)
  );
  const weeks = weeksBetween(start, end);
  const sessions = Map.groupBy(
    matching,
    (call) => `${call.harness}:${call.session.rootID}`,
  );
  const efficiencyByWeek = new Map<string, number[]>();
  const imageResults: PerformanceResponse[Vendor]["imageCohorts"] = [
    { cohort: "no-image", sessions: 0, sessionsWithMiss: 0 },
    { cohort: "first-turn-image", sessions: 0, sessionsWithMiss: 0 },
    { cohort: "later-turn-image", sessions: 0, sessionsWithMiss: 0 },
  ];
  let sessionsWithMiss = 0;
  let turns = 0;
  let turnsWithMiss = 0;

  for (const sessionCalls of sessions.values()) {
    const sessionWeek = weekKey(sessionCalls[0].sessionStartedAt);
    const bucket = weeks.get(sessionWeek);
    if (!bucket) continue;
    bucket.sessions++;
    const totalInput = sessionCalls.reduce(
      (sum, call) => sum + contextSize(call.tokens),
      0,
    );
    if (totalInput > 0) {
      const values = efficiencyByWeek.get(sessionWeek) ?? [];
      values.push(
        sessionCalls.reduce((sum, call) => sum + call.tokens.cacheRead, 0) /
          totalInput,
      );
      efficiencyByWeek.set(sessionWeek, values);
    }
    const sessionMiss = sessionCalls.some((call) =>
      call.cacheAssessment.cause === undefined &&
      (call.cacheAssessment.status === "partial-hit" ||
        call.cacheAssessment.status === "full-miss")
    );
    if (sessionMiss) {
      sessionsWithMiss++;
      bucket.sessionsWithMiss++;
    }
    const sessionKey = `${sessionCalls[0].harness}:${sessionCalls[0].session.rootID}`;
    const imageResult = imageResults.find((result) =>
      result.cohort === (cohorts.get(sessionKey) ?? "no-image")
    )!;
    imageResult.sessions++;
    if (sessionMiss) imageResult.sessionsWithMiss++;
    const sessionTurns = Map.groupBy(
      sessionCalls,
      (call) => `${call.session.id}:${call.turnID}`,
    );
    turns += sessionTurns.size;
    bucket.turns += sessionTurns.size;
    for (const turnCalls of sessionTurns.values()) {
      if (turnCalls.some((call) =>
        call.cacheAssessment.cause === undefined &&
        (call.cacheAssessment.status === "partial-hit" ||
          call.cacheAssessment.status === "full-miss")
      )) {
        turnsWithMiss++;
        bucket.turnsWithMiss++;
      }
    }
  }

  for (const [date, values] of efficiencyByWeek) {
    const week = weeks.get(date);
    if (week) week.efficiency = efficiencyDistribution(values);
  }

  return {
    provider: vendor,
    selectedModel,
    sessions: sessions.size,
    sessionsWithMiss,
    turns,
    turnsWithMiss,
    imageCohorts: imageResults,
    weeks: [...weeks.values()],
  };
}

export function aggregatePerformance(
  calls: UsageCall[],
  start: number,
  end: number,
  openaiModel = "all",
  anthropicModel = "all",
): PerformanceResponse {
  const assessed = categorizeUsageCallCache(calls);
  const cohorts = imageCohorts(assessed);
  return {
    rangeDays: PERFORMANCE_RANGE_DAYS,
    models: {
      openai: [...PERFORMANCE_MODELS.openai],
      anthropic: [...PERFORMANCE_MODELS.anthropic],
    },
    openai: providerResult(
      assessed,
      cohorts,
      "openai",
      openaiModel,
      start,
      end,
    ),
    anthropic: providerResult(
      assessed,
      cohorts,
      "anthropic",
      anthropicModel,
      start,
      end,
    ),
  };
}
