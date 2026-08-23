import type { UsageResponse } from "../shared/sessionSchemas.ts";
import type { SessionOverviewRollup } from "./sessionRollups.ts";
import type { InitialInputSample } from "./conversationRepository.ts";
import type { UsageCall } from "./usage.ts";

export type StoredUsageRollup = {
  rootSessionID: number;
  sessionStartedAt: number;
  directInput: number;
  subagentInput: number;
  subagentModelCalls: number;
  overview: SessionOverviewRollup;
};

export type StoredSubagentUsage = {
  rootSessionID: number;
  subagentSessionID: number;
  date: string;
  input: number;
  cost: number;
  hasUnpricedCost: boolean;
};

type UsageAggregation = {
  response: UsageResponse;
  dayCount: number;
};

type CallUsageAggregation = UsageAggregation & { callCount: number };
type RollupUsageAggregation = UsageAggregation & { rootCount: number };

function dateKey(value: number) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function percentile(values: number[], quantile: number) {
  const index = (values.length - 1) * quantile;
  const lower = Math.floor(index);
  const remainder = index - lower;
  return values[lower] + (values[lower + 1] - values[lower]) * remainder ||
    values[lower];
}

function weekKey(date: string) {
  const day = Temporal.PlainDate.from(date);
  return day.subtract({ days: day.dayOfWeek - 1 }).toString();
}

function summarizeInitialInput(samples: InitialInputSample[]) {
  if (samples.length === 0) return undefined;
  const values = samples.map((sample) => sample.input).sort((a, b) => a - b);
  return {
    median: percentile(values, 0.5),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    sessions: values.length,
  };
}

function summarizeInitialInputs(samples: InitialInputSample[]) {
  return [
    ...Map.groupBy(
      samples,
      (sample) => `${dateKey(sample.sessionStartedAt)}:${sample.harness}`,
    ).entries(),
  ].map(([key, cohort]) => {
    const separator = key.indexOf(":");
    const values = cohort.map((sample) => sample.input).sort((a, b) => a - b);
    return {
      date: key.slice(0, separator),
      harness: cohort[0].harness,
      median: percentile(values, 0.5),
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
      sessions: values.length,
    };
  }).sort((a, b) =>
    a.date.localeCompare(b.date) || a.harness.localeCompare(b.harness)
  );
}

function summarizeSessionInputs(inputs: Map<string, number[]>) {
  return [...inputs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
    ([date, values]) => {
      values.sort((a, b) => a - b);
      return {
        date,
        median: percentile(values, 0.5),
        p90: percentile(values, 0.9),
        average: values.reduce((sum, value) => sum + value, 0) / values.length,
        sessions: values.length,
      };
    },
  );
}

type SubagentBucket = {
  rootOnly: number;
  withSubagents: number;
  withMultipleSubagents: number;
  subagents: number;
  calls: number;
  subagentCalls: number;
  totalInput: number;
  subagentInput: number;
  totalCost: number;
  subagentCost: number;
  hasUnpricedCost: boolean;
};

function emptySubagentBucket(): SubagentBucket {
  return {
    rootOnly: 0,
    withSubagents: 0,
    withMultipleSubagents: 0,
    subagents: 0,
    calls: 0,
    subagentCalls: 0,
    totalInput: 0,
    subagentInput: 0,
    totalCost: 0,
    subagentCost: 0,
    hasUnpricedCost: false,
  };
}

function summarizeSubagents(inputs: Map<string, SubagentBucket>) {
  return [...inputs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
    ([date, bucket]) => ({
      date,
      rootOnly: bucket.rootOnly,
      withSubagents: bucket.withSubagents,
      withMultipleSubagents: bucket.withMultipleSubagents,
      subagents: bucket.subagents,
      totalInput: bucket.totalInput,
      subagentInput: bucket.subagentInput,
      totalCost: bucket.totalCost,
      subagentCost: bucket.subagentCost,
      hasUnpricedCost: bucket.hasUnpricedCost,
    }),
  );
}

function aggregateSubagentBucket(calls: UsageCall[]) {
  const bucket = emptySubagentBucket();
  const sessions = Map.groupBy(
    calls,
    (call) => `${call.harness}:${call.session.rootID}`,
  );
  for (const sessionCalls of sessions.values()) {
    const subagentCalls = sessionCalls.filter((call) =>
      call.session.id !== call.session.rootID
    );
    const subagentIDs = new Set(subagentCalls.map((call) => call.session.id));
    bucket.rootOnly += subagentIDs.size === 0 ? 1 : 0;
    bucket.withSubagents += subagentIDs.size > 0 ? 1 : 0;
    bucket.withMultipleSubagents += subagentIDs.size > 1 ? 1 : 0;
    bucket.subagents += subagentIDs.size;
    bucket.calls += sessionCalls.length;
    bucket.subagentCalls += subagentCalls.length;
    bucket.totalInput += sessionCalls.reduce(
      (sum, call) =>
        sum + call.tokens.uncachedInput + call.tokens.cacheRead +
        (call.tokens.cacheWrite ?? 0),
      0,
    );
    bucket.subagentInput += subagentCalls.reduce(
      (sum, call) =>
        sum + call.tokens.uncachedInput + call.tokens.cacheRead +
        (call.tokens.cacheWrite ?? 0),
      0,
    );
    bucket.totalCost += sessionCalls.reduce(
      (sum, call) => sum + (call.computedCost ?? 0),
      0,
    );
    bucket.subagentCost += subagentCalls.reduce(
      (sum, call) => sum + (call.computedCost ?? 0),
      0,
    );
    bucket.hasUnpricedCost ||= sessionCalls.some((call) =>
      call.computedCost === undefined
    );
  }
  return bucket;
}

function aggregateSubagentsBy(
  calls: UsageCall[],
  bucketKey: (call: UsageCall) => string,
) {
  return new Map(
    [...Map.groupBy(calls, bucketKey).entries()].map(([date, bucketCalls]) => [
      date,
      aggregateSubagentBucket(bucketCalls),
    ]),
  );
}

export function aggregateUsage(
  usageCalls: UsageCall[],
  start?: number,
  subagentCoverage: UsageResponse["subagentCoverage"] = "full",
  initialInputSamples: InitialInputSample[] = [],
): CallUsageAggregation {
  const days = new Map<
    string,
    Map<string, { input: number; cost: number; hasPricedCost: boolean }>
  >();
  let hasUnpricedCost = false;
  let callCount = 0;
  const rangedCalls = usageCalls.filter((call) =>
    start === undefined || call.startedAt >= start
  );

  for (const call of rangedCalls) {
    callCount++;
    const date = dateKey(call.startedAt);
    const models = days.get(date) ?? new Map();
    const bucket = models.get(call.model) ?? {
      input: 0,
      cost: 0,
      hasPricedCost: false,
    };
    bucket.input += call.tokens.uncachedInput + call.tokens.cacheRead +
      (call.tokens.cacheWrite ?? 0);
    bucket.hasPricedCost ||= call.computedCost !== undefined ||
      call.reportedCost !== undefined;
    hasUnpricedCost ||= call.computedCost === undefined;
    bucket.cost += call.computedCost ?? call.reportedCost ?? 0;
    models.set(call.model, bucket);
    days.set(date, models);
  }

  const sessionCalls = Map.groupBy(
    usageCalls.filter((call) =>
      start === undefined || call.sessionStartedAt >= start
    ),
    (call) => `${call.harness}:${call.session.rootID}`,
  );
  const sessionInputs = new Map<string, number[]>();
  for (const calls of sessionCalls.values()) {
    const date = dateKey(calls[0].sessionStartedAt);
    const inputs = sessionInputs.get(date) ?? [];
    inputs.push(calls.reduce(
      (sum, call) =>
        sum + call.tokens.uncachedInput + call.tokens.cacheRead +
        (call.tokens.cacheWrite ?? 0),
      0,
    ));
    sessionInputs.set(date, inputs);
  }

  const sessionInputWeeks = new Map<string, number[]>();
  for (const [date, values] of sessionInputs) {
    const week = weekKey(date);
    const inputs = sessionInputWeeks.get(week) ?? [];
    inputs.push(...values);
    sessionInputWeeks.set(week, inputs);
  }
  const subagentDays = aggregateSubagentsBy(
    rangedCalls,
    (call) => dateKey(call.startedAt),
  );
  const subagentWeeks = aggregateSubagentsBy(
    rangedCalls,
    (call) => weekKey(dateKey(call.startedAt)),
  );

  return {
    callCount,
    dayCount: days.size,
    response: {
      hasUnpricedCost,
      subagentCoverage,
      subagentDays: summarizeSubagents(subagentDays),
      subagentWeeks: summarizeSubagents(subagentWeeks).map((entry) => ({
        ...entry,
        endDate: Temporal.PlainDate.from(entry.date).add({ days: 6 })
          .toString(),
      })),
      sessionInputDays: summarizeSessionInputs(sessionInputs),
      sessionInputWeeks: summarizeSessionInputs(sessionInputWeeks).map(
        (entry) => ({
          ...entry,
          endDate: Temporal.PlainDate.from(entry.date).add({ days: 6 })
            .toString(),
        }),
      ),
      initialInputSummary: summarizeInitialInput(initialInputSamples),
      initialInputDays: summarizeInitialInputs(initialInputSamples),
      days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
        ([date, models]) => ({
          date,
          models: [...models.entries()].map(([model, bucket]) => ({
            model,
            input: bucket.input,
            cost: bucket.hasPricedCost ? bucket.cost : undefined,
          })),
        }),
      ),
    },
  };
}

export function aggregateUsageRollups(
  rollups: StoredUsageRollup[],
  subagentUsage: StoredSubagentUsage[],
  start?: number,
  subagentCoverage: UsageResponse["subagentCoverage"] = "full",
  initialInputSamples: InitialInputSample[] = [],
): RollupUsageAggregation {
  const modelDays = new Map<
    string,
    Map<string, { input: number; cost: number; hasPricedCost: boolean }>
  >();
  const subagentsByRootDay = Map.groupBy(
    subagentUsage,
    (row) => `${row.rootSessionID}:${row.date}`,
  );
  const dailySubagents = new Map<string, SubagentBucket>();
  const weeklySubagents = new Map<string, SubagentBucket>();
  const sessionInputs = new Map<string, number[]>();
  let hasUnpricedCost = false;

  const addSubagentCohort = (
    buckets: Map<string, SubagentBucket>,
    key: string,
    totalInput: number,
    totalCost: number,
    unpriced: boolean,
    rows: StoredSubagentUsage[],
  ) => {
    const bucket = buckets.get(key) ?? emptySubagentBucket();
    const subagentIDs = new Set(rows.map((row) => row.subagentSessionID));
    bucket.rootOnly += subagentIDs.size === 0 ? 1 : 0;
    bucket.withSubagents += subagentIDs.size > 0 ? 1 : 0;
    bucket.withMultipleSubagents += subagentIDs.size > 1 ? 1 : 0;
    bucket.subagents += subagentIDs.size;
    bucket.totalInput += totalInput;
    bucket.subagentInput += rows.reduce((sum, row) => sum + row.input, 0);
    bucket.totalCost += totalCost;
    bucket.subagentCost += rows.reduce((sum, row) => sum + row.cost, 0);
    bucket.hasUnpricedCost ||= unpriced ||
      rows.some((row) => row.hasUnpricedCost);
    buckets.set(key, bucket);
  };

  for (const root of rollups) {
    if (start === undefined || root.sessionStartedAt >= start) {
      const date = dateKey(root.sessionStartedAt);
      const values = sessionInputs.get(date) ?? [];
      values.push(root.directInput + root.subagentInput);
      sessionInputs.set(date, values);
    }

    const rangedDays = root.overview.days.filter((day) =>
      start === undefined || day.firstTurnAt >= start
    );
    const weeks = new Map<
      string,
      {
        input: number;
        cost: number;
        hasUnpricedCost: boolean;
        rows: Map<number, StoredSubagentUsage>;
      }
    >();
    for (const day of rangedDays) {
      hasUnpricedCost ||= day.hasUnpricedCost;
      const models = modelDays.get(day.date) ?? new Map();
      for (const model of day.models) {
        const bucket = models.get(model.model) ?? {
          input: 0,
          cost: 0,
          hasPricedCost: false,
        };
        bucket.input += model.input;
        bucket.cost += model.cost;
        bucket.hasPricedCost ||= model.hasPricedCost ??
          (!model.hasUnpricedCost || model.cost > 0);
        models.set(model.model, bucket);
      }
      modelDays.set(day.date, models);

      const rows = subagentsByRootDay.get(
        `${root.rootSessionID}:${day.date}`,
      ) ?? [];
      addSubagentCohort(
        dailySubagents,
        day.date,
        day.input,
        day.cost,
        day.hasUnpricedCost,
        rows,
      );

      const week = weekKey(day.date);
      const weekly = weeks.get(week) ?? {
        input: 0,
        cost: 0,
        hasUnpricedCost: false,
        rows: new Map(),
      };
      weekly.input += day.input;
      weekly.cost += day.cost;
      weekly.hasUnpricedCost ||= day.hasUnpricedCost;
      for (const row of rows) {
        const existing = weekly.rows.get(row.subagentSessionID);
        weekly.rows.set(
          row.subagentSessionID,
          existing === undefined ? { ...row } : {
            ...existing,
            input: existing.input + row.input,
            cost: existing.cost + row.cost,
            hasUnpricedCost: existing.hasUnpricedCost || row.hasUnpricedCost,
          },
        );
      }
      weeks.set(week, weekly);
    }
    for (const [week, values] of weeks) {
      addSubagentCohort(
        weeklySubagents,
        week,
        values.input,
        values.cost,
        values.hasUnpricedCost,
        [...values.rows.values()],
      );
    }
  }

  const sessionInputWeeks = new Map<string, number[]>();
  for (const [date, values] of sessionInputs) {
    const week = weekKey(date);
    const inputs = sessionInputWeeks.get(week) ?? [];
    inputs.push(...values);
    sessionInputWeeks.set(week, inputs);
  }

  return {
    rootCount: rollups.length,
    dayCount: modelDays.size,
    response: {
      hasUnpricedCost,
      subagentCoverage,
      subagentDays: summarizeSubagents(dailySubagents),
      subagentWeeks: summarizeSubagents(weeklySubagents).map((entry) => ({
        ...entry,
        endDate: Temporal.PlainDate.from(entry.date).add({ days: 6 })
          .toString(),
      })),
      sessionInputDays: summarizeSessionInputs(sessionInputs),
      sessionInputWeeks: summarizeSessionInputs(sessionInputWeeks).map(
        (entry) => ({
          ...entry,
          endDate: Temporal.PlainDate.from(entry.date).add({ days: 6 })
            .toString(),
        }),
      ),
      initialInputSummary: summarizeInitialInput(initialInputSamples),
      initialInputDays: summarizeInitialInputs(initialInputSamples),
      days: [...modelDays.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
        ([date, models]) => ({
          date,
          models: [...models.entries()].map(([model, bucket]) => ({
            model,
            input: bucket.input,
            cost: bucket.hasPricedCost ? bucket.cost : undefined,
          })),
        }),
      ),
    },
  };
}
