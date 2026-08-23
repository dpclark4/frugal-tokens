import type {
  ActivityOverviewResponse,
  WorkRhythmOverviewResponse,
} from "../shared/sessionSchemas.ts";
import type { StoredOverviewRollup } from "./overviewAnalytics.ts";
import { aggregateWorkRhythm } from "./workRhythm.ts";
import { modelMetadata } from "../shared/modelMetadata.ts";
import {
  estimatedWorkIntervals,
  mergeWorkIntervals,
} from "../shared/workTime.ts";

export const ACTIVITY_INACTIVITY_MINUTES = 10;

type ModelBucket = {
  model: string;
  input: number;
  spend: number;
  hasUnpricedCost: boolean;
};

type TopSession =
  ActivityOverviewResponse["days"][number]["topSessions"][number];

type DayBucket = {
  processedInput: number;
  cacheRead: number;
  spend: number;
  hasUnpricedCost: boolean;
  sessions: number;
  turns: number;
  models: Map<string, ModelBucket>;
  topSessions: TopSession[];
};

type Interval = { start: number; end: number };

function dateKey(value: number) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function localDayBounds(date: string): Interval {
  const [year, month, day] = date.split("-").map(Number);
  return {
    start: new Date(year, month - 1, day).getTime(),
    end: new Date(year, month - 1, day + 1).getTime(),
  };
}

function spendComposition(
  days: Map<string, DayBucket>,
  start: number,
  end: number,
) {
  const allModels = new Map<string, ModelBucket>();
  for (const day of days.values()) {
    for (const model of day.models.values()) {
      const total = allModels.get(model.model) ?? {
        model: model.model,
        input: 0,
        spend: 0,
        hasUnpricedCost: false,
      };
      total.input += model.input;
      total.spend += model.spend;
      total.hasUnpricedCost ||= model.hasUnpricedCost;
      allModels.set(model.model, total);
    }
  }

  const bySpend = [...allModels.values()].toSorted((a, b) =>
    b.spend - a.spend || b.input - a.input || a.model.localeCompare(b.model)
  );
  const byTokens = [...allModels.values()].toSorted((a, b) =>
    b.input - a.input || b.spend - a.spend || a.model.localeCompare(b.model)
  );
  const spendRanks = new Map(
    bySpend.map((model, index) => [model.model, index + 1]),
  );
  const tokenRanks = new Map(
    byTokens.map((model, index) => [model.model, index + 1]),
  );
  const selectedIds = new Set([
    ...bySpend.slice(0, 5).map((model) => model.model),
    ...byTokens.slice(0, 5).map((model) => model.model),
  ]);
  const selected = bySpend.filter((model) => selectedIds.has(model.model));
  const omitted = bySpend.filter((model) => !selectedIds.has(model.model));
  const other = omitted.length === 0 ? undefined : omitted.reduce(
    (total, model) => ({
      spend: total.spend + model.spend,
      processedInput: total.processedInput + model.input,
      hasUnpricedCost: total.hasUnpricedCost || model.hasUnpricedCost,
    }),
    { spend: 0, processedInput: 0, hasUnpricedCost: false },
  );

  const chartDates: string[] = [];
  for (
    let date = Temporal.PlainDate.from(dateKey(start));
    Temporal.PlainDate.compare(date, Temporal.PlainDate.from(dateKey(end))) <=
      0;
    date = date.add({ days: 1 })
  ) chartDates.push(date.toString());

  return {
    spend: bySpend.reduce((sum, model) => sum + model.spend, 0),
    processedInput: bySpend.reduce((sum, model) => sum + model.input, 0),
    hasUnpricedCost: bySpend.some((model) => model.hasUnpricedCost),
    models: selected.map((model) => ({
      model: model.model,
      ...modelMetadata(model.model),
      spend: model.spend,
      processedInput: model.input,
      effectiveCostPerMillion: model.input === 0
        ? undefined
        : model.spend / model.input * 1_000_000,
      spendRank: spendRanks.get(model.model)!,
      tokenRank: tokenRanks.get(model.model)!,
      selectedBySpend: spendRanks.get(model.model)! <= 5,
      selectedByTokens: tokenRanks.get(model.model)! <= 5,
      hasUnpricedCost: model.hasUnpricedCost,
    })),
    other,
    days: chartDates.map(
      (date) => {
        const dayModels = [...(days.get(date)?.models.values() ?? [])];
        const models = dayModels.filter((model) => selectedIds.has(model.model))
          .map((model) => ({
            model: model.model,
            spend: model.spend,
            processedInput: model.input,
            hasUnpricedCost: model.hasUnpricedCost,
          }));
        const otherModels = dayModels.filter((model) =>
          !selectedIds.has(model.model)
        );
        return {
          date,
          models,
          otherSpend: otherModels.reduce((sum, model) => sum + model.spend, 0),
          otherProcessedInput: otherModels.reduce(
            (sum, model) => sum + model.input,
            0,
          ),
          otherHasUnpricedCost: otherModels.some((model) =>
            model.hasUnpricedCost
          ),
          otherModels: otherModels.toSorted((a, b) =>
            b.spend - a.spend || b.input - a.input ||
            a.model.localeCompare(b.model)
          ).map((model) => ({
            model: model.model,
            ...modelMetadata(model.model),
            spend: model.spend,
            processedInput: model.input,
            hasUnpricedCost: model.hasUnpricedCost,
          })),
        };
      },
    ),
  };
}

function estimatedActiveMs(date: string, intervals: Interval[]) {
  const day = localDayBounds(date);
  const clipped = intervals.filter((interval) =>
    interval.end > day.start && interval.start < day.end
  ).map((interval) => ({
    start: Math.max(day.start, interval.start),
    end: Math.min(day.end, interval.end),
  })).toSorted((a, b) => a.start - b.start);

  const merged: Interval[] = [];
  for (const interval of clipped) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return Math.round(
    merged.reduce((sum, interval) => sum + interval.end - interval.start, 0),
  );
}

function sessionDiagnostics(
  roots: StoredOverviewRollup[],
  start: number,
  end: number,
): WorkRhythmOverviewResponse["sessionDiagnostics"] {
  const sessions = roots.flatMap((root) => {
    const days = root.overview.days.filter((day) =>
      day.firstTurnAt >= start && day.firstTurnAt <= end
    );
    if (days.length === 0) return [];

    const processedInput = days.reduce((sum, day) => sum + day.input, 0);
    const cacheRead = days.reduce((sum, day) => sum + day.cacheRead, 0);
    const intervals = mergeWorkIntervals(
      estimatedWorkIntervals(
        root.rootExecutionIntervals ?? root.overview.executionIntervals,
      ),
      start,
      end,
    );
    const models = new Map<string, { input: number; spend: number }>();
    for (const day of days) {
      for (const model of day.models) {
        const total = models.get(model.model) ?? { input: 0, spend: 0 };
        total.input += model.input;
        total.spend += model.cost;
        models.set(model.model, total);
      }
    }
    const primaryModel = [...models.entries()].toSorted(([, a], [, b]) =>
      b.spend - a.spend || b.input - a.input
    )[0]?.[0] ?? null;

    const session:
      WorkRhythmOverviewResponse["sessionDiagnostics"]["sessions"][number] = {
        id: root.sessionID ?? String(root.rootSessionID),
        title: root.title ?? `Session ${root.rootSessionID}`,
        primaryModel,
        estimatedActiveMinutes: intervals.reduce(
          (sum, interval) =>
            sum + interval.end - interval.start,
          0,
        ) / 60_000,
        observedSessionMinutes: Math.max(
          0,
          (root.endedAt ?? Math.max(
            ...root.overview.days.map((day) =>
              day.lastCallAt ?? day.firstTurnAt
            ),
          )) -
            (root.startedAt ?? Math.min(
              ...root.overview.days.map((day) => day.firstTurnAt),
            )),
        ) / 60_000,
        spend: days.reduce((sum, day) => sum + day.cost, 0),
        hasUnpricedSpend: days.some((day) => day.hasUnpricedCost),
        processedInput,
        userTurns: days.reduce((sum, day) => sum + day.turns, 0),
      };
    if (root.harness !== undefined) session.harness = root.harness;
    if (processedInput !== 0) session.tokenReuse = cacheRead / processedInput;
    return [session];
  }).toSorted((a, b) =>
    a.spend - b.spend || a.processedInput - b.processedInput ||
    a.id.localeCompare(b.id)
  );
  return { sessions };
}

export function aggregateActivityOverview(
  roots: StoredOverviewRollup[],
  start: number,
  end: number,
  spendAtMissCalls = 0,
  recordTiming?: (name: string, duration: number) => void,
): ActivityOverviewResponse {
  const aggregationStartedAt = performance.now();
  const measured = <T>(name: string, operation: () => T): T => {
    const startedAt = performance.now();
    const result = operation();
    recordTiming?.(name, performance.now() - startedAt);
    return result;
  };
  const days = new Map<string, DayBucket>();
  const activityIntervals: Interval[] = [];
  const inactivityBuffer = ACTIVITY_INACTIVITY_MINUTES * 60_000;
  const rootSessionSpend: number[] = [];
  let subagentSpend = 0;
  let sessions = 0;

  for (const root of roots) {
    const rangedDays = root.overview.days.filter((day) =>
      day.firstTurnAt >= start && day.firstTurnAt <= end
    );
    if (rangedDays.length === 0) continue;
    sessions++;
    if (rangedDays.some((day) => day.hasPricedCost)) {
      rootSessionSpend.push(
        rangedDays.reduce((sum, day) => sum + day.cost, 0),
      );
    }
    subagentSpend += root.subagentSpend ?? 0;

    for (const interval of root.overview.executionIntervals) {
      if (
        interval.executionEndAt + inactivityBuffer < start ||
        interval.startedAt > end
      ) {
        continue;
      }
      activityIntervals.push({
        start: interval.startedAt,
        end: Math.max(interval.startedAt, interval.executionEndAt) +
          inactivityBuffer,
      });
    }

    for (const day of rangedDays) {
      const bucket = days.get(day.date) ?? {
        processedInput: 0,
        cacheRead: 0,
        spend: 0,
        hasUnpricedCost: false,
        sessions: 0,
        turns: 0,
        models: new Map<string, ModelBucket>(),
        topSessions: [],
      };
      bucket.processedInput += day.input;
      bucket.cacheRead += day.cacheRead;
      bucket.spend += day.cost;
      bucket.hasUnpricedCost ||= day.hasUnpricedCost;
      bucket.sessions++;
      bucket.turns += day.turns;

      for (const model of day.models) {
        const modelBucket = bucket.models.get(model.model) ?? {
          model: model.model,
          input: 0,
          spend: 0,
          hasUnpricedCost: false,
        };
        modelBucket.input += model.input;
        modelBucket.spend += model.cost;
        modelBucket.hasUnpricedCost ||= model.hasUnpricedCost;
        bucket.models.set(model.model, modelBucket);
      }

      bucket.topSessions.push({
        id: root.rootSessionID,
        title: root.title ?? `Session ${root.rootSessionID}`,
        harness: root.harness,
        models: day.models.map((model) => model.model),
        turns: day.turns,
        processedInput: day.input,
        spend: day.cost,
        hasUnpricedCost: day.hasUnpricedCost,
      });
      days.set(day.date, bucket);
    }
  }

  const processedInput = [...days.values()].reduce(
    (sum, day) => sum + day.processedInput,
    0,
  );
  const cacheRead = [...days.values()].reduce(
    (sum, day) => sum + day.cacheRead,
    0,
  );

  const pricedSessionSpend = rootSessionSpend.reduce(
    (sum, spend) => sum + spend,
    0,
  );
  // Rank one selected-period spend total per root session and consistently
  // include ceil(10% of priced roots), so a non-empty sample always has a top.
  const topSessionCount = Math.ceil(rootSessionSpend.length * 0.1);
  const topDecileSpend = rootSessionSpend.toSorted((a, b) => b - a)
    .slice(0, topSessionCount)
    .reduce((sum, spend) => sum + spend, 0);
  recordTiming?.(
    "activity-buckets",
    performance.now() - aggregationStartedAt,
  );
  const composition = measured(
    "spend-composition",
    () => spendComposition(days, start, end),
  );
  const responseDays = measured(
    "daily-response",
    () =>
      [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
        ([date, day]) => ({
          date,
          processedInput: day.processedInput,
          spend: day.spend,
          hasUnpricedCost: day.hasUnpricedCost,
          sessions: day.sessions,
          turns: day.turns,
          estimatedActiveMs: estimatedActiveMs(date, activityIntervals),
          models: [...day.models.values()].toSorted((a, b) =>
            b.spend - a.spend || b.input - a.input ||
            a.model.localeCompare(b.model)
          ).slice(0, 3).map((model) => ({
            model: model.model,
            input: model.input,
            spend: model.spend,
          })),
          topSessions: day.topSessions.toSorted((a, b) =>
            b.spend - a.spend || b.processedInput - a.processedInput ||
            a.id - b.id
          ).slice(0, 3),
        }),
      ),
  );

  return {
    startDate: dateKey(start),
    endDate: dateKey(end),
    summary: {
      sessions,
      processedInput,
      tokenReuse: processedInput === 0 ? undefined : cacheRead / processedInput,
      spend: [...days.values()].reduce((sum, day) => sum + day.spend, 0),
      hasUnpricedCost: [...days.values()].some((day) => day.hasUnpricedCost),
      spendAtMissCalls,
      subagentSpend,
      topDecileSpendShare: pricedSessionSpend === 0
        ? 0
        : topDecileSpend / pricedSessionSpend,
    },
    spendComposition: composition,
    days: responseDays,
  };
}

export function aggregateWorkRhythmOverview(
  roots: StoredOverviewRollup[],
  start: number,
  end: number,
  timeZone: string,
  recordTiming?: (name: string, duration: number) => void,
): WorkRhythmOverviewResponse {
  const measured = <T>(name: string, operation: () => T): T => {
    const startedAt = performance.now();
    const result = operation();
    recordTiming?.(name, performance.now() - startedAt);
    return result;
  };
  return {
    workRhythm: measured(
      "work-rhythm",
      () => aggregateWorkRhythm(roots, start, end, timeZone),
    ),
    sessionDiagnostics: measured(
      "session-diagnostics",
      () => sessionDiagnostics(roots, start, end),
    ),
  };
}
