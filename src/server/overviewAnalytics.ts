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
  let sessions = 0;
  let multiDaySessions = 0;
  let overallInput = 0;
  let overallCacheRead = 0;
  let hasUnpricedCost = false;

  for (const root of roots) {
    const rootKey = `${root.harness}:${root.id}`;
    const turns = sessionTree(root).flatMap((session) =>
      session.turns.filter((turn) =>
        turn.startedAt >= start && turn.startedAt <= end
      )
    );
    if (turns.length === 0) continue;
    sessions++;

    const sessionDates = new Set<string>();
    const calls = turns.flatMap((turn) => turn.calls);
    let sessionInput = 0;
    let sessionCacheRead = 0;
    let sessionSpend = 0;
    let sessionHasUnpricedCost = false;
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
        const cost = call.computedCost;
        sessionInput += input;
        sessionCacheRead += call.tokens.cacheRead;
        peakContext = Math.max(peakContext, input);
        lastCall = Math.max(lastCall, call.completedAt ?? call.startedAt);
        if (cost === undefined) {
          sessionHasUnpricedCost = true;
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
    if (!sessionHasUnpricedCost) profileSpend.push(sessionSpend);
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
  const topModels = rankedModels.slice(0, 3).map((model) =>
    modelResult(model, totalSpend)
  );
  if (rankedModels.length > 3) {
    const other = rankedModels.slice(3).reduce<ModelBucket>(
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
  const dailySpendValues = hasUnpricedCost
    ? []
    : [...activeDates].map((date) => dailySpend.get(date) ?? 0);

  return {
    rangeDays,
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
