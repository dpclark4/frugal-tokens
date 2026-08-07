export type WorkRhythmHarness =
  | "claude-code"
  | "opencode"
  | "pi"
  | "codex";

export interface WorkRhythmSession {
  id: string;
  title: string | null;
  harness: WorkRhythmHarness;
  model: string | null;
  startTime: string;
  spend: number;
}

export interface WorkRhythmDay {
  date: string;
  estimatedActiveMinutes: number;
  spend: number;
  processedInputTokens: number;
  userTurns: number;
  rootSessions: number;
  intensity: 0 | 1 | 2 | 3 | 4;
  topSessions: WorkRhythmSession[];
}

/**
 * Frontend contract for the future work-rhythm endpoint/loader.
 *
 * The backend will create one interval covering the five minutes immediately
 * before each actual user turn, union those intervals across every root session,
 * subagent, and harness, then aggregate the union. Overlaps count once and idle
 * gaps are never filled. The frontend intentionally consumes only those
 * already-aggregated estimates.
 */
export interface WorkRhythmData {
  range: {
    start: string;
    end: string;
  };
  estimatedActiveMinutes: number;
  methodology: {
    minutesBeforeTurn: number;
    overlapsCountedOnce: boolean;
  };
  weekdayActivity: Array<{
    weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    label: string;
    averageMinutes: number;
    totalMinutes: number;
    occurrences: number;
    activeOccurrences: number;
  }>;
  hourlyActivity: Array<{
    hour: number;
    estimatedMinutes: number;
    shareOfTotal: number;
    activeDates: number;
  }>;
  afterHoursShare: number;
  peakHour: number;
  days: Record<string, WorkRhythmDay>;
}
