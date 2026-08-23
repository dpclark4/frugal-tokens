import type { SessionDistributionResponse } from "../shared/sessionSchemas.ts";
import type { StoredSessionDistributionRollup } from "./conversationRepository.ts";

type Distribution =
  SessionDistributionResponse["metrics"][number]["distribution"];

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
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
  };
}

export function aggregateSessionDistributions(
  roots: StoredSessionDistributionRollup[],
  start: number,
  end: number,
  rangeDays: 30 | 90,
): SessionDistributionResponse {
  const costs: number[] = [];
  const inputs: number[] = [];
  const turns: number[] = [];
  const spans: number[] = [];
  const startingContexts: number[] = [];
  const peakContexts: number[] = [];
  const tokenReuse: number[] = [];
  let unpricedSessions = 0;
  let multiDaySessions = 0;

  for (const root of roots) {
    const days = root.overview.days.filter((day) =>
      day.firstTurnAt >= start && day.firstTurnAt <= end
    );
    if (days.length === 0) continue;

    const input = days.reduce((sum, day) => sum + day.input, 0);
    const cacheRead = days.reduce((sum, day) => sum + day.cacheRead, 0);
    const firstTurnAt = Math.min(...days.map((day) => day.firstTurnAt));
    const lastCallAt = Math.max(
      ...days.map((day) => day.lastCallAt ?? day.firstTurnAt),
    );

    costs.push(days.reduce((sum, day) => sum + day.cost, 0));
    inputs.push(input);
    turns.push(days.reduce((sum, day) => sum + day.turns, 0));
    spans.push(Math.max(0, lastCallAt - firstTurnAt));
    peakContexts.push(Math.max(...days.map((day) => day.peakContext)));
    if (root.initialInput !== undefined) {
      startingContexts.push(root.initialInput);
    }
    if (input > 0) tokenReuse.push(cacheRead / input);
    if (days.length > 1) multiDaySessions++;
    if (days.some((day) => day.hasUnpricedCost)) unpricedSessions++;
  }

  return {
    rangeDays,
    sampleSize: inputs.length,
    unpricedSessions,
    multiDaySessions,
    multiDaySessionRate: inputs.length === 0
      ? 0
      : multiDaySessions / inputs.length,
    metrics: [
      { key: "cost", distribution: distribution(costs) },
      { key: "processedInput", distribution: distribution(inputs) },
      { key: "userTurns", distribution: distribution(turns) },
      { key: "observedSpan", distribution: distribution(spans) },
      { key: "startingContext", distribution: distribution(startingContexts) },
      { key: "peakContext", distribution: distribution(peakContexts) },
      { key: "tokenReuse", distribution: distribution(tokenReuse) },
    ],
  };
}
