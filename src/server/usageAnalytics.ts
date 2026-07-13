import type { UsageResponse } from "../shared/sessionSchemas.ts";
import { assessCache } from "./cacheAnalysis.ts";
import type { UsageCall } from "./usage.ts";

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

export function aggregateUsage(
  usageCalls: UsageCall[],
  start?: number,
): { response: UsageResponse; callCount: number; dayCount: number } {
  const days = new Map<
    string,
    Map<string, { input: number; cost: number; priced: boolean }>
  >();
  let hasUnpricedCost = false;
  let callCount = 0;

  for (const call of usageCalls) {
    if (start !== undefined && call.startedAt < start) continue;
    callCount++;
    const date = dateKey(call.startedAt);
    const models = days.get(date) ?? new Map();
    const bucket = models.get(call.model) ?? {
      input: 0,
      cost: 0,
      priced: true,
    };
    bucket.input += call.tokens.uncachedInput + call.tokens.cacheRead +
      (call.tokens.cacheWrite ?? 0);
    bucket.priced &&= call.computedCost !== undefined;
    hasUnpricedCost ||= call.computedCost === undefined;
    bucket.cost += call.computedCost ?? 0;
    models.set(call.model, bucket);
    days.set(date, models);
  }

  const sessionCalls = Map.groupBy(
    usageCalls.filter((call) =>
      start === undefined || call.sessionStartedAt >= start
    ),
    (call) => `${call.harness}:${call.sourceSessionID}`,
  );
  const cacheDays = new Map<
    string,
    { clean: number; partial: number; fullMiss: number; notComparable: number }
  >();
  const sessionInputs = new Map<string, number[]>();
  for (const calls of sessionCalls.values()) {
    const statuses = [
      ...Map.groupBy(calls, (call) => call.cacheChainID).values(),
    ]
      .flatMap((chain) => {
        let previous: UsageCall | undefined;
        return chain.sort((a, b) => a.startedAt - b.startedAt).map((call) => {
          const status = assessCache(previous, call).status;
          previous = call;
          return status;
        });
      });
    const date = dateKey(calls[0].sessionStartedAt);
    const inputs = sessionInputs.get(date) ?? [];
    inputs.push(calls.reduce(
      (sum, call) =>
        sum + call.tokens.uncachedInput + call.tokens.cacheRead +
        (call.tokens.cacheWrite ?? 0),
      0,
    ));
    sessionInputs.set(date, inputs);
    const bucket = cacheDays.get(date) ?? {
      clean: 0,
      partial: 0,
      fullMiss: 0,
      notComparable: 0,
    };
    if (statuses.includes("full-miss")) bucket.fullMiss++;
    else if (statuses.includes("partial-hit")) bucket.partial++;
    else if (statuses.includes("hit")) bucket.clean++;
    else bucket.notComparable++;
    cacheDays.set(date, bucket);
  }

  const sessionInputWeeks = new Map<string, number[]>();
  for (const [date, values] of sessionInputs) {
    const week = weekKey(date);
    const inputs = sessionInputWeeks.get(week) ?? [];
    inputs.push(...values);
    sessionInputWeeks.set(week, inputs);
  }

  return {
    callCount,
    dayCount: days.size,
    response: {
      hasUnpricedCost,
      sessionInputDays: summarizeSessionInputs(sessionInputs),
      sessionInputWeeks: summarizeSessionInputs(sessionInputWeeks).map(
        (entry) => ({
          ...entry,
          endDate: Temporal.PlainDate.from(entry.date).add({ days: 6 })
            .toString(),
        }),
      ),
      cacheDays: [...cacheDays.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([date, bucket]) => ({ date, ...bucket })),
      days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
        ([date, models]) => ({
          date,
          models: [...models.entries()].map(([model, bucket]) => ({
            model,
            input: bucket.input,
            cost: bucket.priced ? bucket.cost : undefined,
          })),
        }),
      ),
    },
  };
}
