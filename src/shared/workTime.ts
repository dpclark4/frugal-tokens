export const WORK_RHYTHM_INITIAL_MINUTES = 5;
export const WORK_RHYTHM_GAP_TIMEOUT_MINUTES = 10;
export const WORK_RHYTHM_FALLBACK_MINUTES = 5;

const INITIAL_WINDOW_MS = WORK_RHYTHM_INITIAL_MINUTES * 60_000;
const GAP_TIMEOUT_MS = WORK_RHYTHM_GAP_TIMEOUT_MINUTES * 60_000;
const FALLBACK_WINDOW_MS = WORK_RHYTHM_FALLBACK_MINUTES * 60_000;

export type WorkInterval = { start: number; end: number };
export type WorkExecutionInterval = {
  startedAt: number;
  executionEndAt: number;
};

export function estimatedWorkIntervals(
  executionIntervals: WorkExecutionInterval[],
): WorkInterval[] {
  const turns = executionIntervals.toSorted((a, b) =>
    a.startedAt - b.startedAt || a.executionEndAt - b.executionEndAt
  );
  return turns.map((turn, index) => {
    if (index === 0) {
      return {
        start: turn.startedAt - INITIAL_WINDOW_MS,
        end: turn.startedAt,
      };
    }

    const previous = turns[index - 1];
    if (turn.startedAt - previous.startedAt <= GAP_TIMEOUT_MS) {
      return { start: previous.startedAt, end: turn.startedAt };
    }
    return {
      start: turn.startedAt - FALLBACK_WINDOW_MS,
      end: turn.startedAt,
    };
  });
}

export function mergeWorkIntervals(
  intervals: WorkInterval[],
  start = Number.NEGATIVE_INFINITY,
  end = Number.POSITIVE_INFINITY,
) {
  const merged: WorkInterval[] = [];
  for (
    const interval of intervals.toSorted((a, b) =>
      a.start - b.start || a.end - b.end
    )
  ) {
    const clipped = {
      start: Math.max(start, interval.start),
      end: Math.min(end, interval.end),
    };
    if (clipped.end <= clipped.start) continue;
    const previous = merged.at(-1);
    if (previous && clipped.start <= previous.end) {
      previous.end = Math.max(previous.end, clipped.end);
    } else {
      merged.push(clipped);
    }
  }
  return merged;
}

export function summarizeWorkTime(executionIntervals: WorkExecutionInterval[]) {
  const intervals = mergeWorkIntervals(
    estimatedWorkIntervals(executionIntervals),
  );
  return {
    activeMilliseconds: intervals.reduce(
      (sum, interval) => sum + interval.end - interval.start,
      0,
    ),
    blocks: intervals.length,
    intervals,
  };
}
