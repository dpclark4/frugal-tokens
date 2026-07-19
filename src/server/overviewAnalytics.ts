import type {
  OverviewResponse,
  SessionDetail,
} from "../shared/sessionSchemas.ts";
import { contextSize } from "../shared/contextMetrics.ts";

type Distribution = NonNullable<
  OverviewResponse["sessionProfile"]["turns"]
>;

type ModelBucket = {
  model: string;
  sessions: Set<string>;
  input: number;
  cacheRead: number;
  spend: number;
  hasUnpricedCost: boolean;
};

type Interval = { start: number; end: number };

export const ROTATION_INACTIVITY_MINUTES = 30;

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

function distribution(values: number[]): Distribution | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  return {
    average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
  };
}

function sessionTree(session: SessionDetail): SessionDetail[] {
  return [
    session,
    ...session.subagents.flatMap((subagent) => sessionTree(subagent)),
  ];
}

function turnExecutionEnd(turn: SessionDetail["turns"][number]) {
  let end = turn.startedAt;
  for (const call of turn.calls) {
    end = Math.max(end, call.completedAt ?? call.startedAt);
    for (const tool of call.activity.tools) {
      end = Math.max(
        end,
        tool.completedAt ?? tool.startedAt ?? call.completedAt ??
          call.startedAt,
      );
    }
  }
  return end;
}

function mergeIntervals(intervals: Interval[]) {
  const merged: Interval[] = [];
  for (const interval of intervals.toSorted((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function localDayBounds(date: string): Interval {
  const [year, month, day] = date.split("-").map(Number);
  return {
    start: new Date(year, month - 1, day).getTime(),
    end: new Date(year, month - 1, day + 1).getTime(),
  };
}

function dailyRotationPeaks(
  activeDates: Set<string>,
  intervalsBySession: Map<string, Interval[]>,
) {
  const merged = [...intervalsBySession.values()].flatMap(mergeIntervals);
  return [...activeDates].map((date) => {
    const day = localDayBounds(date);
    const events: Array<{ at: number; delta: number }> = [];
    for (const interval of merged) {
      if (interval.end <= day.start || interval.start >= day.end) continue;
      events.push({ at: Math.max(interval.start, day.start), delta: 1 });
      events.push({ at: Math.min(interval.end, day.end), delta: -1 });
    }
    events.sort((a, b) => a.at - b.at || a.delta - b.delta);
    let active = 0;
    let peak = 0;
    for (const event of events) {
      active += event.delta;
      peak = Math.max(peak, active);
    }
    return peak;
  });
}

function modelResult(
  bucket: ModelBucket,
  totalSpend: number,
  isOther = false,
): OverviewResponse["models"][number] {
  return {
    model: bucket.model,
    sessions: bucket.sessions.size,
    input: bucket.input,
    spend: bucket.spend,
    spendShare: totalSpend === 0 ? 0 : bucket.spend / totalSpend,
    efficiency: bucket.input === 0
      ? undefined
      : bucket.cacheRead / bucket.input,
    hasUnpricedCost: bucket.hasUnpricedCost,
    isOther,
  };
}

export function aggregateOverview(
  roots: SessionDetail[],
  start: number,
  end: number,
  rangeDays: number,
  subagentCoverage: OverviewResponse["subagentCoverage"] = "full",
): OverviewResponse {
  const startDate = Temporal.PlainDate.from(dateKey(start));
  const endDate = Temporal.PlainDate.from(dateKey(end));
  let elapsedWeekdays = 0;
  for (
    let date = startDate;
    Temporal.PlainDate.compare(date, endDate) <= 0;
    date = date.add({ days: 1 })
  ) {
    if (date.dayOfWeek <= 5) elapsedWeekdays++;
  }

  const activeDates = new Set<string>();
  const activeWeekdays = new Set<string>();
  const weekendDates = new Set<string>();
  const dailySessions = new Map<string, Set<string>>();
  const dailyTurns = new Map<string, number>();
  const dailySpend = new Map<string, number>();
  const profileTurns: number[] = [];
  const profileInput: number[] = [];
  const profilePeakContext: number[] = [];
  const profileElapsed: number[] = [];
  const profileSpend: number[] = [];
  const profileEfficiency: number[] = [];
  const activeSpans: number[] = [];
  const models = new Map<string, ModelBucket>();
  const rotationIntervals = new Map<string, Interval[]>();
  const rotationBuffer = ROTATION_INACTIVITY_MINUTES * 60_000;
  let sessions = 0;
  let multiDaySessions = 0;
  let overallInput = 0;
  let overallCacheRead = 0;
  let hasUnpricedCost = false;

  for (const root of roots) {
    const rootKey = `${root.harness}:${root.id}`;
    const allTurns = sessionTree(root).flatMap((session) => session.turns);
    const executionIntervals = allTurns.map((turn) => ({
      start: turn.startedAt,
      end: turnExecutionEnd(turn),
    }));
    if (executionIntervals.length > 0) {
      const sessionStart = Math.min(
        ...executionIntervals.map((interval) => interval.start),
      );
      const sessionEnd = Math.max(
        ...executionIntervals.map((interval) => interval.end),
      );
      const intervals = executionIntervals.map((interval) => ({
        start: Math.max(sessionStart, interval.start - rotationBuffer),
        end: Math.min(sessionEnd, interval.end + rotationBuffer),
      })).filter((interval) => interval.end > start && interval.start <= end);
      if (intervals.length > 0) rotationIntervals.set(rootKey, intervals);
    }
    const turns = allTurns.filter((turn) =>
      turn.startedAt >= start && turn.startedAt <= end
    );
    if (turns.length === 0) continue;
    sessions++;

    const sessionDates = new Set<string>();
    let sessionInput = 0;
    let sessionCacheRead = 0;
    let sessionSpend = 0;
    let peakContext = 0;
    let firstTurn = Number.POSITIVE_INFINITY;
    let lastCall = Number.NEGATIVE_INFINITY;

    for (const turn of turns) {
      const date = dateKey(turn.startedAt);
      const plainDate = Temporal.PlainDate.from(date);
      sessionDates.add(date);
      activeDates.add(date);
      if (plainDate.dayOfWeek <= 5) activeWeekdays.add(date);
      else weekendDates.add(date);
      const workedOn = dailySessions.get(date) ?? new Set<string>();
      workedOn.add(rootKey);
      dailySessions.set(date, workedOn);
      dailyTurns.set(date, (dailyTurns.get(date) ?? 0) + 1);
      firstTurn = Math.min(firstTurn, turn.startedAt);

      for (const call of turn.calls) {
        const input = contextSize(call.tokens);
        const cost = call.computedCost ?? call.reportedCost;
        sessionInput += input;
        sessionCacheRead += call.tokens.cacheRead;
        peakContext = Math.max(peakContext, input);
        lastCall = Math.max(lastCall, call.completedAt ?? call.startedAt);
        if (cost === undefined) {
          hasUnpricedCost = true;
        } else {
          sessionSpend += cost;
          const callDate = dateKey(call.startedAt);
          dailySpend.set(callDate, (dailySpend.get(callDate) ?? 0) + cost);
        }

        const bucket = models.get(call.model) ?? {
          model: call.model,
          sessions: new Set<string>(),
          input: 0,
          cacheRead: 0,
          spend: 0,
          hasUnpricedCost: false,
        };
        bucket.sessions.add(rootKey);
        bucket.input += input;
        bucket.cacheRead += call.tokens.cacheRead;
        bucket.spend += cost ?? 0;
        bucket.hasUnpricedCost ||= cost === undefined;
        models.set(call.model, bucket);
      }
    }

    profileTurns.push(turns.length);
    profileInput.push(sessionInput);
    profilePeakContext.push(peakContext);
    if (Number.isFinite(firstTurn) && Number.isFinite(lastCall)) {
      profileElapsed.push(Math.max(0, lastCall - firstTurn));
    }
    profileSpend.push(sessionSpend);
    if (sessionInput > 0) {
      profileEfficiency.push(sessionCacheRead / sessionInput);
    }
    overallInput += sessionInput;
    overallCacheRead += sessionCacheRead;
    activeSpans.push(sessionDates.size);
    if (sessionDates.size > 1) multiDaySessions++;
  }

  const totalSpend = [...models.values()].reduce(
    (sum, model) => sum + model.spend,
    0,
  );
  const rankedModels = [...models.values()].sort((a, b) =>
    b.spend - a.spend || b.input - a.input || a.model.localeCompare(b.model)
  );
  const topModels = rankedModels.slice(0, 4).map((model) =>
    modelResult(model, totalSpend)
  );
  if (rankedModels.length > 4) {
    const other = rankedModels.slice(4).reduce<ModelBucket>(
      (result, model) => {
        model.sessions.forEach((session) => result.sessions.add(session));
        result.input += model.input;
        result.cacheRead += model.cacheRead;
        result.spend += model.spend;
        result.hasUnpricedCost ||= model.hasUnpricedCost;
        return result;
      },
      {
        model: "Other",
        sessions: new Set(),
        input: 0,
        cacheRead: 0,
        spend: 0,
        hasUnpricedCost: false,
      },
    );
    topModels.push(modelResult(other, totalSpend, true));
  }

  const dailySessionValues = [...dailySessions.values()].map((day) => day.size);
  const dailyTurnValues = [...activeDates].map((date) =>
    dailyTurns.get(date) ?? 0
  );
  const dailySpendValues = [...activeDates].map((date) =>
    dailySpend.get(date) ?? 0
  );
  const rotationPeaks = dailyRotationPeaks(activeDates, rotationIntervals);

  return {
    rangeDays,
    rotationInactivityMinutes: ROTATION_INACTIVITY_MINUTES,
    sessions,
    activeDays: activeDates.size,
    activeWeekdays: activeWeekdays.size,
    elapsedWeekdays,
    weekendDays: weekendDates.size,
    weekdayActivityRate: elapsedWeekdays === 0
      ? 0
      : activeWeekdays.size / elapsedWeekdays,
    subagentCoverage,
    activity: {
      sessions: distribution(dailySessionValues),
      peakConcurrentSessions: distribution(rotationPeaks),
      turns: distribution(dailyTurnValues),
      spend: distribution(dailySpendValues),
      hasUnpricedCost,
    },
    sessionProfile: {
      turns: distribution(profileTurns),
      input: distribution(profileInput),
      peakContext: distribution(profilePeakContext),
      elapsed: distribution(profileElapsed),
      spend: distribution(profileSpend),
      efficiency: distribution(profileEfficiency),
      overallEfficiency: overallInput === 0
        ? undefined
        : overallCacheRead / overallInput,
      hasUnpricedCost,
    },
    multiDaySessions,
    multiDaySessionRate: sessions === 0 ? 0 : multiDaySessions / sessions,
    averageActiveSpan: activeSpans.length === 0
      ? 0
      : activeSpans.reduce((sum, value) => sum + value, 0) /
        activeSpans.length,
    models: topModels,
  };
}
